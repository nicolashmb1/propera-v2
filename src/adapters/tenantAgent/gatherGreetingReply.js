/**
 * Opening gather greeting — brand from propertiesList already loaded (no extra DB call).
 */
const { hasProblemSignal } = require("../../brain/core/splitIssueGroups");
const { tenantAgentPropertyAllowlist } = require("../../config/env");
const { buildRosterAwareGreeting } = require("./lookupTenantRosterForAgent");

const GREETING_ONLY_RE =
  /^(?:hi|hello|hey|yo|howdy|good\s+(?:morning|afternoon|evening))(?:\s+there)?[!.\s]*$/i;

const CASUAL_OPEN_RE =
  /^(?:what'?s\s*up|whatsup|wassup|sup|how\s+are\s+you|how\s+r\s+u|how\s+are\s+u)(?:\s+there)?[!.\s]*$/i;

const TELEGRAM_START_RE =
  /^\/start(?:@\w+)?(?:\s+.*)?$/i;

/**
 * Tenant-facing property label from DB row — short name first (what tenants say).
 * @param {object | null | undefined} row
 * @returns {string}
 */
function propertyTenantLabel(row) {
  if (!row) return "";
  return (
    String(row.display_name_short || "").trim() ||
    String(row.short_name || "").trim() ||
    String(row.display_name || "").trim() ||
    String(row.code || "").trim()
  );
}

/**
 * @param {object[]} propertiesList
 * @param {string} propertyCode
 * @returns {string}
 */
function propertyTenantLabelFromList(propertiesList, propertyCode) {
  const code = String(propertyCode || "")
    .trim()
    .toUpperCase();
  if (!code) return "";
  const row = (propertiesList || []).find(
    (p) => String(p.code || "").trim().toUpperCase() === code
  );
  return propertyTenantLabel(row);
}

/**
 * @param {object} propertiesList
 * @param {string} propertyCode
 * @returns {string}
 */
function propertyDisplayNameFromList(propertiesList, propertyCode) {
  return propertyTenantLabelFromList(propertiesList, propertyCode);
}

/**
 * Brand label when unambiguous from partial slot or single-property pilot allowlist.
 * @param {object[]} propertiesList
 * @param {object} [partial]
 * @returns {string}
 */
function inferBrandDisplayName(propertiesList, partial) {
  const fromPartial = propertyDisplayNameFromList(
    propertiesList,
    partial && partial.property
  );
  if (fromPartial) return fromPartial;

  const allow = tenantAgentPropertyAllowlist();
  if (allow.length === 1) {
    return propertyDisplayNameFromList(propertiesList, allow[0]);
  }
  return "";
}

/**
 * Pure greeting with no maintenance content gathered yet.
 * @param {string} bodyText
 * @param {object} [partial]
 * @returns {boolean}
 */
function isGatheringGreetingOnly(bodyText, partial) {
  const s = String(bodyText || "").trim();
  if (!s || s.length > 80) return false;
  if (TELEGRAM_START_RE.test(s)) return true;
  if (hasProblemSignal(s)) return false;
  if (String((partial && partial.issue) || "").trim().length >= 2) return false;
  if (String((partial && partial.unit) || "").trim()) return false;
  if (String((partial && partial.property) || "").trim()) return false;
  return GREETING_ONLY_RE.test(s) || CASUAL_OPEN_RE.test(s);
}

/**
 * @param {{ propertiesList?: object[], partial?: object }} o
 * @returns {string}
 */
function buildGatherGreetingReply(o) {
  const rosterGreeting = buildRosterAwareGreeting(o.partial || {}, o.propertiesList || []);
  if (rosterGreeting) return rosterGreeting;

  const brand = inferBrandDisplayName(o.propertiesList, o.partial);
  if (brand) {
    return (
      `Hi — I'm the ${brand} virtual maintenance assistant. ` +
      "How can I help you today?"
    );
  }
  return "Hi! How can I help you today with maintenance?";
}

module.exports = {
  isGatheringGreetingOnly,
  buildGatherGreetingReply,
  inferBrandDisplayName,
  propertyDisplayNameFromList,
  propertyTenantLabel,
  propertyTenantLabelFromList,
};
