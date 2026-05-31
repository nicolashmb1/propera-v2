/**
 * MO-4b / Responsibility catalog — org team coverage + escalation prefs (Settings only).
 * Syncs legacy staff_assignments for tenant deflect parity with Team & routing catalog.
 * @see docs/RESPONSIBILITY_ROUTING_REFACTOR.md
 */
const {
  getRoleCatalog,
  isValidRoleKey,
  normalizeEnabledRoleKeys,
  DEFAULT_ENABLED_ROLE_KEYS,
  DEFAULT_ESCALATION_CHAIN,
  LEGACY_ASSIGNMENT_ROLE_BY_KEY,
} = require("../responsibility/roleCatalog");
const { ASSIGNMENT_MODULES } = require("../responsibility/assignmentRuleCatalog");
const { listAssignmentRulesForOrg } = require("./portalOrgAssignmentRules");

function normOrg(orgId) {
  return String(orgId || "").trim().toLowerCase();
}

function mapCoverageRow(row, staffById) {
  const staffId = String(row.staff_id || "").trim();
  const staff = staffById[staffId];
  return {
    id: String(row.id || ""),
    staffId,
    staffName: staff ? String(staff.display_name || "").trim() : staffId,
    propertyCode: String(row.property_code || "").trim().toUpperCase(),
    roleKey: String(row.role_key || "").trim(),
    isPrimary: row.is_primary === true,
    active: row.active !== false,
  };
}

async function loadOrgStaffByStaffId(sb, orgId) {
  const oid = normOrg(orgId);
  const { data, error } = await sb
    .from("staff")
    .select("id, staff_id, display_name, active")
    .eq("org_id", oid)
    .eq("active", true);
  if (error) return { ok: false, error: error.message, staff: [], byStaffId: {}, internalIds: [] };
  const staff = data || [];
  const byStaffId = {};
  const internalIds = [];
  for (const s of staff) {
    byStaffId[String(s.staff_id || "").trim()] = s;
    internalIds.push(s.id);
  }
  return { ok: true, staff, byStaffId, internalIds };
}

async function assertStaffInOrg(sb, orgId, staffIdText) {
  const oid = normOrg(orgId);
  const sid = String(staffIdText || "").trim();
  if (!sid) return { ok: false, error: "missing_staff_id", status: 400 };
  const { data, error } = await sb
    .from("staff")
    .select("id, staff_id, display_name, active")
    .eq("org_id", oid)
    .eq("staff_id", sid)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!data || data.active === false) return { ok: false, error: "staff_not_found", status: 404 };
  return { ok: true, staff: data };
}

async function assertPropertyInOrg(sb, orgId, propertyCode) {
  const oid = normOrg(orgId);
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!code) return { ok: false, error: "missing_property_code", status: 400 };
  const { data, error } = await sb
    .from("properties")
    .select("code, display_name, active")
    .eq("code", code)
    .eq("org_id", oid)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!data) return { ok: false, error: "property_not_found", status: 404 };
  return { ok: true, property: data, propertyCode: code };
}

async function getOrgResponsibilityPrefs(sb, orgId) {
  const oid = normOrg(orgId);
  const { data, error } = await sb
    .from("org_responsibility_prefs")
    .select("org_id, enabled_role_keys, updated_at")
    .eq("org_id", oid)
    .maybeSingle();
  if (error) {
    if (error.code === "42P01") {
      return { ok: true, enabledRoleKeys: DEFAULT_ENABLED_ROLE_KEYS.slice() };
    }
    return { ok: false, error: error.message };
  }
  const enabledRoleKeys = normalizeEnabledRoleKeys(
    data && data.enabled_role_keys ? data.enabled_role_keys : DEFAULT_ENABLED_ROLE_KEYS
  );
  return { ok: true, enabledRoleKeys };
}

async function patchOrgResponsibilityPrefs(sb, orgId, patch) {
  const oid = normOrg(orgId);
  const enabledRoleKeys = normalizeEnabledRoleKeys(
    patch.enabledRoleKeys ?? patch.enabled_role_keys ?? DEFAULT_ENABLED_ROLE_KEYS
  );
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("org_responsibility_prefs")
    .upsert(
      { org_id: oid, enabled_role_keys: enabledRoleKeys, updated_at: now },
      { onConflict: "org_id" }
    )
    .select("org_id, enabled_role_keys, updated_at")
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  return {
    ok: true,
    enabledRoleKeys: normalizeEnabledRoleKeys(data?.enabled_role_keys),
  };
}

async function getEscalationConfigForOrg(sb, orgId, module = "maintenance") {
  const oid = normOrg(orgId);
  const mod = String(module || "maintenance").trim() || "maintenance";
  const { data, error } = await sb
    .from("org_escalation_config")
    .select("org_id, module, property_code, enabled, chain_json, updated_at")
    .eq("org_id", oid)
    .eq("module", mod)
    .eq("property_code", "*")
    .maybeSingle();
  if (error) {
    if (error.code === "42P01") {
      return {
        ok: true,
        escalation: {
          module: mod,
          propertyCode: "*",
          enabled: false,
          chain: DEFAULT_ESCALATION_CHAIN.slice(),
        },
      };
    }
    return { ok: false, error: error.message };
  }
  let chain = DEFAULT_ESCALATION_CHAIN.slice();
  if (data && data.chain_json) {
    try {
      const parsed = Array.isArray(data.chain_json)
        ? data.chain_json
        : JSON.parse(String(data.chain_json));
      if (Array.isArray(parsed)) {
        chain = parsed.map((k) => String(k || "").trim()).filter((k) => isValidRoleKey(k));
      }
    } catch (_) {
      /* keep default */
    }
  }
  if (!chain.length) chain = DEFAULT_ESCALATION_CHAIN.slice();
  return {
    ok: true,
    escalation: {
      module: mod,
      propertyCode: "*",
      enabled: data ? data.enabled === true : false,
      chain,
    },
  };
}

async function patchEscalationConfigForOrg(sb, orgId, patch) {
  const oid = normOrg(orgId);
  const mod = String(patch.module || "maintenance").trim() || "maintenance";
  const enabled = patch.enabled === true || patch.enabled === "1" || patch.enabled === 1;
  let chain = DEFAULT_ESCALATION_CHAIN.slice();
  const rawChain = patch.chain ?? patch.chainJson ?? patch.chain_json;
  if (Array.isArray(rawChain)) {
    chain = rawChain.map((k) => String(k || "").trim()).filter((k) => isValidRoleKey(k));
  }
  if (!chain.length) chain = DEFAULT_ESCALATION_CHAIN.slice();
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("org_escalation_config")
    .upsert(
      {
        org_id: oid,
        module: mod,
        property_code: "*",
        enabled,
        chain_json: chain,
        updated_at: now,
      },
      { onConflict: "org_id,module,property_code" }
    )
    .select("enabled, chain_json")
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  return {
    ok: true,
    escalation: {
      module: mod,
      propertyCode: "*",
      enabled: data ? data.enabled === true : enabled,
      chain,
    },
  };
}

async function listCoverageForOrg(sb, orgId) {
  const oid = normOrg(orgId);
  const staffRes = await loadOrgStaffByStaffId(sb, oid);
  if (!staffRes.ok) return { ok: false, error: staffRes.error, coverage: [] };

  const { data, error } = await sb
    .from("staff_property_roles")
    .select("id, org_id, staff_id, property_code, role_key, is_primary, active")
    .eq("org_id", oid)
    .eq("active", true)
    .order("property_code", { ascending: true });

  if (error) {
    if (error.code === "42P01") return { ok: true, coverage: [] };
    return { ok: false, error: error.message, coverage: [] };
  }

  return {
    ok: true,
    coverage: (data || []).map((r) => mapCoverageRow(r, staffRes.byStaffId)),
  };
}

async function savePropertyCoverageForOrg(sb, orgId, propertyCode, roleCoverage) {
  const oid = normOrg(orgId);
  const propRes = await assertPropertyInOrg(sb, oid, propertyCode);
  if (!propRes.ok) return propRes;

  const code = propRes.propertyCode;
  const rolesInput = roleCoverage && typeof roleCoverage === "object" ? roleCoverage : {};
  const prefs = await getOrgResponsibilityPrefs(sb, oid);
  const enabledKeys = prefs.ok ? prefs.enabledRoleKeys : DEFAULT_ENABLED_ROLE_KEYS;

  const rowsToInsert = [];

  for (const roleKey of enabledKeys) {
    if (!isValidRoleKey(roleKey)) continue;
    const slot = rolesInput[roleKey];
    if (!slot || typeof slot !== "object") continue;

    const primaryStaffId = String(slot.primaryStaffId ?? slot.primary_staff_id ?? "").trim();
    const extraIds = Array.isArray(slot.staffIds ?? slot.staff_ids)
      ? (slot.staffIds ?? slot.staff_ids).map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const allIds = [];
    if (primaryStaffId) allIds.push(primaryStaffId);
    for (const id of extraIds) {
      if (!allIds.includes(id)) allIds.push(id);
    }
    if (!allIds.length && String(slot.staffId ?? slot.staff_id ?? "").trim()) {
      allIds.push(String(slot.staffId ?? slot.staff_id).trim());
    }

    for (const staffId of allIds) {
      const staffCheck = await assertStaffInOrg(sb, oid, staffId);
      if (!staffCheck.ok) return staffCheck;
      let isPrimary = false;
      if (primaryStaffId) {
        isPrimary = staffId === primaryStaffId;
      } else if (allIds.length === 1) {
        isPrimary = true;
      } else if (!rowsToInsert.some((r) => r.property_code === code && r.role_key === roleKey && r.is_primary)) {
        isPrimary = true;
      }
      rowsToInsert.push({
        org_id: oid,
        staff_id: staffId,
        property_code: code,
        role_key: roleKey,
        is_primary: isPrimary,
        active: true,
        updated_at: new Date().toISOString(),
      });
    }
  }

  const { error: delErr } = await sb
    .from("staff_property_roles")
    .delete()
    .eq("org_id", oid)
    .eq("property_code", code);
  if (delErr) return { ok: false, error: delErr.message, status: 500 };

  if (rowsToInsert.length) {
    const { error: insErr } = await sb.from("staff_property_roles").insert(rowsToInsert);
    if (insErr) return { ok: false, error: insErr.message, status: 500 };
  }

  const sync = await syncLegacyAssignmentsForProperty(sb, oid, code);
  if (!sync.ok) return sync;

  const listed = await listCoverageForOrg(sb, oid);
  return {
    ok: true,
    propertyCode: code,
    coverage: listed.ok ? listed.coverage.filter((c) => c.propertyCode === code) : [],
  };
}

async function saveGlobalOwnerForOrg(sb, orgId, ownerStaffId) {
  const oid = normOrg(orgId);
  const sid = String(ownerStaffId || "").trim();
  const roleCoverage = {};
  if (sid) {
    roleCoverage.owner = { primaryStaffId: sid, staffIds: [sid] };
  }
  return savePropertyCoverageForOrg(sb, oid, "GLOBAL", roleCoverage);
}

async function copyPropertyCoverageToAll(sb, orgId, sourcePropertyCode) {
  const oid = normOrg(orgId);
  const srcRes = await assertPropertyInOrg(sb, oid, sourcePropertyCode);
  if (!srcRes.ok) return srcRes;
  const source = srcRes.propertyCode;

  const { data: sourceRows, error } = await sb
    .from("staff_property_roles")
    .select("staff_id, role_key, is_primary")
    .eq("org_id", oid)
    .eq("property_code", source)
    .eq("active", true);
  if (error) return { ok: false, error: error.message, status: 500 };

  const { data: props, error: pErr } = await sb
    .from("properties")
    .select("code")
    .eq("org_id", oid)
    .eq("active", true)
    .neq("code", "GLOBAL");
  if (pErr) return { ok: false, error: pErr.message, status: 500 };

  const targets = (props || []).map((p) => String(p.code || "").trim().toUpperCase()).filter(Boolean);
  for (const target of targets) {
    if (target === source) continue;
    const roleCoverage = {};
    for (const row of sourceRows || []) {
      const rk = String(row.role_key || "").trim();
      if (!roleCoverage[rk]) roleCoverage[rk] = { staffIds: [], primaryStaffId: "" };
      const rowStaffId = String(row.staff_id || "").trim();
      if (!roleCoverage[rk].staffIds.includes(rowStaffId)) roleCoverage[rk].staffIds.push(rowStaffId);
      if (row.is_primary === true) roleCoverage[rk].primaryStaffId = rowStaffId;
    }
    const saved = await savePropertyCoverageForOrg(sb, oid, target, roleCoverage);
    if (!saved.ok) return saved;
  }

  return { ok: true, copiedFrom: source, propertyCount: targets.length };
}

async function syncLegacyAssignmentsForProperty(sb, orgId, propertyCode) {
  const oid = normOrg(orgId);
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!code) return { ok: false, error: "missing_property_code", status: 400 };

  const staffRes = await loadOrgStaffByStaffId(sb, oid);
  if (!staffRes.ok) return staffRes;
  if (!staffRes.internalIds.length) return { ok: true };

  const { data: coverage, error: cErr } = await sb
    .from("staff_property_roles")
    .select("staff_id, role_key, is_primary")
    .eq("org_id", oid)
    .eq("property_code", code)
    .eq("active", true);
  if (cErr) return { ok: false, error: cErr.message, status: 500 };

  const { error: delErr } = await sb
    .from("staff_assignments")
    .delete()
    .eq("property_code", code)
    .in("staff_id", staffRes.internalIds);
  if (delErr) return { ok: false, error: delErr.message, status: 500 };

  const staffInternalByTextId = {};
  for (const s of staffRes.staff) {
    staffInternalByTextId[String(s.staff_id || "").trim()] = s.id;
  }

  for (const row of coverage || []) {
    const roleKey = String(row.role_key || "").trim();
    const legacyRole = LEGACY_ASSIGNMENT_ROLE_BY_KEY[roleKey];
    if (!legacyRole) continue;
    if (
      (roleKey === "building_super" ||
        roleKey === "office_pm" ||
        roleKey === "office_staff" ||
        roleKey === "leasing" ||
        roleKey === "owner") &&
      row.is_primary !== true
    ) {
      continue;
    }
    const sid = String(row.staff_id || "").trim();
    const internalId = staffInternalByTextId[sid];
    if (!internalId) continue;
    const { error: insErr } = await sb.from("staff_assignments").insert({
      staff_id: internalId,
      property_code: code,
      role: legacyRole,
    });
    if (insErr && !/duplicate|unique/i.test(String(insErr.message || ""))) {
      return { ok: false, error: insErr.message, status: 500 };
    }
  }

  return { ok: true };
}

async function getTeamSettingsBundleForOrg(sb, orgId) {
  const oid = normOrg(orgId);
  if (!sb) return { ok: false, error: "no_db" };

  const prefs = await getOrgResponsibilityPrefs(sb, oid);
  if (!prefs.ok) return prefs;

  const escalation = await getEscalationConfigForOrg(sb, oid);
  if (!escalation.ok) return escalation;

  const coverage = await listCoverageForOrg(sb, oid);
  if (!coverage.ok) return coverage;

  const staffRes = await loadOrgStaffByStaffId(sb, oid);
  if (!staffRes.ok) return staffRes;

  const { data: props, error: pErr } = await sb
    .from("properties")
    .select("code, display_name, active")
    .eq("org_id", oid)
    .order("code", { ascending: true });
  if (pErr) return { ok: false, error: pErr.message };

  const properties = (props || [])
    .filter((p) => String(p.code || "").trim().toUpperCase() !== "GLOBAL")
    .map((p) => ({
      propertyCode: String(p.code || "").trim().toUpperCase(),
      displayName: String(p.display_name || "").trim(),
      active: p.active !== false,
    }));

  const globalOwner = (coverage.coverage || []).find(
    (c) => c.propertyCode === "GLOBAL" && c.roleKey === "owner" && c.isPrimary
  );

  const rulesRes = await listAssignmentRulesForOrg(sb, oid);
  if (!rulesRes.ok) return rulesRes;

  return {
    ok: true,
    roleCatalog: getRoleCatalog(),
    assignmentModules: ASSIGNMENT_MODULES.map((m) => ({ ...m })),
    assignmentRules: rulesRes.rules,
    enabledRoleKeys: prefs.enabledRoleKeys,
    escalation: escalation.escalation,
    coverage: coverage.coverage,
    globalOwnerStaffId: globalOwner ? globalOwner.staffId : "",
    staff: staffRes.staff.map((s) => ({
      staffId: String(s.staff_id || "").trim(),
      displayName: String(s.display_name || "").trim(),
    })),
    properties,
  };
}

module.exports = {
  getTeamSettingsBundleForOrg,
  patchOrgResponsibilityPrefs,
  getEscalationConfigForOrg,
  patchEscalationConfigForOrg,
  savePropertyCoverageForOrg,
  saveGlobalOwnerForOrg,
  copyPropertyCoverageToAll,
  listCoverageForOrg,
  syncLegacyAssignmentsForProperty,
};
