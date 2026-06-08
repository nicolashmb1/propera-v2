/**
 * Tenant portal — amenity reservations scoped to roster property_code.
 * @see docs/ACCESS_ENGINE_BUILD_PLAN.md
 */
const { getSupabase } = require("../db/supabase");
const { accessEngineEnabled } = require("../config/env");
const { canReserve } = require("../access/canReserve");
const { getActivePolicy } = require("../access/getActivePolicy");
const {
  listAccessLocationsForPortal,
  getAccessLocationById,
  createReservationForPortal,
  getReservationDetail,
  cancelReservation,
  listReservationsForLocation,
  listSchedulesForLocation,
} = require("../dal/accessEngine");

function tenantPropertyCode(tenantCtx) {
  return String(tenantCtx?.propertyCode || "").trim().toUpperCase();
}

function mapTenantLocation(loc, policy) {
  return {
    id: loc.id,
    slug: loc.slug,
    name: loc.name,
    description: loc.description,
    minDurationMin: policy?.min_duration_min ?? 30,
    maxDurationMin: policy?.max_duration_min ?? 120,
    requiresApproval: !!policy?.requires_approval,
    depositAmount: Number(policy?.deposit_amount) || 0,
  };
}

function mapTenantReservation(row, location) {
  const status = String(row.status || "");
  const out = {
    id: row.id,
    locationId: row.location_id,
    locationName: location?.name || "",
    locationSlug: location?.slug || "",
    startAt: row.start_at,
    endAt: row.end_at,
    status,
    channel: row.channel,
    depositAmount: Number(row.deposit_amount) || 0,
    createdAt: row.created_at,
  };
  return out;
}

/**
 * Active access locations for the tenant's building only.
 * @param {{ tenantId: string, propertyCode: string }} tenantCtx
 */
async function listTenantAccessLocations(tenantCtx) {
  if (!accessEngineEnabled()) return [];
  const code = tenantPropertyCode(tenantCtx);
  if (!code) return [];

  const locations = await listAccessLocationsForPortal({ propertyCode: code, activeOnly: true });
  const active = locations.filter((l) => !l.staffOnly);
  const sb = getSupabase();
  const out = [];
  for (const loc of active) {
    const policy = sb ? await getActivePolicy(sb, loc.id) : null;
    if (!policy) continue;
    out.push(mapTenantLocation(
      { ...loc, description: loc.description },
      policy
    ));
  }
  return out;
}

/**
 * Whether the tenant portal should show amenity reservation UI for this building.
 * True when at least one active access location has a bookable policy (same as
 * locations returned by {@link listTenantAccessLocations}).
 * @param {{ propertyCode: string }} tenantCtx
 */
async function tenantAmenitiesVisible(tenantCtx) {
  if (!accessEngineEnabled()) return false;
  const locations = await listTenantAccessLocations(tenantCtx);
  return locations.length > 0;
}

/**
 * @param {{ propertyCode: string }} tenantCtx
 * @param {string} slug
 */
/**
 * Public preview for QR deep link (org + property + slug).
 * @param {string} orgId
 * @param {string} propertyCode
 * @param {string} slug
 */
async function getPublicAccessLocation(orgId, propertyCode, slug) {
  if (!accessEngineEnabled()) return null;
  const sb = getSupabase();
  const org = String(orgId || "").trim();
  const pc = String(propertyCode || "").trim().toUpperCase();
  const s = String(slug || "").trim().toLowerCase();
  if (!sb || !org || !pc || !s) return null;

  const { data } = await sb
    .from("access_locations")
    .select("*")
    .eq("org_id", org)
    .eq("property_code", pc)
    .eq("slug", s)
    .eq("active", true)
    .maybeSingle();
  if (!data || data.staff_only) return null;

  const policy = await getActivePolicy(sb, data.id);
  if (!policy) return null;

  return mapTenantLocation(
    {
      id: data.id,
      slug: data.slug,
      name: data.name,
      description: data.description,
      propertyCode: data.property_code,
    },
    policy
  );
}

async function getTenantAccessLocationBySlug(tenantCtx, slug) {
  if (!accessEngineEnabled()) return null;
  const code = tenantPropertyCode(tenantCtx);
  const s = String(slug || "").trim().toLowerCase();
  if (!code || !s) return null;

  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb
    .from("access_locations")
    .select("*")
    .eq("property_code", code)
    .eq("slug", s)
    .eq("active", true)
    .maybeSingle();
  if (!data || data.staff_only) return null;

  const loc = {
    id: data.id,
    orgId: data.org_id,
    propertyCode: data.property_code,
    slug: data.slug,
    name: data.name,
    description: data.description,
    active: !!data.active,
  };
  const policy = await getActivePolicy(sb, loc.id);
  if (!policy) return null;
  return mapTenantLocation(loc, policy);
}

/**
 * @param {{ tenantId: string, propertyCode: string }} tenantCtx
 */
async function listTenantAccessReservations(tenantCtx) {
  if (!accessEngineEnabled()) return [];
  const sb = getSupabase();
  const tenantId = String(tenantCtx?.tenantId || "").trim();
  const code = tenantPropertyCode(tenantCtx);
  if (!sb || !tenantId || !code) return [];

  const { data, error } = await sb
    .from("access_reservations")
    .select("*, access_locations:location_id (name, slug, property_code)")
    .eq("tenant_id", tenantId)
    .order("start_at", { ascending: false })
    .limit(50);

  if (error || !data) return [];

  return data
    .filter((r) => String(r.access_locations?.property_code || "").toUpperCase() === code)
    .map((r) =>
      mapTenantReservation(r, {
        name: r.access_locations?.name,
        slug: r.access_locations?.slug,
      })
    );
}

/**
 * @param {{ tenantId: string, propertyCode: string }} tenantCtx
 * @param {string} reservationId
 */
async function getTenantAccessReservation(tenantCtx, reservationId) {
  const detail = await getReservationDetail(reservationId);
  if (!detail) return null;
  if (String(detail.tenantId) !== String(tenantCtx.tenantId)) return null;

  const loc = await getAccessLocationById(detail.locationId);
  if (!loc || loc.propertyCode !== tenantPropertyCode(tenantCtx)) return null;

  return {
    ...mapTenantReservation(
      {
        id: detail.id,
        location_id: detail.locationId,
        start_at: detail.startAt,
        end_at: detail.endAt,
        status: detail.status,
        channel: detail.channel,
        deposit_amount: detail.depositAmount,
        created_at: detail.createdAt,
      },
      { name: loc.name, slug: loc.slug }
    ),
    pin: detail.pin || null,
    pinMasked: detail.pinMasked || null,
  };
}

/**
 * @param {{ tenantId: string, propertyCode: string }} tenantCtx
 * @param {string} locationId
 * @param {string} startAt
 * @param {string} endAt
 */
async function checkTenantCanReserve(tenantCtx, locationId, startAt, endAt) {
  const loc = await getAccessLocationById(locationId);
  if (!loc || loc.propertyCode !== tenantPropertyCode(tenantCtx) || loc.staffOnly) {
    return { allowed: false, reason: loc?.staffOnly ? "staff_only_location" : "location_not_found" };
  }
  return canReserve({
    locationId,
    tenantId: tenantCtx.tenantId,
    startAt,
    endAt,
    staffOverride: false,
  });
}

/**
 * @param {{ tenantId: string, propertyCode: string }} tenantCtx
 * @param {{ locationId: string, startAt: string, endAt: string }} body
 */
async function createTenantAccessReservation(tenantCtx, body) {
  const locationId = String(body.locationId || "").trim();
  const loc = await getAccessLocationById(locationId);
  if (!loc || loc.propertyCode !== tenantPropertyCode(tenantCtx)) {
    const err = new Error("location_not_found");
    err.code = "location_not_found";
    throw err;
  }

  const detail = await createReservationForPortal(
    {
      locationId,
      tenantId: tenantCtx.tenantId,
      startAt: body.startAt,
      endAt: body.endAt,
      channel:
        String(body.channel || "").trim() === "qr_portal"
          ? "qr_portal"
          : "tenant_portal",
    },
    `tenant:${tenantCtx.tenantId}`
  );

  const mapped = await getTenantAccessReservation(tenantCtx, detail.id);
  return mapped;
}

/**
 * @param {{ tenantId: string, propertyCode: string }} tenantCtx
 * @param {string} reservationId
 */
async function cancelTenantAccessReservation(tenantCtx, reservationId) {
  const existing = await getTenantAccessReservation(tenantCtx, reservationId);
  if (!existing) {
    const err = new Error("not_found");
    err.code = "not_found";
    throw err;
  }
  if (["CANCELLED", "COMPLETED", "NO_SHOW"].includes(existing.status)) {
    const err = new Error("invalid_status");
    err.code = "invalid_status";
    throw err;
  }
  await cancelReservation(reservationId, `tenant:${tenantCtx.tenantId}`);
  return getTenantAccessReservation(tenantCtx, reservationId);
}

/**
 * Day reservations for a location (tenant's property only) — for slot picker UI.
 * @param {string} locationId
 * @param {Date|string} day
 */
/**
 * Weekly operating hours for an amenity (tenant's property only).
 * @param {{ tenantId: string, propertyCode: string }} tenantCtx
 * @param {string} locationId
 */
async function listSchedulesForTenantLocation(tenantCtx, locationId) {
  const loc = await getAccessLocationById(locationId);
  if (!loc || loc.propertyCode !== tenantPropertyCode(tenantCtx)) return [];
  return listSchedulesForLocation(locationId);
}

async function listDayReservationsForTenantLocation(tenantCtx, locationId, day) {
  const loc = await getAccessLocationById(locationId);
  if (!loc || loc.propertyCode !== tenantPropertyCode(tenantCtx)) return [];

  const { propertyDayBoundsUtc } = require("../access/accessLocalTime");
  const { startUtc, endUtc } = propertyDayBoundsUtc(day);

  const rows = await listReservationsForLocation(
    locationId,
    startUtc instanceof Date ? startUtc.toISOString() : startUtc,
    endUtc instanceof Date ? endUtc.toISOString() : endUtc
  );
  return rows.map((r) => ({
    id: r.id,
    startAt: r.startAt,
    endAt: r.endAt,
    status: r.status,
  }));
}

module.exports = {
  tenantAmenitiesVisible,
  listTenantAccessLocations,
  getPublicAccessLocation,
  getTenantAccessLocationBySlug,
  listTenantAccessReservations,
  getTenantAccessReservation,
  checkTenantCanReserve,
  createTenantAccessReservation,
  cancelTenantAccessReservation,
  listDayReservationsForTenantLocation,
  listSchedulesForTenantLocation,
};
