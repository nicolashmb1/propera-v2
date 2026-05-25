/**
 * Tenant Agent pilot property allowlist — see TENANT_AGENT_ADAPTER.md §6.
 */
const { tenantAgentPropertyAllowlist } = require("../../config/env");

/**
 * @param {string} propertyCode
 * @returns {boolean}
 */
function isPropertyOnTenantAgentPilot(propertyCode) {
  const allow = tenantAgentPropertyAllowlist();
  if (!allow.length) return true;
  const code = String(propertyCode || "")
    .trim()
    .toUpperCase();
  if (!code) return true;
  return allow.includes(code);
}

module.exports = {
  isPropertyOnTenantAgentPilot,
};
