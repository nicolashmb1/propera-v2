/**
 * CRUD for `tenant_conversations` — adapter-owned state.
 */
const { getSupabase } = require("../../db/supabase");
const { tenantAgentMaxTurns } = require("../../config/env");

const MAX_MESSAGE_HISTORY = 20;

/**
 * @param {object} row
 * @returns {object}
 */
function normalizeRow(row) {
  if (!row) return null;
  const partial =
    row.partial_package && typeof row.partial_package === "object"
      ? row.partial_package
      : {};
  if (partial._awaiting && partial._awaiting.expires_at) {
    try {
      if (new Date(partial._awaiting.expires_at) < new Date()) {
        const p2 = { ...partial };
        delete p2._awaiting;
        return {
          ...row,
          partial_package: p2,
          messages: Array.isArray(row.messages) ? row.messages : [],
        };
      }
    } catch (_) {
      const p2 = { ...partial };
      delete p2._awaiting;
      return {
        ...row,
        partial_package: p2,
        messages: Array.isArray(row.messages) ? row.messages : [],
      };
    }
  }
  return {
    ...row,
    partial_package: partial,
    messages: Array.isArray(row.messages) ? row.messages : [],
  };
}

/**
 * @param {string} tenantActorKey
 * @param {string} transportChannel
 * @returns {Promise<object | null>}
 */
async function loadTenantConversation(tenantActorKey, transportChannel) {
  const sb = getSupabase();
  if (!sb) return null;
  const actor = String(tenantActorKey || "").trim();
  const channel = String(transportChannel || "sms").toLowerCase();
  if (!actor) return null;

  const { data, error } = await sb
    .from("tenant_conversations")
    .select("*")
    .eq("tenant_actor_key", actor)
    .eq("transport_channel", channel)
    .maybeSingle();

  if (error || !data) return null;
  return normalizeRow(data);
}

/**
 * @param {object} row
 * @returns {Promise<object | null>}
 */
async function saveTenantConversation(row) {
  const sb = getSupabase();
  if (!sb) return null;

  const actor = String(row.tenant_actor_key || "").trim();
  const channel = String(row.transport_channel || "sms").toLowerCase();
  if (!actor) return null;

  const now = new Date().toISOString();
  const patch = {
    ...row,
    tenant_actor_key: actor,
    transport_channel: channel,
    updated_at: now,
    max_turns: row.max_turns != null ? row.max_turns : tenantAgentMaxTurns(),
  };

  const existing = await loadTenantConversation(actor, channel);
  if (existing && existing.id) {
    await sb.from("tenant_conversations").update(patch).eq("id", existing.id);
    return loadTenantConversation(actor, channel);
  }

  const insertRow = {
    status: "gathering",
    partial_package: {},
    messages: [],
    turn_count: 0,
    tenant_locale: "en",
    ...patch,
    created_at: patch.created_at || now,
  };

  const ins = await sb.from("tenant_conversations").insert(insertRow).select("id").single();
  if (ins.error || !ins.data || !ins.data.id) return null;
  return loadTenantConversation(actor, channel);
}

/**
 * @param {object} conv
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @returns {object[]}
 */
function appendMessage(conv, role, content) {
  const prev = Array.isArray(conv.messages) ? conv.messages : [];
  const next = [
    ...prev,
    {
      role: role === "assistant" ? "assistant" : "user",
      content: String(content || "").trim(),
      at: new Date().toISOString(),
    },
  ];
  return next.slice(-MAX_MESSAGE_HISTORY);
}

module.exports = {
  loadTenantConversation,
  saveTenantConversation,
  appendMessage,
  normalizeRow,
};
