/**
 * MO-4 — bootstrap a new management company (org + owner + first property).
 * Gated by PROPERA_ORG_SIGNUP_ENABLED + signup secret (not portal JWT).
 * @see docs/MULTI_ORG_ARCHITECTURE.md
 */
const { ensureDefaultChannelRows } = require("./portalOrgChannels");
const { staffIdSlugFromName, resolveUniqueStaffId } = require("./portalOrgSettings");
const { normalizePhoneE164 } = require("../utils/phone");

const ORG_ID_RE = /^[a-z][a-z0-9_]{2,30}$/;
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;
const PROPERTY_CODE_RE = /^[A-Z][A-Z0-9_]{1,24}$/;

function normOrg(orgId) {
  return String(orgId || "").trim().toLowerCase();
}

function normSubdomain(sub) {
  return String(sub || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

function normPropertyCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "");
}

function validateOrgId(orgId) {
  const id = normOrg(orgId);
  if (!id || !ORG_ID_RE.test(id)) return { ok: false, error: "invalid_org_id" };
  if (id === "global") return { ok: false, error: "invalid_org_id" };
  return { ok: true, orgId: id };
}

function validateSubdomain(subdomain) {
  const sub = normSubdomain(subdomain);
  if (!sub || !SUBDOMAIN_RE.test(sub)) return { ok: false, error: "invalid_subdomain" };
  return { ok: true, subdomain: sub };
}

function validatePropertyCode(code) {
  const pc = normPropertyCode(code);
  if (!pc || !PROPERTY_CODE_RE.test(pc)) return { ok: false, error: "invalid_property_code" };
  if (pc === "GLOBAL") return { ok: false, error: "invalid_property_code" };
  return { ok: true, propertyCode: pc };
}

async function checkOrgBootstrapAvailability(sb, input) {
  if (!sb) return { ok: false, error: "no_db" };

  const orgCheck = validateOrgId(input.orgId ?? input.org_id);
  const subCheck = validateSubdomain(input.properaSubdomain ?? input.propera_subdomain ?? input.subdomain);
  if (!orgCheck.ok) return { ...orgCheck, status: 400 };
  if (!subCheck.ok) return { ...subCheck, status: 400 };

  const propertyRaw = input.propertyCode ?? input.property_code;
  let propertyCode = "";
  if (propertyRaw) {
    const pc = validatePropertyCode(propertyRaw);
    if (!pc.ok) return { ...pc, status: 400 };
    propertyCode = pc.propertyCode;
  }

  const email = String(input.ownerEmail ?? input.email ?? "").trim().toLowerCase();
  if (email && !email.includes("@")) {
    return { ok: false, error: "invalid_email", status: 400 };
  }

  const conflicts = [];

  const { data: orgRow } = await sb
    .from("organizations")
    .select("id")
    .eq("id", orgCheck.orgId)
    .maybeSingle();
  if (orgRow) conflicts.push("org_id_taken");

  const { data: subRow } = await sb
    .from("organizations")
    .select("id")
    .eq("propera_subdomain", subCheck.subdomain)
    .maybeSingle();
  if (subRow) conflicts.push("subdomain_taken");

  if (propertyCode) {
    const { data: propRow } = await sb
      .from("properties")
      .select("code")
      .eq("code", propertyCode)
      .maybeSingle();
    if (propRow) conflicts.push("property_code_taken");
  }

  if (email) {
    const { data: allowRow } = await sb
      .from("portal_auth_allowlist")
      .select("id")
      .eq("email_lower", email)
      .eq("org_id", orgCheck.orgId)
      .maybeSingle();
    if (allowRow) conflicts.push("email_already_allowlisted");
  }

  return {
    ok: true,
    available: conflicts.length === 0,
    conflicts,
    orgId: orgCheck.orgId,
    properaSubdomain: subCheck.subdomain,
    propertyCode: propertyCode || null,
  };
}

async function rollbackOrgBootstrap(sb, orgId) {
  const oid = normOrg(orgId);
  if (!oid) return;

  const { data: staffRows } = await sb.from("staff").select("id").eq("org_id", oid);
  const staffInternalIds = (staffRows || []).map((r) => r.id).filter(Boolean);
  if (staffInternalIds.length) {
    await sb.from("staff_assignments").delete().in("staff_id", staffInternalIds);
  }

  await sb.from("portal_auth_allowlist").delete().eq("org_id", oid);
  await sb.from("staff").delete().eq("org_id", oid);
  await sb.from("properties").delete().eq("org_id", oid);
  await sb.from("org_channel_configs").delete().eq("org_id", oid);
  await sb.from("organizations").delete().eq("id", oid);
}

async function bootstrapOrganization(sb, input) {
  if (!sb) return { ok: false, error: "no_db" };

  const avail = await checkOrgBootstrapAvailability(sb, input);
  if (!avail.ok) return avail;
  if (!avail.available) {
    return { ok: false, error: avail.conflicts[0] || "not_available", status: 409 };
  }

  const orgId = avail.orgId;
  const subdomain = avail.properaSubdomain;
  const brandName = String(input.brandName ?? input.brand_name ?? "").trim().slice(0, 200);
  const brandShortName = String(input.brandShortName ?? input.brand_short_name ?? "").trim().slice(0, 80);
  const ownerName = String(input.ownerName ?? input.owner_name ?? input.displayName ?? "").trim().slice(0, 200);
  const ownerEmail = String(input.ownerEmail ?? input.email ?? "").trim().toLowerCase();
  const ownerPhone = normalizePhoneE164(String(input.ownerPhone ?? input.phone ?? input.phoneE164 ?? ""));
  const propertyCode = avail.propertyCode || normPropertyCode(input.propertyCode ?? input.property_code);
  const propertyName = String(
    input.propertyDisplayName ?? input.property_display_name ?? input.propertyName ?? ""
  )
    .trim()
    .slice(0, 200);
  const propertyAddress = String(input.propertyAddress ?? input.address ?? "").trim().slice(0, 500);
  const ticketPrefix = String(input.ticketPrefix ?? input.ticket_prefix ?? propertyCode.slice(0, 4))
    .trim()
    .slice(0, 12);

  if (!brandName) return { ok: false, error: "missing_brand_name", status: 400 };
  if (!ownerName) return { ok: false, error: "missing_owner_name", status: 400 };
  if (!ownerEmail || !ownerEmail.includes("@")) {
    return { ok: false, error: "invalid_email", status: 400 };
  }
  if (!ownerPhone || ownerPhone.length < 8) {
    return { ok: false, error: "invalid_phone", status: 400 };
  }
  const pcCheck = validatePropertyCode(propertyCode);
  if (!pcCheck.ok) return { ...pcCheck, status: 400 };

  const now = new Date().toISOString();

  try {
    const { error: orgErr } = await sb.from("organizations").insert({
      id: orgId,
      brand_name: brandName,
      brand_short_name: brandShortName || brandName.slice(0, 80),
      propera_subdomain: subdomain,
      show_propera_attribution: input.showProperaAttribution !== false,
      created_via: "wizard",
      onboarding_completed_at: now,
    });
    if (orgErr) throw new Error(orgErr.message);

    const channels = await ensureDefaultChannelRows(sb, orgId);
    if (!channels.ok) throw new Error(channels.error || "channel_seed_failed");

    const { error: propErr } = await sb.from("properties").insert({
      code: pcCheck.propertyCode,
      display_name: propertyName || pcCheck.propertyCode,
      address: propertyAddress,
      active: true,
      ticket_prefix: ticketPrefix || pcCheck.propertyCode,
      org_id: orgId,
    });
    if (propErr) throw new Error(propErr.message);

    const { data: contactRows, error: cErr } = await sb
      .from("contacts")
      .upsert(
        { phone_e164: ownerPhone, display_name: ownerName },
        { onConflict: "phone_e164" }
      )
      .select("id, phone_e164");
    if (cErr) throw new Error(cErr.message);
    const contact = contactRows && contactRows[0];
    if (!contact) throw new Error("contact_upsert_failed");

    const baseStaffId = staffIdSlugFromName(ownerName);
    const unique = await resolveUniqueStaffId(sb, orgId, baseStaffId);
    if (!unique.ok) throw new Error(unique.error || "staff_id_failed");

    const { data: staffRows, error: sErr } = await sb
      .from("staff")
      .insert({
        contact_id: contact.id,
        staff_id: unique.staffId,
        display_name: ownerName,
        role: "Owner",
        active: true,
        org_id: orgId,
      })
      .select("id, staff_id, display_name")
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!staffRows) throw new Error("staff_insert_failed");

    const { data: allowRow, error: aErr } = await sb
      .from("portal_auth_allowlist")
      .insert({
        org_id: orgId,
        email_lower: ownerEmail,
        portal_role: "Owner",
        staff_access_tier: "operations",
        staff_id: staffRows.staff_id,
        active: true,
        notes: "MO-4 wizard bootstrap",
      })
      .select("id, email_lower, portal_role, staff_id")
      .maybeSingle();
    if (aErr) throw new Error(aErr.message);
    if (!allowRow) throw new Error("allowlist_insert_failed");

    const { error: assignErr } = await sb.from("staff_assignments").insert({
      staff_id: staffRows.id,
      property_code: pcCheck.propertyCode,
      role: "PM",
    });
    if (assignErr) throw new Error(assignErr.message);

    return {
      ok: true,
      org: {
        orgId,
        brandName,
        brandShortName: brandShortName || brandName.slice(0, 80),
        properaSubdomain: subdomain,
        tenantPortalHost: `${subdomain}.usepropera.com`,
      },
      owner: {
        email: ownerEmail,
        staffId: staffRows.staff_id,
        displayName: ownerName,
        allowlistId: String(allowRow.id || ""),
      },
      property: {
        propertyCode: pcCheck.propertyCode,
        displayName: propertyName || pcCheck.propertyCode,
      },
    };
  } catch (err) {
    await rollbackOrgBootstrap(sb, orgId);
    return {
      ok: false,
      error: String(err && err.message ? err.message : err),
      status: 500,
    };
  }
}

module.exports = {
  checkOrgBootstrapAvailability,
  bootstrapOrganization,
  validateOrgId,
  validateSubdomain,
  validatePropertyCode,
};
