/**
 * Max voice agent — WebSocket bridge (Twilio Media Stream ↔ OpenAI Realtime GA).
 * Expression layer only — ticket reads/creates go through maxTools → tenantMaintenanceService → pipeline.
 */
const WebSocket = require("ws");
const { getSupabase } = require("../db/supabase");
const { lookupCallerRoster } = require("./lookupCallerRoster");
const { loadVoiceBrandForRoster } = require("./voiceBrandResolve");
const { loadVoiceCallerContext } = require("./voiceCallerContext");
const { buildMaxSystemPrompt } = require("./maxSystemPrompt");
const { MAX_TOOL_SCHEMAS, runTool, mergeVoiceIntakeDraft } = require("./maxTools");
const { emit } = require("../logging/structuredLog");
const {
  openaiApiKey,
  voiceModel,
  voiceAgentVoice,
  voiceAgentName,
  voiceVadEagerness,
  voiceTurnDetectionMode,
  voiceSilenceDurationMs,
} = require("../config/env");

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";
const GREETING_FALLBACK_MS = 1200;

function createTwilioVoiceWss() {
  const wss = new WebSocket.Server({ noServer: true });
  wss.on("connection", handleTwilioStream);
  return wss;
}

/** @deprecated Prefer voice upgrade routing via registerVoiceRoutes */
function attachVoiceWebSocketBridge(httpServer) {
  const wss = createTwilioVoiceWss();
  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/voice/stream") return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });
  emit({ level: "info", log_kind: "voice_bridge", event: "ws_server_attached", data: { path: "/voice/stream" } });
}

function buildTurnDetection() {
  const interruptResponse = false;
  const createResponse = true;
  if (voiceTurnDetectionMode() === "semantic_vad") {
    return {
      type: "semantic_vad",
      eagerness: voiceVadEagerness(),
      interrupt_response: interruptResponse,
      create_response: createResponse,
    };
  }
  return {
    type: "server_vad",
    threshold: 0.5,
    prefix_padding_ms: 400,
    silence_duration_ms: voiceSilenceDurationMs(),
    interrupt_response: interruptResponse,
    create_response: createResponse,
  };
}

function buildGaSessionUpdate(systemPrompt, model, options = {}) {
  const vadCreateResponse =
    options.vadCreateResponse !== undefined ? Boolean(options.vadCreateResponse) : false;
  const voice = voiceAgentVoice() || "alloy";
  const turnDetection = { ...buildTurnDetection(), create_response: vadCreateResponse };
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model,
      output_modalities: ["audio"],
      instructions: systemPrompt,
      tools: MAX_TOOL_SCHEMAS,
      tool_choice: "auto",
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          turn_detection: turnDetection,
          transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
        },
        output: {
          format: { type: "audio/pcmu" },
          voice,
        },
      },
    },
  };
}

async function handleTwilioStream(twilioWs) {
  const traceId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  emit({ level: "info", trace_id: traceId, log_kind: "voice_bridge", event: "call_connected" });

  let streamSid = null;
  let callSid = null;
  let callerPhone = null;
  let rosterRow = null;
  let openaiWs = null;
  let sessionReady = false;
  const pendingAudio = [];
  const handledToolCalls = new Set();
  let responseInProgress = false;
  let pendingResponseAfterTool = false;
  let greetingSent = false;
  let greetingFallbackTimer = null;
  let vadAutoResponseEnabled = false;
  let cachedSystemPrompt = "";
  let cachedModel = "";
  let intakeDraft = {};
  let createTicketAttempts = 0;
  let isUnknownCaller = false;
  let orgBrandLabel = "";
  let unknownGreetingStep = 0;
  const agentDisplayName = voiceAgentName();

  const apiKey = openaiApiKey();
  if (!apiKey) {
    emit({ level: "error", trace_id: traceId, log_kind: "voice_bridge", event: "no_openai_key" });
    twilioWs.close();
    return;
  }

  const model = voiceModel() || "gpt-realtime-2";
  openaiWs = new WebSocket(`${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  function markSessionReady() {
    sessionReady = true;
    for (const chunk of pendingAudio) {
      safeOpenAiSend(openaiWs, chunk);
    }
    pendingAudio.length = 0;
  }

  function responseDoneTerminal(status) {
    const s = String(status || "").toLowerCase();
    return s === "completed" || s === "cancelled" || s === "incomplete";
  }

  /** Single gate for response.create — avoids greeting/VAD/tool collisions. */
  function scheduleResponseCreate(extra = {}) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return false;
    if (responseInProgress) {
      pendingResponseAfterTool = true;
      return false;
    }
    safeOpenAiSend(openaiWs, { type: "response.create", ...extra });
    responseInProgress = true;
    return true;
  }

  function enableVadAutoResponse() {
    if (vadAutoResponseEnabled || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (!cachedSystemPrompt) return;
    vadAutoResponseEnabled = true;
    safeOpenAiSend(
      openaiWs,
      buildGaSessionUpdate(cachedSystemPrompt, cachedModel, { vadCreateResponse: true })
    );
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "voice_bridge",
      event: "vad_auto_response_enabled",
    });
  }

  function maybeEnableVadAfterGreeting(unknownStep2Queued) {
    if (unknownStep2Queued) return;
    if (isUnknownCaller && unknownGreetingStep < 2) return;
    if (greetingSent && !vadAutoResponseEnabled) {
      enableVadAutoResponse();
    }
  }

  function startGreetingOnce() {
    if (greetingSent || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    greetingSent = true;
    if (greetingFallbackTimer) {
      clearTimeout(greetingFallbackTimer);
      greetingFallbackTimer = null;
    }
    if (isUnknownCaller) {
      unknownGreetingStep = 1;
      scheduleResponseCreate({
        response: {
          instructions:
            `Say ONLY this intro — no questions yet, then stop: "Hi, this is ${agentDisplayName} with ${orgBrandLabel}."`,
        },
      });
    } else {
      scheduleResponseCreate();
    }
  }

  function continueUnknownCallerGreeting(status) {
    if (!isUnknownCaller || unknownGreetingStep !== 1 || status !== "completed") return false;
    unknownGreetingStep = 2;
    scheduleResponseCreate({
      response: {
        instructions:
          'Say ONLY this question, then stop and wait in silence: "Which building or property are you calling from?"',
      },
    });
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "voice_bridge",
      event: "unknown_caller_greeting_step2",
    });
    return true;
  }

  function toolCtx() {
    return {
      sb: getSupabase(),
      traceId,
      callerPhone,
      rosterRow,
      intakeDraft,
    };
  }

  async function executeToolCall(toolName, toolArgs, callId) {
    if (!toolName || !callId || handledToolCalls.has(callId)) return;
    handledToolCalls.add(callId);

    if (toolName === "create_ticket") {
      intakeDraft = mergeVoiceIntakeDraft(intakeDraft, toolArgs);
      toolArgs = intakeDraft;
      createTicketAttempts += 1;
    }

    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "voice_tool",
      event: "tool_call",
      data: {
        tool: toolName,
        call_id: callId,
        args_preview: JSON.stringify(toolArgs).slice(0, 300),
        ...(toolName === "create_ticket" ? { attempt: createTicketAttempts } : {}),
      },
    });

    let toolResult;
    try {
      toolResult = await runTool(toolName, toolArgs, toolCtx());
    } catch (err) {
      toolResult = {
        error: String(err?.message || err),
        recovery: toolName === "create_ticket" ? "retry_create_ticket" : undefined,
      };
    }

    if (toolName === "create_ticket" && toolResult && !toolResult.created && !toolResult.error) {
      emit({
        level: "warn",
        trace_id: traceId,
        log_kind: "voice_tool",
        event: "create_ticket_failed",
        data: {
          attempt: createTicketAttempts,
          missing_fields: toolResult.missing_fields || [],
          recovery: toolResult.recovery || null,
        },
      });
    }

    safeOpenAiSend(openaiWs, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(toolResult),
      },
    });
    if (responseInProgress) {
      pendingResponseAfterTool = true;
    } else {
      scheduleResponseCreate();
    }
  }

  function flushPendingResponse() {
    if (!pendingResponseAfterTool) return;
    pendingResponseAfterTool = false;
    scheduleResponseCreate();
  }

  openaiWs.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }

    const audioDelta =
      (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") && msg.delta;
    if (audioDelta && streamSid) {
      responseInProgress = true;
      safeTwilioSend(
        twilioWs,
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: audioDelta },
        })
      );
      return;
    }

    if (
      (msg.type === "response.output_audio.done" || msg.type === "response.audio.done") &&
      streamSid
    ) {
      safeTwilioSend(
        twilioWs,
        JSON.stringify({ event: "mark", streamSid, mark: { name: "response_done" } })
      );
      return;
    }

    switch (msg.type) {
      case "session.created":
        emit({ level: "info", trace_id: traceId, log_kind: "voice_bridge", event: "openai_session_created" });
        if (!greetingSent && !greetingFallbackTimer) {
          greetingFallbackTimer = setTimeout(() => startGreetingOnce(), GREETING_FALLBACK_MS);
        }
        break;

      case "session.updated":
        emit({ level: "info", trace_id: traceId, log_kind: "voice_bridge", event: "openai_session_updated" });
        if (greetingFallbackTimer) {
          clearTimeout(greetingFallbackTimer);
          greetingFallbackTimer = null;
        }
        if (!vadAutoResponseEnabled) {
          startGreetingOnce();
        }
        break;

      case "response.created":
        responseInProgress = true;
        break;

      case "response.function_call_arguments.done": {
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(msg.arguments || "{}");
        } catch (_) {}
        await executeToolCall(msg.name, toolArgs, msg.call_id);
        break;
      }

      case "response.done": {
        const status = String(msg.response?.status || "").toLowerCase();
        if (responseDoneTerminal(status)) {
          responseInProgress = false;
        }
        const queuedUnknownStep2 = continueUnknownCallerGreeting(status);
        maybeEnableVadAfterGreeting(queuedUnknownStep2);
        if (!queuedUnknownStep2) {
          flushPendingResponse();
        }

        const output = msg.response?.output;
        if (!Array.isArray(output)) break;
        for (const item of output) {
          if (item?.type !== "function_call" || item.status !== "completed") continue;
          let toolArgs = {};
          try {
            toolArgs = JSON.parse(item.arguments || "{}");
          } catch (_) {}
          await executeToolCall(item.name, toolArgs, item.call_id);
        }
        break;
      }

      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (msg.transcript) {
          emit({
            level: "info",
            trace_id: traceId,
            log_kind: "voice_transcript",
            event: "agent_spoke",
            data: { text: String(msg.transcript).slice(0, 200) },
          });
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript) {
          emit({
            level: "info",
            trace_id: traceId,
            log_kind: "voice_transcript",
            event: "caller_spoke",
            data: { text: String(msg.transcript).slice(0, 200) },
          });
        }
        break;

      case "input_audio_buffer.speech_started":
        /* Let OpenAI semantic_vad handle interruption — manual response.cancel caused Max to cut himself on "ok"/"uh-huh". */
        break;

      case "error": {
        const code = msg.error?.code || "";
        if (
          code === "response_cancel_not_active" ||
          code === "conversation_already_has_active_response"
        ) {
          pendingResponseAfterTool = true;
          break;
        }
        emit({
          level: "error",
          trace_id: traceId,
          log_kind: "voice_bridge",
          event: "openai_error",
          data: { error: msg.error },
        });
        break;
      }

      default:
        break;
    }
  });

  openaiWs.on("error", (err) => {
    emit({
      level: "error",
      trace_id: traceId,
      log_kind: "voice_bridge",
      event: "openai_ws_error",
      data: { error: String(err?.message || err) },
    });
  });

  openaiWs.on("close", () => {
    emit({ level: "info", trace_id: traceId, log_kind: "voice_bridge", event: "openai_ws_closed" });
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  twilioWs.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }

    switch (msg.event) {
      case "start": {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        callerPhone =
          (msg.start.customParameters && msg.start.customParameters.callerPhone) ||
          msg.start.from ||
          null;

        emit({
          level: "info",
          trace_id: traceId,
          log_kind: "voice_bridge",
          event: "stream_start",
          data: { streamSid, callSid, callerPhone },
        });

        const sb = getSupabase();
        const rosterResult = callerPhone
          ? await lookupCallerRoster(sb, callerPhone)
          : { matched: false };
        rosterRow = rosterResult.matched ? rosterResult.row : null;
        isUnknownCaller = !rosterRow;
        orgBrandLabel = "";
        unknownGreetingStep = 0;
        const brandCtx = await loadVoiceBrandForRoster(sb, rosterRow);
        orgBrandLabel = brandCtx.orgBrandName || brandCtx.orgBrandShort || "your property management team";

        let callerContextBlock = "";
        if (rosterRow) {
          const callerCtx = await loadVoiceCallerContext(sb, rosterRow, traceId);
          callerContextBlock = callerCtx.promptBlock || "";
        }

        emit({
          level: "info",
          trace_id: traceId,
          log_kind: "voice_bridge",
          event: "caller_resolved",
          data: {
            matched: !!rosterRow,
            property_code: rosterRow ? rosterRow.property_code : null,
            unit_label: rosterRow ? rosterRow.unit_label : null,
          },
        });

        let greetingInstruction = "";
        if (rosterRow) {
          const firstName = (rosterRow.resident_name || "").split(/\s+/)[0];
          const propLabel = brandCtx.propertyDisplayName || brandCtx.orgBrandShort;
          greetingInstruction =
            `Caller: ${firstName}, unit ${rosterRow.unit_label}, ${propLabel}. ` +
            `Greet: "Hi ${firstName} — ${agentDisplayName} with ${brandCtx.orgBrandName || brandCtx.orgBrandShort}. ` +
            `You're at ${propLabel}, unit ${rosterRow.unit_label}. How can I help?"`;
        } else {
          greetingInstruction =
            `Unknown caller — not on roster. ` +
            `The bridge will greet in two steps (intro, then property question). ` +
            `After that: ask unit on a NEW turn after they answer property, then issue — never two questions in one turn.`;
        }

        const systemPrompt =
          buildMaxSystemPrompt({
            brandName: brandCtx.orgBrandName,
            brandShort: brandCtx.orgBrandShort,
            propertyName: brandCtx.propertyDisplayName,
            rosterKnown: !!rosterRow,
          }) +
          "\n\n## THIS CALL\n" +
          greetingInstruction +
          (callerContextBlock ? `\n\n${callerContextBlock}` : "");

        cachedSystemPrompt = systemPrompt;
        cachedModel = model;

        const configure = () => {
          safeOpenAiSend(openaiWs, buildGaSessionUpdate(systemPrompt, model, { vadCreateResponse: false }));
          markSessionReady();
        };

        if (openaiWs.readyState === WebSocket.OPEN) {
          configure();
        } else {
          openaiWs.once("open", configure);
        }
        break;
      }

      case "media": {
        const audioPayload = msg.media && msg.media.payload;
        if (!audioPayload) break;

        const audioMsg = {
          type: "input_audio_buffer.append",
          audio: audioPayload,
        };

        if (!sessionReady || openaiWs.readyState !== WebSocket.OPEN) {
          pendingAudio.push(audioMsg);
        } else {
          safeOpenAiSend(openaiWs, audioMsg);
        }
        break;
      }

      case "stop":
        emit({ level: "info", trace_id: traceId, log_kind: "voice_bridge", event: "stream_stop", data: { callSid } });
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
        break;

      default:
        break;
    }
  });

  twilioWs.on("close", () => {
    emit({ level: "info", trace_id: traceId, log_kind: "voice_bridge", event: "twilio_ws_closed" });
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on("error", (err) => {
    emit({
      level: "error",
      trace_id: traceId,
      log_kind: "voice_bridge",
      event: "twilio_ws_error",
      data: { error: String(err?.message || err) },
    });
  });
}

function safeOpenAiSend(ws, payload) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
    }
  } catch (_) {}
}

function safeTwilioSend(ws, payload) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
    }
  } catch (_) {}
}

module.exports = {
  attachVoiceWebSocketBridge,
  createTwilioVoiceWss,
  buildGaSessionUpdate,
  buildTurnDetection,
  GREETING_FALLBACK_MS,
};
