/**
 * conversation_ctx.pending_expected — GAS "waiting on SCHEDULE" parity.
 */
const { getSupabase } = require("../db/supabase");

/**
 * @param {string} phoneE164
 * @param {string} workItemId
 */
async function setPendingExpectedSchedule(phoneE164, workItemId) {
  const sb = getSupabase();
  if (!sb) return { ok: false };
  const phone = String(phoneE164 || "").trim();
  if (!phone) return { ok: false };
  const wi = String(workItemId || "").trim();

  const now = new Date().toISOString();
  const { error } = await sb.from("conversation_ctx").upsert(
    {
      phone_e164: phone,
      active_work_item_id: wi,
      pending_expected: "SCHEDULE",
      last_intent: "MAINT_INTAKE_FINALIZED",
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
async function clearPendingExpected(phoneE164) {
  const sb = getSupabase();
  if (!sb) return { ok: false };
  const phone = String(phoneE164 || "").trim();
  if (!phone) return { ok: false };

  const { error } = await sb
    .from("conversation_ctx")
    .update({ pending_expected: "", updated_at: new Date().toISOString() })
    .eq("phone_e164", phone);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = {
  setPendingExpectedSchedule,
  clearPendingExpected,
};
