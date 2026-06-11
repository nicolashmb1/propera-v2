/**
 * Org settings CRUD for portal MO-2 — reference/catalog only (not ticket lifecycle).
 * @see docs/MULTI_ORG_ARCHITECTURE.md
 */
const { normalizePhoneE164 } = require("../utils/phone");

function normOrg(orgId) {
  return String(orgId || "").trim().toLowerCase();
}

function canManageOrgSettings(portalRole) {
  const r = String(portalRole || "").trim().toLowerCase();
  if (!r || r === "read-only") return false;
  if (r === "staff" || r === "maintenance" || r === "field") return false;
  if (r.includes("staff") && !r.includes("ops")) return false;
  return r === "owner" || r === "ops" || r === "pm";
}

function staffIdSlugFromName(displayName) {
  const raw = String(displayName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!raw) return "";
  const core = raw.length > 40 ? raw.slice(0, 40) : raw;
  return `STAFF_${core}`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} orgId
 * @param {string} baseId
 */
async function resolveUniqueStaffId(sb, orgId, baseId) {
  const root = String(baseId || "").trim();
  if (!root) return { ok: false, error: "invalid_staff_id" };
  let candidate = root;
  for (let n = 0; n < 50; n += 1) {
    const { data: row, error } = await sb
      .from("staff")
      .select("staff_id")
      .eq("staff_id", candidate)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row) return { ok: true, staffId: candidate };
    candidate = `${root}_${n + 2}`;
  }
  return { ok: false, error: "staff_id_collision" };
}

function mapStaffRow(row, contact) {
  return {
    internalId: String(row.id || ""),
    staffId: String(row.staff_id || "").trim(),
    displayName: String(row.display_name || "").trim(),
    role: String(row.role || "").trim(),
    active: row.active !== false,
    phoneE164: contact ? String(contact.phone_e164 || "").trim() : "",
    orgId: String(row.org_id || "").trim(),
  };
}

async function getOrganizationForPortal(sb, orgId) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  if (!oid) return { ok: false, error: "missing_org_id" };

  const { data, error } = await sb
    .from("organizations")
    .select("id, brand_name, brand_short_name, show_propera_attribution, propera_subdomain, custom_domain, comm_sms_header_template, comm_sms_footer_template")
    .eq("id", oid)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "org_not_found", status: 404 };

  return {
    ok: true,
    organization: {
      orgId: String(data.id || "").trim(),
      brandName: String(data.brand_name || "").trim(),
      brandShortName: String(data.brand_short_name || "").trim(),
      showProperaAttribution: data.show_propera_attribution !== false,
      properaSubdomain: String(data.propera_subdomain || "").trim(),
      customDomain: String(data.custom_domain || "").trim(),
      commSmsHeaderTemplate: String(data.comm_sms_header_template || "").trim(),
      commSmsFooterTemplate: String(data.comm_sms_footer_template || "").trim(),
    },
  };
}

async function patchOrganizationForPortal(sb, orgId, patch) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  if (!oid) return { ok: false, error: "missing_org_id" };

  const updates = { updated_at: new Date().toISOString() };
  if (patch.brandName != null || patch.brand_name != null) {
    updates.brand_name = String(patch.brandName ?? patch.brand_name ?? "")
      .trim()
      .slice(0, 200);
  }
  if (patch.brandShortName != null || patch.brand_short_name != null) {
    updates.brand_short_name = String(patch.brandShortName ?? patch.brand_short_name ?? "")
      .trim()
      .slice(0, 80);
  }
  if (patch.showProperaAttribution != null || patch.show_propera_attribution != null) {
    const v = patch.showProperaAttribution ?? patch.show_propera_attribution;
    updates.show_propera_attribution = v === true || v === "1" || v === 1;
  }
  if (patch.commSmsHeaderTemplate != null || patch.comm_sms_header_template != null) {
    updates.comm_sms_header_template = String(
      patch.commSmsHeaderTemplate ?? patch.comm_sms_header_template ?? ""
    )
      .trim()
      .slice(0, 500);
  }
  if (patch.commSmsFooterTemplate != null || patch.comm_sms_footer_template != null) {
    updates.comm_sms_footer_template = String(
      patch.commSmsFooterTemplate ?? patch.comm_sms_footer_template ?? ""
    )
      .trim()
      .slice(0, 500);
  }

  if (Object.keys(updates).length <= 1) {
    return { ok: false, error: "no_changes", status: 400 };
  }

  const { data, error } = await sb
    .from("organizations")
    .update(updates)
    .eq("id", oid)
    .select("id, brand_name, brand_short_name, show_propera_attribution, propera_subdomain, custom_domain, comm_sms_header_template, comm_sms_footer_template")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "org_not_found", status: 404 };

  return getOrganizationForPortal(sb, oid);
}

async function listStaffForOrg(sb, orgId) {
  if (!sb) return { ok: false, error: "no_db", staff: [] };
  const oid = normOrg(orgId);
  const { data: rows, error } = await sb
    .from("staff")
    .select("id, staff_id, display_name, role, active, org_id, contact_id")
    .eq("org_id", oid)
    .order("display_name", { ascending: true });

  if (error) return { ok: false, error: error.message, staff: [] };

  const contactIds = (rows || []).map((r) => r.contact_id).filter(Boolean);
  const contactsById = {};
  if (contactIds.length) {
    const { data: contacts } = await sb
      .from("contacts")
      .select("id, phone_e164")
      .in("id", contactIds);
    for (const c of contacts || []) {
      contactsById[c.id] = c;
    }
  }

  const staff = (rows || []).map((r) => mapStaffRow(r, contactsById[r.contact_id]));
  return { ok: true, staff };
}

async function createStaffForPortal(sb, orgId, input) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  const displayName = String(input.displayName ?? input.display_name ?? "").trim().slice(0, 200);
  if (!displayName) return { ok: false, error: "missing_display_name", status: 400 };

  const phoneRaw = normalizePhoneE164(String(input.phone ?? input.phone_e164 ?? input.phoneE164 ?? ""));
  if (!phoneRaw || phoneRaw.length < 8) {
    return { ok: false, error: "invalid_phone", status: 400 };
  }

  const explicitId = String(input.staffId ?? input.staff_id ?? "").trim();
  let baseId = explicitId || staffIdSlugFromName(displayName);
  if (!baseId) return { ok: false, error: "invalid_staff_id", status: 400 };

  const unique = await resolveUniqueStaffId(sb, oid, baseId);
  if (!unique.ok) return { ok: false, error: unique.error, status: 400 };

  const role = String(input.role ?? "").trim().slice(0, 120);

  const { data: contactRows, error: cErr } = await sb
    .from("contacts")
    .upsert(
      { phone_e164: phoneRaw, display_name: displayName },
      { onConflict: "phone_e164" }
    )
    .select("id, phone_e164");

  if (cErr) return { ok: false, error: cErr.message, status: 500 };
  const contact = contactRows && contactRows[0];
  if (!contact) return { ok: false, error: "contact_upsert_failed", status: 500 };

  const { data: staffRows, error: sErr } = await sb
    .from("staff")
    .insert({
      contact_id: contact.id,
      staff_id: unique.staffId,
      display_name: displayName,
      role,
      active: true,
      org_id: oid,
    })
    .select("id, staff_id, display_name, role, active, org_id, contact_id");

  if (sErr) {
    if (/duplicate|unique/i.test(String(sErr.message || ""))) {
      return { ok: false, error: "staff_contact_already_linked", status: 409 };
    }
    return { ok: false, error: sErr.message, status: 500 };
  }

  const row = staffRows && staffRows[0];
  if (!row) return { ok: false, error: "insert_failed", status: 500 };

  return { ok: true, staff: mapStaffRow(row, contact) };
}

async function patchStaffForPortal(sb, orgId, staffIdText, patch) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  const sid = String(staffIdText || "").trim();
  if (!sid) return { ok: false, error: "missing_staff_id", status: 400 };

  const { data: existing, error: findErr } = await sb
    .from("staff")
    .select("id, staff_id, display_name, role, active, org_id, contact_id")
    .eq("staff_id", sid)
    .eq("org_id", oid)
    .maybeSingle();

  if (findErr) return { ok: false, error: findErr.message, status: 500 };
  if (!existing) return { ok: false, error: "staff_not_found", status: 404 };

  const updates = {};
  if (patch.displayName != null || patch.display_name != null) {
    updates.display_name = String(patch.displayName ?? patch.display_name ?? "")
      .trim()
      .slice(0, 200);
  }
  if (patch.role != null) {
    updates.role = String(patch.role ?? "").trim().slice(0, 120);
  }
  if (patch.active != null) {
    updates.active = patch.active !== false && patch.active !== "0" && patch.active !== 0;
  }

  if (Object.keys(updates).length) {
    const { error: upErr } = await sb.from("staff").update(updates).eq("id", existing.id);
    if (upErr) return { ok: false, error: upErr.message, status: 500 };
  }

  const phonePatch = patch.phone ?? patch.phone_e164 ?? patch.phoneE164;
  if (phonePatch != null) {
    const phoneRaw = normalizePhoneE164(String(phonePatch));
    if (!phoneRaw || phoneRaw.length < 8) {
      return { ok: false, error: "invalid_phone", status: 400 };
    }
    const { error: pErr } = await sb
      .from("contacts")
      .update({ phone_e164: phoneRaw, display_name: updates.display_name || existing.display_name })
      .eq("id", existing.contact_id);
    if (pErr) return { ok: false, error: pErr.message, status: 500 };
  }

  const { data: row, error } = await sb
    .from("staff")
    .select("id, staff_id, display_name, role, active, org_id, contact_id")
    .eq("id", existing.id)
    .maybeSingle();
  if (error || !row) return { ok: false, error: error?.message || "reload_failed", status: 500 };

  const { data: contact } = await sb
    .from("contacts")
    .select("id, phone_e164")
    .eq("id", row.contact_id)
    .maybeSingle();

  return { ok: true, staff: mapStaffRow(row, contact) };
}

function mapAllowlistRow(row) {
  const portalRole = String(row.portal_role || "").trim();
  const tierRaw = String(row.staff_access_tier || "assigned_only").trim().toLowerCase();
  return {
    id: String(row.id || ""),
    email: String(row.email_lower || "").trim(),
    portalRole,
    staffAccessTier: tierRaw === "operations" ? "operations" : "assigned_only",
    staffId: String(row.staff_id || "").trim(),
    active: row.active !== false,
    registeredAt: row.registered_at ? String(row.registered_at) : "",
    notes: String(row.notes || "").trim(),
  };
}

async function listPortalUsersForOrg(sb, orgId) {
  if (!sb) return { ok: false, error: "no_db", users: [] };
  const oid = normOrg(orgId);
  const { data, error } = await sb
    .from("portal_auth_allowlist")
    .select("id, email_lower, portal_role, staff_access_tier, staff_id, active, registered_at, notes")
    .eq("org_id", oid)
    .order("email_lower", { ascending: true });

  if (error) return { ok: false, error: error.message, users: [] };
  return { ok: true, users: (data || []).map(mapAllowlistRow) };
}

async function createPortalUserForOrg(sb, orgId, input) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  const email = String(input.email ?? input.email_lower ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { ok: false, error: "invalid_email", status: 400 };
  }

  const portalRole = String(input.portalRole ?? input.portal_role ?? "Read-only").trim() || "Read-only";
  const staffId = String(input.staffId ?? input.staff_id ?? "").trim();
  const notes = String(input.notes ?? "").trim().slice(0, 500);
  const tierRaw = String(input.staffAccessTier ?? input.staff_access_tier ?? "assigned_only")
    .trim()
    .toLowerCase();
  const staffAccessTier = tierRaw === "operations" ? "operations" : "assigned_only";

  const { data, error } = await sb
    .from("portal_auth_allowlist")
    .insert({
      org_id: oid,
      email_lower: email,
      portal_role: portalRole,
      staff_access_tier: staffAccessTier,
      staff_id: staffId || null,
      active: true,
      notes,
    })
    .select("id, email_lower, portal_role, staff_access_tier, staff_id, active, registered_at, notes")
    .maybeSingle();

  if (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      return { ok: false, error: "email_already_allowlisted", status: 409 };
    }
    return { ok: false, error: error.message, status: 500 };
  }

  return { ok: true, user: mapAllowlistRow(data) };
}

async function patchPortalUserForOrg(sb, orgId, rowId, patch) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  const id = String(rowId || "").trim();
  if (!id) return { ok: false, error: "missing_id", status: 400 };

  const { data: existing, error: findErr } = await sb
    .from("portal_auth_allowlist")
    .select("id")
    .eq("id", id)
    .eq("org_id", oid)
    .maybeSingle();

  if (findErr) return { ok: false, error: findErr.message, status: 500 };
  if (!existing) return { ok: false, error: "user_not_found", status: 404 };

  const updates = {};
  if (patch.portalRole != null || patch.portal_role != null) {
    updates.portal_role = String(patch.portalRole ?? patch.portal_role ?? "").trim() || "Read-only";
  }
  if (patch.staffAccessTier != null || patch.staff_access_tier != null) {
    const tierRaw = String(patch.staffAccessTier ?? patch.staff_access_tier ?? "assigned_only")
      .trim()
      .toLowerCase();
    updates.staff_access_tier = tierRaw === "operations" ? "operations" : "assigned_only";
  }
  if (patch.staffId != null || patch.staff_id != null) {
    const sid = String(patch.staffId ?? patch.staff_id ?? "").trim();
    updates.staff_id = sid || null;
  }
  if (patch.active != null) {
    updates.active = patch.active !== false && patch.active !== "0" && patch.active !== 0;
  }
  if (patch.notes != null) {
    updates.notes = String(patch.notes ?? "").trim().slice(0, 500);
  }

  if (!Object.keys(updates).length) {
    return { ok: false, error: "no_changes", status: 400 };
  }

  const { data, error } = await sb
    .from("portal_auth_allowlist")
    .update(updates)
    .eq("id", id)
    .select("id, email_lower, portal_role, staff_access_tier, staff_id, active, registered_at, notes")
    .maybeSingle();

  if (error) return { ok: false, error: error.message, status: 500 };
  return { ok: true, user: mapAllowlistRow(data) };
}

async function deletePortalUserForOrg(sb, orgId, rowId) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  const id = String(rowId || "").trim();
  if (!id) return { ok: false, error: "missing_id", status: 400 };

  const { data: existing, error: findErr } = await sb
    .from("portal_auth_allowlist")
    .select("id, registered_at")
    .eq("id", id)
    .eq("org_id", oid)
    .maybeSingle();

  if (findErr) return { ok: false, error: findErr.message, status: 500 };
  if (!existing) return { ok: false, error: "user_not_found", status: 404 };
  if (existing.registered_at) {
    return { ok: false, error: "use_revoke_for_registered_user", status: 409 };
  }

  const { error } = await sb.from("portal_auth_allowlist").delete().eq("id", id).eq("org_id", oid);
  if (error) return { ok: false, error: error.message, status: 500 };
  return { ok: true };
}

async function listVendorsForOrg(sb, orgId, opts = {}) {
  if (!sb) return { ok: false, error: "no_db", vendors: [] };
  const oid = normOrg(orgId);
  let query = sb
    .from("vendors")
    .select("vendor_id, display_name, active, notes, created_at, updated_at")
    .eq("org_id", oid)
    .order("display_name", { ascending: true });
  if (!opts.includeInactive) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) {
    if (error.code === "42P01") return { ok: false, error: "vendors_migration_required", vendors: [] };
    return { ok: false, error: error.message, vendors: [] };
  }
  const vendors = (data || []).map((r) => ({
    vendorId: String(r.vendor_id || "").trim(),
    displayName: String(r.display_name || "").trim(),
    active: r.active !== false,
    notes: String(r.notes || "").trim(),
  }));
  return { ok: true, vendors };
}

async function patchVendorForOrg(sb, orgId, vendorId, patch) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  const vid = String(vendorId || "").trim();
  if (!vid) return { ok: false, error: "missing_vendor_id", status: 400 };

  const updates = { updated_at: new Date().toISOString() };
  if (patch.displayName != null || patch.display_name != null) {
    updates.display_name = String(patch.displayName ?? patch.display_name ?? "")
      .trim()
      .slice(0, 200);
  }
  if (patch.active != null) {
    updates.active = patch.active !== false && patch.active !== "0" && patch.active !== 0;
  }
  if (patch.notes != null) {
    updates.notes = String(patch.notes ?? "").trim().slice(0, 2000);
  }
  if (Object.keys(updates).length <= 1) {
    return { ok: false, error: "no_changes", status: 400 };
  }

  const { data, error } = await sb
    .from("vendors")
    .update(updates)
    .eq("vendor_id", vid)
    .eq("org_id", oid)
    .select("vendor_id, display_name, active, notes")
    .maybeSingle();

  if (error) return { ok: false, error: error.message, status: 500 };
  if (!data) return { ok: false, error: "vendor_not_found", status: 404 };

  return {
    ok: true,
    vendor: {
      vendorId: String(data.vendor_id || "").trim(),
      displayName: String(data.display_name || "").trim(),
      active: data.active !== false,
      notes: String(data.notes || "").trim(),
    },
  };
}

const PROPERTY_CODE_RE = /^[A-Z][A-Z0-9_]{1,24}$/;

function normPropertyCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "");
}

function propertyCodeFromDisplayName(name) {
  const raw = String(name || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!raw) return "";
  return raw.slice(0, 24);
}

function mapPropertyRow(row) {
  return {
    propertyCode: String(row.code || "").trim().toUpperCase(),
    displayName: String(row.display_name || "").trim(),
    shortName: String(row.short_name || "").trim(),
    ticketPrefix: String(row.ticket_prefix || "").trim(),
    address: String(row.address || "").trim(),
    active: row.active !== false,
    orgId: String(row.org_id || "").trim(),
  };
}

async function listPropertiesForOrg(sb, orgId, opts = {}) {
  if (!sb) return { ok: false, error: "no_db", properties: [] };
  const oid = normOrg(orgId);
  let query = sb
    .from("properties")
    .select("code, display_name, short_name, ticket_prefix, address, active, org_id")
    .eq("org_id", oid)
    .order("code", { ascending: true });
  if (!opts.includeInactive) {
    query = query.eq("active", true);
  }
  const { data, error } = await query;
  if (error) return { ok: false, error: error.message, properties: [] };
  return { ok: true, properties: (data || []).map(mapPropertyRow) };
}

async function seedPropertyAliasesForProperty(sb, orgId, propertyCode, fields) {
  const oid = normOrg(orgId);
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!code || code === "GLOBAL") return { ok: true };

  const aliases = [];
  const shortName = String(fields.shortName ?? fields.short_name ?? "").trim();
  const displayName = String(fields.displayName ?? fields.display_name ?? "").trim();
  const address = String(fields.address ?? "").trim();

  if (shortName) aliases.push(shortName);
  if (displayName && displayName.toLowerCase() !== shortName.toLowerCase()) {
    aliases.push(displayName);
  }

  const streetMatch = address.match(
    /^\s*\d+\s+([A-Za-z][A-Za-z0-9]*)\s+(?:ave|avenue|st|street|rd|road|blvd|boulevard|dr|drive)\b/i
  );
  if (streetMatch && streetMatch[1]) {
    const token =
      streetMatch[1].charAt(0).toUpperCase() + streetMatch[1].slice(1).toLowerCase();
    if (!aliases.some((a) => a.toLowerCase() === token.toLowerCase())) {
      aliases.push(token);
    }
  }

  for (const alias of aliases) {
    const { error } = await sb.from("property_aliases").insert({
      property_code: code,
      alias,
      active: true,
      org_id: oid,
    });
    if (error && !/duplicate|unique/i.test(String(error.message || ""))) {
      if (error.code === "42P01") return { ok: true };
      return { ok: false, error: error.message };
    }
  }

  return { ok: true };
}

async function createPropertyForOrg(sb, orgId, input) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  if (!oid) return { ok: false, error: "missing_org_id" };

  const displayName = String(
    input.displayName ?? input.display_name ?? input.propertyName ?? input.property_name ?? ""
  )
    .trim()
    .slice(0, 200);
  if (!displayName) return { ok: false, error: "missing_display_name", status: 400 };

  const address = String(input.address ?? "").trim().slice(0, 500);
  if (!address) return { ok: false, error: "missing_address", status: 400 };

  const ticketPrefix = String(input.ticketPrefix ?? input.ticket_prefix ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  if (!ticketPrefix || ticketPrefix.length < 2) {
    return { ok: false, error: "invalid_ticket_prefix", status: 400 };
  }

  let propertyCode = normPropertyCode(
    input.propertyCode ?? input.property_code ?? input.propertyId ?? ""
  );
  if (!propertyCode) {
    propertyCode = propertyCodeFromDisplayName(displayName);
  }
  if (!propertyCode || !PROPERTY_CODE_RE.test(propertyCode)) {
    return { ok: false, error: "invalid_property_code", status: 400 };
  }
  if (propertyCode === "GLOBAL") {
    return { ok: false, error: "invalid_property_code", status: 400 };
  }

  const shortName = String(input.shortName ?? input.short_name ?? "")
    .trim()
    .slice(0, 80);

  const { data: existingCode, error: codeErr } = await sb
    .from("properties")
    .select("code")
    .eq("code", propertyCode)
    .maybeSingle();
  if (codeErr) return { ok: false, error: codeErr.message, status: 500 };
  if (existingCode) {
    return { ok: false, error: "property_code_taken", status: 409 };
  }

  const { data: prefixRows, error: prefixErr } = await sb
    .from("properties")
    .select("code")
    .eq("org_id", oid)
    .eq("ticket_prefix", ticketPrefix);
  if (prefixErr) return { ok: false, error: prefixErr.message, status: 500 };
  if (prefixRows && prefixRows.length) {
    return { ok: false, error: "ticket_prefix_taken", status: 409 };
  }

  const { data, error } = await sb
    .from("properties")
    .insert({
      code: propertyCode,
      display_name: displayName,
      short_name: shortName,
      address,
      ticket_prefix: ticketPrefix,
      active: true,
      org_id: oid,
    })
    .select("code, display_name, short_name, ticket_prefix, address, active, org_id")
    .maybeSingle();

  if (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      return { ok: false, error: "property_code_taken", status: 409 };
    }
    return { ok: false, error: error.message, status: 500 };
  }
  if (!data) return { ok: false, error: "insert_failed", status: 500 };

  const aliasSeed = await seedPropertyAliasesForProperty(sb, oid, propertyCode, {
    shortName,
    displayName,
    address,
  });
  if (!aliasSeed.ok) {
    return {
      ok: true,
      property: mapPropertyRow(data),
      aliasSeedWarning: aliasSeed.error || "alias_seed_failed",
    };
  }

  return { ok: true, property: mapPropertyRow(data) };
}

async function patchPropertyForOrg(sb, orgId, propertyCode, patch) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!code) return { ok: false, error: "missing_property_code", status: 400 };

  const { data: existing, error: findErr } = await sb
    .from("properties")
    .select("code")
    .eq("code", code)
    .eq("org_id", oid)
    .maybeSingle();
  if (findErr) return { ok: false, error: findErr.message, status: 500 };
  if (!existing) return { ok: false, error: "property_not_found", status: 404 };

  const updates = {};
  if (patch.displayName != null || patch.display_name != null) {
    updates.display_name = String(patch.displayName ?? patch.display_name ?? "")
      .trim()
      .slice(0, 200);
  }
  if (patch.shortName != null || patch.short_name != null) {
    updates.short_name = String(patch.shortName ?? patch.short_name ?? "")
      .trim()
      .slice(0, 80);
  }
  if (patch.ticketPrefix != null || patch.ticket_prefix != null) {
    updates.ticket_prefix = String(patch.ticketPrefix ?? patch.ticket_prefix ?? "")
      .trim()
      .slice(0, 20);
  }
  if (patch.address != null) {
    updates.address = String(patch.address ?? "").trim().slice(0, 500);
  }
  if (patch.active != null) {
    updates.active = patch.active !== false && patch.active !== "0" && patch.active !== 0;
  }

  if (!Object.keys(updates).length) {
    return { ok: false, error: "no_changes", status: 400 };
  }

  const { data, error } = await sb
    .from("properties")
    .update(updates)
    .eq("code", code)
    .eq("org_id", oid)
    .select("code, display_name, short_name, ticket_prefix, address, active, org_id")
    .maybeSingle();

  if (error) return { ok: false, error: error.message, status: 500 };
  return { ok: true, property: mapPropertyRow(data) };
}

function mapAssignmentRow(row, staff) {
  return {
    id: String(row.id || ""),
    propertyCode: String(row.property_code || "").trim().toUpperCase(),
    role: String(row.role || "").trim(),
    staffInternalId: String(row.staff_id || ""),
    staffId: String(staff?.staff_id || "").trim(),
    staffName: String(staff?.display_name || "").trim(),
  };
}

async function listStaffAssignmentsForOrg(sb, orgId) {
  if (!sb) return { ok: false, error: "no_db", assignments: [] };
  const oid = normOrg(orgId);

  const { data: staffRows, error: staffErr } = await sb
    .from("staff")
    .select("id, staff_id, display_name")
    .eq("org_id", oid);
  if (staffErr) return { ok: false, error: staffErr.message, assignments: [] };

  const staffByInternal = {};
  const internalIds = [];
  for (const s of staffRows || []) {
    staffByInternal[s.id] = s;
    internalIds.push(s.id);
  }
  if (!internalIds.length) return { ok: true, assignments: [] };

  const { data, error } = await sb
    .from("staff_assignments")
    .select("id, staff_id, property_code, role")
    .in("staff_id", internalIds)
    .order("property_code", { ascending: true });

  if (error) return { ok: false, error: error.message, assignments: [] };

  const assignments = (data || []).map((r) => mapAssignmentRow(r, staffByInternal[r.staff_id]));
  return { ok: true, assignments };
}

async function resolveStaffInternalId(sb, orgId, staffIdText) {
  const oid = normOrg(orgId);
  const sid = String(staffIdText || "").trim();
  if (!sid) return { ok: false, error: "missing_staff_id", status: 400 };
  const { data, error } = await sb
    .from("staff")
    .select("id, staff_id, display_name")
    .eq("org_id", oid)
    .eq("staff_id", sid)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!data) return { ok: false, error: "staff_not_found", status: 404 };
  return { ok: true, staff: data };
}

async function assertPropertyInOrg(sb, orgId, propertyCode) {
  const oid = normOrg(orgId);
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!code) return { ok: false, error: "missing_property_code", status: 400 };
  const { data, error } = await sb
    .from("properties")
    .select("code")
    .eq("code", code)
    .eq("org_id", oid)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!data) return { ok: false, error: "property_not_found", status: 404 };
  return { ok: true, propertyCode: code };
}

async function createStaffAssignmentForOrg(sb, orgId, input) {
  if (!sb) return { ok: false, error: "no_db" };
  const staffIdText = String(input.staffId ?? input.staff_id ?? "").trim();
  const propertyCode = String(input.propertyCode ?? input.property_code ?? "").trim();
  const role = String(input.role ?? "").trim().slice(0, 120);
  if (!role) return { ok: false, error: "missing_role", status: 400 };

  const staffRes = await resolveStaffInternalId(sb, orgId, staffIdText);
  if (!staffRes.ok) return staffRes;

  const propRes = await assertPropertyInOrg(sb, orgId, propertyCode);
  if (!propRes.ok) return propRes;

  const { data, error } = await sb
    .from("staff_assignments")
    .insert({
      staff_id: staffRes.staff.id,
      property_code: propRes.propertyCode,
      role,
    })
    .select("id, staff_id, property_code, role")
    .maybeSingle();

  if (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      return { ok: false, error: "assignment_already_exists", status: 409 };
    }
    return { ok: false, error: error.message, status: 500 };
  }

  return {
    ok: true,
    assignment: mapAssignmentRow(data, staffRes.staff),
  };
}

async function patchStaffAssignmentForOrg(sb, orgId, assignmentId, patch) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  const id = String(assignmentId || "").trim();
  if (!id) return { ok: false, error: "missing_id", status: 400 };

  const { data: existing, error: findErr } = await sb
    .from("staff_assignments")
    .select("id, staff_id, property_code, role")
    .eq("id", id)
    .maybeSingle();

  if (findErr) return { ok: false, error: findErr.message, status: 500 };
  if (!existing) return { ok: false, error: "assignment_not_found", status: 404 };

  const { data: staffRow, error: staffErr } = await sb
    .from("staff")
    .select("id, staff_id, display_name, org_id")
    .eq("id", existing.staff_id)
    .maybeSingle();
  if (staffErr) return { ok: false, error: staffErr.message, status: 500 };
  if (!staffRow || normOrg(staffRow.org_id) !== oid) {
    return { ok: false, error: "assignment_not_found", status: 404 };
  }

  const updates = {};
  if (patch.role != null) {
    updates.role = String(patch.role ?? "").trim().slice(0, 120);
    if (!updates.role) return { ok: false, error: "missing_role", status: 400 };
  }

  if (!Object.keys(updates).length) {
    return { ok: false, error: "no_changes", status: 400 };
  }

  const { data, error } = await sb
    .from("staff_assignments")
    .update(updates)
    .eq("id", id)
    .select("id, staff_id, property_code, role")
    .maybeSingle();

  if (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      return { ok: false, error: "assignment_already_exists", status: 409 };
    }
    return { ok: false, error: error.message, status: 500 };
  }

  return {
    ok: true,
    assignment: mapAssignmentRow(data, staffRow),
  };
}

async function deleteStaffAssignmentForOrg(sb, orgId, assignmentId) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  const id = String(assignmentId || "").trim();
  if (!id) return { ok: false, error: "missing_id", status: 400 };

  const { data: existing, error: findErr } = await sb
    .from("staff_assignments")
    .select("id, staff_id")
    .eq("id", id)
    .maybeSingle();

  if (findErr) return { ok: false, error: findErr.message, status: 500 };
  if (!existing) return { ok: false, error: "assignment_not_found", status: 404 };

  const { data: staffRow, error: staffErr } = await sb
    .from("staff")
    .select("org_id")
    .eq("id", existing.staff_id)
    .maybeSingle();
  if (staffErr) return { ok: false, error: staffErr.message, status: 500 };
  if (!staffRow || normOrg(staffRow.org_id) !== oid) {
    return { ok: false, error: "assignment_not_found", status: 404 };
  }

  const { error } = await sb.from("staff_assignments").delete().eq("id", id);
  if (error) return { ok: false, error: error.message, status: 500 };
  return { ok: true };
}

module.exports = {
  canManageOrgSettings,
  staffIdSlugFromName,
  resolveUniqueStaffId,
  getOrganizationForPortal,
  patchOrganizationForPortal,
  listStaffForOrg,
  createStaffForPortal,
  patchStaffForPortal,
  listPortalUsersForOrg,
  createPortalUserForOrg,
  patchPortalUserForOrg,
  deletePortalUserForOrg,
  listVendorsForOrg,
  patchVendorForOrg,
  listPropertiesForOrg,
  createPropertyForOrg,
  patchPropertyForOrg,
  listStaffAssignmentsForOrg,
  createStaffAssignmentForOrg,
  patchStaffAssignmentForOrg,
  deleteStaffAssignmentForOrg,
};
