/**
 * Tenant-visible prompts for missing draft slots — GAS outgate class (simplified copy).
 * Stable keys for Outgate / MessageSpec binding (facts stay in brain; copy can evolve).
 */
const MAINTENANCE_TEMPLATE = {
  ISSUE: "MAINTENANCE_ISSUE",
  PROPERTY_MENU: "MAINTENANCE_PROPERTY_MENU",
  UNIT: "MAINTENANCE_UNIT",
  SCHEDULE_ASK: "MAINTENANCE_SCHEDULE_ASK",
  EMERGENCY_DONE: "MAINTENANCE_EMERGENCY_DONE",
  ATTACH_CLARIFY: "MAINTENANCE_ATTACH_CLARIFY",
  FALLBACK: "MAINTENANCE_FALLBACK",
};

/**
 * Map `recomputeDraftExpected` slot → Outgate template id (not final text).
 * @param {string} next
 * @returns {string}
 */
function maintenanceTemplateKeyForNext(next) {
  const n = String(next || "").toUpperCase();
  if (n === "ISSUE") return MAINTENANCE_TEMPLATE.ISSUE;
  if (n === "PROPERTY") return MAINTENANCE_TEMPLATE.PROPERTY_MENU;
  if (n === "UNIT") return MAINTENANCE_TEMPLATE.UNIT;
  if (n === "SCHEDULE" || n === "SCHEDULE_PRETICKET") {
    return MAINTENANCE_TEMPLATE.SCHEDULE_ASK;
  }
  if (n === "EMERGENCY_DONE") return MAINTENANCE_TEMPLATE.EMERGENCY_DONE;
  if (n === "ATTACH_CLARIFY") return MAINTENANCE_TEMPLATE.ATTACH_CLARIFY;
  return MAINTENANCE_TEMPLATE.FALLBACK;
}

/**
 * @param {string} next — from recomputeDraftExpected
 * @param {Array<{ code: string, display_name: string }>} propertiesList
 */
function buildMaintenancePrompt(next, propertiesList) {
  const n = String(next || "").toUpperCase();
  const list = propertiesList || [];

  if (n === "ISSUE") {
    return (
      "What is going on? Send one message describing the maintenance issue " +
      "(location in the unit and what is wrong)."
    );
  }

  if (n === "PROPERTY") {
    if (list.length === 0) {
      return (
        "Which property? Reply with the short code (example: PENN) " +
        "or the property name exactly as your lease lists it."
      );
    }
    const lines = [
      "Please confirm your property — reply with the number or name:",
    ];
    list.forEach((p, i) => {
      const label = (p.display_name && p.display_name.trim()) || p.code;
      lines.push(`${i + 1}) ${label}`);
    });
    return lines.join("\n");
  }

  if (n === "UNIT") {
    return "What is your apartment or unit number?";
  }

  if (n === "SCHEDULE" || n === "SCHEDULE_PRETICKET") {
    return (
      "When would be a good time for us to come by? " +
      "Share a day and time window (example: tomorrow 9–11am)."
    );
  }

  if (n === "EMERGENCY_DONE") {
    return (
      "If this is life-safety or urgent, call 911. Our team will follow up on next steps."
    );
  }

  if (n === "ATTACH_CLARIFY") {
    return (
      "Quick check: is this about the same open request we are already working on, " +
      "or a separate new issue?\n\n" +
      "Reply 1 for same request, or 2 for a separate new issue."
    );
  }

  return "Thanks — we need a bit more information to open a ticket.";
}

module.exports = {
  buildMaintenancePrompt,
  maintenanceTemplateKeyForNext,
  MAINTENANCE_TEMPLATE,
};
