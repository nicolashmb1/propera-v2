/**
 * Structured logs — one JSON object per line on stdout.
 * Easy to grep, pipe to jq, and paste into Cursor / LLMs for debugging.
 *
 * Every line has: ts, service, level, trace_id, log_kind, event, data (optional).
 *
 * Intake / schedule (grep-friendly; **DB flight recorder** mirrors policy + brain via `appendEventLog`):
 * - INTAKE_PARSE_BRANCH — { branch: "compile_turn" | "regex_only" } (INTAKE_COMPILE_TURN)
 * - INTAKE_BRAIN_PATH — { brain_path, llm_structured_used, extraction_source } (also in `event_log`)
 * - INTAKE_LLM_SKIPPED — { reason } when LLM not called
 * - INTAKE_LLM_REQUEST / INTAKE_LLM_RESPONSE — OpenAI structured extract
 * - INTAKE_PACKAGE_RESOLVED — { extraction_source, llm_structured_used }
 * - SCHEDULE_PARSED — natural-language window parse
 * - SCHEDULE_POLICY_CHECK — inputs + policy_snapshot before validateSchedPolicy_
 * - SCHEDULE_POLICY_OK | SCHEDULE_POLICY_REJECT | SCHEDULE_POLICY_ERROR
 *
 * **Breadcrumbs / latency:** pass `trace_start_ms` (Date.now() at request entry). Each line then
 * includes top-level `elapsed_ms` since that moment — filter by `trace_id`, sort by `elapsed_ms`
 * to see processing order and speed.
 *
 * **Inbound identity (`ctx`):** when the Telegram handler runs inside `runWithInboundLogCtx`
 * (`inboundLogContext.js`), every line gets top-level `ctx`: `actor_key`, `chat_id`, `update_id`,
 * `inbound_text_preview`, etc. Filter concurrent traffic: `jq 'select(.ctx.actor_key=="TG:…")'`.
 */
const SERVICE = "propera-v2";
const { getInboundLogCtx } = require("./inboundLogContext");

function emit(payload) {
  if (process.env.STRUCTURED_LOG === "0") return;

  const t0 = payload.trace_start_ms;
  const line = {
    ts: new Date().toISOString(),
    service: SERVICE,
    level: payload.level || "info",
    trace_id: payload.trace_id || null,
    log_kind: payload.log_kind || "log",
    event: payload.event || "",
  };

  if (t0 != null && isFinite(Number(t0))) {
    line.elapsed_ms = Date.now() - Number(t0);
  }

  const fromAls = getInboundLogCtx();
  if (fromAls && typeof fromAls === "object") {
    line.ctx = { ...fromAls, ...(payload.ctx && typeof payload.ctx === "object" ? payload.ctx : {}) };
  } else if (payload.ctx && typeof payload.ctx === "object") {
    line.ctx = payload.ctx;
  }

  if (payload.data !== undefined && payload.data !== null) {
    line.data = payload.data;
  }

  console.log(JSON.stringify(line));
}

/**
 * Same as `emit`, but attaches request timing when `traceStartMs` is a finite number
 * (from `req.traceStartMs` / `Date.now()` at HTTP middleware entry).
 */
function emitTimed(traceStartMs, payload) {
  const t0 =
    traceStartMs != null && isFinite(Number(traceStartMs))
      ? Number(traceStartMs)
      : undefined;
  emit({
    ...payload,
    ...(t0 !== undefined ? { trace_start_ms: t0 } : {}),
  });
}

/**
 * Boot / non-request logs (no trace yet).
 */
function boot(event, data) {
  emit({
    level: "info",
    trace_id: null,
    log_kind: "boot",
    event,
    data: data || {},
  });
}

module.exports = { emit, emitTimed, boot, SERVICE };
