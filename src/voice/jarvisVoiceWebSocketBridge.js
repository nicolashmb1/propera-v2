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
const { verifyProposalConfirmToken } = require("../agent/proposals/proposalToken");
const { extractProposalPortalFields } = require("../agent/proposals/proposalPortalFields");
const { openTicketsFromScope } = require("./jarvisCopilotTicketEnrich");
const {
  openaiApiKey,
  voiceModel,
  voiceAgentVoice,
  jarvisVoiceEnabled,
} = require("../config/env");

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";
const GREETING_FALLBACK_MS = 1200;
/** Ping clients on this cadence; terminate any that miss a pong (half-open drop). */
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * One heartbeat sweep over a set of client sockets: terminate clients that never
 * answered the previous ping (dead/half-open), ping the rest. A `pong` handler
 * resets `isAlive`. Exported for tests. Pure over the passed iterable.
 * @param {Iterable<{ isAlive?: boolean, terminate?: () => void, ping?: () => void }>} clients
 */
function heartbeatSweep(clients) {
  for (const ws of clients || []) {
    if (ws.isAlive === false) {
      try {
        ws.terminate && ws.terminate();
      } catch (_) {
        /* already gone */
      }
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping && ws.ping();
    } catch (_) {
      /* socket dying — terminated next sweep */
    }
  }
}

function buildJarvisGaSessionUpdate(systemPrompt, model, options = {}) {
  const vadCreateResponse =
    options.vadCreateResponse !== undefined ? Boolean(options.vadCreateResponse) : true;
  const voice = voiceAgentVoice() || "alloy";
  const turnDetection = { ...buildTurnDetection(), create_response: vadCreateResponse };
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
          turn_detection: turnDetection,
          transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
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

function candidateToCopilotPayload(c) {
  if (!c || typeof c !== "object") return null;
  const humanTicketId = String(c.humanTicketId || c.human_ticket_id || "").trim();
  if (!humanTicketId) return null;
  const issue = String(c.issue || c.summary || c.message_raw || "").trim();
  const { formatTicketChoiceLabel, ticketAgeSpeak } = require("./ticketDisambiguationSpeak");
  return {
    humanTicketId,
    unitLabel: String(c.unitLabel || c.unit_label || "").trim() || undefined,
    propertyCode: String(c.propertyCode || c.property_code || "").trim() || undefined,
    category: String(c.category || "").trim() || undefined,
    issue: issue || undefined,
    label: formatTicketChoiceLabel(c) || undefined,
    ageLabel: ticketAgeSpeak(c) || undefined,
  };
}

function emitCopilotFromToolResult(clientWs, toolName, toolResult) {
  if (!toolResult || typeof toolResult !== "object") return;

  if (toolResult.error && !toolResult.needs_confirm && !toolResult.committed) {
    safeSend(clientWs, {
      type: "copilot.error",
      error: {
        code: String(toolResult.error || "error"),
        message: String(toolResult.message || toolResult.error || "Something went wrong.").trim(),
      },
    });
  }

  const candidates = Array.isArray(toolResult.candidates) ? toolResult.candidates : [];
  if (candidates.length) {
    safeSend(clientWs, {
      type: "copilot.candidates",
      candidates: candidates.map(candidateToCopilotPayload).filter(Boolean),
    });
  }

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
    const op = String(toolResult.op || "proposal").trim();
    const portalFields = extractProposalPortalFields(op, toolResult);
    safeSend(clientWs, {
      type: "copilot.proposal",
      proposal: {
        op,
        summary: String(toolResult.summary_human || toolResult.summary || "").trim(),
        humanTicketId:
          String(toolResult.human_ticket_id || ticketPayload?.humanTicketId || portalFields.humanTicketId || "")
            .trim() || undefined,
        needsConfirm: true,
        confirmToken: String(toolResult.confirm_token || "").trim() || undefined,
        amountCents:
          portalFields.amountCents ??
          (Number(toolResult.amount_cents) > 0 ? Number(toolResult.amount_cents) : undefined),
        entryType: portalFields.entryType || String(toolResult.entry_type || "").trim() || undefined,
        vendorName:
          portalFields.vendorName || String(toolResult.vendor_name || "").trim() || undefined,
        noteText:
          portalFields.noteText ||
          String(toolResult.note_text || toolResult.noteText || "").trim() ||
          undefined,
        dispatch:
          toolResult.dispatch === false ? false : toolResult.dispatch === true ? true : portalFields.dispatch,
        propertyCode: portalFields.propertyCode || String(toolResult.property_code || "").trim() || undefined,
        unitLabel: portalFields.unitLabel || String(toolResult.unit_label || "").trim() || undefined,
        issue:
          portalFields.issue ||
          String(toolResult.issue_text || toolResult.issue || "").trim() ||
          undefined,
        preferredWindow:
          portalFields.preferredWindow || String(toolResult.preferred_window || "").trim() || undefined,
        statusTo: portalFields.statusTo || String(toolResult.status_to || "").trim() || undefined,
        category: portalFields.category || String(toolResult.category || "").trim() || undefined,
        amenityName: portalFields.amenityName,
        bookingLabel: portalFields.bookingLabel,
        tenantName: portalFields.tenantName,
        scheduleSummary: portalFields.scheduleSummary,
        policySummary: portalFields.policySummary,
        maxDurationMin: portalFields.maxDurationMin,
        audienceLabel: portalFields.audienceLabel,
        willSend: portalFields.willSend,
        skippedNoPhone: portalFields.skippedNoPhone,
        skippedOptOut: portalFields.skippedOptOut,
        messageBody: portalFields.messageBody,
        finalMessagePreview: portalFields.finalMessagePreview,
        smsSegments: portalFields.smsSegments,
        campaignId: portalFields.campaignId,
        commType: portalFields.commType,
        deliveryMode: portalFields.deliveryMode,
        recipientsPreview: portalFields.recipientsPreview,
      },
    });
  }

  if (toolResult.committed) {
    safeSend(clientWs, {
      type: "copilot.receipt",
      receipt: {
        op: String(toolResult.op || "proposal"),
        message: String(toolResult.reply || "Confirmed.").trim(),
        humanTicketId: String(toolResult.human_ticket_id || "").trim() || undefined,
      },
    });
    safeSend(clientWs, { type: "copilot.proposal.clear" });
  }

  if (toolResult.dismissed === true || toolResult.pending_cleared === true) {
    safeSend(clientWs, { type: "copilot.proposal.clear" });
  }

  if (toolResult.read_only && toolName === "query_service_history") {
    const message = String(toolResult.text || toolResult.speak || "").trim();
    if (message) {
      safeSend(clientWs, {
        type: "copilot.receipt",
        receipt: {
          op: "service_history",
          message,
        },
      });
    }
  }
}

function emitCopilotScopeSummary(clientWs, scope) {
  if (!scope) return;
  const tickets = openTicketsFromScope(scope);
  const propertyCode = String(scope.anchor?.propertyCode || tickets[0]?.propertyCode || "")
    .trim()
    .toUpperCase();
  if (!tickets.length && !propertyCode) return;
  safeSend(clientWs, {
    type: "copilot.summary",
    summary: {
      kind: "property_open_tickets",
      propertyCode: propertyCode || undefined,
      story: String(scope.story || "").trim() || undefined,
      tickets,
    },
  });
}

function proposalFieldsFromPending(pending, anchor) {
  const op = String(pending?.op || "").trim();
  const confirmToken = String(pending?.confirm_token || "").trim();
  const verified = confirmToken ? verifyProposalConfirmToken(confirmToken) : null;
  const payload =
    verified?.payload && typeof verified.payload === "object"
      ? verified.payload
      : pending?.payload && typeof pending.payload === "object"
        ? pending.payload
        : {};
  const fields = extractProposalPortalFields(op, payload);
  const humanTicketId =
    String(anchor?.humanTicketId || fields.humanTicketId || "").trim() || undefined;

  return {
    op,
    summary: String(pending?.summary_human || "").trim(),
    humanTicketId,
    needsConfirm: true,
    confirmToken: confirmToken || undefined,
    amountCents: fields.amountCents,
    entryType: fields.entryType,
    vendorName: fields.vendorName,
    noteText: fields.noteText,
    dispatch: fields.dispatch,
    propertyCode: fields.propertyCode,
    unitLabel: fields.unitLabel,
    issue: fields.issue,
    preferredWindow: fields.preferredWindow,
    statusTo: fields.statusTo,
    category: fields.category,
    amenityName: fields.amenityName,
    bookingLabel: fields.bookingLabel,
    tenantName: fields.tenantName,
    scheduleSummary: fields.scheduleSummary,
    policySummary: fields.policySummary,
    maxDurationMin: fields.maxDurationMin,
    audienceLabel: fields.audienceLabel,
    willSend: fields.willSend,
    skippedNoPhone: fields.skippedNoPhone,
    skippedOptOut: fields.skippedOptOut,
    messageBody: fields.messageBody,
    finalMessagePreview: fields.finalMessagePreview,
    smsSegments: fields.smsSegments,
    campaignId: fields.campaignId,
    commType: fields.commType,
    deliveryMode: fields.deliveryMode,
    recipientsPreview: fields.recipientsPreview,
  };
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

function emitCopilotFromThreadState(clientWs, thread, scope, options = {}) {
  if (!thread) return;

  const skipPending = options.skipPendingProposal === true;
  const pending = latestAwaitingProposal(thread.pendingProposals || []);
  if (!skipPending && pending && String(pending.state || "") === "awaiting_confirm") {
    const exp = pending.expires_at ? new Date(String(pending.expires_at)).getTime() : 0;
    if (!exp || Date.now() <= exp) {
      const anchor = thread.scopeSnapshot?.anchor || scope?.anchor;
      safeSend(clientWs, {
        type: "copilot.proposal",
        proposal: proposalFieldsFromPending(pending, anchor),
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

  // Detect half-open client sockets (mobile/network drop with no close frame) so
  // the paired OpenAI Realtime connection is freed instead of leaking. terminate()
  // fires clientWs 'close', which tears the upstream socket down.
  const heartbeat = setInterval(() => heartbeatSweep(wss.clients), HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));

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
  let vadAutoResponseEnabled = false;
  let cachedSystemPrompt = "";
  let cachedModel = "";

  // Heartbeat liveness: createJarvisVoiceWss pings; a pong marks the socket alive.
  clientWs.isAlive = true;
  clientWs.on("pong", () => {
    clientWs.isAlive = true;
  });

  // Single idempotent teardown — closes BOTH sockets and clears timers so a drop
  // or error on either side never leaks the paired connection.
  let toreDown = false;
  function teardown() {
    if (toreDown) return;
    toreDown = true;
    if (greetingFallbackTimer) {
      clearTimeout(greetingFallbackTimer);
      greetingFallbackTimer = null;
    }
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch (_) {
      /* already closing */
    }
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    } catch (_) {
      /* already closing */
    }
  }

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

  function responseDoneTerminal(status) {
    const s = String(status || "").toLowerCase();
    return s === "completed" || s === "cancelled" || s === "incomplete";
  }

  /** Single gate for response.create — avoids greeting/VAD/tool collisions. */
  function scheduleResponseCreate() {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return false;
    if (responseInProgress) {
      pendingResponseAfterTool = true;
      return false;
    }
    safeSend(openaiWs, { type: "response.create" });
    responseInProgress = true;
    return true;
  }

  function enableVadAutoResponse() {
    if (vadAutoResponseEnabled || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (!cachedSystemPrompt) return;
    vadAutoResponseEnabled = true;
    safeSend(
      openaiWs,
      buildJarvisGaSessionUpdate(cachedSystemPrompt, cachedModel, { vadCreateResponse: true })
    );
  }

  function startGreetingOnce() {
    if (greetingSent || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    greetingSent = true;
    if (greetingFallbackTimer) {
      clearTimeout(greetingFallbackTimer);
      greetingFallbackTimer = null;
    }
    scheduleResponseCreate();
  }

  let pendingConfirmToken = "";
  let pendingSessionEnd = false;
  /** Staff utterances heard this call (gates writes until someone actually spoke). */
  let staffTurnCount = 0;
  let confirmTokenIssuedAtTurn = 0;
  let staffSpeechSeen = false;
  let lastStaffTranscript = "";

  function noteStaffUtterance(transcript) {
    const text = String(transcript || "").trim();
    if (text.length >= 2) {
      staffSpeechSeen = true;
      staffTurnCount += 1;
      lastStaffTranscript = text;
    }
  }

  function toolCtx() {
    return {
      traceId,
      staffContext,
      staffActorKey,
      pageContext,
      scope: voiceScope,
      pendingConfirmToken,
      staffTurnCount,
      staffSpeechSeen,
      lastStaffTranscript,
      confirmTokenIssuedAtTurn,
      requireSessionConfirmToken: true,
      onPendingConfirm: (token) => {
        pendingConfirmToken = String(token || "").trim();
        confirmTokenIssuedAtTurn = staffTurnCount;
      },
      onPendingClear: () => {
        pendingConfirmToken = "";
      },
      onSessionEndRequested: () => {
        pendingSessionEnd = true;
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

    scheduleResponseCreate();
  }

  function flushPendingResponse() {
    if (!pendingResponseAfterTool) return;
    pendingResponseAfterTool = false;
    scheduleResponseCreate();
  }

  function maybeEndSessionAfterResponse() {
    if (!pendingSessionEnd) return;
    pendingSessionEnd = false;
    safeSend(clientWs, { type: "copilot.session_end" });
    setTimeout(() => {
      try {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
      } catch (_) {}
      try {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      } catch (_) {}
    }, 800);
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
      forVoice: true,
    });
    voiceScope = loaded.scope;
    emitCopilotFromThreadState(clientWs, loaded.thread, loaded.scope, { skipPendingProposal: true });
    emitCopilotScopeSummary(clientWs, loaded.scope);

    const systemPrompt = buildJarvisSystemPrompt({
      staffDisplayName: loaded.staffDisplayName,
      sessionContextBlock: loaded.promptBlock,
    });

    const model = voiceModel() || "gpt-realtime-2";
    cachedSystemPrompt = systemPrompt;
    cachedModel = model;
    vadAutoResponseEnabled = false;
    openaiWs = new WebSocket(`${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const configure = () => {
      safeSend(
        openaiWs,
        buildJarvisGaSessionUpdate(systemPrompt, model, { vadCreateResponse: false })
      );
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
        noteStaffUtterance(msg.transcript);
        safeSend(clientWs, { type: "transcript.user", text: String(msg.transcript) });
      }

      if (msg.type === "input_audio_buffer.speech_stopped" && vadAutoResponseEnabled) {
        staffSpeechSeen = true;
      }

      if (msg.type === "session.created") {
        markSessionReady();
        if (!greetingSent && !greetingFallbackTimer) {
          greetingFallbackTimer = setTimeout(() => startGreetingOnce(), GREETING_FALLBACK_MS);
        }
        return;
      }

      if (msg.type === "session.updated") {
        markSessionReady();
        if (greetingFallbackTimer) {
          clearTimeout(greetingFallbackTimer);
          greetingFallbackTimer = null;
        }
        if (!vadAutoResponseEnabled) {
          startGreetingOnce();
        }
        return;
      }

      if (msg.type === "response.created") {
        responseInProgress = true;
      }

      if (msg.type === "response.done") {
        const status = String(msg.response?.status || "").toLowerCase();
        if (responseDoneTerminal(status)) {
          responseInProgress = false;
          if (greetingSent && !vadAutoResponseEnabled) {
            enableVadAutoResponse();
          }
          flushPendingResponse();
          maybeEndSessionAfterResponse();
        }
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
        const errObj = msg.error && typeof msg.error === "object" ? msg.error : {};
        const errCode = String(errObj.code || "").trim();
        const errMessage = String(errObj.message || msg.message || "Realtime API error").trim();
        if (errCode === "conversation_already_has_active_response") {
          pendingResponseAfterTool = true;
          emit({
            level: "info",
            trace_id: traceId,
            log_kind: "jarvis_voice",
            event: "openai_response_busy_queued",
            data: { message: errMessage.slice(0, 200) },
          });
          return;
        }
        emit({
          level: "error",
          trace_id: traceId,
          log_kind: "jarvis_voice",
          event: "openai_error",
          data: { error: JSON.stringify(msg.error || msg).slice(0, 400) },
        });
        safeSend(clientWs, {
          type: "error",
          message: errMessage,
        });
      }
    });

    openaiWs.on("close", () => {
      emit({ level: "info", trace_id: traceId, log_kind: "jarvis_voice", event: "openai_ws_closed" });
      teardown();
    });

    openaiWs.on("error", (err) => {
      emit({
        level: "error",
        trace_id: traceId,
        log_kind: "jarvis_voice",
        event: "openai_ws_error",
        data: { error: String(err?.message || err) },
      });
      teardown();
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
    teardown();
  });

  clientWs.on("error", (err) => {
    emit({
      level: "error",
      trace_id: traceId,
      log_kind: "jarvis_voice",
      event: "client_ws_error",
      data: { error: String(err?.message || err) },
    });
    teardown();
  });
}

module.exports = {
  createJarvisVoiceWss,
  buildJarvisGaSessionUpdate,
  handleJarvisPortalStream,
  heartbeatSweep,
  GREETING_FALLBACK_MS,
  HEARTBEAT_INTERVAL_MS,
};
