/**
 * When brain set intake_sessions expected SCHEDULE, defer agent so core applies policy.
 */
const { getIntakeSession } = require("../../dal/intakeSession");

/**
 * @param {object} o
 * @param {Record<string, string>} [o.routerParameter]
 * @returns {Promise<boolean>}
 */
async function tenantAgentShouldDeferToCoreSchedule(o) {
  const rp = o.routerParameter || {};
  const actor = String(
    rp._canonicalBrainActorKey || rp._phoneE164 || rp.From || ""
  ).trim();
  if (!actor) return false;

  const session = await getIntakeSession(actor);
  if (!session) return false;

  const expected = String(session.expected || "").trim().toUpperCase();
  const artifact = String(session.active_artifact_key || "").trim();
  return expected === "SCHEDULE" && artifact.length > 0;
}

module.exports = { tenantAgentShouldDeferToCoreSchedule };
