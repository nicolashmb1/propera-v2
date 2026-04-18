/**
 * conversation_ctx.pending_expected — attach vs new-ticket clarify parity slice.
 */
const { getSupabase } = require("../db/supabase");

/**
 * @param {string} phoneE164
 * @returns {Promise<{ pending_expected?: string, last_intent?: string } | null>}
 */
async function getConversationCtxAttach(phoneE164) {
  const sb = getSupabase();
  if (!sb) return null;
  const phone = String(phoneE164 || "").trim();
  if (!phone) return null;
  const { data, error } = await sb
    .from("conversation_ctx")
    .select("pending_expected, last_intent")
    .eq("phone_e164", phone)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * GAS `ctxUpsert_` resolution clear — `16_ROUTER_ENGINE.gs` ~526–527.
 * @param {string} phoneE164
 */
async function clearAttachClarifyLatch(phoneE164) {
  const sb = getSupabase();
  if (!sb) return { ok: false };
  const phone = String(phoneE164 || "").trim();
  if (!phone) return { ok: false };
  const now = new Date().toISOString();
  const { error } = await sb.from("conversation_ctx").upsert(
    {
      phone_e164: phone,
      pending_expected: "",
      last_intent: "ATTACH_CLARIFY_RESOLVED",
      updated_at: now,
    },
    { onConflict: "phone_e164" }
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * @param {string} phoneE164
 */
async function setPendingAttachClarify(phoneE164) {
  const sb = getSupabase();
  if (!sb) return { ok: false };
  const phone = String(phoneE164 || "").trim();
  if (!phone) return { ok: false };

  const now = new Date().toISOString();
  const { error } = await sb.from("conversation_ctx").upsert(
    {
      phone_e164: phone,
      pending_expected: "ATTACH_CLARIFY",
      last_intent: "ATTACH_CLARIFY_PROMPT_SENT",
      updated_at: now,
    },
    { onConflict: "phone_e164" }
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = {
  setPendingAttachClarify,
  getConversationCtxAttach,
  clearAttachClarifyLatch,
};
