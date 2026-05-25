/**
 * Gather-phase location_kind — common area vs unit (adapter expression).
 */
const {
  inferLocationTypeFromText,
  isCommonAreaLocation,
  resolveMaintenanceDraftLocationType,
} = require("../../brain/shared/commonArea");

const COMMON_AREA_LABEL_RE =
  /\b(elevator|lift|lobby|hallway|corridor|stairwell|staircase|mail room|laundry room|garage|entrance|fitness center|gym|pool deck|common area)\b/i;

const ISSUE_NOT_IN_UNIT_RE =
  /\b(?:not|isn'?t|is not)\s+(?:in|inside)\s+(?:my\s+)?(?:unit|apartment|apt)\b/i;

const ISSUE_IN_COMMON_RE =
  /\b(?:issue|problem|it(?:'s|\s+is)|this)\s+(?:is\s+)?(?:in|at)\s+(?:the\s+)?(?:elevator|lobby|hallway|corridor|stairwell|garage|mail room|laundry room|common area)\b/i;

/**
 * @param {string} text
 * @returns {boolean}
 */
function tenantDescribesCommonAreaIssue(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (ISSUE_NOT_IN_UNIT_RE.test(t)) return true;
  if (ISSUE_IN_COMMON_RE.test(t)) return true;
  if (/\bin the (elevator|lobby|hallway|corridor|stairwell|garage|mail room|laundry room|common area)\b/i.test(t)) {
    return true;
  }
  return inferLocationTypeFromText(t) === "COMMON_AREA";
}

/**
 * @param {string} text
 * @returns {string}
 */
function inferCommonAreaLabelSnapshot(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  const m = t.match(COMMON_AREA_LABEL_RE);
  if (!m) return "";
  const raw = String(m[1] || "").trim().toLowerCase();
  if (raw === "lift") return "elevator";
  if (raw === "common area") return "common area";
  return raw;
}

/**
 * @param {object} next
 * @param {object} o
 * @param {string} o.body
 * @param {object} o.prev
 * @param {object} o.parsed
 */
function applyGatherLocationFields(next, o) {
  const body = String(o.body || "").trim();
  const prev = o.prev || {};
  const parsed = o.parsed || {};
  const hintText = [body, next.issue, prev.issue]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(" ");

  const parsedLocationType = resolveMaintenanceDraftLocationType(
    parsed,
    body,
    next.issue,
    prev.issue
  );
  const commonAreaIssue =
    tenantDescribesCommonAreaIssue(hintText) ||
    parsedLocationType === "COMMON_AREA" ||
    isCommonAreaLocation(parsed.locationType) ||
    String(next.location_kind || prev.location_kind || "").trim().toLowerCase() ===
      "common_area";

  const reporterUnit = String(
    next.unit || parsed.unitLabel || prev.unit || prev.report_source_unit || ""
  ).trim();

  if (commonAreaIssue) {
    next.location_kind = "common_area";
    next.unit = "";
    if (reporterUnit) {
      next.report_source_unit = reporterUnit;
    }
    const label =
      String(next.location_label_snapshot || prev.location_label_snapshot || "").trim() ||
      inferCommonAreaLabelSnapshot(hintText);
    if (label) next.location_label_snapshot = label;
    delete next.preferredWindow;
    delete next.preferred_window;
    return;
  }

  if (String(next.unit || "").trim()) {
    next.location_kind = "unit";
  } else if (!next.location_kind) {
    next.location_kind = "unit";
  }
}

/**
 * @param {object} partial
 * @returns {boolean}
 */
function isCommonAreaGatherPartial(partial) {
  return (
    String((partial && partial.location_kind) || "")
      .trim()
      .toLowerCase() === "common_area"
  );
}

module.exports = {
  applyGatherLocationFields,
  isCommonAreaGatherPartial,
  tenantDescribesCommonAreaIssue,
  inferCommonAreaLabelSnapshot,
};
