/**
 * Persist Jarvis thread state from a staff/agent turn (propose or commit).
 */

const { getSupabase } = require("../../db/supabase");
const { jarvisThreadEnabled } = require("../../config/env");
const { appendEventLog } = require("../../dal/appendEventLog");
const {
  upsertJarvisThread,
  addPendingProposalToThread,
  markProposalOnThread,
  threadSummaryForPortal,
} = require("../../dal/jarvisOperatorThreads");
const {
  buildAnchorFingerprint,
  buildThreadId,
} = require("./anchorFingerprint");
const { readAnchorFromRouter } = require("./readAnchorFromRouter");

/**
 * @param {object} opts
 * @param {string} opts.traceId
 * @param {string} opts.actorKey
 * @param {string} [opts.transportChannel]
 * @param {Record<string, string | undefined>} opts.routerParameter
 * @param {object | null} opts.staffRun
 * @param {object | null} [opts.scopeSnapshot]
 */
async function recordThreadForStaffRun(opts) {
  if (!jarvisThreadEnabled()) return null;

  const staffRun = opts.staffRun;
  if (!staffRun) return null;

  const sb = getSupabase();
  const actorKey = String(opts.actorKey || "").trim();
  const channel = String(opts.transportChannel || "portal").trim() || "portal";
  if (!sb || !actorKey) return null;

  const anchor = readAnchorFromRouter(opts.routerParameter || {});
  const anchorFingerprint = buildAnchorFingerprint(anchor);
  const threadId = buildThreadId(actorKey, channel, anchorFingerprint);

  const resolution = staffRun.resolution || {};
  const proposal = resolution.proposal;

  if (resolution.needsConfirm && proposal && proposal.confirm_token) {
    await upsertJarvisThread(sb, {
      threadId,
      actorKey,
      transportChannel: channel,
      anchorFingerprint,
      status: "proposal_pending",
      pendingProposals: [],
      scopeSnapshot: opts.scopeSnapshot || { anchor },
    });

    const thread = await addPendingProposalToThread(sb, {
      threadId,
      proposal,
      scopeSnapshot: opts.scopeSnapshot || { anchor },
    });

    await appendEventLog({
      traceId: String(opts.traceId || ""),
      log_kind: "agent",
      event: "JARVIS_THREAD_PROPOSAL_PENDING",
      payload: {
        thread_id: threadId,
        proposal_id: proposal.proposal_id,
        op: proposal.op,
      },
    });

    return threadSummaryForPortal(thread);
  }

  const committedOp =
    resolution.committed_op ||
    (resolution.costEntryId && !resolution.needsConfirm ? "attach_ticket_cost" : "") ||
    (staffRun.ok !== false && resolution.idempotent ? "attach_ticket_cost" : "");
  const proposalId =
    resolution.proposal_id ||
    (proposal && proposal.proposal_id) ||
    "";

  if (committedOp && proposalId) {
    const receipt = {
      committed_op: committedOp,
      proposal_id: proposalId,
      reply_preview: String(staffRun.replyText || "").slice(0, 400),
      at: new Date().toISOString(),
    };

    const thread = await markProposalOnThread(sb, {
      threadId,
      proposalId,
      state: "committed",
      lastReceipt: receipt,
    });

    await appendEventLog({
      traceId: String(opts.traceId || ""),
      log_kind: "agent",
      event: "JARVIS_THREAD_PROPOSAL_COMMITTED",
      payload: {
        thread_id: threadId,
        proposal_id: proposalId,
        op: committedOp,
      },
    });

    return threadSummaryForPortal(thread);
  }

  return null;
}

/**
 * Ensure thread row exists and return summary (e.g. idle Plan turn).
 * @param {object} opts
 */
async function ensureJarvisThread(opts) {
  if (!jarvisThreadEnabled()) return null;
  const sb = getSupabase();
  const actorKey = String(opts.actorKey || "").trim();
  const channel = String(opts.transportChannel || "portal").trim() || "portal";
  if (!sb || !actorKey) return null;

  const anchor = readAnchorFromRouter(opts.routerParameter || {});
  const anchorFingerprint = buildAnchorFingerprint(anchor);
  const threadId = buildThreadId(actorKey, channel, anchorFingerprint);

  const thread = await upsertJarvisThread(sb, {
    threadId,
    actorKey,
    transportChannel: channel,
    anchorFingerprint,
    status: String(opts.status || "idle"),
    pendingProposals: opts.pendingProposals || [],
    scopeSnapshot: opts.scopeSnapshot || { anchor },
    lastReceipt: opts.lastReceipt || null,
  });

  return threadSummaryForPortal(thread);
}

module.exports = { recordThreadForStaffRun, ensureJarvisThread };
