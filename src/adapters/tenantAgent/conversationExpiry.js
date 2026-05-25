/**
 * Lazy TTL for tenant_conversations — adapter working memory only (see TENANT_AGENT_ADAPTER.md).
 * Tickets + event_log are not deleted.
 */
const { appendEventLog } = require("../../dal/appendEventLog");
const { getSupabase } = require("../../db/supabase");
const { tenantAgentConversationTtlHours } = require("../../config/env");

/**
 * @param {object | null | undefined} row
 * @param {number} [ttlHours]
 * @returns {boolean}
 */
function tenantConversationIsExpired(row, ttlHours) {
  const ttl = ttlHours != null ? ttlHours : tenantAgentConversationTtlHours();
  if (!ttl || ttl <= 0 || !row) return false;
  const updatedAt = String(row.updated_at || "").trim();
  if (!updatedAt) return false;
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return false;
  return Date.now() - updatedMs > ttl * 60 * 60 * 1000;
}

/**
 * @param {object} partial
 * @returns {object}
 */
function partialPackageSummary(partial) {
  const p = partial && typeof partial === "object" ? partial : {};
  return {
    property: String(p.property || "").trim() || undefined,
    unit: String(p.unit || "").trim() || undefined,
    issue: String(p.issue || "").trim() || undefined,
    location_kind: String(p.location_kind || "").trim() || undefined,
  };
}

/**
 * Log expiry, delete row. Returns true when deleted.
 * @param {object} o
 * @param {object} o.row — tenant_conversations row
 * @param {string} [o.traceId]
 * @returns {Promise<boolean>}
 */
async function expireTenantConversationRow(o) {
  const row = o && o.row;
  if (!row || !row.id) return false;

  const ttl = tenantAgentConversationTtlHours();
  const partial = row.partial_package || {};
  const messages = Array.isArray(row.messages) ? row.messages : [];

  await appendEventLog({
    traceId: String(o.traceId || "").trim(),
    log_kind: "router",
    event: "TENANT_AGENT_CONVERSATION_EXPIRED",
    payload: {
      conversation_id: String(row.id),
      tenant_actor_key: String(row.tenant_actor_key || "").trim(),
      transport_channel: String(row.transport_channel || "").trim(),
      status: String(row.status || "").trim(),
      turn_count: Number(row.turn_count || 0),
      active_ticket_key: String(row.active_ticket_key || "").trim() || null,
      handoff_at: row.handoff_at || null,
      partial_summary: partialPackageSummary(partial),
      message_count: messages.length,
      updated_at: row.updated_at || null,
      ttl_hours: ttl,
    },
  });

  const sb = getSupabase();
  if (!sb) return false;

  const { error } = await sb.from("tenant_conversations").delete().eq("id", row.id);
  return !error;
}

module.exports = {
  tenantConversationIsExpired,
  expireTenantConversationRow,
  partialPackageSummary,
};
