/**
 * Property display name for first-contact outgate header (Block D).
 */
const { getPropertyByCode } = require("../dal/propertyLookup");

/**
 * @param {object | null | undefined} coreRun
 * @returns {Promise<string>}
 */
async function resolveOutgatePropertyDisplayName(coreRun) {
  if (!coreRun || typeof coreRun !== "object") return "";
  const d = coreRun.draft && typeof coreRun.draft === "object" ? coreRun.draft : {};
  const code = String(d.propertyCode || d.draft_property || "").trim().toUpperCase();
  if (!code) return "";
  const prop = await getPropertyByCode(code);
  if (prop && String(prop.display_name || "").trim()) {
    return String(prop.display_name).trim();
  }
  return code;
}

module.exports = { resolveOutgatePropertyDisplayName };
