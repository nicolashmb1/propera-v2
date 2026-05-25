/**
 * Facts for buildMaintenanceReceipt from a core handoff result — ticket ids from brain only.
 */
const { inferEmergency } = require("../../dal/ticketDefaults");
const { isCommonAreaLocation } = require("../../brain/shared/commonArea");

/**
 * @param {object | null | undefined} coreRun
 * @returns {{ multi: true } | { multi: false, fins: object[], groups: object[], emergency: boolean, commonArea: boolean, unitLabel: string, locationLabelSnapshot: string } | null}
 */
function extractBrainReceiptFacts(coreRun) {
  if (!coreRun || typeof coreRun !== "object") return null;
  if (String(coreRun.brain || "") !== "core_finalized") return null;

  const outgate =
    coreRun.outgate && typeof coreRun.outgate === "object" ? coreRun.outgate : {};
  const templateKey = String(outgate.templateKey || "").trim();

  if (templateKey === "MAINTENANCE_RECEIPT_MULTI") {
    return { multi: true };
  }

  const fin = coreRun.finalize && typeof coreRun.finalize === "object" ? coreRun.finalize : {};
  const ticketId = String(fin.ticketId || "").trim();
  if (!ticketId) return null;

  const draft = coreRun.draft && typeof coreRun.draft === "object" ? coreRun.draft : {};
  const locType =
    draft.portalLocationKind ||
    draft.locationType ||
    draft.draft_location_type ||
    "";
  const commonArea = isCommonAreaLocation(locType);
  const unitLabel = String(
    draft.unitLabel || draft.draft_unit || draft.unit || ""
  ).trim();
  const locationLabelSnapshot = String(
    draft.locationLabelSnapshot || draft.location_label_snapshot || ""
  ).trim();
  const propertyCode = String(
    draft.propertyCode || draft.draft_property || draft.property || ""
  )
    .trim()
    .toUpperCase();
  const propertyDisplayName = String(
    draft.propertyDisplayName || draft.display_name || draft.property_display_name || ""
  ).trim();
  const issueText = String(draft.issueText || draft.issue || "").trim();
  const inferred = inferEmergency(issueText);

  const emergency =
    outgate.emergency === true ||
    String(outgate.emergency || "").toLowerCase() === "yes" ||
    templateKey === "MAINTENANCE_RECEIPT_EMERGENCY" ||
    inferred.emergency === "Yes";
  const emergencyType = String(
    draft.emergencyType ||
      draft.emergency_type ||
      (draft.safety && draft.safety.emergencyType) ||
      inferred.emergencyType ||
      ""
  ).trim();

  let urgency = "Normal";
  if (templateKey === "MAINTENANCE_RECEIPT_URGENT") urgency = "Urgent";

  return {
    multi: false,
    fins: [{ ticketId, issueText }],
    groups: [{ issueText, urgency }],
    emergency,
    emergencyType,
    commonArea,
    unitLabel,
    locationLabelSnapshot,
    propertyCode,
    propertyDisplayName,
  };
}

module.exports = { extractBrainReceiptFacts };
