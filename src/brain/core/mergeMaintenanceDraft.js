/**
 * Merge one inbound turn into maintenance draft slots.
 *
 * PARITY GAP: deterministic slice only — not full GAS `draftUpsertFromTurn_` / canonical merge.
 * See docs/PARITY_LEDGER.md §2.
 */
const {
  extractUnitFromBody,
  resolvePropertyExplicitOnly,
  detectPropertyFromBody,
} = require("../staff/lifecycleExtract");
const { parseMaintenanceDraft } = require("./parseMaintenanceDraft");
const {
  intakeAttachClassifyDeterministic,
  canonicalInboundLooksScheduleOnly,
  intakeMaintenanceSymptomHeuristic,
} = require("./intakeAttachClassify");
const { hasProblemSignal } = require("./splitIssueGroups");

/**
 * @param {string} bodyTrim
 * @param {Array<{ code: string, display_name: string }>} propertiesList
 */
function resolvePropertyFromReply(bodyTrim, propertiesList) {
  const t = String(bodyTrim || "").trim();
  if (!t || !propertiesList || propertiesList.length === 0) return "";

  const known = new Set(
    propertiesList.map((p) => String(p.code || "").trim().toUpperCase())
  );
  const strict = resolvePropertyExplicitOnly(t, propertiesList);
  if (strict) return strict;
  const hint = detectPropertyFromBody(t, propertiesList, known);
  if (hint) return hint;

  const tl = t.toLowerCase();
  for (const p of propertiesList) {
    const code = String(p.code || "").toUpperCase();
    const dn = String(p.display_name || "").toLowerCase();
    if (code && tl.includes(code.toLowerCase())) return code;
    if (dn && (tl.includes(dn) || dn.includes(tl))) return code;
  }
  return "";
}

/**
 * @param {object} o
 * @param {string} o.bodyText
 * @param {string} o.expected — ISSUE | PROPERTY | UNIT | SCHEDULE | SCHEDULE_PRETICKET | FINALIZE_DRAFT | ''
 * @param {string} [o.draft_issue]
 * @param {string} [o.draft_property]
 * @param {string} [o.draft_unit]
 * @param {string} [o.draft_schedule_raw]
 * @param {string[]} [o.draft_issue_buf_json]
 * @param {{ propertyCode?: string, unitLabel?: string, issueText?: string, scheduleRaw?: string, openerNext?: string }} [o.parsedDraft] — compile/async parse output
 * @param {Set<string>} o.knownPropertyCodesUpper
 * @param {Array<{ code: string, display_name: string }>} o.propertiesList
 * @param {string} [o.attachClarifyOutcome] — see `intakeAttachClassifyDeterministic`
 */
function mergeMaintenanceDraftTurn(o) {
  const bodyText = String(o.bodyText || "").trim();
  const exp = String(o.expected || "ISSUE").toUpperCase();
  const known = o.knownPropertyCodesUpper || new Set();
  const propertiesList = o.propertiesList || [];

  let issue = String(o.draft_issue != null ? o.draft_issue : "").trim();
  let prop = String(o.draft_property != null ? o.draft_property : "").trim();
  let unit = String(o.draft_unit != null ? o.draft_unit : "").trim();
  let sched = String(o.draft_schedule_raw != null ? o.draft_schedule_raw : "").trim();
  let issueBuf = Array.isArray(o.draft_issue_buf_json)
    ? o.draft_issue_buf_json
        .map((x) => String(x || "").trim())
        .filter((x) => x.length >= 4)
        .slice(0, 24)
    : [];

  const parsed =
    o.parsedDraft && typeof o.parsedDraft === "object"
      ? {
          propertyCode: String(o.parsedDraft.propertyCode || "").trim().toUpperCase(),
          unitLabel: String(o.parsedDraft.unitLabel || "").trim(),
          issueText: String(o.parsedDraft.issueText || "").trim(),
          scheduleRaw: String(o.parsedDraft.scheduleRaw || "").trim(),
          openerNext: String(o.parsedDraft.openerNext || "").trim().toUpperCase(),
        }
      : parseMaintenanceDraft(bodyText, known, propertiesList);
  const hasParsedDraft = !!(o.parsedDraft && typeof o.parsedDraft === "object");

  const attachDec = intakeAttachClassifyDeterministic({
    bodyTrim: bodyText,
    collectStage: exp,
    sessionDraft: {
      draft_issue: issue,
      draft_property: prop,
      draft_unit: unit,
    },
    propertiesList,
    attachClarifyOutcome: o.attachClarifyOutcome,
  });

  if (attachDec.attachmentDecision === "clarify_attach_vs_new") {
    return {
      draft_issue: issue,
      draft_property: prop,
      draft_unit: unit,
      draft_schedule_raw: sched,
      draft_issue_buf_json: issueBuf,
      attachDecision: attachDec.attachmentDecision,
      attachMessageRole: attachDec.messageRole,
      attachReasonTags: attachDec.reasonTags || [],
    };
  }

  function issueKey(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function pushIssueBuffer(txt) {
    const t = String(txt || "").trim();
    if (t.length < 4) return;
    const k = issueKey(t);
    if (!k) return;
    const seen = new Set(issueBuf.map((x) => issueKey(x)));
    if (seen.has(k)) return;
    issueBuf.push(t);
    if (issueBuf.length > 24) issueBuf = issueBuf.slice(0, 24);
  }

  function maybeCaptureIssueFromTurn() {
    if (attachDec.suppressRawIssueForMerge) return;
    const candidate = parsed.issueText;
    if (!candidate) return;
    // UNIT slot: LLM often restates "common area" as meta copy; do not stack that on a real issue.
    if (exp === "UNIT" && issue && !hasProblemSignal(String(candidate).trim())) {
      return;
    }
    if (!issue) {
      issue = candidate;
      pushIssueBuffer(candidate);
      return;
    }
    pushIssueBuffer(candidate);
  }

  if (issue) pushIssueBuffer(issue);

  if (!attachDec.suppressRawIssueForMerge && !issue && parsed.issueText)
    issue = parsed.issueText;
  if (!prop && parsed.propertyCode) prop = parsed.propertyCode;
  // Hydrate unit from the same parse as property/issue (compile turn / regex). Matches fast-path
  // behavior where unitLabel is already applied — avoids "what unit?" when the message included it.

  if (!unit && parsed.unitLabel && String(parsed.unitLabel).trim()) {
    unit = String(parsed.unitLabel).trim();
  }

  if (exp === "ISSUE" || exp === "") {
    if (!attachDec.suppressRawIssueForMerge) {
      if (hasParsedDraft && parsed.issueText) {
        issue = parsed.issueText;
        pushIssueBuffer(parsed.issueText);
      } else if (bodyText) {
        const p2 = parseMaintenanceDraft(bodyText, known, propertiesList);
        issue = p2.issueText || bodyText;
        pushIssueBuffer(issue);
      }
    }
    if (!prop && parsed.propertyCode) prop = parsed.propertyCode;
  } else if (exp === "PROPERTY") {
    // GAS parity class: slot collection turns may still carry actionable issue text.
    maybeCaptureIssueFromTurn();
    const r = resolvePropertyFromReply(bodyText, propertiesList);
    if (r) prop = r;
    if (attachDec.resolvedProperty && attachDec.resolvedProperty.code) {
      prop = String(attachDec.resolvedProperty.code || "").trim().toUpperCase();
    }
    if (attachDec.resolvedUnit) unit = attachDec.resolvedUnit;
  } else if (exp === "UNIT") {
    maybeCaptureIssueFromTurn();
    let u = extractUnitFromBody(bodyText);
    if (!u && /^\s*([0-9]+[a-z]?)\s*$/i.test(bodyText)) {
      u = bodyText.trim();
    }
    if (u) unit = u;
    if (attachDec.resolvedUnit) unit = attachDec.resolvedUnit;
    if (attachDec.resolvedProperty && attachDec.resolvedProperty.code) {
      prop = String(attachDec.resolvedProperty.code || "").trim().toUpperCase();
    }
  } else if (exp === "SCHEDULE" || exp === "SCHEDULE_PRETICKET") {
    maybeCaptureIssueFromTurn();
    if (attachDec.messageRole === "schedule_fill_only") {
      sched = attachDec.overlayScheduleRaw || sched;
    } else if (hasParsedDraft && parsed.scheduleRaw) {
      sched = parsed.scheduleRaw;
    } else if (bodyText) {
      sched = bodyText;
    }
    if (
      (exp === "SCHEDULE" || exp === "SCHEDULE_PRETICKET") &&
      !sched &&
      parsed.issueText &&
      !attachDec.suppressRawIssueForMerge
    ) {
      const probe = String(parsed.issueText || "").trim();
      if (
        canonicalInboundLooksScheduleOnly(probe) &&
        !intakeMaintenanceSymptomHeuristic(probe)
      ) {
        sched = probe;
        parsed.issueText = "";
      }
    }
  }

  if (attachDec.overlayIssueText) {
    const ot = String(attachDec.overlayIssueText || "").trim();
    if (ot.length >= 4) {
      if (!issue) issue = ot;
      pushIssueBuffer(ot);
    }
  }

  return {
    draft_issue: issue,
    draft_property: prop,
    draft_unit: unit,
    draft_schedule_raw: sched,
    draft_issue_buf_json: issueBuf,
    attachDecision: attachDec.attachmentDecision,
    attachMessageRole: attachDec.messageRole,
    attachReasonTags: attachDec.reasonTags || [],
  };
}

module.exports = {
  mergeMaintenanceDraftTurn,
  resolvePropertyFromReply,
};
