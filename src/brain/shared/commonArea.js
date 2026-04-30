/**
 * Deterministic COMMON_AREA helpers shared by intake/core/finalize.
 */

/** Amenity / shared-space hints (#gym staff shorthand, fitness, pools deck, etc.) */
const COMMON_AREA_RE =
  /\b(common area|hallway|corridor|lobby|stairwell|stair case|staircase|laundry room|mail room|parking|garage|entrance|front door|back door|building entrance|gym|fitness center|fitness room|clubhouse|recreation room|community room|business center|pool deck|swimming pool)\b/i;

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

module.exports = {
  normalizeLocationType,
  inferLocationTypeFromText,
  isCommonAreaLocation,
};
