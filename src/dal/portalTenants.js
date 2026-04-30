/**
 * Tenant roster CRUD for portal PM (`propera-app`) — Supabase `tenant_roster` only.
 * Staff #capture reads via `tenantRoster.js`; keep phone_e164 normalized.
 */
const { getSupabase } = require("../db/supabase");
const { normalizePhoneE164 } = require("../utils/phone");
const { normalizeUnit_ } = require("../brain/shared/extractUnitGas");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} label — property display name, short name, or code
 * @returns {Promise<string>} uppercase property code or ""
 */
async function resolvePropertyCodeFromLabel(sb, label) {
  const s = String(label || "").trim();
  if (!s || !sb) return "";
  const { data, error } = await sb
    .from("properties")
    .select("code, display_name, short_name")
    .eq("active", true);
  if (error || !data || !data.length) return "";
  const upper = s.toUpperCase();
  for (const p of data) {
    const code = String(p.code || "").trim().toUpperCase();
    if (code === upper) return code;
  }
  for (const p of data) {
    const dn = String(p.display_name || "").trim();
    if (dn && dn === s) return String(p.code || "").trim().toUpperCase();
  }
  for (const p of data) {
    const sn = String(p.short_name || "").trim();
    if (sn && sn === s) return String(p.code || "").trim().toUpperCase();
  }
  return "";
}

function mapRowToPortalShape(row, codeToDisplayName) {
  const code = String(row.property_code || "").trim().toUpperCase();
  const display =
    codeToDisplayName[code] ||
    String(row.property_code || "").trim();
  return {
    id: row.id,
    property: display,
    propertyCode: code,
    unit: String(row.unit_label || "").trim(),
    phone: String(row.phone_e164 || "").trim(),
    name: String(row.resident_name || "").trim(),
    email: String(row.email || "").trim(),
    active: row.active !== false,
    notes: String(row.notes || "").trim(),
    source: "v2",
  };
}

/**
 * @returns {Promise<object[]>}
 */
async function listTenantsForPortal() {
  const sb = getSupabase();
  if (!sb) return [];

  const { data: props } = await sb
    .from("properties")
    .select("code, display_name");
  const codeToDisplayName = {};
  for (const p of props || []) {
    const c = String(p.code || "").trim().toUpperCase();
    if (!c) continue;
    codeToDisplayName[c] =
      String(p.display_name || p.code || "").trim() || c;
  }

  const { data: rows, error } = await sb
    .from("tenant_roster")
    .select(
      "id, property_code, unit_label, phone_e164, resident_name, email, active, notes, updated_at"
    )
    .order("property_code", { ascending: true })
    .order("unit_label", { ascending: true });

  if (error || !rows) return [];

  return rows.map((r) => mapRowToPortalShape(r, codeToDisplayName));
}

/**
 * @param {object} input
 * @returns {Promise<{ ok: boolean, tenant?: object, error?: string }>}
 */
async function createTenantForPortal(input) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const propertyCode = await resolvePropertyCodeFromLabel(
    sb,
    input.property ?? input.propertyCode ?? ""
  );
  if (!propertyCode) {
    return { ok: false, error: "unknown_property" };
  }

  const unitLabel = normalizeUnit_(String(input.unit ?? input.unit_label ?? ""));
  const phoneRaw = normalizePhoneE164(String(input.phone ?? input.phone_e164 ?? ""));
  if (!phoneRaw || phoneRaw.length < 8) {
    return { ok: false, error: "invalid_phone" };
  }

  const residentName = String(input.name ?? input.resident_name ?? "").trim();
  const email = String(input.email ?? "").trim();
  const notes = String(input.notes ?? "").trim();
  const active = input.active !== false;

  const { data: props } = await sb
    .from("properties")
    .select("code, display_name");
  const codeToDisplayName = {};
  for (const p of props || []) {
    const c = String(p.code || "").trim().toUpperCase();
    if (c)
      codeToDisplayName[c] =
        String(p.display_name || p.code || "").trim() || c;
  }

  const { data: insertedRows, error } = await sb
    .from("tenant_roster")
    .insert({
      property_code: propertyCode,
      unit_label: unitLabel,
      phone_e164: phoneRaw,
      resident_name: residentName,
      email,
      notes,
      active,
    })
    .select(
      "id, property_code, unit_label, phone_e164, resident_name, email, active, notes"
    );

  if (error) {
    return { ok: false, error: error.message || "insert_failed" };
  }
  const inserted = insertedRows && insertedRows[0];
  if (!inserted) return { ok: false, error: "insert_failed" };

  return {
    ok: true,
    tenant: mapRowToPortalShape(inserted, codeToDisplayName),
  };
}

/**
 * @param {string} id — uuid
 * @param {object} patch
 * @returns {Promise<{ ok: boolean, tenant?: object, error?: string }>}
 */
async function updateTenantForPortal(id, patch) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const rid = String(id || "").trim();
  if (!rid) return { ok: false, error: "missing_id" };

  const updates = {};
  if (patch.property != null || patch.propertyCode != null) {
    const pc = await resolvePropertyCodeFromLabel(
      sb,
      patch.property ?? patch.propertyCode ?? ""
    );
    if (!pc) return { ok: false, error: "unknown_property" };
    updates.property_code = pc;
  }
  if (patch.unit != null || patch.unit_label != null) {
    updates.unit_label = normalizeUnit_(String(patch.unit ?? patch.unit_label ?? ""));
  }
  if (patch.phone != null || patch.phone_e164 != null) {
    const ph = normalizePhoneE164(String(patch.phone ?? patch.phone_e164 ?? ""));
    if (!ph || ph.length < 8) return { ok: false, error: "invalid_phone" };
    updates.phone_e164 = ph;
  }
  if (patch.name != null || patch.resident_name != null) {
    updates.resident_name = String(patch.name ?? patch.resident_name ?? "").trim();
  }
  if (patch.email != null) {
    updates.email = String(patch.email ?? "").trim();
  }
  if (patch.notes != null) {
    updates.notes = String(patch.notes ?? "").trim();
  }
  if (patch.active != null) {
    updates.active = !!patch.active;
  }

  if (!Object.keys(updates).length) {
    return { ok: false, error: "no_updates" };
  }

  updates.updated_at = new Date().toISOString();

  const { data: props } = await sb
    .from("properties")
    .select("code, display_name");
  const codeToDisplayName = {};
  for (const p of props || []) {
    const c = String(p.code || "").trim().toUpperCase();
    if (c)
      codeToDisplayName[c] =
        String(p.display_name || p.code || "").trim() || c;
  }

  const { data: row, error } = await sb
    .from("tenant_roster")
    .update(updates)
    .eq("id", rid)
    .select(
      "id, property_code, unit_label, phone_e164, resident_name, email, active, notes"
    )
    .maybeSingle();

  if (error) {
    return { ok: false, error: error.message || "update_failed" };
  }
  if (!row) return { ok: false, error: "not_found" };

  return { ok: true, tenant: mapRowToPortalShape(row, codeToDisplayName) };
}

/**
 * @param {string} id
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function deactivateTenantForPortal(id) {
  return updateTenantForPortal(id, { active: false });
}

module.exports = {
  listTenantsForPortal,
  createTenantForPortal,
  updateTenantForPortal,
  deactivateTenantForPortal,
  resolvePropertyCodeFromLabel,
};
