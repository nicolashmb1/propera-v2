/**
 * Tenant-visible prompts for missing draft slots — GAS outgate class (simplified copy).
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

  return "Thanks — we need a bit more information to open a ticket.";
}

module.exports = { buildMaintenancePrompt };
