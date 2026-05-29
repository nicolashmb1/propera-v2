/**
 * CME-2 write DAL — report_policy_violation + issue_policy_notice (courtesy tier).
 * @see docs/CONFLICT_MEDIATION_ENGINE.md
 */
const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("../dal/appendEventLog");
const { isSmsOptedOut } = require("../dal/smsOptOut");
const { dispatchOutbound } = require("../outgate/dispatchOutbound");
const { twilioOutboundEnabled } = require("../config/env");
const { mapCaseRow, getConflictCaseDetailForPortal } = require("./conflictCaseRead");
const { buildConflictCourtesyNotice } = require("./conflictNoticeOutgate");
const {
  validateReportPolicyViolationBody,
  validateIssueCourtesyNotice,
  CME2_NOTICE_TIER,
} = require("./validateConflictAction");
const { resolveSubjectTenantForConflict } = require("./resolveSubjectTenant");

async function appendCaseEvent(sb, row) {
  const { error } = await sb.from("conflict_case_events").insert({
    case_id: row.caseId,
    event_kind: row.eventKind || "STATE_CHANGE",
    from_state: row.fromState || null,
    to_state: row.toState || null,
    notice_tier: row.noticeTier || null,
    policy_record_id: String(row.policyRecordId || "").trim(),
    actor: String(row.actor || "").trim(),
    note: String(row.note || "").trim(),
    payload_json: row.payloadJson && typeof row.payloadJson === "object" ? row.payloadJson : {},
  });
  if (error) return { ok: false, error: error.message || "event_insert_failed" };
  return { ok: true };
}

async function loadPropertyLabel(sb, propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  const { data } = await sb
    .from("properties")
    .select("code, short_name, name")
    .eq("code", code)
    .maybeSingle();
  if (!data) return code;
  return String(data.short_name || data.name || data.code || code).trim() || code;
}

async function loadPolicyById(sb, policyId, propertyCode) {
  const id = String(policyId || "").trim();
  if (!id) return { ok: true, policy: null };
  const { data, error } = await sb
    .from("conflict_policies")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message || "policy_lookup_failed" };
  if (!data) return { ok: false, error: "policy_not_found" };
  const code = String(propertyCode || "").trim().toUpperCase();
  if (String(data.property_code || "").trim().toUpperCase() !== code) {
    return { ok: false, error: "policy_property_mismatch" };
  }
  if (data.active !== true) return { ok: false, error: "policy_inactive" };
  return { ok: true, policy: data };
}

/**
 * Staff report observed policy violation — opens case (CME-2).
 * @param {object} body
 * @param {{ traceId?: string }} [opts]
 */
async function reportPolicyViolation(body, opts = {}) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const validated = validateReportPolicyViolationBody(body);
  if (!validated.ok) return validated;

  const { propertyCode, subjectUnit, summary, policyId, openedBy, subjectTenantRosterId } =
    validated.payload;

  let policyRow = null;
  if (policyId) {
    const pol = await loadPolicyById(sb, policyId, propertyCode);
    if (!pol.ok) return pol;
    policyRow = pol.policy;
  }

  const tenantRes = await resolveSubjectTenantForConflict(
    sb,
    propertyCode,
    subjectUnit,
    subjectTenantRosterId
  );
  if (!tenantRes.ok) return tenantRes;

  const toState = policyRow ? "CASE_OPEN" : "POLICY_MATCH";
  const nowIso = new Date().toISOString();

  const { data: inserted, error: insertErr } = await sb
    .from("conflict_cases")
    .insert({
      property_code: propertyCode,
      case_kind: "VIOLATION",
      state: toState,
      subject_unit: subjectUnit,
      subject_tenant_roster_id: tenantRes.tenant.id,
      complainant_protected: false,
      policy_id: policyRow ? policyRow.id : null,
      summary,
      opened_by: openedBy,
      current_notice_tier: null,
      updated_at: nowIso,
    })
    .select("*")
    .single();

  if (insertErr || !inserted) {
    return { ok: false, error: insertErr?.message || "case_insert_failed" };
  }

  const caseId = inserted.id;
  const actor = openedBy;

  await appendCaseEvent(sb, {
    caseId,
    eventKind: "STATE_CHANGE",
    fromState: null,
    toState: "INTAKE",
    actor,
    note: "Case reported",
    payloadJson: { action: "report_policy_violation" },
  });

  await appendCaseEvent(sb, {
    caseId,
    eventKind: policyRow ? "POLICY_APPLIED" : "STATE_CHANGE",
    fromState: "INTAKE",
    toState,
    actor,
    note: policyRow
      ? `Policy matched: ${policyRow.title || policyRow.policy_key}`
      : "Awaiting policy match",
    policyRecordId: policyRow ? String(policyRow.id) : "",
    payloadJson: {
      action: "report_policy_violation",
      policy_key: policyRow ? policyRow.policy_key : null,
      subject_tenant_roster_id: tenantRes.tenant.id,
    },
  });

  await appendEventLog({
    traceId: opts.traceId,
    log_kind: "conflict_mediation",
    event: "CME_CASE_OPENED",
    payload: {
      case_id: caseId,
      property_code: propertyCode,
      state: toState,
      policy_id: policyRow ? policyRow.id : null,
    },
  });

  return getConflictCaseDetailForPortal(caseId);
}

/**
 * Preview courtesy notice body without sending.
 * @param {string} caseId
 */
async function previewPolicyNotice(caseId) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const detail = await getConflictCaseDetailForPortal(caseId);
  if (!detail.ok) return detail;

  const caseRow = detail.case;
  const gate = validateIssueCourtesyNotice({
    state: caseRow.state,
    policy_id: caseRow.policyId,
    current_notice_tier: caseRow.currentNoticeTier,
  });
  if (!gate.ok) return gate;

  const policy = detail.policy;
  if (!policy) return { ok: false, error: "policy_not_found" };

  const propertyLabel = await loadPropertyLabel(sb, caseRow.propertyCode);
  const body = buildConflictCourtesyNotice({
    propertyLabel,
    propertyCode: caseRow.propertyCode,
    subjectUnit: caseRow.subjectUnit,
    policyTitle: policy.title,
    enforceableText: policy.enforceableText,
    noticeTier: gate.tier,
  });

  return {
    ok: true,
    noticeTier: gate.tier,
    messageBody: body,
    case: caseRow,
    policy,
  };
}

/**
 * Issue courtesy-tier policy notice and send SMS to subject tenant (CME-2).
 * @param {string} caseId
 * @param {object} [body]
 * @param {{ traceId?: string, dryRun?: boolean }} [opts]
 */
async function issuePolicyNotice(caseId, body = {}, opts = {}) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(caseId || "").trim();
  if (!id) return { ok: false, error: "missing_case_id" };

  const { data: caseRow, error: caseErr } = await sb
    .from("conflict_cases")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (caseErr) return { ok: false, error: caseErr.message || "case_lookup_failed" };
  if (!caseRow) return { ok: false, error: "not_found" };

  const gate = validateIssueCourtesyNotice(caseRow);
  if (!gate.ok) return gate;

  const actor = String(body.actor || body.openedBy || body.opened_by || "PORTAL").trim() || "PORTAL";
  const fromState = String(caseRow.state || "").trim().toUpperCase();

  const pol = await loadPolicyById(sb, caseRow.policy_id, caseRow.property_code);
  if (!pol.ok) return pol;
  const policyRow = pol.policy;

  const tenantRes = await resolveSubjectTenantForConflict(
    sb,
    caseRow.property_code,
    caseRow.subject_unit,
    caseRow.subject_tenant_roster_id
  );
  if (!tenantRes.ok) return tenantRes;

  const optedOut = await isSmsOptedOut(tenantRes.tenant.phoneE164);
  if (optedOut) return { ok: false, error: "subject_sms_opt_out" };

  const propertyLabel = await loadPropertyLabel(sb, caseRow.property_code);
  const messageBody = buildConflictCourtesyNotice({
    propertyLabel,
    propertyCode: caseRow.property_code,
    subjectUnit: caseRow.subject_unit,
    policyTitle: policyRow.title,
    enforceableText: policyRow.enforceable_text,
    noticeTier: gate.tier,
  });

  if (opts.dryRun || body.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      noticeTier: gate.tier,
      messageBody,
      case: mapCaseRow(caseRow),
    };
  }

  const nowIso = new Date().toISOString();

  const { error: draftErr } = await sb
    .from("conflict_cases")
    .update({
      state: "NOTICE_DRAFTED",
      current_notice_tier: gate.tier,
      updated_at: nowIso,
    })
    .eq("id", id);

  if (draftErr) return { ok: false, error: draftErr.message || "case_update_failed" };

  await appendCaseEvent(sb, {
    caseId: id,
    eventKind: "STATE_CHANGE",
    fromState,
    toState: "NOTICE_DRAFTED",
    noticeTier: gate.tier,
    actor,
    note: "Courtesy notice drafted",
    policyRecordId: String(policyRow.id),
    payloadJson: { action: "issue_policy_notice", tier: gate.tier },
  });

  if (!twilioOutboundEnabled()) {
    await sb
      .from("conflict_cases")
      .update({ state: fromState, current_notice_tier: null, updated_at: nowIso })
      .eq("id", id);
    return { ok: false, error: "twilio_outbound_disabled", messageBody };
  }

  const sendResult = await dispatchOutbound({
    traceId: opts.traceId,
    transportChannel: "sms",
    twilioTo: tenantRes.tenant.phoneE164,
    body: messageBody,
    dispatchMeta: {
      intentType: "conflict_policy_notice",
      caseId: id,
      noticeTier: gate.tier,
    },
  });

  if (!sendResult.ok) {
    await appendCaseEvent(sb, {
      caseId: id,
      eventKind: "COMMENT",
      fromState: "NOTICE_DRAFTED",
      toState: "NOTICE_DRAFTED",
      noticeTier: gate.tier,
      actor,
      note: "Notice send failed",
      policyRecordId: String(policyRow.id),
      payloadJson: {
        action: "issue_policy_notice",
        error: sendResult.error || "send_failed",
        phone: tenantRes.tenant.phoneE164,
      },
    });
    await sb
      .from("conflict_cases")
      .update({ state: fromState, updated_at: nowIso })
      .eq("id", id);
    return {
      ok: false,
      error: sendResult.error || "notice_send_failed",
      messageBody,
    };
  }

  const { error: sentErr } = await sb
    .from("conflict_cases")
    .update({
      state: "NOTICE_SENT",
      current_notice_tier: gate.tier,
      updated_at: nowIso,
    })
    .eq("id", id);

  if (sentErr) return { ok: false, error: sentErr.message || "case_finalize_failed" };

  await appendCaseEvent(sb, {
    caseId: id,
    eventKind: "NOTICE",
    fromState: "NOTICE_DRAFTED",
    toState: "NOTICE_SENT",
    noticeTier: gate.tier,
    actor,
    note: "Courtesy notice sent",
    policyRecordId: String(policyRow.id),
    payloadJson: {
      action: "issue_policy_notice",
      phone: tenantRes.tenant.phoneE164,
      message_preview: messageBody.slice(0, 280),
      twilio_message_id: sendResult.sid || null,
    },
  });

  await appendEventLog({
    traceId: opts.traceId,
    log_kind: "conflict_mediation",
    event: "CME_NOTICE_SENT",
    payload: {
      case_id: id,
      property_code: caseRow.property_code,
      notice_tier: gate.tier,
      phone: tenantRes.tenant.phoneE164,
    },
  });

  const detail = await getConflictCaseDetailForPortal(id);
  return {
    ...detail,
    noticeTier: gate.tier,
    messageBody,
    send: { ok: true },
  };
}

module.exports = {
  reportPolicyViolation,
  issuePolicyNotice,
  previewPolicyNotice,
  CME2_NOTICE_TIER,
};
