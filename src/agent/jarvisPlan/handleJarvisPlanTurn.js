/**
 * Jarvis Plan — structured propose → confirm (portal).
 * Slice 1: attach_ticket_cost via existing $$ expense capture.
 */

const { getSupabase } = require("../../db/supabase");
const { appendEventLog } = require("../../dal/appendEventLog");
const { findAwaitingProposalForActor } = require("../../dal/jarvisOperatorThreads");
const { jarvisPlanEnabled, financeCostCaptureChatEnabled } = require("../../config/env");
const {
  tryStaffExpenseCapture,
  isExpenseCaptureMessage,
} = require("../../dal/staffExpenseCapture");
const { compileOperationalScope } = require("../operationalScope/compileOperationalScope");
const {
  executeJarvisConfirm,
  enrichStaffRunWithProposal,
} = require("../proposals");
const { readProposalConfirmTokenFromPortal } = require("./readPortalProposalContext");
const { recordThreadForStaffRun } = require("../thread/recordThreadForStaffRun");
const { parseProposeVendorRequest } = require("./parseProposeVendorRequest");
const { parseProposeAppendServiceNote } = require("./parseProposeAppendServiceNote");
const { parseProposeCommunicationCampaign } = require("./parseProposeCommunicationCampaign");
const { resolveProposeVendorRequestDraft } = require("./resolveProposeVendorRequestDraft");
const { resolveProposeAppendServiceNoteDraft } = require("./resolveProposeAppendServiceNoteDraft");
const { resolveProposeCommunicationCampaignDraft } = require("./resolveProposeCommunicationCampaignDraft");
const {
  buildProposeVendorRequestProposal,
  normalizeProposalForPortal,
} = require("../proposals");
const CONFIRM_BODY_RE = /^(?:yes|y|confirm|ok|1)\.?$/i;

/**
 * @param {Record<string, string | undefined>} routerParameter
 */
function actorLabelFromPortal(routerParameter) {
  try {
    const j = JSON.parse(String(routerParameter._portalMutationActorJson || "{}"));
    return String(j.changed_by_actor_label || "").trim() || "Staff";
  } catch (_) {
    return "Staff";
  }
}

/**
 * @param {object} opts
 * @param {string} opts.traceId
 * @param {Record<string, string | undefined>} opts.routerParameter
 * @param {{ isStaff?: boolean, staff?: { staff_id?: string }, staffActorKey?: string }} opts.staffContext
 */
async function handleJarvisPlanTurn(opts) {
  const traceId = String(opts.traceId || "");
  const routerParameter = opts.routerParameter || {};
  const staffContext = opts.staffContext || {};

  if (!jarvisPlanEnabled()) {
    return {
      ok: true,
      brain: "jarvis_plan",
      replyText:
        "Jarvis Plan is not enabled on this server. Set JARVIS_PLAN_ENABLED=1 on propera-v2.",
    };
  }

  const staffActorKey =
    staffContext.staff && staffContext.staffActorKey
      ? String(staffContext.staffActorKey || "").trim()
      : String(routerParameter.From || "").trim();

  const bodyTrim = String(routerParameter.Body || "").trim();
  let confirmToken = readProposalConfirmTokenFromPortal(routerParameter);
  let confirmedFromThread = false;
  if (!confirmToken && CONFIRM_BODY_RE.test(bodyTrim)) {
    const sb = getSupabase();
    if (sb && staffActorKey) {
      const hit = await findAwaitingProposalForActor(sb, staffActorKey, "portal");
      const token = String(hit?.proposal?.confirm_token || "").trim();
      if (token) {
        confirmToken = token;
        confirmedFromThread = true;
      }
    }
  }
  if (confirmToken) {
    const result = await executeJarvisConfirm({
      confirmToken,
      traceId,
      staffActorKey,
      routerParameter,
      staffContext,
      confirmedFromThread,
    });

    if (!result.ok) {
      return {
        ok: true,
        brain: "jarvis_plan",
        replyText: result.replyText,
        resolution: {
          error: result.error,
          proposal_id: result.proposal_id,
        },
      };
    }

    const committed = {
      ok: true,
      brain: "jarvis_plan",
      replyText: result.replyText,
      resolution: {
        ...(result.resolution || {}),
        idempotent: result.idempotent === true ? true : undefined,
      },
    };
    if (result.resolution?.thread) {
      committed.resolution = { ...committed.resolution, thread: result.resolution.thread };
    }
    return committed;
  }

  if (!isExpenseCaptureMessage(bodyTrim) && !bodyTrim) {
    await compileOperationalScope({
      routerParameter,
      actorRole: staffContext.isStaff ? "staff" : "owner",
      staffId:
        staffContext.staff && staffContext.staff.staff_id
          ? String(staffContext.staff.staff_id).trim()
          : "",
      actorKey: staffActorKey,
      transportChannel: "portal",
    });
    return {
      ok: true,
      brain: "jarvis_plan",
      replyText:
        "Plan mode: propose an action, then confirm.\n" +
        "• Note: note: need to order part (with ticket id or pinned unit)\n" +
        "• Vendor: schedule plumber for unit 303 PENN\n" +
        "• Broadcast: send message to all tenants at PENN about …\n" +
        "• Cost: $$42.00 homedepot parts",
    };
  }

  const noteParsed = parseProposeAppendServiceNote(bodyTrim, routerParameter);
  if (noteParsed) {
    const draft = await resolveProposeAppendServiceNoteDraft(noteParsed, {
      routerParameter,
      actorLabel: actorLabelFromPortal(routerParameter),
      staffActorKey,
      staffId:
        staffContext.staff && staffContext.staff.staff_id
          ? String(staffContext.staff.staff_id).trim()
          : "",
    });
    if (!draft.ok) {
      return {
        ok: true,
        brain: "jarvis_plan",
        replyText: draft.message || "Could not draft service note.",
      };
    }
    const run = {
      ok: true,
      brain: "jarvis_plan",
      replyText: `${draft.summary}\nReply Confirm on the card (or type yes).`,
      resolution: {
        needsConfirm: true,
        confirmToken: draft.confirmToken,
        confirmSummary: draft.summary,
        proposal: normalizeProposalForPortal(draft.proposal),
      },
    };
    const thread = await recordThreadForStaffRun({
      traceId,
      actorKey: staffActorKey,
      transportChannel: "portal",
      routerParameter,
      staffRun: run,
      scopeSnapshot: draft.scopeSnapshot,
    });
    if (thread) {
      run.resolution = { ...run.resolution, thread };
    }
    await appendEventLog({
      traceId,
      log_kind: "agent",
      event: "JARVIS_PLAN_PROPOSED",
      payload: {
        op: draft.proposal.op,
        proposal_id: draft.proposal.proposal_id,
        needs_confirm: true,
        thread_id: thread?.thread_id,
      },
    });
    return run;
  }

  const commParsed = parseProposeCommunicationCampaign(bodyTrim, routerParameter);
  if (commParsed) {
    const draft = await resolveProposeCommunicationCampaignDraft(commParsed, {
      traceId,
      routerParameter,
      staffActorKey,
      staffId:
        staffContext.staff && staffContext.staff.staff_id
          ? String(staffContext.staff.staff_id).trim()
          : "",
    });
    if (!draft.ok) {
      return {
        ok: true,
        brain: "jarvis_plan",
        replyText: draft.message || "Could not draft tenant broadcast.",
      };
    }
    const run = {
      ok: true,
      brain: "jarvis_plan",
      replyText: `${draft.summary}\nReply Confirm on the card (or type yes).`,
      resolution: {
        needsConfirm: true,
        confirmToken: draft.confirmToken,
        confirmSummary: draft.summary,
        proposal: normalizeProposalForPortal(draft.proposal),
      },
    };
    const thread = await recordThreadForStaffRun({
      traceId,
      actorKey: staffActorKey,
      transportChannel: "portal",
      routerParameter,
      staffRun: run,
      scopeSnapshot: draft.scopeSnapshot,
    });
    if (thread) {
      run.resolution = { ...run.resolution, thread };
    }
    await appendEventLog({
      traceId,
      log_kind: "agent",
      event: "JARVIS_PLAN_PROPOSED",
      payload: {
        op: draft.proposal.op,
        proposal_id: draft.proposal.proposal_id,
        needs_confirm: true,
        thread_id: thread?.thread_id,
      },
    });
    return run;
  }

  const vendorParsed = parseProposeVendorRequest(bodyTrim, routerParameter);
  if (vendorParsed) {
    const draft = await resolveProposeVendorRequestDraft(
      vendorParsed,
      actorLabelFromPortal(routerParameter)
    );
    if (!draft.ok) {
      return {
        ok: true,
        brain: "jarvis_plan",
        replyText: draft.message || "Could not draft vendor assignment.",
      };
    }
    const built = buildProposeVendorRequestProposal(draft.commitPayload, draft.summary);
    const run = {
      ok: true,
      brain: "jarvis_plan",
      replyText: `${draft.summary}\nReply Confirm on the card (or type yes).`,
      resolution: {
        needsConfirm: true,
        confirmToken: built.confirmToken,
        confirmSummary: draft.summary,
        proposal: normalizeProposalForPortal(built.proposal),
      },
    };
    const thread = await recordThreadForStaffRun({
      traceId,
      actorKey: staffActorKey,
      transportChannel: "portal",
      routerParameter,
      staffRun: run,
    });
    if (thread) {
      run.resolution = { ...run.resolution, thread };
    }
    await appendEventLog({
      traceId,
      log_kind: "agent",
      event: "JARVIS_PLAN_PROPOSED",
      payload: {
        op: built.proposal.op,
        proposal_id: built.proposal.proposal_id,
        needs_confirm: true,
        thread_id: thread?.thread_id,
      },
    });
    return run;
  }

  const expenseRouter = {
    ...routerParameter,
    _portalChatMode: "cost",
  };

  if (!financeCostCaptureChatEnabled()) {
    return {
      ok: true,
      brain: "jarvis_plan",
      replyText:
        "Cost proposals need finance cost capture. Set PROPERA_FINANCE_COST_CAPTURE_CHAT=1 on propera-v2.\n" +
        "For notes use: note: your text here",
    };
  }

  let run = await tryStaffExpenseCapture({
    traceId,
    routerParameter: expenseRouter,
    transportChannel: "portal",
    staffActorKey,
    messageId: String(routerParameter.MessageSid || "").trim(),
  });

  if (!run) {
    return {
      ok: true,
      brain: "jarvis_plan",
      replyText:
        "Could not draft a proposal. Use $$ plus amount and vendor, with a ticket id or property/unit pin.",
    };
  }

  run = enrichStaffRunWithProposal(run);
  if (run.resolution && run.resolution.proposal) {
    run.brain = "jarvis_plan";
    const thread = await recordThreadForStaffRun({
      traceId,
      actorKey: staffActorKey,
      transportChannel: "portal",
      routerParameter,
      staffRun: run,
    });
    if (thread) {
      run.resolution = { ...run.resolution, thread };
    }
    await appendEventLog({
      traceId,
      log_kind: "agent",
      event: "JARVIS_PLAN_PROPOSED",
      payload: {
        op: run.resolution.proposal.op,
        proposal_id: run.resolution.proposal.proposal_id,
        needs_confirm: true,
        thread_id: thread?.thread_id,
      },
    });
  }

  return run;
}

module.exports = { handleJarvisPlanTurn };
