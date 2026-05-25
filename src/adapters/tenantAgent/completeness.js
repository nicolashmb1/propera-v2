/**
 * Rule-based handoff completeness — adapter confirms before brain call (not LLM alone).
 */
const { MIN_SCHEDULE_LEN } = require("../../dal/ticketPreferredWindow");
const { isCommonAreaGatherPartial } = require("./resolveGatherLocation");
const { getGatherSafety } = require("./detectGatherSafety");

/**
 * @param {object} partial
 * @param {Set<string>} knownPropertyCodesUpper
 * @returns {{ ready: boolean, missing: string | null }}
 */
function completenessCheck(partial, knownPropertyCodesUpper) {
  const pkg = partial || {};
  const property = String(pkg.property || pkg.property_code || "")
    .trim()
    .toUpperCase();
  const issue = String(pkg.issue || pkg.message || "").trim();
  const locationKind = String(pkg.location_kind || "unit").trim().toLowerCase();
  const commonArea = isCommonAreaGatherPartial(pkg) || locationKind === "common_area";
  const unit = String(pkg.unit || pkg.unit_label || "").trim();
  const schedule = String(pkg.preferredWindow || pkg.preferred_window || "").trim();
  const propertyCandidates = Array.isArray(pkg._property_candidates)
    ? pkg._property_candidates
    : [];

  if (
    propertyCandidates.length > 1 ||
    (propertyCandidates.length >= 1 && !property)
  ) {
    return { ready: false, missing: "property" };
  }
  if (!property || !(knownPropertyCodesUpper && knownPropertyCodesUpper.has(property))) {
    return { ready: false, missing: "property" };
  }
  if (locationKind === "unit" && !unit) {
    return { ready: false, missing: "unit" };
  }
  if (issue.length < 2) {
    return { ready: false, missing: "issue" };
  }
  const safety = getGatherSafety(pkg);
  if (!commonArea && !safety?.skipScheduling && schedule.length < MIN_SCHEDULE_LEN) {
    return { ready: false, missing: "schedule" };
  }
  return { ready: true, missing: null };
}

module.exports = {
  completenessCheck,
};
