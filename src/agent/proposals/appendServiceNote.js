/**
 * append_service_note — Jarvis proposal op (staff field note on open ticket).
 * Phase 2 foundation for voice/chat "add to service note" without opening the ticket page.
 */

const crypto = require("crypto");
const { getSupabase } = require("../../db/supabase");
const { appendEventLog } = require("../../dal/appendEventLog");
const { isTicketOpenForTenantAppend } = require("../../dal/tenantTicketAppend");
const { PROPOSAL_OPS } = require("./types");
const { buildProposalConfirmToken } = require("./proposalToken");

const MAX_NOTE_CHARS = 2000;

/**
 * @param {object} target
 * @param {string} noteText
 * @param {string} [actorLabel]
 */
function formatStaffServiceNoteLine(noteText, actorLabel) {
  const text = String(noteText || "").trim().slice(0, MAX_NOTE_CHARS);
  if (!text) return "";
  const who = String(actorLabel || "Staff").trim() || "Staff";
  const when = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `[${who} ${when}] ${text}`;
}

/**
 * @param {object} draft
 * @param {string} summary
 */
function proposalFromAppendServiceNoteDraft(draft, summary) {
  const d = draft || {};
  return {
    version: "1",
    proposal_id: String(d.proposal_id || crypto.randomUUID()).trim(),
    op: PROPOSAL_OPS.APPEND_SERVICE_NOTE,
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
      note_text: String(d.noteText || d.note_text || "").trim().slice(0, MAX_NOTE_CHARS),
      actor_label: String(d.actorLabel || d.actor_label || "Staff").trim(),
    },
    approval_tier_suggested: 1,
    confirm_token: "",
  };
}

/**
 * @param {object} draft
 * @param {string} summary
 */
function buildAppendServiceNoteProposal(draft, summary) {
  const proposalId = crypto.randomUUID();
  const body = { ...draft, proposal_id: proposalId };
  const token = buildProposalConfirmToken(body, PROPOSAL_OPS.APPEND_SERVICE_NOTE);
  const proposal = proposalFromAppendServiceNoteDraft(body, summary);
  proposal.confirm_token = token;
  return { proposal, confirmToken: token };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} verified — from verifyProposalConfirmToken
 * @param {object} ctx
 */
async function commitAppendServiceNote(sb, verified, ctx) {
  const payload = verified.payload || {};
  const humanId = String(
    payload.humanTicketId || payload.human_ticket_id || ""
  )
    .trim()
    .toUpperCase();
  const noteText = String(payload.noteText || payload.note_text || "").trim();
  const actorLabel =
    String(ctx?.actorLabel || payload.actorLabel || payload.actor_label || "Staff").trim() ||
    "Staff";

  if (!humanId || !noteText) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Could not append — missing ticket or note text.",
    };
  }

  const line = formatStaffServiceNoteLine(noteText, actorLabel);
  if (!line) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Note text was empty.",
    };
  }

  const { data: ticket, error } = await sb
    .from("tickets")
    .select("id, ticket_id, ticket_key, status, service_notes")
    .eq("ticket_id", humanId)
    .maybeSingle();

  if (error || !ticket) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: `Ticket ${humanId} not found.`,
    };
  }

  if (!isTicketOpenForTenantAppend(ticket.status)) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: `${humanId} is closed — cannot append a service note.`,
    };
  }

  const prev = String(ticket.service_notes || "").trim();
  const merged = prev ? `${prev}\n${line}` : line;
  const now = new Date().toISOString();

  const { error: upErr } = await sb
    .from("tickets")
    .update({
      service_notes: merged.slice(0, 8000),
      updated_at: now,
      last_activity_at: now,
    })
    .eq("ticket_id", humanId);

  if (upErr) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Could not save the service note.",
    };
  }

  await appendEventLog({
    traceId: String(ctx?.traceId || "").trim(),
    log_kind: "brain",
    event: "JARVIS_APPEND_SERVICE_NOTE",
    payload: {
      ticket_id: humanId,
      proposal_id: verified.proposal_id,
      note_len: noteText.length,
    },
  });

  return {
    ok: true,
    brain: "jarvis_plan",
    replyText: `Added service note to ${humanId}.`,
    resolution: {
      committed_op: PROPOSAL_OPS.APPEND_SERVICE_NOTE,
      proposal_id: verified.proposal_id,
      human_ticket_id: humanId,
    },
  };
}

module.exports = {
  formatStaffServiceNoteLine,
  proposalFromAppendServiceNoteDraft,
  buildAppendServiceNoteProposal,
  commitAppendServiceNote,
};
