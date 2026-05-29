/**
 * CME-1 read-only DAL — conflict cases and policies for portal list/detail.
 */
const { getSupabase } = require("../db/supabase");

function mapCaseRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id || "",
    propertyCode: row.property_code,
    caseKind: row.case_kind,
    state: row.state,
    subjectUnit: row.subject_unit || "",
    subjectTenantRosterId: row.subject_tenant_roster_id || null,
    complainantProtected: row.complainant_protected === true,
    complainantRosterId: row.complainant_roster_id || null,
    policyId: row.policy_id || null,
    maintenanceTicketRowId: row.maintenance_ticket_row_id || null,
    summary: row.summary || "",
    openedBy: row.opened_by || "",
    closedReason: row.closed_reason || "",
    currentNoticeTier: row.current_notice_tier || null,
    monitoringStartedAt: row.monitoring_started_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    eventKind: row.event_kind,
    fromState: row.from_state || null,
    toState: row.to_state || null,
    noticeTier: row.notice_tier || null,
    policyRecordId: row.policy_record_id || "",
    actor: row.actor || "",
    note: row.note || "",
    payloadJson: row.payload_json || {},
    createdAt: row.created_at,
  };
}

function mapPolicyRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id || "",
    propertyCode: row.property_code,
    policyKey: row.policy_key || "",
    title: row.title || "",
    summary: row.summary || "",
    enforceableText: row.enforceable_text || "",
    defaultNoticeTier: row.default_notice_tier,
    active: row.active === true,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.propertyCode]
 * @param {string} [opts.state]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 */
async function listConflictCasesForPortal(opts = {}) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const propertyCode = String(opts.propertyCode || opts.property_code || "")
    .trim()
    .toUpperCase();

  let q = sb
    .from("conflict_cases")
    .select(
      "id, org_id, property_code, case_kind, state, subject_unit, summary, opened_by, current_notice_tier, monitoring_started_at, created_at, updated_at",
      { count: "exact" }
    )
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (propertyCode) q = q.eq("property_code", propertyCode);
  if (opts.state) q = q.eq("state", String(opts.state).trim().toUpperCase());

  const { data, error, count } = await q;
  if (error) return { ok: false, error: error.message || "list_failed" };

  return {
    ok: true,
    cases: (data || []).map(mapCaseRow),
    total: count != null ? count : (data || []).length,
    limit,
    offset,
  };
}

/**
 * @param {string} caseId
 */
async function getConflictCaseDetailForPortal(caseId) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const id = String(caseId || "").trim();
  if (!id) return { ok: false, error: "missing_case_id" };

  const { data: caseRow, error: caseErr } = await sb
    .from("conflict_cases")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (caseErr) return { ok: false, error: caseErr.message || "detail_failed" };
  if (!caseRow) return { ok: false, error: "not_found" };

  const { data: events, error: evErr } = await sb
    .from("conflict_case_events")
    .select("*")
    .eq("case_id", id)
    .order("created_at", { ascending: true });

  if (evErr) return { ok: false, error: evErr.message || "events_failed" };

  let policy = null;
  if (caseRow.policy_id) {
    const { data: pol } = await sb
      .from("conflict_policies")
      .select("*")
      .eq("id", caseRow.policy_id)
      .maybeSingle();
    policy = mapPolicyRow(pol);
  }

  return {
    ok: true,
    case: mapCaseRow(caseRow),
    events: (events || []).map(mapEventRow),
    policy,
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.propertyCode]
 */
async function listConflictPoliciesForPortal(opts = {}) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const propertyCode = String(opts.propertyCode || opts.property_code || "")
    .trim()
    .toUpperCase();

  let q = sb
    .from("conflict_policies")
    .select("*")
    .eq("active", true)
    .order("policy_key", { ascending: true });

  if (propertyCode) q = q.eq("property_code", propertyCode);

  const { data, error } = await q;
  if (error) return { ok: false, error: error.message || "list_policies_failed" };

  return { ok: true, policies: (data || []).map(mapPolicyRow) };
}

module.exports = {
  listConflictCasesForPortal,
  getConflictCaseDetailForPortal,
  listConflictPoliciesForPortal,
  mapCaseRow,
  mapEventRow,
  mapPolicyRow,
};
