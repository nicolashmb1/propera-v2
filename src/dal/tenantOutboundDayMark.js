/**
 * First tenant outbound per ops day — drives property header + SMS compliance footer (Outgate Phase 4).
 */
const { getSupabase } = require("../db/supabase");
const { properaTimezone } = require("../config/env");

/**
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD in PROPERA_TZ
 */
function opsDateKeyInProperaTz(now) {
  const d = now instanceof Date ? now : new Date();
  const tz = properaTimezone();
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch (_) {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * @param {string} tenantActorKey
 * @returns {Promise<boolean>}
 */
async function isFirstTenantOutboundToday(tenantActorKey) {
  const key = String(tenantActorKey || "").trim();
  if (!key) return false;
  const sb = getSupabase();
  if (!sb) return false;

  const opsDate = opsDateKeyInProperaTz();
  const { data, error } = await sb
    .from("tenant_outbound_day_mark")
    .select("ops_date")
    .eq("tenant_actor_key", key)
    .maybeSingle();

  if (error || !data) return true;
  return String(data.ops_date || "") !== opsDate;
}

/**
 * @param {string} tenantActorKey
 * @returns {Promise<void>}
 */
async function markTenantOutboundToday(tenantActorKey) {
  const key = String(tenantActorKey || "").trim();
  if (!key) return;
  const sb = getSupabase();
  if (!sb) return;

  const opsDate = opsDateKeyInProperaTz();
  await sb.from("tenant_outbound_day_mark").upsert(
    {
      tenant_actor_key: key,
      ops_date: opsDate,
      first_outbound_at: new Date().toISOString(),
    },
    { onConflict: "tenant_actor_key" }
  );
}

module.exports = {
  opsDateKeyInProperaTz,
  isFirstTenantOutboundToday,
  markTenantOutboundToday,
};
