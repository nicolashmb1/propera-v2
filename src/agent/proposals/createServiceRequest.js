/**
 * create_service_request — Jarvis Plan → finalizeMaintenanceDraft (structured portal create).
 * @see docs/JARVIS_SPINE.md
 */

const crypto = require("crypto");
const { getSupabase } = require("../../db/supabase");
const { finalizeMaintenanceDraft } = require("../../dal/finalizeMaintenance");
const { appendEventLog } = require("../../dal/appendEventLog");
const { staffTicketActor } = require("../../dal/ticketAuditPatch");
const {
  applyPreferredWindowByTicketKey,
  MIN_SCHEDULE_LEN,
  schedulePolicyRejectMessage,
} = require("../../dal/ticketPreferredWindow");
const { afterTenantScheduleApplied } = require("../../brain/lifecycle/afterTenantScheduleApplied");
const { PROPOSAL_OPS } = require("./types");
const { buildProposalConfirmToken } = require("./proposalToken");

/**
 * @param {object} draft
 * @param {string} summary
 */
function proposalFromCreateServiceRequestDraft(draft, summary) {
  const d = draft || {};
  return {
    version: "1",
    proposal_id: String(d.proposal_id || crypto.randomUUID()).trim(),
    op: PROPOSAL_OPS.CREATE_SERVICE_REQUEST,
    state: "awaiting_confirm",
    summary_human: String(summary || "").trim(),
    target: {
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
      unit_label: String(d.unitLabel || d.unit_label || "").trim(),
    },
    payload: {
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
      unit_label: String(d.unitLabel || d.unit_label || "").trim(),
      issue_text: String(d.issueText || d.issue_text || "").trim(),
      category: String(d.category || "General").trim() || "General",
      urgency: String(d.urgency || "Normal").trim() || "Normal",
      preferred_window: String(d.preferredWindow || d.preferred_window || "").trim(),
    },
    approval_tier_suggested: 2,
    confirm_token: "",
  };
}

/**
 * @param {object} draft
 * @param {string} summary
 */
function buildCreateServiceRequestProposal(draft, summary) {
  const proposalId = crypto.randomUUID();
  const body = { ...draft, proposal_id: proposalId };
  const token = buildProposalConfirmToken(body, PROPOSAL_OPS.CREATE_SERVICE_REQUEST);
  const proposal = proposalFromCreateServiceRequestDraft(body, summary);
  proposal.confirm_token = token;
  return { proposal, confirmToken: token };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} _sb
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {{ traceId?: string, actorLabel?: string, staffId?: string, staffActorKey?: string }} ctx
 */
/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} o
 */
async function applyScheduleAfterCreate(sb, o) {
  const ticketKey = String(o.ticketKey || "").trim();
  const preferredWindow = String(o.preferredWindow || "").trim();
  if (!sb || !ticketKey || preferredWindow.length < MIN_SCHEDULE_LEN) {
    return { ok: true, skipped: true };
  }

  const traceId = String(o.traceId || "").trim();
  const traceStartMs = Date.now();
  const applied = await applyPreferredWindowByTicketKey({
    ticketKey,
    preferredWindow,
    traceId,
    traceStartMs,
    ticketChangedBy: o.ticketChangedBy || null,
  });

  if (!applied.ok) {
    const msg =
      applied.error === "policy"
        ? schedulePolicyRejectMessage(applied.policyKey, applied.policyVars)
        : applied.error === "bad_input"
          ? "Could not interpret that time window."
          : String(applied.error || "schedule_failed");
    return { ok: false, error: msg };
  }

  await afterTenantScheduleApplied({
    sb,
    ticketKey,
    parsed: applied.parsed || null,
    propertyCodeHint: String(o.propertyCode || "").trim().toUpperCase(),
    traceId,
    traceStartMs,
    ticketChangedBy: o.ticketChangedBy || null,
  });

  const label =
    applied.parsed && applied.parsed.label
      ? String(applied.parsed.label).trim()
      : preferredWindow;

  return { ok: true, scheduleLabel: label };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} _sb
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {{ traceId?: string, actorLabel?: string, staffId?: string, staffActorKey?: string }} ctx
 */
async function commitCreateServiceRequest(_sb, verified, ctx) {
  const p = verified.payload || {};
  const propertyCode = String(p.property_code || p.propertyCode || "")
    .trim()
    .toUpperCase();
  const unitLabel = String(p.unit_label || p.unitLabel || "").trim();
  const issueText = String(p.issue_text || p.issueText || "").trim();
  const category = String(p.category || "General").trim() || "General";
  const urgRaw = String(p.urgency || "Normal").trim().toUpperCase();
  const urgency = urgRaw === "URGENT" || urgRaw === "HIGH" ? "Urgent" : "Normal";

  if (!propertyCode || !unitLabel || issueText.length < 2) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Missing property, unit, or issue for create.",
    };
  }

  const staffId = String(ctx.staffId || "").trim();
  const actorLabel = String(ctx.actorLabel || "Staff").trim() || "Staff";
  const changedBy = staffId
    ? staffTicketActor({ staffId, displayName: actorLabel, source: "jarvis_voice" })
    : null;

  const routerParameter = {
    _portalAction: "create_ticket",
    _portalPayloadJson: JSON.stringify({
      property: propertyCode,
      unit: unitLabel,
      message: issueText,
      category,
      urgency,
      status: "Open",
      serviceNote: "",
      location_kind: "unit",
    }),
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

  const traceId = String(ctx.traceId || "").trim();
  const actorKey = String(ctx.staffActorKey || "").trim() || "portal_jarvis";

  const fin = await finalizeMaintenanceDraft({
    traceId: traceId || "jarvis_create_ticket",
    propertyCode,
    unitLabel,
    issueText,
    actorKey,
    mode: "MANAGER",
    locationType: "UNIT",
    staffActorKey: staffId || actorKey,
    routerParameter,
    tenantPhoneE164: "",
  });

  if (!fin.ok) {
    const err = String(fin.error || fin.hint || "create_failed").trim();
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: `Could not create ticket: ${err}.`,
    };
  }

  const humanId = String(fin.ticketId || "").trim().toUpperCase();
  const ticketKey = String(fin.ticketKey || "").trim();
  const preferredWindow = String(
    p.preferred_window || p.preferredWindow || ""
  ).trim();

  await appendEventLog({
    traceId,
    log_kind: "brain",
    event: "JARVIS_CREATE_SERVICE_REQUEST",
    payload: {
      proposal_id: verified.proposal_id,
      human_ticket_id: humanId,
      property_code: propertyCode,
      unit_label: unitLabel,
      has_schedule: preferredWindow.length >= MIN_SCHEDULE_LEN,
    },
  });

  let replyText = humanId
    ? `Created ${humanId} for unit ${unitLabel} at ${propertyCode}.`
    : "Ticket created.";
  let scheduleLabel = "";

  if (preferredWindow.length >= MIN_SCHEDULE_LEN && ticketKey) {
    const sb = getSupabase();
    const sched = await applyScheduleAfterCreate(sb, {
      ticketKey,
      preferredWindow,
      propertyCode,
      traceId,
      ticketChangedBy: changedBy,
    });
    if (sched.ok && !sched.skipped && sched.scheduleLabel) {
      scheduleLabel = sched.scheduleLabel;
      replyText = humanId
        ? `Created ${humanId} and scheduled ${scheduleLabel}.`
        : `Ticket created and scheduled ${scheduleLabel}.`;
      await appendEventLog({
        traceId,
        log_kind: "brain",
        event: "JARVIS_CREATE_SERVICE_REQUEST_SCHEDULED",
        payload: {
          proposal_id: verified.proposal_id,
          human_ticket_id: humanId,
          window: preferredWindow,
          schedule_label: scheduleLabel,
        },
      });
    } else if (!sched.ok) {
      replyText = humanId
        ? `Created ${humanId}, but schedule was not applied: ${sched.error}. You can schedule separately.`
        : `Ticket created, but schedule was not applied: ${sched.error}. You can schedule separately.`;
    }
  }

  const schedulePartial =
    preferredWindow.length >= MIN_SCHEDULE_LEN && !!humanId && !scheduleLabel && !!ticketKey;

  return {
    ok: true,
    brain: "jarvis_plan",
    replyText,
    resolution: {
      committed_op: PROPOSAL_OPS.CREATE_SERVICE_REQUEST,
      proposal_id: verified.proposal_id,
      human_ticket_id: humanId,
      ticket_key: ticketKey,
      schedule_label: scheduleLabel || undefined,
      schedule_partial: schedulePartial || undefined,
      property_code: propertyCode,
      unit_label: unitLabel,
      issue_text: issueText,
      preferred_window: preferredWindow || undefined,
    },
  };
}

module.exports = {
  proposalFromCreateServiceRequestDraft,
  buildCreateServiceRequestProposal,
  commitCreateServiceRequest,
};
