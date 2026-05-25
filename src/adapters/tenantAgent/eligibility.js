/**
 * Tenant Agent path eligibility — all conditions must hold (see TENANT_AGENT_ADAPTER.md §6).
 */

const { tenantAgentEnabled } = require("../../config/env");

const AGENT_TRANSPORTS = new Set(["sms", "whatsapp", "telegram"]);

/**
 * @param {object} o
 * @param {string} o.transportChannel
 * @param {{ isStaff?: boolean }} [o.staffContext]
 * @param {{ outcome?: string, tenantCommand?: string | null, compliance?: string | null }} [o.precursor]
 * @param {{ lane?: string }} [o.laneDecision]
 * @param {object | null} [o.staffRun]
 * @param {object | null} [o.complianceRun]
 * @param {object | null} [o.suppressedRun]
 * @param {object | null} [o.stubRun]
 * @param {boolean} o.coreEnabledFlag
 * @param {boolean} o.dbConfigured
 * @returns {boolean}
 */
function isTenantAgentEligible(o) {
  if (!tenantAgentEnabled()) return false;
  if (!o.coreEnabledFlag || !o.dbConfigured) return false;

  const transport = String(o.transportChannel || "").toLowerCase();
  if (!AGENT_TRANSPORTS.has(transport)) return false;

  if (o.staffContext && o.staffContext.isStaff) return false;
  if (o.staffRun || o.complianceRun || o.suppressedRun || o.stubRun) return false;

  const precursor = o.precursor || {};
  if (precursor.tenantCommand) return false;
  if (precursor.compliance) return false;

  const outcome = String(precursor.outcome || "");
  if (outcome !== "PRECURSOR_EVALUATED") return false;

  const lane = String((o.laneDecision && o.laneDecision.lane) || "");
  if (lane === "vendorLane" || lane === "systemLane") return false;

  return true;
}

module.exports = {
  isTenantAgentEligible,
};
