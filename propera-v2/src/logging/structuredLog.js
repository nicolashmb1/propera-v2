/**
 * Structured logs — one JSON object per line on stdout.
 * Easy to grep, pipe to jq, and paste into Cursor / LLMs for debugging.
 *
 * Every line has: ts, service, level, trace_id, log_kind, event, data (optional).
 */
const SERVICE = "propera-v2";

function emit(payload) {
  if (process.env.STRUCTURED_LOG === "0") return;

  const line = {
    ts: new Date().toISOString(),
    service: SERVICE,
    level: payload.level || "info",
    trace_id: payload.trace_id || null,
    log_kind: payload.log_kind || "log",
    event: payload.event || "",
  };

  if (payload.data !== undefined && payload.data !== null) {
    line.data = payload.data;
  }

  console.log(JSON.stringify(line));
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

module.exports = { emit, boot, SERVICE };
