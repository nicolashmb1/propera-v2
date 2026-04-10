/**
 * Flight-recorder trace — each step emits one structured JSON line (stdout).
 * Optional in-memory buffer for summary(); DB persistence via event_log later.
 */
const { randomUUID } = require("crypto");
const { emit } = require("../logging/structuredLog");

function createTrace(overrides) {
  const traceId = (overrides && overrides.traceId) || randomUUID();
  const t0 = Date.now();
  const steps = [];

  function push(kind, payload) {
    const entry = { t: Date.now() - t0, kind, ...payload };
    steps.push(entry);

    emit({
      level: kind === "error" ? "error" : "info",
      trace_id: traceId,
      log_kind: "trace_" + kind,
      event: payload.phase || payload.label || kind,
      data: {
        ms_from_start: Date.now() - t0,
        ...payload,
      },
    });
  }

  return {
    traceId,
    step(phase, data) {
      push("step", { phase, data });
    },
    snap(label, stateObj) {
      push("snap", { label, state: stateObj });
    },
    decision(phase, decided, reason, context) {
      push("decision", { phase, decided, reason, context });
    },
    error(phase, err, context) {
      const message = err && err.message ? err.message : String(err);
      push("error", { phase, message, context });
    },
    perf(phase) {
      push("perf", { phase, ms: Date.now() - t0 });
    },
    summary() {
      return { traceId, totalMs: Date.now() - t0, stepCount: steps.length, steps };
    },
  };
}

module.exports = { createTrace };
