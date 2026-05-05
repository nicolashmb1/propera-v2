/**
 * Deterministic COMMON_AREA helpers shared by intake/core/finalize.
 */

/** Amenity / shared-space hints (#gym staff shorthand, fitness, pools deck, etc.) */
const COMMON_AREA_RE =
  /\b(common area|hallway|corridor|lobby|stairwell|stair case|staircase|laundry room|mail room|parking|garage|entrance|front door|back door|building entrance|gym|fitness center|fitness room|clubhouse|recreation room|community room|business center|pool deck|swimming pool)\b/i;

/**
 * Shared building systems (not tied to a unit). Kept separate from COMMON_AREA_RE so we only
 * treat as common-area when there is no unit cue — avoids misclassifying in-unit copy.
 */
const SHARED_BUILDING_INFRA_RE =
  /\b(elevators?|lifts?|escalators?)\b/i;

const { extractUnit } = require("./extractUnitGas");

function normalizeLocationType(raw) {
  const t = String(raw || "")
    .trim()
    .toUpperCase();
  return t === "COMMON_AREA" ? "COMMON_AREA" : "UNIT";
}

function inferLocationTypeFromText(text) {
  const s = String(text || "").trim();
  if (!s) return "UNIT";
  return COMMON_AREA_RE.test(s) ? "COMMON_AREA" : "UNIT";
}

function isCommonAreaLocation(raw) {
  return normalizeLocationType(raw) === "COMMON_AREA";
}

function hasSharedBuildingInfraSignal(text) {
  return SHARED_BUILDING_INFRA_RE.test(String(text || ""));
}

/**
 * Merge full-turn body with parsed issue chunks for COMMON_AREA hints. The LLM often
 * strips phrases like "common area" from `issueText` while `effectiveBody` still contains them;
 * evaluating only the cleaned issue incorrectly forces a unit prompt.
 * Explicit parser `locationType` COMMON_AREA still wins.
 *
 * When the message describes shared vertical transport (elevator / lift / escalator) and
 * there is no unit signal in the combined hint or parsed `unitLabel`, treat as COMMON_AREA so
 * intake does not ask for an apartment number.
 *
 * @param {{ locationType?: string, unitLabel?: string } | null | undefined} fastDraft
 * @param {string} effectiveBody
 * @param {...string} extraIssueChunks — e.g. finalized issue line, raw draft_issue
 * @returns {"COMMON_AREA" | "UNIT"}
 */
function resolveMaintenanceDraftLocationType(fastDraft, effectiveBody, ...extraIssueChunks) {
  const fd = fastDraft && typeof fastDraft === "object" ? fastDraft : null;
  const hintText = [effectiveBody, ...extraIssueChunks]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(" ");
  let lt = inferLocationTypeFromText(hintText);
  if (fd && isCommonAreaLocation(fd.locationType)) lt = "COMMON_AREA";

  const parsedUnit = fd && String(fd.unitLabel || "").trim();
  const extractedUnit = extractUnit(hintText);
  const hasUnitCue = !!(parsedUnit || extractedUnit);
  if (
    lt === "UNIT" &&
    !hasUnitCue &&
    hasSharedBuildingInfraSignal(hintText)
  ) {
    lt = "COMMON_AREA";
  }
  return lt;
}

module.exports = {
  normalizeLocationType,
  inferLocationTypeFromText,
  isCommonAreaLocation,
  hasSharedBuildingInfraSignal,
  resolveMaintenanceDraftLocationType,
};
