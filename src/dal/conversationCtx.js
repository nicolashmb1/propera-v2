const { getSupabase } = require("../db/supabase");

/**
 * @param {string} phoneE164 — router actor key (E.164 or TG:…)
 */
async function getConversationCtx(phoneE164) {
  const key = String(phoneE164 || "").trim();
  if (!key) return null;
  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from("conversation_ctx")
    .select(
      "phone_e164, pending_work_item_id, active_work_item_id, lang, last_intent"
    )
    .eq("phone_e164", key)
    .maybeSingle();

  if (error) return null;
  return data || null;
}

module.exports = { getConversationCtx };
