/**
 * GAS parity slice: deterministic portion of `properaIntakeAttachClassify_`
 * — `10_CANONICAL_INTAKE_ENGINE.gs` (pre-merge attachment / message-role classifier).
 *
 * PARITY GAP: no canonical IntakeMemory sheet, no AI assist path, no global clarify guards —
 * V2 uses session draft snapshot + expected stage only. See docs/PARITY_LEDGER.md §2.
 */
const {
  extractUnitFromBody,
  resolvePropertyExplicitOnly,
} = require("../staff/lifecycleExtract");

function canonicalInboundLooksScheduleOnly(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.length > 160) return false;
  return /\b(today|tomorrow|tonight|morning|afternoon|evening|noon|am\b|pm\b|after\s+\d|before\s+\d|between|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*-\s*\d{1,2})\b/i.test(
    t
  );
}

function intakeMaintenanceSymptomHeuristic(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  return /\b(broken|break|leak|leaking|clog(?:ged)?|stuck|drain|draining|off\s*track|loose|wobbly|won'?t\s+work|not\s+working|doesn'?t\s+work|smell|mold|mould|spark|smoke|flood|flooding|backed\s+up|back\s+up|handle|hinge|creak|squeak|damage|crack|cracked|missing|ripped|torn|infest|pest|no\s+hot\s+water|no\s+water|not\s+flushing)\b/.test(
    t
  );
}

function intakeExplicitNewTicketMarkers(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (
    /\b(another\s+issue|new\s+issue|separate\s+problem|different\s+(apartment|unit|building|place)|other\s+unit|another\s+unit|unrelated\s+issue)\b/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(also|another|new)\s+(have|got|need)\b[\s\S]{0,120}\b(in\s+apartment|apartment)\s+\d{2,4}\b/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

function intakeContinuationMarkers(text) {
  return /\b(also|and\s+then|,\s*and\b|\band\b\s+(the|my|our|a|an)\b|plus|oh\s+i\s+(?:just\s+)?remembered|actually|as\s+well|additionally)\b/i.test(
    String(text || "")
  );
}

function intakeDeterministicSplitSlotAndResidual(body) {
  const b = String(body || "").trim();
  if (!b) return { slotPart: "", residualPart: "", marker: "" };
  let m = b.match(
    /^([\s\S]{1,220}?)[\.\!\?]\s+(also|and\s+then|and|plus|oh\s+i\s+(?:just\s+)?remembered|actually)\b[\s,:-]+([\s\S]+)$/i
  );
  if (m && m[3] && String(m[3]).trim().length >= 4) {
    return {
      slotPart: String(m[1]).trim(),
      residualPart: String(m[3]).trim(),
      marker: String(m[2] || "").trim(),
    };
  }
  m = b.match(/^(.{1,48}?)\s+(also|and|plus)\s+(.+)$/i);
  if (
    m &&
    String(m[3]).trim().length >= 6 &&
    String(m[1]).trim().length <= 44
  ) {
    return {
      slotPart: String(m[1]).trim(),
      residualPart: String(m[3]).trim(),
      marker: String(m[2] || "").trim(),
    };
  }
  return { slotPart: "", residualPart: "", marker: "" };
}

function intakeLooksPurePropertyUnitAnswer(body, expectedStage, propertiesList) {
  const exp = String(expectedStage || "").trim().toUpperCase();
  if (!(exp === "PROPERTY" || exp === "PROPERTY_AND_UNIT" || exp === "UNIT"))
    return false;
  const b = String(body || "").trim();
  if (!b || b.length > 56) return false;
  if (intakeMaintenanceSymptomHeuristic(b)) return false;
  if (intakeExplicitNewTicketMarkers(b)) return false;
  if (canonicalInboundLooksScheduleOnly(b)) return false;
  const u = extractUnitFromBody(b);
  if (!u) return false;
  const propHit = resolvePropertyExplicitOnly(b, propertiesList || []);
  if (propHit) return true;
  const compact = b.replace(/\s+/g, " ").trim();
  if (/^[\w\.\-]{2,24}\s+#?\d{2,5}$/i.test(compact)) return true;
  return false;
}

function intakeResolvePropertyToken(token, propertiesList) {
  const t = String(token || "").trim();
  if (!t) return null;
  const code = resolvePropertyExplicitOnly(t, propertiesList || []);
  if (code) return { code, name: "" };
  return null;
}

/**
 * @param {object} o
 * @param {string} o.bodyTrim
 * @param {string} o.collectStage
 * @param {{ draft_unit?: string, draft_property?: string, draft_issue?: string }} [o.sessionDraft]
 * @param {Array<{ code: string, display_name?: string, ticket_prefix?: string, short_name?: string, address?: string, aliases?: string[] }>} [o.propertiesList]
 * @param {string} [o.attachClarifyOutcome] — `attach` when GAS ATTACH_CLARIFY latch was just resolved (`16_ROUTER_ENGINE.gs`)
 */
function intakeAttachClassifyDeterministic(o) {
  const bodyTrim = String(o.bodyTrim || "").trim();
  const exp = String(o.collectStage || "").trim().toUpperCase();
  const props = Array.isArray(o.propertiesList) ? o.propertiesList : [];
  const sd = o.sessionDraft && typeof o.sessionDraft === "object" ? o.sessionDraft : {};
  const reasonTags = [];
  const decisionSource = "deterministic";
  const aco = String(o.attachClarifyOutcome || "").trim().toLowerCase();
  let attachmentDecision = "attach_to_active_intake";
  let messageRole = "unknown";
  let suppressRawIssueForMerge = false;
  let overlayIssueText = "";
  const overlayIssueAppends = [];
  let overlayScheduleRaw = "";
  let resolvedProperty = null;
  let resolvedUnit = "";

  const activeIncomplete = !!(
    exp ||
    String(sd.draft_issue || "").trim() ||
    String(sd.draft_property || "").trim() ||
    String(sd.draft_unit || "").trim()
  );

  if (!activeIncomplete || !bodyTrim) {
    return {
      attachmentDecision,
      messageRole: "unknown",
      suppressRawIssueForMerge: false,
      overlayIssueText: "",
      overlayIssueAppends,
      overlayScheduleRaw: "",
      resolvedProperty: null,
      resolvedUnit: "",
      decisionSource,
      reasonTags: ["no_active_incomplete_v2"],
    };
  }

  if (aco === "attach") {
    if (/^\s*1\s*$/.test(bodyTrim)) {
      reasonTags.push("clarify_choice_digit_same");
      return {
        attachmentDecision: "attach_to_active_intake",
        messageRole: "unknown",
        suppressRawIssueForMerge: true,
        overlayIssueText: "",
        overlayIssueAppends,
        overlayScheduleRaw: "",
        resolvedProperty: null,
        resolvedUnit: "",
        decisionSource: "attach_clarify_resolution",
        reasonTags,
      };
    }
    const lc = bodyTrim.toLowerCase();
    const mSame = lc.match(
      /^\s*(same request|same one|this one|this request)\b[\s,.\-:]*/i
    );
    if (mSame) {
      const rest = bodyTrim.slice(mSame[0].length).trim();
      reasonTags.push("clarify_resolved_same_request");
      return {
        attachmentDecision: "attach_to_active_intake",
        messageRole: "unknown",
        suppressRawIssueForMerge: !rest || rest.length < 4,
        overlayIssueText: "",
        overlayIssueAppends,
        overlayScheduleRaw: "",
        resolvedProperty: null,
        resolvedUnit: "",
        decisionSource: "attach_clarify_resolution",
        reasonTags,
      };
    }
    reasonTags.push("attach_clarify_forced_attach");
    return {
      attachmentDecision: "attach_to_active_intake",
      messageRole: "unknown",
      suppressRawIssueForMerge: false,
      overlayIssueText: "",
      overlayIssueAppends,
      overlayScheduleRaw: "",
      resolvedProperty: null,
      resolvedUnit: "",
      decisionSource: "attach_clarify_resolution",
      reasonTags,
    };
  }

  if (intakeExplicitNewTicketMarkers(bodyTrim)) {
    reasonTags.push("explicit_new_ticket_marker");
    return {
      attachmentDecision: "start_new_intake",
      messageRole: "explicit_new_ticket",
      suppressRawIssueForMerge: false,
      overlayIssueText: "",
      overlayIssueAppends,
      overlayScheduleRaw: "",
      resolvedProperty: null,
      resolvedUnit: "",
      decisionSource,
      reasonTags,
    };
  }

  const recUnitNow = String(sd.draft_unit || "").trim().toUpperCase();
  const uCandNow = String(extractUnitFromBody(bodyTrim) || "")
    .trim()
    .toUpperCase();
  if (!aco && recUnitNow && uCandNow && uCandNow !== recUnitNow) {
    attachmentDecision = "clarify_attach_vs_new";
    messageRole = "unknown";
    suppressRawIssueForMerge = false;
    reasonTags.push("unit_mismatch_without_explicit_new_ticket");
    return {
      attachmentDecision,
      messageRole,
      suppressRawIssueForMerge,
      overlayIssueText: "",
      overlayIssueAppends,
      overlayScheduleRaw: "",
      resolvedProperty: null,
      resolvedUnit: "",
      decisionSource,
      reasonTags,
    };
  }

  if (
    (exp === "PROPERTY" ||
      exp === "PROPERTY_AND_UNIT" ||
      exp === "UNIT" ||
      exp === "SCHEDULE" ||
      exp === "SCHEDULE_PRETICKET" ||
      exp === "FINALIZE_DRAFT") &&
    canonicalInboundLooksScheduleOnly(bodyTrim) &&
    !intakeMaintenanceSymptomHeuristic(bodyTrim) &&
    !intakeContinuationMarkers(bodyTrim)
  ) {
    messageRole = "schedule_fill_only";
    suppressRawIssueForMerge = true;
    overlayScheduleRaw = bodyTrim;
    reasonTags.push("schedule_window_only");
    return {
      attachmentDecision,
      messageRole,
      suppressRawIssueForMerge,
      overlayIssueText,
      overlayIssueAppends,
      overlayScheduleRaw,
      resolvedProperty,
      resolvedUnit,
      decisionSource,
      reasonTags,
    };
  }

  const split = intakeDeterministicSplitSlotAndResidual(bodyTrim);
  if (
    split.residualPart &&
    (intakeContinuationMarkers(bodyTrim) || split.marker) &&
    intakeMaintenanceSymptomHeuristic(split.residualPart)
  ) {
    messageRole = "slot_fill_plus_append";
    suppressRawIssueForMerge = true;
    overlayIssueText = split.residualPart;
    reasonTags.push("split_slot_residual", "continuation_marker");
    if (split.slotPart) {
      const uSp = extractUnitFromBody(split.slotPart);
      if (uSp) resolvedUnit = uSp;
      const slotHead = split.slotPart.replace(/\s+\d{1,5}\b.*$/, "").trim();
      const rp =
        intakeResolvePropertyToken(slotHead, props) ||
        intakeResolvePropertyToken(split.slotPart, props);
      if (rp) resolvedProperty = rp;
    }
    return {
      attachmentDecision,
      messageRole,
      suppressRawIssueForMerge,
      overlayIssueText,
      overlayIssueAppends,
      overlayScheduleRaw,
      resolvedProperty,
      resolvedUnit,
      decisionSource,
      reasonTags,
    };
  }

  if (intakeLooksPurePropertyUnitAnswer(bodyTrim, exp, props)) {
    messageRole = "slot_fill_only";
    suppressRawIssueForMerge = true;
    reasonTags.push("pure_property_unit_answer");
    return {
      attachmentDecision,
      messageRole,
      suppressRawIssueForMerge,
      overlayIssueText,
      overlayIssueAppends,
      overlayScheduleRaw,
      resolvedProperty,
      resolvedUnit,
      decisionSource,
      reasonTags,
    };
  }

  if (
    /^(also|and|plus|oh\b|actually)\b/i.test(bodyTrim) &&
    intakeMaintenanceSymptomHeuristic(bodyTrim) &&
    bodyTrim.length >= 8
  ) {
    messageRole = "append_only";
    reasonTags.push("leading_continuation_token");
    return {
      attachmentDecision,
      messageRole,
      suppressRawIssueForMerge: false,
      overlayIssueText,
      overlayIssueAppends,
      overlayScheduleRaw,
      resolvedProperty,
      resolvedUnit,
      decisionSource,
      reasonTags,
    };
  }

  return {
    attachmentDecision,
    messageRole,
    suppressRawIssueForMerge: false,
    overlayIssueText,
    overlayIssueAppends,
    overlayScheduleRaw,
    resolvedProperty,
    resolvedUnit,
    decisionSource,
    reasonTags,
  };
}

module.exports = {
  intakeAttachClassifyDeterministic,
  canonicalInboundLooksScheduleOnly,
  intakeMaintenanceSymptomHeuristic,
};
