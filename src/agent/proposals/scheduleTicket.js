/**
 * schedule_ticket — Jarvis Plan → applyPreferredWindowByTicketKey + lifecycle.
 * @see docs/JARVIS_SPINE.md
 */

const crypto = require("crypto");
const { getSupabase } = require("../../db/supabase");
const {
  applyPreferredWindowByTicketKey,
  MIN_SCHEDULE_LEN,
  schedulePolicyRejectMessage,
} = require("../../dal/ticketPreferredWindow");
const { afterTenantScheduleApplied } = require("../../brain/lifecycle/afterTenantScheduleApplied");
const { appendEventLog } = require("../../dal/appendEventLog");
const { staffTicketActor } = require("../../dal/ticketAuditPatch");
const { PROPOSAL_OPS } = require("./types");
const { buildProposalConfirmToken } = require("./proposalToken");

/**
 * @param {object} draft
 * @param {string} summary
 */
function proposalFromScheduleTicketDraft(draft, summary) {
  const d = draft || {};
  return {
    version: "1",
    proposal_id: String(d.proposal_id || crypto.randomUUID()).trim(),
    op: PROPOSAL_OPS.SCHEDULE_TICKET,
    state: "awaiting_confirm",
    summary_human: String(summary || "").trim(),
    target: {
      ticket_row_id: String(d.ticketRowId || d.ticket_row_id || "").trim(),
      human_ticket_id: String(d.humanTicketId || d.human_ticket_id || "").trim(),
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
      unit_label: String(d.unitLabel || d.unit_label || "").trim(),
    },
    payload: {
      human_ticket_id: String(d.humanTicketId || d.human_ticket_id || "").trim(),
      ticket_row_id: String(d.ticketRowId || d.ticket_row_id || "").trim(),
      ticket_key: String(d.ticketKey || d.ticket_key || "").trim(),
      preferred_window: String(d.preferredWindow || d.preferred_window || "").trim(),
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
    },
    approval_tier_suggested: 2,
    confirm_token: "",
  };
}

/**
 * @param {object} draft
 * @param {string} summary
 */
function buildScheduleTicketProposal(draft, summary) {
  const proposalId = crypto.randomUUID();
  const body = { ...draft, proposal_id: proposalId };
  const token = buildProposalConfirmToken(body, PROPOSAL_OPS.SCHEDULE_TICKET);
  const proposal = proposalFromScheduleTicketDraft(body, summary);
  proposal.confirm_token = token;
  return { proposal, confirmToken: token };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {{ traceId?: string, actorLabel?: string, staffId?: string }} ctx
 */
async function commitScheduleTicket(sb, verified, ctx) {
  const p = verified.payload || {};
  const preferredWindow = String(p.preferred_window || p.preferredWindow || "").trim();
  const humanId = String(p.human_ticket_id || p.humanTicketId || "")
    .trim()
    .toUpperCase();
  let ticketKey = String(p.ticket_key || p.ticketKey || "").trim();

  if (!sb) {
    return { ok: false, brain: "jarvis_plan", replyText: "Database is not configured." };
  }
  if (preferredWindow.length < MIN_SCHEDULE_LEN) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Need a clearer schedule window (day and time).",
    };
  }

  if (!ticketKey && humanId) {
    const { data: row } = await sb
      .from("tickets")
      .select("ticket_key, property_code, status, is_imported_history")
      .eq("ticket_id", humanId)
      .maybeSingle();
    if (!row) {
      return {
        ok: false,
        brain: "jarvis_plan",
        replyText: `Ticket ${humanId} not found.`,
      };
    }
    if (row.is_imported_history === true) {
      return {
        ok: false,
        brain: "jarvis_plan",
        replyText: "Historical tickets cannot be scheduled.",
      };
    }
    const status = String(row.status || "").toLowerCase();
    if (status === "deleted" || status === "completed") {
      return {
        ok: false,
        brain: "jarvis_plan",
        replyText: `Ticket ${humanId} is ${row.status} — cannot schedule.`,
      };
    }
    ticketKey = String(row.ticket_key || "").trim();
  }

  if (!ticketKey) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Could not resolve ticket for scheduling.",
    };
  }

  const staffId = String(ctx.staffId || "").trim();
  const actorLabel = String(ctx.actorLabel || "Staff").trim() || "Staff";
  const ticketChangedBy = staffId
    ? staffTicketActor({ staffId, displayName: actorLabel, source: "jarvis_voice" })
    : null;

  const traceId = String(ctx.traceId || "").trim();
  const traceStartMs = Date.now();

  const applied = await applyPreferredWindowByTicketKey({
    ticketKey,
    preferredWindow,
    traceId,
    traceStartMs,
    ticketChangedBy,
  });

  if (!applied.ok) {
    const msg =
      applied.error === "policy"
        ? schedulePolicyRejectMessage(applied.policyKey, applied.policyVars)
        : applied.error === "bad_input"
          ? "Could not interpret that time window — try a clearer day and time."
          : String(applied.error || "schedule_failed");
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: `Schedule not applied: ${msg}`,
    };
  }

  const propHint = String(p.property_code || p.propertyCode || "").trim().toUpperCase();
  await afterTenantScheduleApplied({
    sb,
    ticketKey,
    parsed: applied.parsed || null,
    propertyCodeHint: propHint,
    traceId,
    traceStartMs,
    ticketChangedBy,
  });

  const label =
    applied.parsed && applied.parsed.label
      ? String(applied.parsed.label).trim()
      : preferredWindow;

  await appendEventLog({
    traceId,
    log_kind: "brain",
    event: "JARVIS_SCHEDULE_TICKET",
    payload: {
      proposal_id: verified.proposal_id,
      human_ticket_id: humanId,
      ticket_key: ticketKey,
      window: preferredWindow,
    },
  });

  return {
    ok: true,
    brain: "jarvis_plan",
    replyText: humanId
      ? `Scheduled ${humanId}: ${label}.`
      : `Scheduled: ${label}.`,
    resolution: {
      committed_op: PROPOSAL_OPS.SCHEDULE_TICKET,
      proposal_id: verified.proposal_id,
      human_ticket_id: humanId,
      ticket_key: ticketKey,
      schedule_label: label,
    },
  };
}

module.exports = {
  proposalFromScheduleTicketDraft,
  buildScheduleTicketProposal,
  commitScheduleTicket,
};
