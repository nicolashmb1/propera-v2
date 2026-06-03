/**
 * Tenant portal UI locale — en | es only for v1.
 * @see docs/TENANT_PORTAL_I18N.md
 */

const SUPPORTED = new Set(["en", "es"]);

/**
 * @param {string} raw
 * @returns {"en"|"es"}
 */
function normalizeTenantUiLocale(raw) {
  const c = String(raw || "en").trim().toLowerCase();
  if (c === "es") return "es";
  return "en";
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
function isSupportedTenantUiLocale(raw) {
  const c = String(raw || "").trim().toLowerCase();
  return SUPPORTED.has(c);
}

module.exports = {
  normalizeTenantUiLocale,
  isSupportedTenantUiLocale,
  SUPPORTED_TENANT_UI_LOCALES: SUPPORTED,
};
