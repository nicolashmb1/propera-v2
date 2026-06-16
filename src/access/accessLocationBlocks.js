/**
 * Per-location tenant reservation block list.
 */

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} locationId
 */
async function getLocationPropertyCode(sb, locationId) {
  const { data } = await sb
    .from("access_locations")
    .select("property_code")
    .eq("id", String(locationId || "").trim())
    .maybeSingle();
  return String(data?.property_code || "").trim().toUpperCase();
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} locationId
 * @param {string} tenantId
 */
async function isTenantBlockedFromLocation(sb, locationId, tenantId) {
  const locId = String(locationId || "").trim();
  const tid = String(tenantId || "").trim();
  if (!sb || !locId || !tid) return false;

  const { data } = await sb
    .from("access_location_tenant_blocks")
    .select("id")
    .eq("location_id", locId)
    .eq("tenant_id", tid)
    .maybeSingle();
  return !!data?.id;
}

/**
 * @param {string} locationId
 */
async function listBlockedTenantsForLocation(locationId) {
  const { getSupabase } = require("../db/supabase");
  const sb = getSupabase();
  const locId = String(locationId || "").trim();
  if (!sb || !locId) return [];

  const { data, error } = await sb
    .from("access_location_tenant_blocks")
    .select(
      "id, location_id, tenant_id, blocked_by, notes, created_at, tenant_roster:tenant_id (resident_name, unit_label, phone_e164, property_code)"
    )
    .eq("location_id", locId)
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  return data.map((row) => {
    const t = row.tenant_roster || {};
    return {
      id: String(row.id),
      locationId: String(row.location_id),
      tenantId: String(row.tenant_id),
      tenantName: String(t.resident_name || "").trim(),
      unitLabel: String(t.unit_label || "").trim(),
      phoneE164: String(t.phone_e164 || "").trim(),
      propertyCode: String(t.property_code || "").trim().toUpperCase(),
      blockedBy: String(row.blocked_by || "").trim(),
      notes: String(row.notes || "").trim(),
      createdAt: row.created_at,
    };
  });
}

/**
 * @param {string} locationId
 * @param {string} tenantId
 * @param {string} [actor]
 * @param {string} [notes]
 */
async function blockTenantFromLocation(locationId, tenantId, actor = "", notes = "") {
  const { getSupabase } = require("../db/supabase");
  const sb = getSupabase();
  const locId = String(locationId || "").trim();
  const tid = String(tenantId || "").trim();
  if (!sb || !locId || !tid) {
    const err = new Error("missing_fields");
    err.code = "missing_fields";
    throw err;
  }

  const locProp = await getLocationPropertyCode(sb, locId);
  if (!locProp) {
    const err = new Error("not_found");
    err.code = "not_found";
    throw err;
  }

  const { data: tenant } = await sb
    .from("tenant_roster")
    .select("id, property_code")
    .eq("id", tid)
    .maybeSingle();
  if (!tenant) {
    const err = new Error("tenant_not_found");
    err.code = "tenant_not_found";
    throw err;
  }
  const tenantProp = String(tenant.property_code || "").trim().toUpperCase();
  if (tenantProp && tenantProp !== locProp) {
    const err = new Error("tenant_property_mismatch");
    err.code = "tenant_property_mismatch";
    throw err;
  }

  const { data, error } = await sb
    .from("access_location_tenant_blocks")
    .upsert(
      {
        location_id: locId,
        tenant_id: tid,
        blocked_by: String(actor || "").trim(),
        notes: String(notes || "").trim().slice(0, 500),
      },
      { onConflict: "location_id,tenant_id" }
    )
    .select("id")
    .maybeSingle();

  if (error) throw new Error(error.message || "block_failed");
  return { ok: true, blockId: String(data?.id || "") };
}

/**
 * @param {string} locationId
 * @param {string} tenantId
 */
async function unblockTenantFromLocation(locationId, tenantId) {
  const { getSupabase } = require("../db/supabase");
  const sb = getSupabase();
  const locId = String(locationId || "").trim();
  const tid = String(tenantId || "").trim();
  if (!sb || !locId || !tid) {
    const err = new Error("missing_fields");
    err.code = "missing_fields";
    throw err;
  }

  const { error } = await sb
    .from("access_location_tenant_blocks")
    .delete()
    .eq("location_id", locId)
    .eq("tenant_id", tid);

  if (error) throw new Error(error.message || "unblock_failed");
  return { ok: true };
}

module.exports = {
  isTenantBlockedFromLocation,
  listBlockedTenantsForLocation,
  blockTenantFromLocation,
  unblockTenantFromLocation,
};
