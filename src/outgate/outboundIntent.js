/**
 * Canonical outbound intent from brain/core (Phase 1 — single shape).
 * PARITY GAP: full facts/correlation coverage — see docs/PARITY_LEDGER.md §7 Outgate
 */

/**
 * @typedef {object} OutboundIntent
 * @property {string} intentType — semantic class (e.g. COMPLIANCE_STOP, CORE_MAINTENANCE_PROMPT)
 * @property {'tenant' | 'staff' | 'owner' | 'unknown'} [audience]
 * @property {string} replyText — deterministic body when no MessageSpec override (legacy brain path)
 * @property {Record<string, unknown>} [facts] — structured payload for future binder / soft validation
 * @property {Record<string, string>} [correlationIds] — ticket_key, work_item_id, etc.
 * @property {string} [traceId]
 */

/**
 * @param {object} o
 * @returns {OutboundIntent}
 */
function buildOutboundIntent(o) {
  const intentType = String(o.intentType || "INBOUND_REPLY").trim() || "INBOUND_REPLY";
  const audience = o.audience || "unknown";
  const replyText = o.replyText != null ? String(o.replyText) : "";
  const facts =
    o.facts && typeof o.facts === "object" && !Array.isArray(o.facts) ? o.facts : {};
  const correlationIds =
    o.correlationIds && typeof o.correlationIds === "object" ? o.correlationIds : {};
  const traceId = o.traceId != null ? String(o.traceId) : "";

  return {
    intentType,
    audience:
      audience === "tenant" ||
      audience === "staff" ||
      audience === "owner" ||
      audience === "unknown"
        ? audience
        : "unknown",
    replyText,
    facts,
    correlationIds,
    traceId,
  };
}

module.exports = { buildOutboundIntent };
