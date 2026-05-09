/**
 * Phase 5 — boundary logs for maintenance core (paired with `CORE_ENTER` in load context).
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const { emitTimed } = require("../../logging/structuredLog");

/**
 * @param {string} traceId
 * @param {number | null} traceStartMs
 * @param {object} result — core return shape (`brain` optional)
 */
async function emitMaintenanceCoreExit(traceId, traceStartMs, result) {
  const brain =
    result && typeof result === "object" && typeof result.brain === "string"
      ? result.brain
      : "";
  await appendEventLog({
    traceId,
    event: "CORE_EXIT",
    payload: { brain },
  });
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: "CORE_EXIT",
    data: { brain, crumb: "core_exit" },
  });
}

/**
 * @param {string} traceId
 * @param {number | null} traceStartMs
 * @param {unknown} err
 */
async function emitMaintenanceCoreError(traceId, traceStartMs, err) {
  const msg = err instanceof Error ? err.message : String(err);
  await appendEventLog({
    traceId,
    event: "CORE_ERROR",
    payload: { error: msg },
  });
  emitTimed(traceStartMs, {
    level: "error",
    trace_id: traceId,
    log_kind: "brain",
    event: "CORE_ERROR",
    data: { error: msg, crumb: "core_error" },
  });
}

module.exports = {
  emitMaintenanceCoreExit,
  emitMaintenanceCoreError,
};
