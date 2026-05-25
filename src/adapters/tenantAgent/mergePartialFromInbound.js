/**
 * Merge inbound text into adapter partial package using existing maintenance parse (no finalize).
 */
const { parseMaintenanceDraftAsync } = require("../../brain/core/parseMaintenanceDraft");
const { extractUnitFromBody } = require("../../brain/staff/lifecycleExtract");
const { resolveHandoffCategory } = require("./resolveHandoffCategory");
const { applyGatherLocationFields } = require("./resolveGatherLocation");
const {
  resolvePropertyForGather,
  bodyHasPropertyIntent,
} = require("./resolvePropertyForGather");

/**
 * @param {string} body
 * @returns {string}
 */
function leadingUnitFromBody(body) {
  const m = String(body || "")
    .trim()
    .match(/^(\d{1,4}[a-z]?)\s*[.:\-]\s*/i);
  return m ? String(m[1]).trim() : "";
}

/**
 * @param {string} body
 * @returns {boolean}
 */
function isUnitOnlyReply(body) {
  const s = String(body || "").trim();
  return /^(?:#|unit|apt|apartment)\s*\d{1,4}[a-z]?$/i.test(s) || /^\d{1,4}[a-z]?$/i.test(s);
}

/**
 * @param {object} next
 * @param {object} prev
 * @param {object} resolution
 */
function applyPropertyResolution(next, prev, resolution) {
  if (resolution.status === "RESOLVED" && resolution.property_code) {
    next.property = resolution.property_code;
    delete next._property_candidates;
    return;
  }
  if (resolution.status === "AMBIGUOUS") {
    delete next.property;
    next._property_candidates = resolution.candidates;
    return;
  }
  if (prev.property) {
    next.property = prev.property;
  }
}

/**
 * @param {object} partial
 * @param {string} bodyText
 * @param {Set<string>} knownPropertyCodesUpper
 * @param {object[]} propertiesList
 * @param {{ traceId?: string }} [opts]
 * @returns {Promise<object>}
 */
async function mergePartialFromInboundMessage(
  partial,
  bodyText,
  knownPropertyCodesUpper,
  propertiesList,
  opts
) {
  const prev = { ...(partial || {}) };
  const body = String(bodyText || "").trim();
  if (!body) return prev;

  const parsed = await parseMaintenanceDraftAsync(body, knownPropertyCodesUpper, {
    propertiesList,
    traceId: opts && opts.traceId ? opts.traceId : "",
  });

  const next = { ...prev };

  if (bodyHasPropertyIntent(body) || !String(prev.property || "").trim()) {
    const resolution = resolvePropertyForGather(
      body,
      propertiesList,
      knownPropertyCodesUpper
    );
    applyPropertyResolution(next, prev, resolution);
  } else if (prev.property) {
    next.property = prev.property;
  }

  const leadingUnit = leadingUnitFromBody(body);
  if (leadingUnit && !parsed.unitLabel) {
    next.unit = leadingUnit;
  }
  if (parsed.unitLabel) {
    next.unit = String(parsed.unitLabel).trim();
  }
  if (
    !String(next.unit || "").trim() &&
    String(next.property || prev.property || "").trim() &&
    isUnitOnlyReply(body)
  ) {
    const unitHint = extractUnitFromBody(body) || leadingUnitFromBody(body);
    if (unitHint) next.unit = unitHint;
  }
  if (parsed.issueText && String(parsed.issueText).trim().length >= 2) {
    const issue = String(parsed.issueText).trim();
    const prevIssue = String(next.issue || "").trim();
    if (!prevIssue || issue.length >= prevIssue.length) {
      next.issue = issue;
    }
  }
  if (parsed.scheduleRaw) {
    next.preferredWindow = String(parsed.scheduleRaw).trim();
  }
  if (next.issue) {
    const cat = resolveHandoffCategory(next);
    if (cat) next.category = cat;
  }
  applyGatherLocationFields(next, { body, prev, parsed });

  return next;
}

module.exports = {
  mergePartialFromInboundMessage,
  leadingUnitFromBody,
  isUnitOnlyReply,
  applyPropertyResolution,
};
