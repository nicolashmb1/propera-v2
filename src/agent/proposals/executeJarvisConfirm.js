/**
 * Shared Jarvis confirm spine — portal Plan tab + live voice.
 * Idempotent confirm, in-process lock, thread claim, failure-safe receipts.
 */

const { getSupabase } = require("../../db/supabase");
const { appendEventLog } = require("../../dal/appendEventLog");
const { jarvisThreadEnabled } = require("../../config/env");
const {
  findAwaitingProposalForActor,
  findThreadWithProposalForActor,
  findProposalStateOnThread,
  tryClaimProposalForCommit,
  waitForProposalOutcome,
  idempotentConfirmFromThread,
  loadJarvisThread,
  markProposalOnThread,
} = require("../../dal/jarvisOperatorThreads");
const { verifyProposalConfirmToken } = require("./proposalToken");
const { commitProposal } = require("./commitProposal");
const { PROPOSAL_OPS } = require("./types");
const { refreshCommCampaignProposalHit, campaignIdFromProposal } = require("./commCampaignProposalGuard");
const { recordThreadForStaffRun } = require("../thread/recordThreadForStaffRun");
const { clearExpenseConfirmPending } = require("../../dal/staffExpenseCapture");
const { formatJarvisConfirmReceipt } = require("./jarvisConfirmReceipt");

/** In-process confirm lock — prevents double-commit races on one V2 instance. */
const confirmLocks = new Map();

/**
 * @param {string} proposalId
 * @param {() => Promise<object>} fn
 */
async function withConfirmLock(proposalId, fn) {
  const id = String(proposalId || "").trim();
  if (!id) return fn();

  while (confirmLocks.has(id)) {
    await confirmLocks.get(id);
  }
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  confirmLocks.set(id, gate);
  try {
    return await fn();
  } finally {
    confirmLocks.delete(id);
    release();
  }
}

/**
 * @param {object} verified
 * @param {object | null | undefined} thread
 */
function idempotentResult(verified, thread) {
  const base = idempotentConfirmFromThread(thread, verified);
  return {
    ok: true,
    committed: true,
    idempotent: true,
    op: verified.op,
    proposal_id: verified.proposal_id,
    reply: base.reply,
    human_ticket_id: base.human_ticket_id,
    brain: "jarvis_plan",
    replyText: base.reply,
    resolution: {
      committed_op: verified.op,
      proposal_id: verified.proposal_id,
      human_ticket_id: base.human_ticket_id,
      idempotent: true,
    },
  };
}

/**
 * Build resolution extras for thread receipt after successful commit.
 * @param {object} run
 * @param {object} verified
 */
function resolutionExtras(run, verified) {
  const p = verified.payload || {};
  return {
    committed_op: verified.op,
    proposal_id: verified.proposal_id,
    human_ticket_id:
      String(run.resolution?.human_ticket_id || "").trim() ||
      String(p.human_ticket_id || p.humanTicketId || p.ticketHumanId || "").trim() ||
      undefined,
    property_code:
      String(
        run.resolution?.property_code ||
          run.resolution?.propertyCode ||
          p.property_code ||
          p.propertyCode ||
          ""
      )
        .trim()
        .toUpperCase() || undefined,
    unit_label:
      String(
        run.resolution?.unit_label || run.resolution?.unitLabel || p.unit_label || p.unitLabel || ""
      ).trim() || undefined,
    issue_text:
      String(
        run.resolution?.issue_text || run.resolution?.issueText || p.issue_text || p.issueText || ""
      ).trim() || undefined,
    preferred_window:
      String(
        run.resolution?.preferred_window ||
          run.resolution?.preferredWindow ||
          p.preferred_window ||
          p.preferredWindow ||
          ""
      ).trim() || undefined,
    schedule_label: String(run.resolution?.schedule_label || "").trim() || undefined,
    schedule_partial: run.resolution?.schedule_partial === true ? true : undefined,
    note_text: String(p.note_text || p.noteText || "").trim() || undefined,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.confirmToken
 * @param {string} [opts.traceId]
 * @param {string} [opts.staffActorKey]
 * @param {string} [opts.threadId]
 * @param {Record<string, string | undefined>} [opts.routerParameter]
 * @param {object} [opts.staffContext]
 * @param {object} [opts.pageContext]
 * @param {boolean} [opts.confirmedFromThread]
 */
async function executeJarvisConfirm(opts) {
  const o = opts || {};
  const confirmToken = String(o.confirmToken || "").trim();
  if (!confirmToken) {
    return {
      ok: false,
      committed: false,
      brain: "jarvis_plan",
      replyText: "Nothing waiting to confirm. Propose an action first.",
      error: "nothing_pending",
    };
  }

  const verified = verifyProposalConfirmToken(confirmToken);
  if (!verified) {
    return {
      ok: false,
      committed: false,
      brain: "jarvis_plan",
      replyText: "That proposal expired — draft the action again.",
      error: "expired",
    };
  }

  return withConfirmLock(verified.proposal_id, async () => {
    const staffActorKey = String(o.staffActorKey || "").trim();
    const transportChannel = "portal";
    let thread = null;
    let threadId = String(o.threadId || "").trim();

    const sb = jarvisThreadEnabled() ? getSupabase() : null;
    if (sb && staffActorKey) {
      if (!threadId) {
        const hit = await refreshCommCampaignProposalHit(
          sb,
          await findAwaitingProposalForActor(sb, staffActorKey, transportChannel)
        );
        threadId = String(hit?.threadId || "").trim();
        if (hit?.proposal && String(hit.proposal.proposal_id || "") === verified.proposal_id) {
          thread = hit.threadId
            ? await loadJarvisThread(sb, { threadId: hit.threadId })
            : null;
        }
      }
      if (!thread && threadId) {
        thread = await loadJarvisThread(sb, { threadId });
      }
      if (!thread) {
        const found = await findThreadWithProposalForActor(
          sb,
          staffActorKey,
          transportChannel,
          verified.proposal_id
        );
        thread = found?.thread || null;
        threadId = String(found?.threadId || threadId || "").trim();
      }

      const state = findProposalStateOnThread(thread, verified.proposal_id);
      if (state === "committed") {
        return idempotentResult(verified, thread);
      }
      if (state === "executing") {
        const outcome = await waitForProposalOutcome(sb, {
          threadId,
          proposalId: verified.proposal_id,
          timeoutMs: 3500,
        });
        if (outcome?.state === "committed") {
          return idempotentResult(verified, outcome.thread || thread);
        }
        if (outcome?.state === "executing") {
          return {
            ok: false,
            committed: false,
            brain: "jarvis_plan",
            replyText: "Still saving — give it a second, then check the ticket.",
            error: "confirm_in_flight",
          };
        }
        if (outcome?.state === "failed") {
          await markProposalOnThread(sb, {
            threadId,
            proposalId: verified.proposal_id,
            state: "awaiting_confirm",
          });
        }
      }

      if (threadId) {
        const claim = await tryClaimProposalForCommit(sb, {
          threadId,
          proposalId: verified.proposal_id,
        });
        if (claim.kind === "already_committed") {
          return idempotentResult(verified, claim.thread || thread);
        }
        if (claim.kind === "in_flight") {
          const outcome = await waitForProposalOutcome(sb, {
            threadId,
            proposalId: verified.proposal_id,
            timeoutMs: 3500,
          });
          if (outcome?.state === "committed") {
            return idempotentResult(verified, outcome.thread || thread);
          }
          return {
            ok: false,
            committed: false,
            brain: "jarvis_plan",
            replyText: "Still saving — give it a second, then check the ticket.",
            error: "confirm_in_flight",
          };
        }
        thread = claim.thread || thread;
      }

      await clearExpenseConfirmPending(sb, staffActorKey);
    }

    if (verified.op === PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN) {
      const campaignId = campaignIdFromProposal({ confirm_token: confirmToken });
      if (!campaignId) {
        if (sb && threadId) {
          await markProposalOnThread(sb, {
            threadId,
            proposalId: verified.proposal_id,
            state: "expired",
          });
        }
        return {
          ok: false,
          committed: false,
          brain: "jarvis_plan",
          replyText:
            "That broadcast draft is no longer valid. Ask Jarvis to draft a new tenant message.",
          error: "stale_proposal",
          op: verified.op,
          proposal_id: verified.proposal_id,
        };
      }
      if (sb) {
        const { data: campaignRow } = await sb
          .from("communication_campaigns")
          .select("id")
          .eq("id", campaignId)
          .maybeSingle();
        if (!campaignRow) {
          if (threadId) {
            await markProposalOnThread(sb, {
              threadId,
              proposalId: verified.proposal_id,
              state: "expired",
            });
          }
          return {
            ok: false,
            committed: false,
            brain: "jarvis_plan",
            replyText:
              "That broadcast draft was removed from Communications. Ask Jarvis to draft a new message.",
            error: "stale_proposal",
            op: verified.op,
            proposal_id: verified.proposal_id,
            resolution: { error: "not_found", campaign_id: campaignId },
          };
        }
      }
    }

    const actorLabel =
      String(o.staffContext?.staff?.display_name || o.actorLabel || "").trim() || "Staff";
    const staffId = String(o.staffContext?.staff?.staff_id || o.staffId || "").trim();

    const run = await commitProposal(verified, {
      traceId: String(o.traceId || "").trim(),
      channel: transportChannel,
      messageId: String(o.routerParameter?.MessageSid || "").trim(),
      actorLabel,
      staffId,
      staffActorKey,
    });

    if (!run.ok) {
      if (sb && threadId) {
        await markProposalOnThread(sb, {
          threadId,
          proposalId: verified.proposal_id,
          state: "awaiting_confirm",
        });
      }
      await appendEventLog({
        traceId: String(o.traceId || "").trim(),
        log_kind: "agent",
        event: "JARVIS_PLAN_COMMIT_FAILED",
        payload: {
          op: verified.op,
          proposal_id: verified.proposal_id,
          error: String(run.replyText || run.resolution?.error || "").slice(0, 200),
        },
      });
      return {
        ok: false,
        committed: false,
        brain: run.brain || "jarvis_plan",
        replyText: String(run.replyText || "Could not save.").trim(),
        op: verified.op,
        proposal_id: verified.proposal_id,
        error: "commit_failed",
        resolution: run.resolution,
      };
    }

    const extras = resolutionExtras(run, verified);
    const receipt = formatJarvisConfirmReceipt(verified, run);

    if (sb && staffActorKey && threadId) {
      const threadSummary = await recordThreadForStaffRun({
        traceId: o.traceId,
        actorKey: staffActorKey,
        transportChannel,
        routerParameter: o.routerParameter || { From: staffActorKey },
        staffRun: {
          ...run,
          ok: true,
          brain: "jarvis_plan",
          replyText: receipt,
          resolution: extras,
        },
      });
      if (threadSummary) {
        extras.thread = threadSummary;
      }
    }

    await appendEventLog({
      traceId: String(o.traceId || "").trim(),
      log_kind: "agent",
      event: "JARVIS_PLAN_COMMITTED",
      payload: {
        op: verified.op,
        proposal_id: verified.proposal_id,
        brain: run.brain,
        thread_id: threadId || undefined,
        confirmed_from_thread: o.confirmedFromThread === true,
        schedule_partial: extras.schedule_partial === true,
      },
    });

    return {
      ok: true,
      committed: true,
      op: verified.op,
      proposal_id: verified.proposal_id,
      reply: receipt,
      replyText: receipt,
      human_ticket_id: extras.human_ticket_id,
      brain: "jarvis_plan",
      resolution: extras,
      multi_ticket: formatJarvisConfirmReceipt.multiTicketHint(verified),
    };
  });
}

module.exports = { executeJarvisConfirm, withConfirmLock, formatJarvisConfirmReceipt };
