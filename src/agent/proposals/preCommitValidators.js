/**
 * Per-op commit-time validators — run after the proposal is claimed and before
 * `commitProposal`. Keeps op-specific staleness / safety checks (e.g. "does the
 * drafted campaign still exist?") out of the generic confirm spine.
 *
 * Mirror of `commitProposal.js`: a central router to per-op modules. Add an op
 * by registering its validator here — do not inline op logic in
 * `executeJarvisConfirm`.
 * @see docs/JARVIS_SPINE.md § How to review a Jarvis slice
 */

const { PROPOSAL_OPS } = require("./types");
const {
  preCommitValidateSendCommunicationCampaign,
} = require("./sendCommunicationCampaign");

/** @type {Record<string, (sb: any, verified: object, ctx: object) => Promise<object>>} */
const PRE_COMMIT_VALIDATORS = {
  [PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN]: preCommitValidateSendCommunicationCampaign,
};

/**
 * @param {import("@supabase/supabase-js").SupabaseClient | null} sb
 * @param {{ op: string, proposal_id: string, payload?: object }} verified
 * @param {object} [ctx]
 * @returns {Promise<{ ok: true } | { ok: false, error: string, replyText: string, markState?: string, resolution?: object }>}
 */
async function runPreCommitValidate(sb, verified, ctx) {
  const fn = PRE_COMMIT_VALIDATORS[String(verified?.op || "").trim()];
  if (!fn) return { ok: true };
  const out = await fn(sb, verified, ctx || {});
  return out && out.ok === false ? out : { ok: true };
}

module.exports = { runPreCommitValidate, PRE_COMMIT_VALIDATORS };
