/**
 * Ticket lifecycle Jarvis ops — status, category, issue, complete, cancel.
 * Commits via portalTicketMutations (same brain path as PM portal edits).
 * @see docs/JARVIS_SPINE.md
 */

const crypto = require("crypto");
const {
  tryPortalPmTicketMutation,
  normalizePortalTicketStatus,
} = require("../../dal/portalTicketMutations");
const { staffTicketActor } = require("../../dal/ticketAuditPatch");
const { PROPOSAL_OPS } = require("./types");
const { buildProposalConfirmToken } = require("./proposalToken");

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeVoiceTicketStatus(raw) {
  const t = String(raw || "")
    .trim()
    .toLowerCase();
  if (!t) return "";
  if (t.includes("progress") || t === "active" || t === "working") return "In Progress";
  if (t === "scheduled" || t === "schedule") return "Scheduled";
  return normalizePortalTicketStatus(raw);
}

/**
 * @param {string} op
 * @param {object} draft
 * @param {string} summary
 */
function proposalFromTicketLifecycleDraft(op, draft, summary) {
  const d = draft || {};
  const humanId = String(d.humanTicketId || d.human_ticket_id || "")
    .trim()
    .toUpperCase();
  const payload = {
    human_ticket_id: humanId,
    ticket_row_id: String(d.ticketRowId || d.ticket_row_id || "").trim(),
    property_code: String(d.propertyCode || d.property_code || "")
      .trim()
      .toUpperCase(),
    unit_label: String(d.unitLabel || d.unit_label || "").trim(),
  };

  if (op === PROPOSAL_OPS.SET_TICKET_STATUS) {
    payload.status_to = String(d.statusTo || d.status_to || "").trim();
  } else if (op === PROPOSAL_OPS.SET_TICKET_CATEGORY) {
    payload.category = String(d.category || "").trim();
  } else if (op === PROPOSAL_OPS.UPDATE_TICKET_ISSUE) {
    payload.issue_text = String(d.issueText || d.issue_text || "").trim();
  }

  return {
    version: "1",
    proposal_id: String(d.proposal_id || crypto.randomUUID()).trim(),
    op,
    state: "awaiting_confirm",
    summary_human: String(summary || "").trim(),
    target: {
      ticket_row_id: payload.ticket_row_id,
      human_ticket_id: humanId,
      property_code: payload.property_code,
      unit_label: payload.unit_label,
    },
    payload,
    approval_tier_suggested:
      op === PROPOSAL_OPS.CANCEL_TICKET ? 3 : op === PROPOSAL_OPS.CLOSE_TICKET ? 2 : 2,
    confirm_token: "",
  };
}

/**
 * @param {string} op
 * @param {object} draft
 * @param {string} summary
 */
function buildTicketLifecycleProposal(op, draft, summary) {
  const proposalId = crypto.randomUUID();
  const body = { ...draft, proposal_id: proposalId };
  const token = buildProposalConfirmToken(body, op);
  const proposal = proposalFromTicketLifecycleDraft(op, body, summary);
  proposal.confirm_token = token;
  return { proposal, confirmToken: token };
}

/**
 * @param {string} op
 * @param {object} payload
 * @returns {{ body: string, portalPayload: object } | { error: string }}
 */
function portalMutationInputForLifecycleOp(op, payload) {
  const humanId = String(payload.human_ticket_id || payload.humanTicketId || "")
    .trim()
    .toUpperCase();
  if (!humanId) return { error: "missing_ticket_id" };

  if (op === PROPOSAL_OPS.CANCEL_TICKET) {
    return {
      body: `${humanId} canceled`,
      portalPayload: { ticket_id: humanId },
    };
  }
  if (op === PROPOSAL_OPS.CLOSE_TICKET) {
    return {
      body: "",
      portalPayload: { ticket_id: humanId, status: "Completed" },
    };
  }
  if (op === PROPOSAL_OPS.SET_TICKET_STATUS) {
    const statusTo = normalizeVoiceTicketStatus(
      payload.status_to || payload.statusTo || ""
    );
    if (!statusTo) return { error: "missing_status" };
    return {
      body: "",
      portalPayload: { ticket_id: humanId, status: statusTo },
    };
  }
  if (op === PROPOSAL_OPS.SET_TICKET_CATEGORY) {
    const category = String(payload.category || "").trim();
    if (!category) return { error: "missing_category" };
    return {
      body: "",
      portalPayload: { ticket_id: humanId, category },
    };
  }
  if (op === PROPOSAL_OPS.UPDATE_TICKET_ISSUE) {
    const issue = String(payload.issue_text || payload.issueText || "").trim();
    if (issue.length < 2) return { error: "missing_issue" };
    return {
      body: "",
      portalPayload: { ticket_id: humanId, issue },
    };
  }
  return { error: "unknown_op" };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} _sb
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {{ traceId?: string, actorLabel?: string, staffId?: string, staffActorKey?: string }} ctx
 */
async function commitTicketLifecycle(_sb, verified, ctx) {
  const op = String(verified?.op || "").trim();
  const input = portalMutationInputForLifecycleOp(op, verified.payload || {});
  if (input.error) {
    const msg =
      input.error === "missing_status"
        ? "Missing status for update."
        : input.error === "missing_category"
          ? "Missing category."
          : input.error === "missing_issue"
            ? "Missing issue text."
            : input.error === "missing_ticket_id"
              ? "Missing ticket id."
              : "Could not apply ticket change.";
    return { ok: false, brain: "jarvis_plan", replyText: msg };
  }

  const staffId = String(ctx?.staffId || "").trim();
  const actorLabel = String(ctx?.actorLabel || "Staff").trim() || "Staff";
  const changedBy = staffId
    ? staffTicketActor({ staffId, displayName: actorLabel, source: "jarvis_voice" })
    : null;

  /** @type {Record<string, string>} */
  const routerParameter = {
    Body: input.body || "",
    _portalPayloadJson: JSON.stringify(input.portalPayload),
    _mediaJson: "",
  };
  if (changedBy) {
    routerParameter._portalMutationActorJson = JSON.stringify({
      changed_by_actor_type: changedBy.changed_by_actor_type,
      changed_by_actor_id: changedBy.changed_by_actor_id,
      changed_by_actor_label: changedBy.changed_by_actor_label,
      changed_by_actor_source: changedBy.changed_by_actor_source,
    });
  }

  const traceId = String(ctx?.traceId || "").trim() || "jarvis_ticket_lifecycle";
  const run = await tryPortalPmTicketMutation({
    traceId,
    routerParameter,
    transportChannel: "portal",
    staffAmendContext: staffId
      ? {
          staffId,
          staffActorKey: String(ctx?.staffActorKey || "").trim(),
        }
      : undefined,
  });

  if (!run) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Could not parse ticket update — check ticket id and fields.",
    };
  }

  if (!run.ok) {
    return {
      ok: false,
      brain: run.brain || "jarvis_plan",
      replyText: String(run.replyText || "Ticket update failed."),
      resolution: run.resolution,
    };
  }

  const humanId = String(
    run.resolution?.humanTicketId ||
      run.resolution?.human_ticket_id ||
      input.portalPayload.ticket_id ||
      ""
  )
    .trim()
    .toUpperCase();

  return {
    ok: true,
    brain: "jarvis_plan",
    replyText: String(run.replyText || "Saved.").trim(),
    resolution: {
      committed_op: op,
      proposal_id: verified.proposal_id,
      human_ticket_id: humanId,
      portal_brain: run.brain,
      ...(run.resolution && typeof run.resolution === "object" ? run.resolution : {}),
    },
  };
}

module.exports = {
  normalizeVoiceTicketStatus,
  proposalFromTicketLifecycleDraft,
  buildTicketLifecycleProposal,
  portalMutationInputForLifecycleOp,
  commitTicketLifecycle,
};
