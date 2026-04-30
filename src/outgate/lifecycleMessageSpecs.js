/**
 * Lifecycle outbound copy — deterministic (GAS template keys).
 * @type {Record<string, import('./messageSpecs').MessageSpec>}
 */
const LIFECYCLE_MESSAGE_SPECS = {
  TENANT_VERIFY_RESOLUTION: {
    templateKey: "TENANT_VERIFY_RESOLUTION",
    fallbackText:
      "Quick check: is your maintenance issue resolved? Reply YES if all set, or NO if you still need help.",
    channelHint: "short",
  },
  STAFF_UPDATE_REMINDER: {
    templateKey: "STAFF_UPDATE_REMINDER",
    fallbackText:
      "Reminder: please send a maintenance update on your open work item (reply here with status).",
    channelHint: "short",
  },
  STAFF_UNSCHEDULED_REMINDER: {
    templateKey: "STAFF_UNSCHEDULED_REMINDER",
    fallbackText:
      "Reminder: an unscheduled maintenance item still needs scheduling or an update. Please follow up.",
    channelHint: "short",
  },
  STAFF_TENANT_NEGATIVE_FOLLOWUP: {
    templateKey: "STAFF_TENANT_NEGATIVE_FOLLOWUP",
    fallbackText:
      "The tenant indicated the issue may not be resolved. Please follow up on the open work item.",
    channelHint: "short",
  },
};

function getLifecycleMessageSpec(templateKey) {
  const k = String(templateKey || "").trim();
  return LIFECYCLE_MESSAGE_SPECS[k] || null;
}

module.exports = {
  LIFECYCLE_MESSAGE_SPECS,
  getLifecycleMessageSpec,
};
