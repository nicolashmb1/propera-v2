/**
 * Jarvis live voice — propose / confirm handlers (expression → proposal spine).
 */

const { getSupabase } = require("../db/supabase");
const { jarvisPlanEnabled, jarvisThreadEnabled } = require("../config/env");
const { resolveProposalTicketTarget } = require("../agent/proposals/resolveProposalTicketTarget");
const { buildAppendServiceNoteProposal } = require("../agent/proposals/appendServiceNote");
const {
  verifyProposalConfirmToken,
  commitProposal,
} = require("../agent/proposals");
const { findAwaitingProposalForActor } = require("../dal/jarvisOperatorThreads");
const { recordThreadForStaffRun } = require("../agent/thread/recordThreadForStaffRun");
const { emit } = require("../logging/structuredLog");

/**
 * @param {object} args
 * @param {object} ctx
 */
async function proposeAppendServiceNote(args, ctx) {
  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Service note proposals need JARVIS_PLAN_ENABLED=1 on the server.",
    };
  }

  const noteText = String(args.note_text || args.noteText || "").trim();
  if (!noteText) {
    return { error: "missing_note", message: "Need note_text to append." };
  }

  const resolved = await resolveProposalTicketTarget({
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    humanTicketId: args.human_ticket_id || args.humanTicketId,
    unitLabel: args.unit_label || args.unitLabel || args.unit,
    propertyCode: args.property_code || args.propertyCode,
    issueHint: args.issue_hint || args.issueHint,
  });

  if (!resolved.ok) {
    return {
      error: resolved.error,
      message: resolved.message,
      candidates: resolved.candidates || [],
    };
  }

  const target = resolved.target;
  const humanId = String(target.humanTicketId || "").trim();
  if (!humanId) {
    return {
      error: "no_ticket_id",
      message: "Resolved a target but ticket id is missing — try the ticket id directly.",
    };
  }

  const actorLabel =
    String(ctx.staffContext?.staff?.display_name || "").trim() || "Staff";
  const summary = `Append service note to ${humanId}${target.unitLabel ? ` (unit ${target.unitLabel})` : ""}: ${noteText.slice(0, 120)}${noteText.length > 120 ? "…" : ""}`;

  const { proposal, confirmToken } = buildAppendServiceNoteProposal(
    {
      ticketRowId: target.ticketRowId,
      humanTicketId: humanId,
      propertyCode: target.propertyCode,
      unitLabel: target.unitLabel,
      noteText,
      actorLabel,
    },
    summary
  );

  if (jarvisThreadEnabled()) {
    await recordThreadForStaffRun({
      traceId: ctx.traceId,
      actorKey: ctx.staffActorKey,
      transportChannel: "portal",
      routerParameter: {
        From: ctx.staffActorKey,
        _portalPageContextJson: ctx.pageContext
          ? JSON.stringify(ctx.pageContext)
          : "",
      },
      staffRun: {
        brain: "jarvis_plan",
        replyText: summary,
        resolution: {
          needsConfirm: true,
          proposal,
        },
      },
      scopeSnapshot: ctx.scope ? { anchor: ctx.scope.anchor } : null,
    });
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "append_service_note_proposed",
    data: { human_ticket_id: humanId, note_len: noteText.length },
  });

  return {
    needs_confirm: true,
    op: "append_service_note",
    summary_human: summary,
    human_ticket_id: humanId,
    unit_label: target.unitLabel,
    confirm_token: confirmToken,
    speak:
      `I'll append that to ${humanId}. ` +
      `${noteText.slice(0, 200)}${noteText.length > 200 ? "…" : ""}. ` +
      "Say yes to confirm.",
  };
}

/**
 * @param {object} ctx
 */
async function confirmPendingProposal(ctx) {
  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Confirm is not available — Jarvis Plan is disabled.",
    };
  }

  let confirmToken = String(ctx.pendingConfirmToken || "").trim();

  if (!confirmToken && jarvisThreadEnabled()) {
    const sb = getSupabase();
    if (sb && ctx.staffActorKey) {
      const hit = await findAwaitingProposalForActor(sb, ctx.staffActorKey, "portal");
      confirmToken = String(hit?.proposal?.confirm_token || "").trim();
    }
  }

  if (!confirmToken) {
    return {
      error: "nothing_pending",
      message: "Nothing waiting to confirm. Propose an action first.",
    };
  }

  const verified = verifyProposalConfirmToken(confirmToken);
  if (!verified) {
    return {
      error: "expired",
      message: "That proposal expired — say it again.",
    };
  }

  const run = await commitProposal(verified, {
    traceId: ctx.traceId,
    channel: "portal",
    actorLabel: String(ctx.staffContext?.staff?.display_name || "").trim() || "Staff",
  });

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "proposal_committed",
    data: { op: verified.op, proposal_id: verified.proposal_id },
  });

  return {
    committed: true,
    op: verified.op,
    reply: String(run.replyText || "").trim() || "Done.",
    human_ticket_id:
      run.resolution?.human_ticket_id ||
      verified.payload?.humanTicketId ||
      "",
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function resolveOpenTicket(args, ctx) {
  const resolved = await resolveProposalTicketTarget({
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    humanTicketId: args.human_ticket_id || args.humanTicketId,
    unitLabel: args.unit_label || args.unitLabel || args.unit,
    propertyCode: args.property_code || args.propertyCode,
    issueHint: args.issue_hint || args.issueHint,
  });

  if (!resolved.ok) {
    return {
      found: false,
      error: resolved.error,
      message: resolved.message,
      candidates: resolved.candidates || [],
    };
  }

  return {
    found: true,
    target: resolved.target,
    reason: resolved.reason,
    message:
      `Open ticket ${resolved.target.humanTicketId}` +
      (resolved.target.unitLabel ? ` unit ${resolved.target.unitLabel}` : "") +
      (resolved.target.category ? ` — ${resolved.target.category}` : ""),
  };
}

module.exports = {
  proposeAppendServiceNote,
  confirmPendingProposal,
  resolveOpenTicket,
};
