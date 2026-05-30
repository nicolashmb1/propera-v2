/**
 * Phase 2 — deterministic assignee from Team & routing (`staff_property_roles`).
 * Maintenance create: primary `building_super` at property.
 * @see docs/RESPONSIBILITY_ROUTING_REFACTOR.md §3, Phase 2
 */
const { getStaffDisplayNameByStaffId } = require("../dal/staffPhoneByStaffId");

const MAINTENANCE_DEFAULT_ROLE = "building_super";
const MAINTENANCE_RULE_ID = "maintenance:building_super";

function normOrg(orgId) {
  return String(orgId || "").trim().toLowerCase();
}

function normPropertyCode(propertyCode) {
  return String(propertyCode || "").trim().toUpperCase();
}

function pickStaffIdFromRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "";
  const primary = list.find((r) => r.is_primary === true);
  if (primary) return String(primary.staff_id || "").trim();
  return String(list[0].staff_id || "").trim();
}

async function loadPropertyOrgId(sb, propertyCode) {
  const code = normPropertyCode(propertyCode);
  if (!code) return { ok: false, error: "missing_property_code" };
  const { data, error } = await sb
    .from("properties")
    .select("code, org_id, active")
    .eq("code", code)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "property_not_found" };
  return {
    ok: true,
    propertyCode: code,
    orgId: normOrg(data.org_id),
  };
}

async function loadStaffIdsForRoleAtProperty(sb, orgId, propertyCode, roleKey) {
  const oid = normOrg(orgId);
  const code = normPropertyCode(propertyCode);
  const role = String(roleKey || "").trim();
  if (!oid || !code || !role) {
    return { ok: true, staffIds: [], migrationMissing: false };
  }

  const { data, error } = await sb
    .from("staff_property_roles")
    .select("staff_id, is_primary, active")
    .eq("org_id", oid)
    .eq("property_code", code)
    .eq("role_key", role)
    .eq("active", true);

  if (error) {
    if (error.code === "42P01") {
      return { ok: true, staffIds: [], migrationMissing: true };
    }
    return { ok: false, error: error.message, staffIds: [], migrationMissing: false };
  }

  const staffId = pickStaffIdFromRows(data || []);
  return { ok: true, staffIds: staffId ? [staffId] : [], migrationMissing: false };
}

async function assertActiveStaffInOrg(sb, orgId, staffIdText) {
  const oid = normOrg(orgId);
  const sid = String(staffIdText || "").trim();
  if (!sid) return { ok: true, staffId: "", displayName: "" };

  const { data, error } = await sb
    .from("staff")
    .select("staff_id, display_name, active, org_id")
    .eq("staff_id", sid)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data || data.active === false || normOrg(data.org_id) !== oid) {
    return { ok: true, staffId: "", displayName: "" };
  }

  const displayName = String(data.display_name || "").trim();
  return { ok: true, staffId: sid, displayName };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{
 *   orgId?: string,
 *   propertyCode: string,
 *   module?: string,
 *   roleKey?: string,
 * }} input
 */
async function resolveAssignee(sb, input) {
  if (!sb) return { ok: false, error: "no_db" };

  const module = String(input.module || "maintenance").trim().toLowerCase();
  const propertyCode = normPropertyCode(input.propertyCode);
  if (!propertyCode) return { ok: false, error: "missing_property_code" };

  let orgId = normOrg(input.orgId);
  if (!orgId) {
    const propCtx = await loadPropertyOrgId(sb, propertyCode);
    if (!propCtx.ok) return propCtx;
    orgId = propCtx.orgId;
  }

  if (module !== "maintenance" && module !== "maint") {
    return { ok: false, error: "unsupported_module" };
  }

  const roleKey = String(input.roleKey || MAINTENANCE_DEFAULT_ROLE).trim();
  const roleRows = await loadStaffIdsForRoleAtProperty(sb, orgId, propertyCode, roleKey);
  if (!roleRows.ok) return roleRows;

  if (roleRows.migrationMissing) {
    return {
      ok: true,
      assigneeType: "",
      assigneeId: "",
      assigneeName: "",
      source: "",
      ruleId: MAINTENANCE_RULE_ID,
      migrationMissing: true,
      empty: true,
    };
  }

  const staffId = roleRows.staffIds[0] || "";
  if (!staffId) {
    return {
      ok: true,
      assigneeType: "",
      assigneeId: "",
      assigneeName: "",
      source: "TEAM_ROUTING",
      ruleId: MAINTENANCE_RULE_ID,
      empty: true,
    };
  }

  const staff = await assertActiveStaffInOrg(sb, orgId, staffId);
  if (!staff.ok) return staff;
  if (!staff.staffId) {
    return {
      ok: true,
      assigneeType: "",
      assigneeId: "",
      assigneeName: "",
      source: "TEAM_ROUTING",
      ruleId: MAINTENANCE_RULE_ID,
      empty: true,
    };
  }

  let displayName = staff.displayName;
  if (!displayName) {
    try {
      displayName = (await getStaffDisplayNameByStaffId(sb, staff.staffId)) || staff.staffId;
    } catch (_) {
      displayName = staff.staffId;
    }
  }

  return {
    ok: true,
    assigneeType: "STAFF",
    assigneeId: staff.staffId,
    assigneeName: displayName,
    source: "TEAM_ROUTING",
    ruleId: MAINTENANCE_RULE_ID,
    empty: false,
  };
}

module.exports = {
  resolveAssignee,
  loadStaffIdsForRoleAtProperty,
  loadPropertyOrgId,
  MAINTENANCE_DEFAULT_ROLE,
  MAINTENANCE_RULE_ID,
};
