/**
 * Jarvis staff live voice — WebSocket bridge (Portal browser ↔ OpenAI Realtime GA).
 * Expression layer only — reads via jarvisVoiceTools → handleJarvisAskTurn.
 */
const WebSocket = require("ws");
const { getSupabase } = require("../db/supabase");
const { resolveStaffContextFromRouterParameter } = require("../identity/resolveStaffContext");
const { loadJarvisStaffSessionContext } = require("./jarvisStaffSessionContext");
const { buildJarvisSystemPrompt } = require("./jarvisSystemPrompt");
const { jarvisVoiceToolSchemas, runJarvisVoiceTool } = require("./jarvisVoiceTools");
const { buildTurnDetection } = require("./voiceWebSocketBridge");
const { emit } = require("../logging/structuredLog");
const { latestAwaitingProposal } = require("../dal/jarvisOperatorThreads");
const {
  openaiApiKey,
  voiceModel,
  voiceAgentVoice,
  jarvisVoiceEnabled,
} = require("../config/env");

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";
const GREETING_FALLBACK_MS = 1200;

function buildJarvisGaSessionUpdate(systemPrompt, model) {
  const voice = voiceAgentVoice() || "alloy";
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model,
      output_modalities: ["audio"],
      instructions: systemPrompt,
      tools: jarvisVoiceToolSchemas(),
      tool_choice: "auto",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          turn_detection: buildTurnDetection(),
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice,
        },
      },
    },
  };
}

function safeSend(ws, payload) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
    }
  } catch (_) {}
}

function normalizePageContext(pageContext) {
  if (!pageContext || typeof pageContext !== "object") return null;
  return {
    surface: String(pageContext.surface || "").trim() || undefined,
    pathname: String(pageContext.pathname || "").trim() || undefined,
    propertyCode: String(
      pageContext.propertyCode || pageContext.property_code || ""
    )
      .trim()
      .toUpperCase() || undefined,
    unit: String(pageContext.unit || "").trim() || undefined,
    ticketRowId: String(pageContext.ticketRowId || pageContext.ticket_row_id || "").trim() || undefined,
    humanTicketId: String(pageContext.humanTicketId || pageContext.human_ticket_id || "").trim() || undefined,
    ticketLabel: String(pageContext.ticketLabel || pageContext.ticket_label || "").trim() || undefined,
  };
}

function ticketToCopilotPayload(target, pageContext) {
  const ctx = pageContext ? normalizePageContext(pageContext) : null;
  if (!target && ctx) {
    const humanTicketId = String(ctx.humanTicketId || "").trim();
    if (!humanTicketId) return null;
    return {
      humanTicketId,
      ticketRowId: String(ctx.ticketRowId || "").trim() || undefined,
      unitLabel: String(ctx.unit || "").trim() || undefined,
      propertyCode: String(ctx.propertyCode || "").trim() || undefined,
      issue: String(ctx.ticketLabel || "").trim() || undefined,
    };
  }
  if (!target) return null;
  const humanTicketId = String(target.humanTicketId || target.human_ticket_id || "").trim();
  if (!humanTicketId) return null;
  return {
    humanTicketId,
    ticketRowId: String(target.ticketRowId || target.ticket_row_id || "").trim() || undefined,
    unitLabel: String(target.unitLabel || target.unit_label || "").trim() || undefined,
    propertyCode: String(target.propertyCode || target.property_code || "").trim() || undefined,
    category: String(target.category || "").trim() || undefined,
    status: String(target.status || "").trim() || undefined,
    issue: String(target.issue || target.issue_summary || "").trim() || undefined,
  };
}

function emitCopilotFromToolResult(clientWs, toolName, toolResult) {
  if (!toolResult || typeof toolResult !== "object") return;

  let ticketPayload = ticketToCopilotPayload(toolResult.target, null);
  if (!ticketPayload && toolResult.human_ticket_id) {
    ticketPayload = {
      humanTicketId: String(toolResult.human_ticket_id).trim(),
      unitLabel: String(toolResult.unit_label || "").trim() || undefined,
    };
  }

  if (ticketPayload && (toolName === "resolve_open_ticket" || toolResult.needs_confirm)) {
    safeSend(clientWs, { type: "copilot.ticket", ticket: ticketPayload, source: toolName });
  }

  if (toolResult.needs_confirm) {
    safeSend(clientWs, {
      type: "copilot.proposal",
      proposal: {
        op: String(toolResult.op || "proposal"),
        summary: String(toolResult.summary_human || toolResult.summary || "").trim(),
        humanTicketId: String(toolResult.human_ticket_id || ticketPayload?.humanTicketId || "").trim(),
        needsConfirm: true,
        confirmToken: String(toolResult.confirm_token || "").trim() || undefined,
      },
    });
  }

  if (toolResult.committed) {
    safeSend(clientWs, {
      type: "copilot.proposal",
      proposal: {
        op: String(toolResult.op || "proposal"),
        summary: String(toolResult.reply || "Confirmed.").trim(),
        humanTicketId: String(toolResult.human_ticket_id || "").trim(),
        needsConfirm: false,
        committed: true,
      },
    });
  }
}

function emitCopilotPageAnchor(clientWs, pageContext) {
  const ctx = normalizePageContext(pageContext);
  const ticket = ticketToCopilotPayload(null, ctx);
  if (!ticket) {
    if (ctx?.propertyCode || ctx?.pathname) {
      safeSend(clientWs, {
        type: "copilot.context",
        context: {
          propertyCode: ctx.propertyCode,
          pathname: ctx.pathname,
          surface: ctx.surface,
        },
      });
    }
    return;
  }
  safeSend(clientWs, { type: "copilot.ticket", ticket, source: "page_context" });
}

function emitCopilotFromThreadState(clientWs, thread, scope) {
  if (!thread) return;

  const pending = latestAwaitingProposal(thread.pendingProposals || []);
  if (pending && String(pending.state || "") === "awaiting_confirm") {
    const exp = pending.expires_at ? new Date(String(pending.expires_at)).getTime() : 0;
    if (!exp || Date.now() <= exp) {
      const anchor = thread.scopeSnapshot?.anchor || scope?.anchor;
      safeSend(clientWs, {
        type: "copilot.proposal",
        proposal: {
          op: String(pending.op || "proposal"),
          summary: String(pending.summary_human || "").trim(),
          humanTicketId: anchor?.humanTicketId
            ? String(anchor.humanTicketId).trim()
            : undefined,
          needsConfirm: true,
          confirmToken: String(pending.confirm_token || "").trim() || undefined,
        },
      });
    }
  }

  const anchor = thread.scopeSnapshot?.anchor || scope?.anchor;
  if (anchor?.humanTicketId) {
    safeSend(clientWs, {
      type: "copilot.ticket",
      ticket: {
        humanTicketId: String(anchor.humanTicketId).trim(),
        ticketRowId: anchor.ticketRowId ? String(anchor.ticketRowId).trim() : undefined,
        unitLabel: anchor.unit ? String(anchor.unit).trim() : undefined,
        propertyCode: anchor.propertyCode ? String(anchor.propertyCode).trim() : undefined,
      },
      source: "thread",
    });
  }
}

function createJarvisVoiceWss() {
  const wss = new WebSocket.Server({ noServer: true });
  wss.on("connection", handleJarvisPortalStream);
  return wss;
}

async function handleJarvisPortalStream(clientWs) {
  const traceId = `jarvis-voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  emit({
    level: "info",
    trace_id: traceId,
    log_kind: "jarvis_voice",
    event: "client_connected",
  });

  let openaiWs = null;
  let sessionReady = false;
  let sessionConfigured = false;
  let staffContext = null;
  let pageContext = null;
  let voiceScope = null;
  let staffActorKey = "";
  const pendingAudio = [];
  const handledToolCalls = new Set();
  let responseInProgress = false;
  let pendingResponseAfterTool = false;
  let greetingSent = false;
  let greetingFallbackTimer = null;

  const apiKey = openaiApiKey();
  if (!apiKey) {
    safeSend(clientWs, { type: "error", message: "OpenAI API key not configured." });
    clientWs.close();
    return;
  }

  if (!jarvisVoiceEnabled()) {
    safeSend(clientWs, { type: "error", message: "Jarvis voice is disabled on this server." });
    clientWs.close();
    return;
  }

  function markSessionReady() {
    sessionReady = true;
    for (const chunk of pendingAudio) {
      safeSend(openaiWs, chunk);
    }
    pendingAudio.length = 0;
    emitCopilotPageAnchor(clientWs, pageContext);
    safeSend(clientWs, { type: "session.ready" });
  }

  function startGreetingOnce() {
    if (greetingSent || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    greetingSent = true;
    if (greetingFallbackTimer) {
      clearTimeout(greetingFallbackTimer);
      greetingFallbackTimer = null;
    }
    safeSend(openaiWs, { type: "response.create" });
    responseInProgress = true;
  }

  let pendingConfirmToken = "";

  function toolCtx() {
    return {
      traceId,
      staffContext,
      staffActorKey,
      pageContext,
      scope: voiceScope,
      pendingConfirmToken,
      onPendingConfirm: (token) => {
        pendingConfirmToken = String(token || "").trim();
      },
    };
  }

  async function executeToolCall(toolName, toolArgs, callId) {
    if (!toolName || !callId || handledToolCalls.has(callId)) return;
    handledToolCalls.add(callId);

    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "jarvis_voice_tool",
      event: "tool_call",
      data: { tool: toolName, call_id: callId },
    });

    let toolResult;
    try {
      toolResult = await runJarvisVoiceTool(toolName, toolArgs, toolCtx());
    } catch (err) {
      toolResult = { error: String(err?.message || err) };
    }

    safeSend(openaiWs, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(toolResult),
      },
    });

    emitCopilotFromToolResult(clientWs, toolName, toolResult);

    if (responseInProgress) {
      pendingResponseAfterTool = true;
    } else {
      safeSend(openaiWs, { type: "response.create" });
      responseInProgress = true;
    }
  }

  function flushPendingResponse() {
    if (!pendingResponseAfterTool) return;
    pendingResponseAfterTool = false;
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      safeSend(openaiWs, { type: "response.create" });
      responseInProgress = true;
    }
  }

  async function configureOpenAiSession() {
    if (sessionConfigured) return;
    sessionConfigured = true;

    const sb = getSupabase();
    const routerParameter = { From: staffActorKey, _transportChannel: "portal" };
    staffContext = await resolveStaffContextFromRouterParameter(routerParameter);

    if (!staffContext.isStaff) {
      safeSend(clientWs, {
        type: "error",
        message: "Staff identity not recognized for this phone. Check portal roster.",
      });
      clientWs.close();
      return;
    }

    const loaded = await loadJarvisStaffSessionContext({
      sb,
      staffContext,
      pageContext,
      traceId,
    });
    voiceScope = loaded.scope;
    emitCopilotFromThreadState(clientWs, loaded.thread, loaded.scope);

    const systemPrompt = buildJarvisSystemPrompt({
      staffDisplayName: loaded.staffDisplayName,
      sessionContextBlock: loaded.promptBlock,
    });

    const model = voiceModel() || "gpt-realtime-2";
    openaiWs = new WebSocket(`${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const configure = () => {
      safeSend(openaiWs, buildJarvisGaSessionUpdate(systemPrompt, model));
    };

    openaiWs.on("open", configure);

    openaiWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }

      const audioDelta =
        (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") &&
        msg.delta;
      if (audioDelta) {
        safeSend(clientWs, { type: "audio.delta", audio: audioDelta });
      }

      if (msg.type === "response.output_audio_transcript.delta" && msg.delta) {
        safeSend(clientWs, { type: "transcript.assistant.delta", text: msg.delta });
      }
      if (
        (msg.type === "response.output_audio_transcript.done" ||
          msg.type === "response.audio_transcript.done") &&
        msg.transcript
      ) {
        safeSend(clientWs, {
          type: "transcript.assistant.done",
          text: String(msg.transcript),
        });
      }
      if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
        safeSend(clientWs, { type: "transcript.user", text: String(msg.transcript) });
      }

      if (msg.type === "session.created" || msg.type === "session.updated") {
        markSessionReady();
        if (msg.type === "session.created") {
          greetingFallbackTimer = setTimeout(() => startGreetingOnce(), GREETING_FALLBACK_MS);
        }
        if (msg.type === "session.updated") {
          startGreetingOnce();
        }
        return;
      }

      if (msg.type === "response.created") {
        responseInProgress = true;
      }

      if (msg.type === "response.done") {
        responseInProgress = false;
        flushPendingResponse();
      }

      if (msg.type === "response.function_call_arguments.done") {
        const callId = msg.call_id;
        const toolName = msg.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(String(msg.arguments || "{}"));
        } catch (_) {
          toolArgs = {};
        }
        await executeToolCall(toolName, toolArgs, callId);
      }

      if (msg.type === "error") {
        emit({
          level: "error",
          trace_id: traceId,
          log_kind: "jarvis_voice",
          event: "openai_error",
          data: { error: JSON.stringify(msg.error || msg).slice(0, 400) },
        });
        safeSend(clientWs, {
          type: "error",
          message: String(msg.error?.message || "Realtime API error"),
        });
      }
    });

    openaiWs.on("close", () => {
      emit({ level: "info", trace_id: traceId, log_kind: "jarvis_voice", event: "openai_ws_closed" });
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    openaiWs.on("error", (err) => {
      emit({
        level: "error",
        trace_id: traceId,
        log_kind: "jarvis_voice",
        event: "openai_ws_error",
        data: { error: String(err?.message || err) },
      });
    });
  }

  clientWs.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }

    switch (msg.type) {
      case "session.start": {
        staffActorKey = String(msg.from || msg.staffPhone || "").trim();
        pageContext = normalizePageContext(
          msg.pageContext && typeof msg.pageContext === "object" ? msg.pageContext : null
        );
        if (!staffActorKey) {
          safeSend(clientWs, { type: "error", message: "session.start requires from (staff phone)." });
          clientWs.close();
          return;
        }
        await configureOpenAiSession();
        break;
      }

      case "audio.append": {
        const audio = String(msg.audio || "").trim();
        if (!audio || !openaiWs) break;
        const audioMsg = { type: "input_audio_buffer.append", audio };
        if (!sessionReady || openaiWs.readyState !== WebSocket.OPEN) {
          pendingAudio.push(audioMsg);
        } else {
          safeSend(openaiWs, audioMsg);
        }
        break;
      }

      case "session.stop":
        emit({ level: "info", trace_id: traceId, log_kind: "jarvis_voice", event: "session_stop" });
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
        clientWs.close();
        break;

      default:
        break;
    }
  });

  clientWs.on("close", () => {
    emit({ level: "info", trace_id: traceId, log_kind: "jarvis_voice", event: "client_ws_closed" });
    if (greetingFallbackTimer) clearTimeout(greetingFallbackTimer);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  clientWs.on("error", (err) => {
    emit({
      level: "error",
      trace_id: traceId,
      log_kind: "jarvis_voice",
      event: "client_ws_error",
      data: { error: String(err?.message || err) },
    });
  });
}

module.exports = {
  createJarvisVoiceWss,
  buildJarvisGaSessionUpdate,
  handleJarvisPortalStream,
  GREETING_FALLBACK_MS,
};
