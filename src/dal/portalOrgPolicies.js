/**
 * MO-2c / PC-2 — org-scoped operational policy admin (property_policy + audit log).
 * Settings catalog only; brain resolves via getSchedPolicySnapshot / resolveOperationalPolicy.
 * @see docs/OPERATIONAL_POLICY_CONFIG.md
 */
const { POLICY_DEFAULTS } = require("../brain/policy/resolveOperationalPolicy");
const { PP_DEFAULTS } = require("../dal/propertyPolicy");

/** Never expose in Settings (secrets / legacy tokens). */
const POLICY_UI_BLOCKLIST = new Set(["PORTAL_API_TOKEN_PM"]);

function numKey(policyKey, label, description, group, min, max, codeDefault) {
  return { policyKey, label, description, group, valueType: "NUMBER", min, max, codeDefault };
}

function boolKey(policyKey, label, description, group, codeDefault) {
  return { policyKey, label, description, group, valueType: "BOOL", codeDefault };
}

function textKey(policyKey, label, description, group, codeDefault = "") {
  return { policyKey, label, description, group, valueType: "TEXT", codeDefault };
}

/** Keys aligned with property_policy seed (004) + conflict (068). Secrets excluded. */
const POLICY_CATALOG = [
  // Scheduling
  numKey(
    "SCHED_EARLIEST_HOUR",
    "Earliest schedule hour",
    "Earliest hour (0–23) tenants may request maintenance visits.",
    "scheduling",
    0,
    23,
    PP_DEFAULTS.SCHED_EARLIEST_HOUR
  ),
  numKey(
    "SCHED_LATEST_HOUR",
    "Latest schedule hour",
    "Latest hour (0–23) for same-day scheduling windows.",
    "scheduling",
    0,
    23,
    PP_DEFAULTS.SCHED_LATEST_HOUR
  ),
  boolKey(
    "SCHED_ALLOW_WEEKENDS",
    "Allow weekend scheduling",
    "When false, Saturday and Sunday requests are rejected unless sat/sun flags override.",
    "scheduling",
    PP_DEFAULTS.SCHED_ALLOW_WEEKENDS
  ),
  boolKey("SCHED_SAT_ALLOWED", "Allow Saturday", "Permit Saturday maintenance windows.", "scheduling", PP_DEFAULTS.SCHED_SAT_ALLOWED),
  boolKey("SCHED_SUN_ALLOWED", "Allow Sunday", "Permit Sunday maintenance windows.", "scheduling", PP_DEFAULTS.SCHED_SUN_ALLOWED),
  numKey(
    "SCHED_SAT_LATEST_HOUR",
    "Saturday latest hour",
    "Latest hour on Saturdays when Saturday scheduling is allowed.",
    "scheduling",
    0,
    23,
    13
  ),
  numKey(
    "SCHED_MIN_LEAD_HOURS",
    "Minimum lead time (hours)",
    "How far in advance a visit must be booked.",
    "scheduling",
    0,
    168,
    PP_DEFAULTS.SCHED_MIN_LEAD_HOURS
  ),
  numKey(
    "SCHED_MAX_DAYS_OUT",
    "Max days ahead",
    "Latest day tenants may schedule into the future.",
    "scheduling",
    1,
    90,
    PP_DEFAULTS.SCHED_MAX_DAYS_OUT
  ),
  numKey(
    "SCHEDULE_BUFFER_HOURS",
    "Schedule buffer (hours)",
    "Minimum hours between now and the start of a requested window.",
    "scheduling",
    0,
    72,
    4
  ),

  // Conflict mediation
  numKey(
    "conflict.monitoring_window_days",
    "Conflict monitoring window (days)",
    "Days in MONITORING before auto-escalation is eligible (CME).",
    "conflict",
    1,
    90,
    POLICY_DEFAULTS["conflict.monitoring_window_days"]
  ),
  numKey(
    "conflict.auto_escalate_after_violations",
    "Auto-escalate after violations",
    "Violation count in rolling window before escalation.",
    "conflict",
    1,
    20,
    POLICY_DEFAULTS["conflict.auto_escalate_after_violations"]
  ),
  {
    policyKey: "conflict.complainant_confidentiality",
    label: "Complainant confidentiality",
    description: "How resident identity is protected in conflict cases.",
    group: "conflict",
    valueType: "ENUM",
    enumValues: ["always", "on_request", "pm_decides"],
    codeDefault: POLICY_DEFAULTS["conflict.complainant_confidentiality"],
  },

  // Lifecycle core
  boolKey(
    "LIFECYCLE_ENABLED",
    "Lifecycle engine enabled",
    "When false, lifecycle timers and stage automation are off for this scope.",
    "lifecycle",
    true
  ),
  boolKey(
    "POLICY_ENGINE_ENABLED",
    "Policy engine enabled",
    "Master switch for automated policy evaluation on intake and lifecycle.",
    "lifecycle",
    true
  ),
  boolKey(
    "POLICY_ENGINE_DRY_RUN",
    "Policy engine dry run",
    "When true, policy decisions are logged but not applied (property override).",
    "lifecycle",
    false
  ),

  // Contact hours
  numKey(
    "CONTACT_EARLIEST_HOUR",
    "Contact earliest hour",
    "Earliest hour for tenant/staff outreach pings.",
    "contact_hours",
    0,
    23,
    8
  ),
  numKey(
    "CONTACT_LATEST_HOUR",
    "Contact latest hour",
    "Latest hour for tenant/staff outreach pings.",
    "contact_hours",
    0,
    23,
    18
  ),
  boolKey("CONTACT_SAT_ALLOWED", "Contact on Saturday", "Allow outreach pings on Saturdays.", "contact_hours", true),
  numKey("CONTACT_SAT_LATEST_HOUR", "Saturday contact latest hour", "Latest outreach hour on Saturdays.", "contact_hours", 0, 23, 16),
  boolKey("CONTACT_SUN_ALLOWED", "Contact on Sunday", "Allow outreach pings on Sundays.", "contact_hours", false),

  // Tenant verify
  boolKey(
    "TENANT_VERIFY_REQUIRED",
    "Tenant verify required",
    "Require tenant confirmation before certain lifecycle transitions.",
    "tenant_verify",
    false
  ),
  numKey(
    "TENANT_VERIFY_HOURS",
    "Tenant verify window (hours)",
    "Hours allowed for tenant to respond to a verify ping.",
    "tenant_verify",
    1,
    168,
    12
  ),
  boolKey(
    "TENANT_VERIFY_RESPECT_CONTACT_HOURS",
    "Tenant verify respects contact hours",
    "Delay tenant verify pings outside contact hours.",
    "tenant_verify",
    true
  ),

  // Staff update pings
  numKey(
    "STAFF_UPDATE_PING_HOURS",
    "Staff update ping interval (hours)",
    "Hours between staff update reminder pings.",
    "staff_updates",
    1,
    168,
    4
  ),
  numKey(
    "STAFF_UPDATE_MAX_ATTEMPTS",
    "Staff update max attempts",
    "Maximum staff update pings before escalation.",
    "staff_updates",
    1,
    20,
    3
  ),
  boolKey(
    "PING_STAFF_UPDATE_RESPECT_CONTACT_HOURS",
    "Staff update pings respect contact hours",
    "Delay staff update pings outside contact hours.",
    "staff_updates",
    true
  ),

  // Parts / waiting
  numKey(
    "PARTS_WAIT_MAX_HOURS",
    "Parts wait max (hours)",
    "Maximum hours in waiting-for-parts before escalation.",
    "parts_wait",
    1,
    720,
    48
  ),
  numKey("PARTS_ETA_BUFFER_HOURS", "Parts ETA buffer (hours)", "Buffer added to vendor ETA commitments.", "parts_wait", 0, 168, 0),
  numKey(
    "PARTS_ETA_ASK_REPEAT_HOURS",
    "Parts ETA re-ask interval (hours)",
    "Hours between parts ETA follow-up asks.",
    "parts_wait",
    1,
    168,
    48
  ),
  numKey(
    "PARTS_ETA_MAX_ATTEMPTS",
    "Parts ETA max attempts",
    "Maximum parts ETA follow-ups before escalation.",
    "parts_wait",
    1,
    20,
    2
  ),

  // Unscheduled work
  numKey(
    "UNSCHEDULED_FIRST_PING_HOURS",
    "Unscheduled first ping (hours)",
    "Hours after WI creation before first unscheduled ping.",
    "unscheduled",
    1,
    168,
    24
  ),
  numKey(
    "UNSCHEDULED_REPEAT_PING_HOURS",
    "Unscheduled repeat ping (hours)",
    "Hours between repeat unscheduled pings.",
    "unscheduled",
    1,
    168,
    24
  ),
  numKey(
    "UNSCHEDULED_MAX_ATTEMPTS",
    "Unscheduled max attempts",
    "Maximum unscheduled pings before escalation.",
    "unscheduled",
    1,
    20,
    3
  ),
  boolKey(
    "PING_UNSCHEDULED_RESPECT_CONTACT_HOURS",
    "Unscheduled pings respect contact hours",
    "Delay unscheduled pings outside contact hours.",
    "unscheduled",
    true
  ),

  // Timer / auto-close rules
  boolKey(
    "TIMER_ESCALATE_RESPECT_CONTACT_HOURS",
    "Timer escalate respects contact hours",
    "Delay timer-driven escalations outside contact hours.",
    "timer_rules",
    true
  ),
  boolKey(
    "AUTO_CLOSE_RESPECT_CONTACT_HOURS",
    "Auto-close respects contact hours",
    "Delay auto-close actions outside contact hours.",
    "timer_rules",
    false
  ),

  // Property routing (override per property)
  textKey(
    "ASSIGN_DEFAULT_OWNER",
    "Default owner staff ID",
    "Staff ID assigned as default ticket owner for this property (e.g. STAFF_NICK). Property override.",
    "routing",
    ""
  ),
];

const POLICY_GROUP_ORDER = [
  "scheduling",
  "conflict",
  "lifecycle",
  "contact_hours",
  "tenant_verify",
  "staff_updates",
  "parts_wait",
  "unscheduled",
  "timer_rules",
  "routing",
];

const CATALOG_BY_KEY = Object.fromEntries(POLICY_CATALOG.map((c) => [c.policyKey, c]));
const ALL_POLICY_KEYS = POLICY_CATALOG.map((c) => c.policyKey);

function normOrg(orgId) {
  return String(orgId || "").trim().toLowerCase();
}

function normPropertyCode(code) {
  return String(code || "").trim().toUpperCase();
}

function parseStoredValue(row) {
  if (!row) return undefined;
  const t = String(row.value_type || "").toUpperCase();
  const raw = String(row.value != null ? row.value : "").trim();
  if (t === "BOOL") return /^true$/i.test(raw);
  if (t === "NUMBER") {
    const n = Number(raw);
    return raw === "" || !isFinite(n) ? NaN : n;
  }
  if (t === "ENUM" || t === "STRING" || t === "TEXT") return raw;
  const n = Number(raw);
  if (raw !== "" && isFinite(n)) return n;
  return raw;
}

function serializeValue(catalog, value) {
  if (catalog.valueType === "BOOL") {
    const b = value === true || value === "true" || value === "1" || value === 1;
    return { ok: true, value: b ? "TRUE" : "FALSE", valueType: "BOOL" };
  }
  if (catalog.valueType === "NUMBER") {
    const n = Number(value);
    if (!isFinite(n)) return { ok: false, error: "invalid_number" };
    if (catalog.min != null && n < catalog.min) return { ok: false, error: "value_below_min" };
    if (catalog.max != null && n > catalog.max) return { ok: false, error: "value_above_max" };
    return { ok: true, value: String(n), valueType: "NUMBER" };
  }
  if (catalog.valueType === "ENUM") {
    const s = String(value || "").trim().toLowerCase();
    if (!catalog.enumValues.includes(s)) return { ok: false, error: "invalid_enum_value" };
    return { ok: true, value: s, valueType: "STRING" };
  }
  if (catalog.valueType === "TEXT") {
    const s = String(value ?? "").trim().slice(0, 120);
    if (!s) return { ok: false, error: "missing_value" };
    return { ok: true, value: s, valueType: "TEXT" };
  }
  return { ok: false, error: "unsupported_value_type" };
}

async function assertPropertyScopeForOrg(sb, orgId, propertyCode) {
  const code = normPropertyCode(propertyCode);
  if (!code) return { ok: false, error: "missing_property_code", status: 400 };
  if (code === "GLOBAL") return { ok: true, propertyCode: code };

  const oid = normOrg(orgId);
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

async function loadPolicyRows(sb, propertyCodes, policyKeys) {
  const { data, error } = await sb
    .from("property_policy")
    .select("id, property_code, policy_key, value, value_type")
    .in("property_code", propertyCodes)
    .in("policy_key", policyKeys);

  if (error) return { ok: false, error: error.message };
  const map = {};
  for (const row of data || []) {
    const pc = normPropertyCode(row.property_code);
    const pk = String(row.policy_key || "").trim();
    map[`${pc}:${pk}`] = row;
  }
  return { ok: true, map };
}

function mergePolicyEntry(catalog, scopeCode, map) {
  const scope = normPropertyCode(scopeCode);
  const key = catalog.policyKey;
  const scopeRow = map[`${scope}:${key}`];
  const globalRow = scope !== "GLOBAL" ? map[`GLOBAL:${key}`] : null;

  let inheritedFrom = null;
  let value;
  let recordId = "";
  let hasOverride = false;

  if (scopeRow) {
    value = parseStoredValue(scopeRow);
    recordId = String(scopeRow.id || "");
    hasOverride = true;
    if (scope !== "GLOBAL") inheritedFrom = null;
  } else if (globalRow && scope !== "GLOBAL") {
    value = parseStoredValue(globalRow);
    inheritedFrom = "GLOBAL";
    recordId = String(globalRow.id || "");
  } else {
    value = catalog.codeDefault;
    inheritedFrom = "default";
  }

  return {
    policyKey: key,
    label: catalog.label,
    description: catalog.description,
    group: catalog.group,
    valueType: catalog.valueType,
    enumValues: catalog.enumValues || [],
    min: catalog.min ?? null,
    max: catalog.max ?? null,
    value,
    storedValue: scopeRow
      ? String(scopeRow.value ?? "")
      : globalRow && scope !== "GLOBAL"
        ? String(globalRow.value ?? "")
        : "",
    recordId,
    hasOverride,
    inheritedFrom,
    codeDefault: catalog.codeDefault,
  };
}

async function listPoliciesForOrgPortal(sb, orgId, propertyCode) {
  if (!sb) return { ok: false, error: "no_db" };
  const scopeCheck = await assertPropertyScopeForOrg(sb, orgId, propertyCode || "GLOBAL");
  if (!scopeCheck.ok) return scopeCheck;

  const scope = scopeCheck.propertyCode;
  const codes = scope === "GLOBAL" ? ["GLOBAL"] : [scope, "GLOBAL"];
  const loaded = await loadPolicyRows(sb, codes, ALL_POLICY_KEYS);
  if (!loaded.ok) return loaded;

  const policies = POLICY_CATALOG.map((c) => mergePolicyEntry(c, scope, loaded.map));

  return {
    ok: true,
    scope,
    policies,
    groups: POLICY_GROUP_ORDER.filter((g) => POLICY_CATALOG.some((c) => c.group === g)),
  };
}

async function appendPolicyAudit(sb, orgId, propertyCode, policyKey, oldValue, newValue, changedByEmail) {
  const { error } = await sb.from("policy_change_log").insert({
    org_id: normOrg(orgId),
    property_code: normPropertyCode(propertyCode),
    policy_key: policyKey,
    old_value: oldValue != null ? String(oldValue) : null,
    new_value: newValue != null ? String(newValue) : null,
    changed_by_email: String(changedByEmail || "").trim().slice(0, 320),
  });
  if (error && !String(error.message || "").includes("policy_change_log")) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

async function patchPolicyForOrgPortal(sb, orgId, propertyCode, policyKey, rawValue, actor) {
  if (!sb) return { ok: false, error: "no_db" };
  const key = String(policyKey || "").trim();
  const catalog = CATALOG_BY_KEY[key];
  if (!catalog) return { ok: false, error: "unknown_policy_key", status: 400 };

  const scopeCheck = await assertPropertyScopeForOrg(sb, orgId, propertyCode);
  if (!scopeCheck.ok) return scopeCheck;
  const scope = scopeCheck.propertyCode;

  const serialized = serializeValue(catalog, rawValue);
  if (!serialized.ok) {
    return { ok: false, error: serialized.error, status: 400 };
  }

  const { data: existing, error: findErr } = await sb
    .from("property_policy")
    .select("id, value")
    .eq("property_code", scope)
    .eq("policy_key", key)
    .maybeSingle();

  if (findErr) return { ok: false, error: findErr.message, status: 500 };

  const oldValue = existing ? String(existing.value ?? "") : null;

  const { data, error } = await sb
    .from("property_policy")
    .upsert(
      {
        property_code: scope,
        policy_key: key,
        value: serialized.value,
        value_type: serialized.valueType,
      },
      { onConflict: "property_code,policy_key" }
    )
    .select("id, property_code, policy_key, value, value_type")
    .maybeSingle();

  if (error) return { ok: false, error: error.message, status: 500 };

  await appendPolicyAudit(
    sb,
    orgId,
    scope,
    key,
    oldValue,
    serialized.value,
    actor?.emailLower || actor?.email || ""
  );

  const loaded = await loadPolicyRows(sb, scope === "GLOBAL" ? ["GLOBAL"] : [scope, "GLOBAL"], [key]);
  if (!loaded.ok) return loaded;

  return {
    ok: true,
    policy: mergePolicyEntry(catalog, scope, loaded.map),
    row: data,
  };
}

async function clearPolicyOverrideForOrgPortal(sb, orgId, propertyCode, policyKey, actor) {
  if (!sb) return { ok: false, error: "no_db" };
  const key = String(policyKey || "").trim();
  if (!CATALOG_BY_KEY[key]) return { ok: false, error: "unknown_policy_key", status: 400 };

  const scopeCheck = await assertPropertyScopeForOrg(sb, orgId, propertyCode);
  if (!scopeCheck.ok) return scopeCheck;
  const scope = scopeCheck.propertyCode;
  if (scope === "GLOBAL") {
    return { ok: false, error: "cannot_clear_global", status: 400 };
  }

  const { data: existing, error: findErr } = await sb
    .from("property_policy")
    .select("id, value")
    .eq("property_code", scope)
    .eq("policy_key", key)
    .maybeSingle();

  if (findErr) return { ok: false, error: findErr.message, status: 500 };
  if (!existing) return { ok: false, error: "no_override", status: 404 };

  const { error } = await sb
    .from("property_policy")
    .delete()
    .eq("property_code", scope)
    .eq("policy_key", key);

  if (error) return { ok: false, error: error.message, status: 500 };

  await appendPolicyAudit(
    sb,
    orgId,
    scope,
    key,
    String(existing.value ?? ""),
    null,
    actor?.emailLower || actor?.email || ""
  );

  const loaded = await loadPolicyRows(sb, [scope, "GLOBAL"], [key]);
  if (!loaded.ok) return loaded;

  return {
    ok: true,
    policy: mergePolicyEntry(CATALOG_BY_KEY[key], scope, loaded.map),
  };
}

async function listPolicyAuditForOrgPortal(sb, orgId, limit) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  if (!oid) return { ok: false, error: "missing_org_id" };

  const n = Math.min(100, Math.max(1, parseInt(String(limit || "30"), 10) || 30));

  const { data, error } = await sb
    .from("policy_change_log")
    .select("id, property_code, policy_key, old_value, new_value, changed_by_email, created_at")
    .eq("org_id", oid)
    .order("created_at", { ascending: false })
    .limit(n);

  if (error) {
    if (String(error.message || "").includes("policy_change_log")) {
      return { ok: true, entries: [], auditAvailable: false };
    }
    return { ok: false, error: error.message };
  }

  const entries = (data || []).map((row) => ({
    id: String(row.id || ""),
    propertyCode: normPropertyCode(row.property_code),
    policyKey: String(row.policy_key || "").trim(),
    label: CATALOG_BY_KEY[String(row.policy_key || "").trim()]?.label || row.policy_key,
    oldValue: row.old_value != null ? String(row.old_value) : "",
    newValue: row.new_value != null ? String(row.new_value) : "",
    changedByEmail: String(row.changed_by_email || "").trim(),
    createdAt: String(row.created_at || ""),
  }));

  return { ok: true, entries, auditAvailable: true };
}

module.exports = {
  POLICY_CATALOG,
  POLICY_GROUP_ORDER,
  POLICY_UI_BLOCKLIST,
  listPoliciesForOrgPortal,
  patchPolicyForOrgPortal,
  clearPolicyOverrideForOrgPortal,
  listPolicyAuditForOrgPortal,
};
