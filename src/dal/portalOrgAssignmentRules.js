/**
 * Phase 3 — org auto-assignment rules CRUD (Settings Team & routing).
 * @see docs/RESPONSIBILITY_ROUTING_REFACTOR.md §3.2
 */
const {
  DEFAULT_ORG_ASSIGNMENT_RULES,
  isValidAssignmentModule,
  VALID_TARGET_KINDS,
  isValidRoleKey,
} = require("../responsibility/assignmentRuleCatalog");

function normOrg(orgId) {
  return String(orgId || "").trim().toLowerCase();
}

function mapAssignmentRuleRow(row) {
  return {
    id: String(row.id || ""),
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

async function seedDefaultAssignmentRulesForOrg(sb, orgId) {
  const oid = normOrg(orgId);
  const now = new Date().toISOString();
  const rows = DEFAULT_ORG_ASSIGNMENT_RULES.map((r) => ({
    org_id: oid,
    rule_key: r.ruleKey,
    label: r.label,
    enabled: r.enabled === true,
    priority: r.priority,
    module: r.module,
    property_code: r.propertyCode || "*",
    category_match: "",
    target_kind: r.targetKind,
    target_ref: r.targetRef,
    assign_mode: r.assignMode || "staff",
    updated_at: now,
  }));
  for (const row of rows) {
    const { error } = await sb.from("org_assignment_rules").upsert(row, {
      onConflict: "org_id,rule_key",
    });
    if (error && error.code !== "42P01") {
      return { ok: false, error: error.message };
    }
  }
  return { ok: true };
}

async function listAssignmentRulesForOrg(sb, orgId) {
  const oid = normOrg(orgId);
  const { data, error } = await sb
    .from("org_assignment_rules")
    .select(
      "id, org_id, rule_key, label, enabled, priority, module, property_code, category_match, target_kind, target_ref, assign_mode"
    )
    .eq("org_id", oid)
    .order("module", { ascending: true })
    .order("priority", { ascending: true });

  if (error) {
    if (error.code === "42P01") {
      return { ok: true, rules: DEFAULT_ORG_ASSIGNMENT_RULES.map((r) => ({ ...r, id: "" })), migrationMissing: true };
    }
    return { ok: false, error: error.message, rules: [] };
  }

  if (!data || !data.length) {
    await seedDefaultAssignmentRulesForOrg(sb, oid);
    return listAssignmentRulesForOrg(sb, oid);
  }

  return {
    ok: true,
    rules: (data || []).map(mapAssignmentRuleRow),
    migrationMissing: false,
  };
}

function validateRulePatch(patch, existing) {
  const ruleKey = String(existing?.ruleKey || patch?.ruleKey || "").trim();
  if (!ruleKey) return { ok: false, error: "missing_rule_key", status: 400 };

  const enabled =
    patch.enabled === undefined
      ? existing?.enabled !== false
      : patch.enabled === true || patch.enabled === "1" || patch.enabled === 1;

  let priority =
    patch.priority != null && Number.isFinite(Number(patch.priority))
      ? Math.floor(Number(patch.priority))
      : existing?.priority ?? 100;

  const targetKind = String(patch.targetKind ?? patch.target_kind ?? existing?.targetKind ?? "primary_role").trim();
  if (!VALID_TARGET_KINDS.has(targetKind)) {
    return { ok: false, error: "invalid_target_kind", status: 400 };
  }

  let targetRef = String(patch.targetRef ?? patch.target_ref ?? existing?.targetRef ?? "").trim();
  if (targetKind === "primary_role") {
    if (!isValidRoleKey(targetRef)) {
      return { ok: false, error: "invalid_target_role", status: 400 };
    }
  } else if (!targetRef) {
    return { ok: false, error: "missing_target_ref", status: 400 };
  }

  const label = String(patch.label ?? existing?.label ?? "").trim();

  return {
    ok: true,
    ruleKey,
    enabled,
    priority,
    targetKind,
    targetRef,
    label,
  };
}

async function patchAssignmentRulesForOrg(sb, orgId, body) {
  const oid = normOrg(orgId);
  const list = Array.isArray(body?.rules)
    ? body.rules
    : Array.isArray(body)
      ? body
      : body && typeof body === "object" && body.ruleKey
        ? [body]
        : [];

  if (!list.length) {
    return { ok: false, error: "missing_rules", status: 400 };
  }

  const existingRes = await listAssignmentRulesForOrg(sb, oid);
  if (!existingRes.ok) return existingRes;
  const byKey = {};
  for (const r of existingRes.rules || []) {
    byKey[r.ruleKey] = r;
  }

  const now = new Date().toISOString();
  const updates = [];

  for (const patch of list) {
    const ruleKey = String(patch.ruleKey ?? patch.rule_key ?? "").trim();
    const existing = byKey[ruleKey];
    if (!existing) {
      return { ok: false, error: "rule_not_found", status: 404 };
    }
    if (!isValidAssignmentModule(existing.module)) {
      return { ok: false, error: "invalid_module", status: 400 };
    }
    const v = validateRulePatch(patch, existing);
    if (!v.ok) return v;
    updates.push({
      org_id: oid,
      rule_key: v.ruleKey,
      label: v.label || existing.label,
      enabled: v.enabled,
      priority: v.priority,
      module: existing.module,
      property_code: existing.propertyCode,
      category_match: existing.categoryMatch || "",
      target_kind: v.targetKind,
      target_ref: v.targetRef,
      assign_mode: existing.assignMode || "staff",
      updated_at: now,
    });
  }

  const { error } = await sb.from("org_assignment_rules").upsert(updates, {
    onConflict: "org_id,rule_key",
  });
  if (error) return { ok: false, error: error.message, status: 500 };

  const listed = await listAssignmentRulesForOrg(sb, oid);
  return listed;
}

module.exports = {
  listAssignmentRulesForOrg,
  patchAssignmentRulesForOrg,
  seedDefaultAssignmentRulesForOrg,
  mapAssignmentRuleRow,
};
