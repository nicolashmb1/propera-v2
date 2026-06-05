const { getSupabase } = require("../db/supabase");
const { getActivePolicy } = require("./getActivePolicy");
const { evaluateCanReserve } = require("./reservationRules");
const { BLOCKING_RESERVATION_STATUSES } = require("./constants");
const { propertyTimezone } = require("./accessLocalTime");

/**
 * @param {object} params
 * @param {string} params.locationId
 * @param {string} [params.tenantId]
 * @param {Date|string} params.startAt
 * @param {Date|string} params.endAt
 * @param {string} [params.excludeReservationId]
 * @param {import("@supabase/supabase-js").SupabaseClient} [params.sb]
 * @param {Date} [params.now]
 */
async function canReserve(params) {
  const sb = params.sb || getSupabase();
  const locationId = String(params.locationId || "").trim();
  const startAt = new Date(params.startAt);
  const endAt = new Date(params.endAt);
  const now = params.now || new Date();

  if (!sb || !locationId || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    return { allowed: false, reason: "invalid_input" };
  }

  const tenantIdEarly = String(params.tenantId || "").trim();
  if (tenantIdEarly && !params.staffOverride) {
    const { data: locRow } = await sb
      .from("access_locations")
      .select("staff_only, active")
      .eq("id", locationId)
      .maybeSingle();
    if (!locRow?.active || locRow.staff_only) {
      return { allowed: false, reason: "staff_only_location" };
    }
  }

  const policy = await getActivePolicy(sb, locationId, startAt);
  if (!policy) return { allowed: false, reason: "no_policy" };

  const { data: overlapping } = await sb
    .from("access_reservations")
    .select("id, status, start_at, end_at")
    .eq("location_id", locationId)
    .in("status", [...BLOCKING_RESERVATION_STATUSES])
    .lt("start_at", endAt.toISOString())
    .gt("end_at", startAt.toISOString());

  let tenantReservations = [];
  const tenantId = String(params.tenantId || "").trim();
  if (tenantId) {
    const { data: tr } = await sb
      .from("access_reservations")
      .select("id, status, start_at, end_at")
      .eq("location_id", locationId)
      .eq("tenant_id", tenantId);
    tenantReservations = tr || [];
  }

  const excludeId = String(params.excludeReservationId || "").trim();
  const filterEx = (rows) =>
    (rows || []).filter((r) => !excludeId || String(r.id) !== excludeId);

  const { data: schedules } = await sb
    .from("access_schedules")
    .select("day_of_week, open_time, close_time")
    .eq("location_id", locationId);

  const { data: blackouts } = await sb
    .from("access_blackouts")
    .select("start_at, end_at")
    .eq("location_id", locationId)
    .lt("start_at", endAt.toISOString())
    .gt("end_at", startAt.toISOString());

  return evaluateCanReserve(
    policy,
    { tenantId, staffOverride: !!params.staffOverride },
    startAt,
    endAt,
    {
      overlapping: filterEx(overlapping),
      tenantReservations: filterEx(tenantReservations),
      schedules: schedules || [],
      blackouts: blackouts || [],
      propertyTimeZone: propertyTimezone(),
    },
    now
  );
}

module.exports = { canReserve };
