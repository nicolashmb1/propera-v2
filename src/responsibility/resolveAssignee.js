/**
 * Phase 2+3 — deterministic assignee from org_assignment_rules + Team & routing roster.
 * @see docs/RESPONSIBILITY_ROUTING_REFACTOR.md §3.2–3.3
 */
const { getStaffDisplayNameByStaffId } = require("../dal/staffPhoneByStaffId");
const {
  normModule,
  categoryMatches,
  propertyMatches,
  DEFAULT_ORG_ASSIGNMENT_RULES,
} = require("./assignmentRuleCatalog");

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

function roleLookupPropertyCodes(roleKey, propertyCode) {
  const code = normPropertyCode(propertyCode);
  const role = String(roleKey || "").trim();
  if (role === "owner") return ["GLOBAL"];
  return code ? [code] : [];
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
  const role = String(roleKey || "").trim();
  if (!oid || !role) {
    return { ok: true, staffIds: [], migrationMissing: false };
  }

  const propertyCodes = roleLookupPropertyCodes(role, propertyCode);
  for (const code of propertyCodes) {
    const { data, error } = await sb
      .from("staff_property_roles")
      .select("staff_id, is_primary, active")
      .eq("org_id", oid)
      .eq("property_code", normPropertyCode(code))
      .eq("role_key", role)
      .eq("active", true)
      .order("is_primary", { ascending: false })
      .order("staff_id", { ascending: true });

    if (error) {
      if (error.code === "42P01") {
        return { ok: true, staffIds: [], migrationMissing: true };
      }
      return { ok: false, error: error.message, staffIds: [], migrationMissing: false };
    }

    const staffId = pickStaffIdFromRows(data || []);
    if (staffId) {
      return { ok: true, staffIds: [staffId], migrationMissing: false };
    }
  }

  return { ok: true, staffIds: [], migrationMissing: false };
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

async function loadAssignmentRulesForOrg(sb, orgId, module) {
  const oid = normOrg(orgId);
  const mod = normModule(module);
  const { data, error } = await sb
    .from("org_assignment_rules")
    .select(
      "rule_key, label, enabled, priority, module, property_code, category_match, target_kind, target_ref, assign_mode"
    )
    .eq("org_id", oid)
    .eq("module", mod)
    .eq("enabled", true)
    .order("priority", { ascending: true });

  if (error) {
    if (error.code === "42P01") {
      return {
        ok: true,
        rules: DEFAULT_ORG_ASSIGNMENT_RULES.filter((r) => r.module === mod && r.enabled),
        migrationMissing: true,
      };
    }
    return { ok: false, error: error.message, rules: [] };
  }

  return { ok: true, rules: data || [], migrationMissing: false };
}

function mapDbRule(row) {
  if (!row) return null;
  if (row.ruleKey) return row;
  return {
    ruleKey: String(row.rule_key || "").trim(),
    label: String(row.label || "").trim(),
    enabled: row.enabled !== false,
    priority: Number(row.priority) || 100,
    module: String(row.module || "").trim(),
    propertyCode: String(row.property_code || "*").trim().toUpperCase() || "*",
    categoryMatch: String(row.category_match || "").trim(),
    targetKind: String(row.target_kind || "primary_role").trim(),
    targetRef: String(row.target_ref || "").trim(),
    assignMode: String(row.assign_mode || "staff").trim(),
  };
}

async function resolveStaffFromRuleTarget(sb, orgId, propertyCode, rule) {
  const mapped = mapDbRule(rule);
  if (!mapped) return { ok: true, staffId: "", displayName: "" };

  if (mapped.targetKind === "primary_role") {
    const roleRows = await loadStaffIdsForRoleAtProperty(sb, orgId, propertyCode, mapped.targetRef);
    if (!roleRows.ok) return roleRows;
    if (roleRows.migrationMissing) {
      return { ok: true, staffId: "", displayName: "", migrationMissing: true };
    }
    const staffId = roleRows.staffIds[0] || "";
    if (!staffId) return { ok: true, staffId: "", displayName: "" };
    return assertActiveStaffInOrg(sb, orgId, staffId);
  }

  if (mapped.targetKind === "staff_id") {
    return assertActiveStaffInOrg(sb, orgId, mapped.targetRef);
  }

  return { ok: true, staffId: "", displayName: "" };
}

async function resolveViaAssignmentRules(sb, orgId, input) {
  const module = normModule(input.module || "maintenance");
  const propertyCode = normPropertyCode(input.propertyCode);
  const category = input.category != null ? String(input.category) : "";

  const rulesRes = await loadAssignmentRulesForOrg(sb, orgId, module);
  if (!rulesRes.ok) return rulesRes;

  if (rulesRes.migrationMissing) {
    return { ok: true, migrationMissing: true, matched: false };
  }

  for (const rawRule of rulesRes.rules || []) {
    const rule = mapDbRule(rawRule);
    if (!rule || rule.enabled === false) continue;
    if (!propertyMatches(rule.propertyCode, propertyCode)) continue;
    if (!categoryMatches(rule.categoryMatch, category)) continue;

    const staffRes = await resolveStaffFromRuleTarget(sb, orgId, propertyCode, rule);
    if (!staffRes.ok) return staffRes;
    if (staffRes.migrationMissing) {
      return { ok: true, migrationMissing: true, matched: false };
    }
    if (!staffRes.staffId) continue;

    let displayName = staffRes.displayName;
    if (!displayName) {
      try {
        displayName = (await getStaffDisplayNameByStaffId(sb, staffRes.staffId)) || staffRes.staffId;
      } catch (_) {
        displayName = staffRes.staffId;
      }
    }

    return {
      ok: true,
      matched: true,
      assigneeType: "STAFF",
      assigneeId: staffRes.staffId,
      assigneeName: displayName,
      source: "TEAM_ROUTING",
      ruleId: rule.ruleKey,
      empty: false,
    };
  }

  return { ok: true, matched: false, empty: true };
}

async function resolveLegacyMaintenanceRole(sb, orgId, propertyCode, roleKey) {
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

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{
 *   orgId?: string,
 *   propertyCode: string,
 *   module?: string,
 *   category?: string,
 *   roleKey?: string,
 * }} input
 */
async function resolveAssignee(sb, input) {
  if (!sb) return { ok: false, error: "no_db" };

  const module = normModule(input.module || "maintenance");
  const propertyCode = normPropertyCode(input.propertyCode);
  if (!propertyCode) return { ok: false, error: "missing_property_code" };

  let orgId = normOrg(input.orgId);
  if (!orgId) {
    const propCtx = await loadPropertyOrgId(sb, propertyCode);
    if (!propCtx.ok) return propCtx;
    orgId = propCtx.orgId;
  }

  const viaRules = await resolveViaAssignmentRules(sb, orgId, {
    module,
    propertyCode,
    category: input.category,
  });
  if (!viaRules.ok) return viaRules;

  if (viaRules.migrationMissing) {
    if (module !== "maintenance" && module !== "maint") {
      return { ok: false, error: "unsupported_module" };
    }
    const roleKey = String(input.roleKey || MAINTENANCE_DEFAULT_ROLE).trim();
    return resolveLegacyMaintenanceRole(sb, orgId, propertyCode, roleKey);
  }

  if (viaRules.matched) {
    return {
      ok: true,
      assigneeType: viaRules.assigneeType,
      assigneeId: viaRules.assigneeId,
      assigneeName: viaRules.assigneeName,
      source: viaRules.source,
      ruleId: viaRules.ruleId,
      empty: false,
    };
  }

  return {
    ok: true,
    assigneeType: "",
    assigneeId: "",
    assigneeName: "",
    source: "TEAM_ROUTING",
    ruleId: "",
    empty: true,
  };
}

module.exports = {
  resolveAssignee,
  loadStaffIdsForRoleAtProperty,
  loadPropertyOrgId,
  loadAssignmentRulesForOrg,
  resolveViaAssignmentRules,
  MAINTENANCE_DEFAULT_ROLE,
  MAINTENANCE_RULE_ID,
};
