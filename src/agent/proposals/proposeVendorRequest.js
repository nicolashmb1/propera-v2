/**
 * propose_vendor_request — Jarvis Plan → assignVendorToTicket + optional dispatch.
 * @see docs/VENDOR_LANE.md, docs/JARVIS_SPINE.md
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const { PROPOSAL_OPS } = require("./types");
const { buildProposalConfirmToken } = require("./proposalToken");

/**
 * @param {object} draft — commitPayload from resolveProposeVendorRequestDraft
 * @param {string} summary
 */
function proposalFromVendorDraft(draft, summary) {
  const d = draft || {};
  return {
    version: "1",
    proposal_id: String(d.proposal_id || "").trim(),
    op: PROPOSAL_OPS.PROPOSE_VENDOR_REQUEST,
    state: "awaiting_confirm",
    summary_human: String(summary || "").trim(),
    target: {
      ticket_row_id: String(d.ticketRowId || "").trim(),
      human_ticket_id: String(d.humanTicketId || "").trim(),
      property_code: "",
    },
    payload: {
      vendor_id: String(d.vendorId || "").trim(),
      vendor_display_name: String(d.vendorDisplayName || "").trim(),
      dispatch: d.dispatch !== false,
      assignment_note: String(d.assignmentNote || "").trim(),
    },
    approval_tier_suggested: 2,
    confirm_token: "",
  };
}

/**
 * @param {object} draft
 * @param {string} summary
 */
function buildProposeVendorRequestProposal(draft, summary) {
  const token = buildProposalConfirmToken(draft, PROPOSAL_OPS.PROPOSE_VENDOR_REQUEST);
  const proposal = proposalFromVendorDraft({ ...draft, proposal_id: draft.proposal_id }, summary);
  proposal.confirm_token = token;
  return { proposal, confirmToken: token };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} _sb
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {{ traceId?: string, actorLabel?: string }} ctx
 */
async function commitProposeVendorRequest(_sb, verified, ctx) {
  const { assignVendorToTicket } = require("../../dal/vendorAssignment");
  const p = verified.payload || {};
  const traceId = String(ctx.traceId || "");
  const actorLabel = String(p.assignedBy || ctx.actorLabel || "Jarvis Plan").trim();

  const out = await assignVendorToTicket({
    ticketLookupHint: String(p.humanTicketId || "").trim(),
    ticketRowIdHint: String(p.ticketRowId || "").trim(),
    ticketKeyHint: String(p.ticketKey || "").trim(),
    vendorId: String(p.vendorId || "").trim(),
    source: "PM_OVERRIDE",
    assignedBy: actorLabel,
    assignmentNote: String(p.assignmentNote || "").trim(),
    dispatch: p.dispatch !== false,
    traceId,
  });

  if (!out.ok) {
    const err = String(out.error || "vendor_assign_failed");
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: `Could not assign vendor: ${err}.`,
    };
  }

  if (out.assignmentSkipped) {
    return {
      ok: true,
      brain: "jarvis_plan",
      replyText:
        "Assignment not changed (PM override on ticket). Dispatch was not sent.",
      resolution: {
        committed_op: PROPOSAL_OPS.PROPOSE_VENDOR_REQUEST,
        proposal_id: verified.proposal_id,
        assignmentSkipped: true,
      },
    };
  }

  const tid = String(out.ticketId || p.humanTicketId || "").trim();
  const name = String(out.assignedDisplayName || p.vendorDisplayName || "").trim();
  let reply = `Assigned ${name} to ${tid}.`;
  if (out.dispatched) {
    reply += " Dispatch SMS sent.";
  } else {
    const reason = String(out.dispatchSkippedReason || out.dispatchError || "").trim();
    if (reason) reply += ` Dispatch not sent (${reason}).`;
  }

  await appendEventLog({
    traceId,
    log_kind: "agent",
    event: "JARVIS_PLAN_VENDOR_COMMITTED",
    payload: {
      proposal_id: verified.proposal_id,
      human_ticket_id: tid,
      vendor_id: p.vendorId,
      dispatched: out.dispatched === true,
    },
  });

  return {
    ok: true,
    brain: "jarvis_plan",
    replyText: reply,
    resolution: {
      committed_op: PROPOSAL_OPS.PROPOSE_VENDOR_REQUEST,
      proposal_id: verified.proposal_id,
      ticketId: tid,
      dispatched: out.dispatched === true,
    },
  };
}

module.exports = {
  proposalFromVendorDraft,
  buildProposeVendorRequestProposal,
  commitProposeVendorRequest,
};
