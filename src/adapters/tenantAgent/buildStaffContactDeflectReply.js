/**
 * Maintenance-only deflect — direct tenant to property staff / office.
 */
const { propertyDisplayNameFromList } = require("./gatherGreetingReply");

/**
 * @param {string} e164
 * @returns {string}
 */
function formatPhoneForTenantDisplay(e164) {
  const raw = String(e164 || "").trim();
  const d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) {
    return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return raw;
}

/**
 * @param {object} o
 * @param {string} [o.phoneE164]
 * @param {string} [o.propertyCode]
 * @param {object[]} [o.propertiesList]
 * @returns {string}
 */
function buildStaffContactDeflectReply(o) {
  const phone = formatPhoneForTenantDisplay(o.phoneE164);
  const propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  const propertyName = propertyDisplayNameFromList(o.propertiesList, propertyCode);

  let lines = [
    "At the moment I can only help with maintenance intake.",
    "",
    "For lease copies, invoices, rent statements, amenity bookings, building questions, and everything else, please contact the office",
  ];

  if (propertyName) {
    lines[2] += ` for ${propertyName}`;
  }
  lines[2] += ".";

  if (phone) {
    lines.push(`Office: ${phone}`);
  } else {
    lines.push("Please contact your building office for help.");
  }

  lines.push("");
  lines.push("If you have a maintenance issue, tell me your building, unit, and what needs fixing.");

  return lines.join("\n");
}

module.exports = {
  buildStaffContactDeflectReply,
  formatPhoneForTenantDisplay,
};
