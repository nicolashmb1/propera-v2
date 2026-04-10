/**
 * Single-turn extraction of property / unit / issue from free text.
 *
 * PARITY GAP: not GAS `compileTurn_` / `properaBuildIntakePackage_` — flow-only maintenance slice.
 * Property hints use `extractPropertyHintFromBody` (PARTIAL vs `detectPropertyFromBody_`).
 * See docs/PARITY_LEDGER.md §1–2.
 */
const {
  extractUnitFromBody,
  extractPropertyHintFromBody,
} = require("../staff/lifecycleExtract");

/**
 * @param {string} bodyTrim
 * @param {Set<string>} knownPropertyCodesUpper
 * @returns {{ propertyCode: string, unitLabel: string, issueText: string }}
 */
function parseMaintenanceDraft(bodyTrim, knownPropertyCodesUpper) {
  const t = String(bodyTrim || "").trim();
  if (!t) {
    return { propertyCode: "", unitLabel: "", issueText: "" };
  }

  const propertyCode = extractPropertyHintFromBody(t, knownPropertyCodesUpper);
  const unitLabel = extractUnitFromBody(t);

  let issue = t;
  if (propertyCode) {
    issue = issue.replace(new RegExp("\\b" + propertyCode + "\\b", "gi"), " ");
  }
  if (unitLabel) {
    const esc = unitLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    issue = issue.replace(new RegExp("\\b" + esc + "\\b", "gi"), " ");
    issue = issue.replace(/\b(?:unit|apt|uni)\s*[:\s]*\s*/gi, " ");
  }
  issue = issue.replace(/\s+/g, " ").trim();

  return {
    propertyCode: propertyCode || "",
    unitLabel: unitLabel || "",
    issueText: issue || t,
  };
}

/**
 * @param {{ propertyCode: string, unitLabel: string, issueText: string }} d
 */
function isMaintenanceDraftComplete(d) {
  if (!d) return false;
  if (!String(d.propertyCode || "").trim()) return false;
  if (!String(d.unitLabel || "").trim()) return false;
  if (!String(d.issueText || "").trim() || String(d.issueText).trim().length < 2)
    return false;
  return true;
}

module.exports = {
  parseMaintenanceDraft,
  isMaintenanceDraftComplete,
};
