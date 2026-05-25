/**
 * Category hint for structured handoff — same rules as NL finalize (localCategoryFromText).
 */
const { localCategoryFromText } = require("../../dal/ticketDefaults");

/**
 * @param {object} [partialPackage]
 * @returns {string}
 */
function resolveHandoffCategory(partialPackage) {
  const issue = String(
    (partialPackage && (partialPackage.issue || partialPackage.message)) || ""
  ).trim();
  if (!issue) return "";
  return String(localCategoryFromText(issue) || "").trim();
}

module.exports = { resolveHandoffCategory };
