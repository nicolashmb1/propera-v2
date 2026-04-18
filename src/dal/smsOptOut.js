/**
 * GAS `setSmsOptOut_` / `isSmsOptedOut_` parity — `16_ROUTER_ENGINE.gs` ~385–404.
 */
const { getSupabase } = require("../db/supabase");

/**
 * @param {string} actorKey — RouterParameter.From (E.164 or TG:…)
 * @param {boolean} optedOut
 */
async function setSmsOptOut(actorKey, optedOut) {
  const key = String(actorKey || "").trim();
  if (!key) return { ok: false };
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const { error } = await sb.from("sms_opt_out").upsert(
    {
      actor_key: key,
      opted_out: !!optedOut,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "actor_key" }
  );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * @param {string} actorKey
 * @returns {Promise<boolean>}
 */
async function isSmsOptedOut(actorKey) {
  const key = String(actorKey || "").trim();
  if (!key) return false;
  const sb = getSupabase();
  if (!sb) return false;

  const { data, error } = await sb
    .from("sms_opt_out")
    .select("opted_out")
    .eq("actor_key", key)
    .maybeSingle();

  if (error || !data) return false;
  return !!data.opted_out;
}

module.exports = { setSmsOptOut, isSmsOptedOut };
