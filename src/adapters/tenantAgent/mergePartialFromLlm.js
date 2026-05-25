/**
 * Merge LLM-proposed slot updates into adapter partial package (strict grounding).
 */
const {
  normalizeConversationSignal,
} = require("./handleConversationSignals");
const { normalizeLlmSafetyAssessment } = require("./detectGatherSafety");

const VALID_LOCATION_KINDS = new Set(["unit", "common_area", "property"]);

const META_ISSUE_RE =
  /\b(request for clarification|clarification on|previous message|tenant (is )?confused|unclear (what|request)|not (a )?maintenance)\b/i;

/**
 * @param {string} issue
 * @returns {boolean}
 */
function isMetaMaintenanceIssue(issue) {
  const t = String(issue || "").trim();
  if (!t || t.length < 2) return false;
  return META_ISSUE_RE.test(t);
}

/**
 * @param {object} partial
 * @param {object} updates
 * @param {Set<string>} knownPropertyCodesUpper
 * @returns {object}
 */
function mergePartialFromLlm(partial, updates, knownPropertyCodesUpper) {
  const prev = { ...(partial || {}) };
  const u = updates && typeof updates === "object" ? updates : {};
  const next = { ...prev };

  const prop = String(u.property || u.property_code || "")
    .trim()
    .toUpperCase();
  void prop;
  void knownPropertyCodesUpper;
  // Property slot is set only from inbound text via resolvePropertyForGather — never LLM guess.

  const unit = String(u.unit || u.unit_label || "").trim();
  if (unit) {
    next.unit = unit;
    next.location_kind = "unit";
  }

  const issue = String(u.issue || u.message || "").trim();
  if (issue.length >= 2 && !isMetaMaintenanceIssue(issue)) next.issue = issue;

  const lk = String(u.location_kind || "").trim().toLowerCase();
  if (lk && VALID_LOCATION_KINDS.has(lk)) {
    next.location_kind = lk;
    if (lk === "common_area") {
      next.unit = "";
      delete next.preferredWindow;
      delete next.preferred_window;
    }
  }

  const locLabel = String(u.location_label_snapshot || u.location_label || "").trim();
  if (locLabel) next.location_label_snapshot = locLabel;

  const pw = String(u.preferredWindow || u.preferred_window || "").trim();
  if (pw && String(next.location_kind || "").trim().toLowerCase() !== "common_area") {
    next.preferredWindow = pw;
  }

  const reportUnit = String(u.report_source_unit || u.reportSourceUnit || "").trim();
  if (reportUnit) next.report_source_unit = reportUnit;

  const locale = String(u.tenant_locale || "").trim().toLowerCase();
  if (locale && /^[a-z]{2}(-[a-z]{2})?$/i.test(locale)) {
    next.tenant_locale = locale.slice(0, 2);
  }

  return next;
}

/**
 * @param {unknown} json
 * @returns {boolean}
 */
function isValidTenantAgentLlmTurnJson(json) {
  if (!json || typeof json !== "object") return false;
  const reply = String(json.reply || "").trim();
  if (!reply) return false;
  const updates = json.partial_updates;
  if (updates != null && (typeof updates !== "object" || Array.isArray(updates))) return false;
  return true;
}

/**
 * @param {string} raw
 * @returns {'maintenance_repair' | 'non_maintenance' | ''}
 */
function normalizeRequestIntent(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "non_maintenance" || v === "non-maintenance" || v === "not_maintenance") {
    return "non_maintenance";
  }
  if (
    v === "maintenance_repair" ||
    v === "maintenance" ||
    v === "maintenance_intake" ||
    v === "repair"
  ) {
    return "maintenance_repair";
  }
  return "";
}

/**
 * @param {unknown} json
 * @returns {{ reply: string, partialUpdates: object, handoffReady: boolean, tenantLocale: string, requestIntent: string }}
 */
function normalizeTenantAgentLlmTurn(json) {
  const reply = String(json.reply || "").trim();
  const partialUpdates =
    json.partial_updates && typeof json.partial_updates === "object"
      ? json.partial_updates
      : {};
  const requestIntent = normalizeRequestIntent(
    json.request_intent || json.requestIntent
  );
  const conversationSignal = normalizeConversationSignal(
    json.conversation_signal || json.conversationSignal
  );
  const safetyRaw =
    json.safety_assessment !== undefined
      ? json.safety_assessment
      : json.safetyAssessment;
  const safetyAssessment =
    safetyRaw !== undefined ? normalizeLlmSafetyAssessment(safetyRaw) : undefined;
  return {
    reply,
    partialUpdates,
    handoffReady: json.handoff_ready === true,
    tenantLocale: String(partialUpdates.tenant_locale || json.tenant_locale || "").trim(),
    requestIntent,
    conversationSignal,
    safetyAssessment,
  };
}

module.exports = {
  mergePartialFromLlm,
  isValidTenantAgentLlmTurnJson,
  normalizeTenantAgentLlmTurn,
  normalizeRequestIntent,
  isMetaMaintenanceIssue,
};
