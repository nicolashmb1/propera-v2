/**
 * Jarvis live voice — propose / confirm handlers (expression → proposal spine).
 */

const crypto = require("crypto");
const { getSupabase } = require("../db/supabase");
const {
  jarvisPlanEnabled,
  jarvisThreadEnabled,
  financeCostCaptureChatEnabled,
  financeCostCapturePropertyAllowlist,
  accessEngineEnabled,
  communicationEngineEnabled,
  jarvisCommPortfolioEnabled,
} = require("../config/env");
const { resolveProposalTicketTarget } = require("../agent/proposals/resolveProposalTicketTarget");
const { buildAppendServiceNoteProposal } = require("../agent/proposals/appendServiceNote");
const { buildAttachTicketCostProposal } = require("../agent/proposals/attachTicketCost");
const { buildProposeVendorRequestProposal } = require("../agent/proposals/proposeVendorRequest");
const { buildCreateServiceRequestProposal } = require("../agent/proposals/createServiceRequest");
const { buildScheduleTicketProposal } = require("../agent/proposals/scheduleTicket");
const {
  buildTicketLifecycleProposal,
  normalizeVoiceTicketStatus,
} = require("../agent/proposals/ticketLifecycleOps");
const { buildBookAmenityProposal } = require("../agent/proposals/bookAmenityReservation");
const { buildSetAmenityScheduleProposal, normalizeScheduleRows, formatScheduleSummary } = require("../agent/proposals/setAmenitySchedule");
const { buildCancelAmenityProposal, formatBookingLabel } = require("../agent/proposals/cancelAmenityReservation");
const {
  buildUpdateAmenityPolicyProposal,
  pickPolicyPatch,
  formatPolicyChangeSummary,
} = require("../agent/proposals/updateAmenityPolicy");
const { resolveAccessLocation } = require("../agent/proposals/resolveAccessLocation");
const { resolveAmenityTenant } = require("../agent/proposals/resolveAmenityTenant");
const { resolveAccessReservation } = require("../agent/access/resolveAccessReservation");
const { buildAmenityBookingTimes } = require("../agent/access/parseAmenityBookingTimes");
const { getAccessPolicyForLocation } = require("../dal/accessEngine");
const { resolveJarvisPropertyForCreate } = require("../agent/proposals/resolveJarvisProperty");
const { resolveCommunicationAudience } = require("../agent/proposals/resolveCommunicationAudience");
const { prepareCommunicationCampaignDraft } = require("../agent/proposals/prepareCommunicationCampaignDraft");
const {
  buildSendCommunicationCampaignProposal,
} = require("../agent/proposals/sendCommunicationCampaign");
const {
  resolveProposeVendorRequestDraft,
} = require("../agent/jarvisPlan/resolveProposeVendorRequestDraft");
const {
  findAwaitingProposalForActor,
  findLatestJarvisThreadForActor,
  findRecentDuplicateCreate,
  findRecentDuplicateSchedule,
  findRecentDuplicateAppendNote,
} = require("../dal/jarvisOperatorThreads");
const { guardPendingProposalBeforeNewPropose } = require("../agent/proposals/guardPendingProposal");
const { refreshCommCampaignProposalHit } = require("../agent/proposals/commCampaignProposalGuard");
const { executeJarvisConfirm } = require("../agent/proposals/executeJarvisConfirm");
const { PROPOSAL_OPS } = require("../agent/proposals/types");
const { recordThreadForStaffRun } = require("../agent/thread/recordThreadForStaffRun");
const { emit } = require("../logging/structuredLog");
const { enrichTicketForCopilot, enrichCandidatesForCopilot } = require("./jarvisCopilotTicketEnrich");
const {
  formatDisambiguationSpeak,
  formatCandidateLine,
  formatResolvedTicketSpeak,
  formatTicketChoiceLabel,
  formatProposeConfirmSpeak,
} = require("./ticketDisambiguationSpeak");

/**
 * @param {object} resolved
 */
async function ambiguousTicketResult(resolved) {
  const raw = resolved.candidates || [];
  const candidates = raw.length ? await enrichCandidatesForCopilot(raw) : [];
  return {
    found: false,
    error: resolved.error,
    message: resolved.message,
    candidates,
    speak: formatDisambiguationSpeak(candidates),
  };
}

/**
 * @param {number} dollars
 * @param {number} cents
 */
function parseVoiceAmountCents(dollars, cents) {
  const rawCents = Number(cents);
  if (Number.isFinite(rawCents) && rawCents > 0) return Math.round(rawCents);
  const rawDollars = Number(dollars);
  if (Number.isFinite(rawDollars) && rawDollars > 0) return Math.round(rawDollars * 100);
  return 0;
}

function fmtUsd(cents) {
  return `$${(Math.max(0, Number(cents) || 0) / 100).toFixed(2)}`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} target
 */
async function loadTicketRowForCost(sb, target) {
  const rowId = String(target.ticketRowId || "").trim().toLowerCase();
  const humanId = String(target.humanTicketId || "")
    .trim()
    .toUpperCase();
  const cols =
    "id, ticket_id, property_code, unit_label, status, is_imported_history";

  if (rowId) {
    const { data } = await sb.from("tickets").select(cols).eq("id", rowId).maybeSingle();
    if (data) return data;
  }
  if (humanId) {
    const { data } = await sb
      .from("tickets")
      .select(cols)
      .eq("ticket_id", humanId)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

function isBlockedTicket(ticket) {
  if (!ticket) return "Ticket not found in database.";
  if (ticket.is_imported_history === true) return "Historical tickets cannot receive new costs.";
  const status = String(ticket.status || "").toLowerCase();
  if (status === "deleted") return "That ticket is deleted — costs cannot be attached.";
  return null;
}

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

  const pendingGuard = await guardPendingProposalBeforeNewPropose(ctx);
  if (pendingGuard) return pendingGuard;

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
    return await ambiguousTicketResult(resolved);
  }

  const target = resolved.target;
  const enrichedTarget = (await enrichTicketForCopilot(target)) || target;
  const humanId = String(target.humanTicketId || "").trim();
  if (!humanId) {
    return {
      error: "no_ticket_id",
      message: "Resolved a target but ticket id is missing — try the ticket id directly.",
    };
  }

  if (jarvisThreadEnabled() && ctx.staffActorKey) {
    const sb = getSupabase();
    if (sb) {
      const thread = await findLatestJarvisThreadForActor(sb, ctx.staffActorKey, "portal");
      const recentNote = findRecentDuplicateAppendNote(thread, {
        humanTicketId: humanId,
        noteText,
      });
      if (recentNote) {
        return {
          error: "recently_committed",
          human_ticket_id: humanId,
          message: `That same note was just added to ${humanId}.`,
          speak: `Same note is already on ${humanId}.`,
        };
      }
    }
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
      scopeSnapshot: ctx.scope
        ? {
            anchor: {
              ...(ctx.scope.anchor || {}),
              humanTicketId: humanId,
              ticketRowId: target.ticketRowId,
              unit: target.unitLabel,
              propertyCode: target.propertyCode,
            },
          }
        : null,
    });
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "append_service_note_proposed",
    data: { human_ticket_id: humanId, note_len: noteText.length },
  });

  const notePreview =
    noteText.slice(0, 80) + (noteText.length > 80 ? "…" : "");

  return {
    needs_confirm: true,
    op: "append_service_note",
    summary_human: summary,
    human_ticket_id: humanId,
    unit_label: target.unitLabel,
    target: enrichedTarget,
    confirm_token: confirmToken,
    note_text: noteText,
    speak: formatProposeConfirmSpeak("Add note on", enrichedTarget, `"${notePreview}"`),
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function proposeAttachTicketCost(args, ctx) {
  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Cost proposals need JARVIS_PLAN_ENABLED=1 on the server.",
    };
  }
  if (!financeCostCaptureChatEnabled()) {
    return {
      error: "cost_capture_disabled",
      message: "Cost capture is not enabled. Set PROPERA_FINANCE_COST_CAPTURE_CHAT=1.",
    };
  }

  const vendorAmt = parseVoiceAmountCents(
    args.amount_dollars ?? args.amountDollars,
    args.amount_cents ?? args.amountCents
  );
  if (vendorAmt <= 0) {
    return {
      error: "missing_amount",
      message: "Need a positive amount_dollars or amount_cents.",
    };
  }

  const entryType = String(args.entry_type || args.entryType || "parts")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  const vendorName = String(args.vendor_name || args.vendorName || "").trim();

  const resolved = await resolveProposalTicketTarget({
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    humanTicketId: args.human_ticket_id || args.humanTicketId,
    unitLabel: args.unit_label || args.unitLabel || args.unit,
    propertyCode: args.property_code || args.propertyCode,
    issueHint: args.issue_hint || args.issueHint,
  });

  if (!resolved.ok) {
    return await ambiguousTicketResult(resolved);
  }

  const target = resolved.target;
  const enrichedTarget = (await enrichTicketForCopilot(target)) || target;
  const humanId = String(target.humanTicketId || "").trim();
  if (!humanId) {
    return {
      error: "no_ticket_id",
      message: "Could not determine ticket id — say the ticket id directly.",
    };
  }

  const sb = getSupabase();
  if (!sb) {
    return { error: "database_unavailable", message: "Database is not configured." };
  }

  const ticket = await loadTicketRowForCost(sb, target);
  const blocked = isBlockedTicket(ticket);
  if (blocked) {
    return { error: "ticket_blocked", message: blocked };
  }
  if (!ticket) {
    return {
      error: "ticket_not_found",
      message: `Ticket ${humanId} not found — double-check the id.`,
    };
  }

  const allow = financeCostCapturePropertyAllowlist();
  const prop = String(ticket.property_code || "").trim().toUpperCase();
  if (allow && !allow.has(prop)) {
    return {
      error: "property_not_enabled",
      message: "Cost capture is not enabled for this property yet.",
    };
  }

  const proposalId = crypto.randomUUID();
  const idempotencyKey = `jarvis-voice-${String(ctx.traceId || "x")}-${proposalId}`;

  const draft = {
    proposal_id: proposalId,
    ticketRowId: String(ticket.id),
    ticketHumanId: String(ticket.ticket_id || humanId),
    vendorAmt,
    tenantAmt: 0,
    hasTenantCharge: false,
    entryType,
    vendorName,
    description: vendorName || entryType.replace(/_/g, " "),
    idempotencyKey,
    normalizedBody: `voice ${fmtUsd(vendorAmt)} ${entryType}`,
  };

  const summary = `Post ${fmtUsd(vendorAmt)} ${entryType.replace(/_/g, " ")} to ${ticket.ticket_id}${vendorName ? ` — ${vendorName}` : ""}?`;

  const { proposal, confirmToken } = buildAttachTicketCostProposal(draft, summary);

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
      scopeSnapshot: {
        anchor: {
          humanTicketId: String(ticket.ticket_id || humanId),
          ticketRowId: String(ticket.id),
          unit: ticket.unit_label || target.unitLabel,
          propertyCode: prop,
        },
      },
    });
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "attach_ticket_cost_proposed",
    data: { human_ticket_id: humanId, vendor_amt: vendorAmt },
  });

  const ticketPayload = {
    ...target,
    humanTicketId: String(ticket.ticket_id || humanId),
    ticketRowId: String(ticket.id),
    unitLabel: ticket.unit_label || target.unitLabel,
    propertyCode: prop,
  };
  const enrichedCostTarget = (await enrichTicketForCopilot(ticketPayload)) || ticketPayload;

  return {
    needs_confirm: true,
    op: "attach_ticket_cost",
    summary_human: summary,
    human_ticket_id: String(ticket.ticket_id || humanId),
    unit_label: ticket.unit_label || target.unitLabel,
    amount_cents: vendorAmt,
    entry_type: entryType,
    vendor_name: vendorName || undefined,
    target: enrichedCostTarget,
    confirm_token: confirmToken,
    speak: `${fmtUsd(vendorAmt)} on ${ticket.ticket_id}. Say yes?`,
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function proposeVendorRequest(args, ctx) {
  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Vendor proposals need JARVIS_PLAN_ENABLED=1 on the server.",
    };
  }

  const assignOnly =
    args.assign_only === true ||
    args.assignOnly === true ||
    args.dispatch === false ||
    args.dispatch === "false";
  const tradeKey = String(args.trade || args.trade_key || args.tradeKey || "vendor")
    .trim()
    .toLowerCase();
  const assignmentNote = String(args.assignment_note || args.assignmentNote || "").trim();

  let humanTicketId = String(args.human_ticket_id || args.humanTicketId || "").trim();
  let ticketRowId = String(args.ticket_row_id || args.ticketRowId || "").trim();
  let propertyCode = String(args.property_code || args.propertyCode || "").trim();
  let unit = String(args.unit_label || args.unitLabel || args.unit || "").trim();

  if (!humanTicketId && !ticketRowId) {
    const resolved = await resolveProposalTicketTarget({
      scope: ctx.scope,
      pageContext: ctx.pageContext,
      humanTicketId,
      unitLabel: unit,
      propertyCode,
      issueHint: args.issue_hint || args.issueHint,
    });
    if (!resolved.ok) {
      return await ambiguousTicketResult(resolved);
    }
    const t = resolved.target;
    humanTicketId = String(t.humanTicketId || "").trim();
    ticketRowId = String(t.ticketRowId || "").trim();
    propertyCode = String(t.propertyCode || propertyCode).trim();
    unit = String(t.unitLabel || unit).trim();
  }

  const parsed = {
    humanTicketId,
    ticketRowId,
    propertyCode,
    unit,
    tradeKey,
    dispatch: !assignOnly,
    assignmentNote,
  };

  const actorLabel = String(ctx.staffContext?.staff?.display_name || "").trim() || "Jarvis voice";
  const draftOut = await resolveProposeVendorRequestDraft(parsed, actorLabel);
  if (!draftOut.ok) {
    return { error: draftOut.error || "vendor_draft_failed", message: draftOut.message };
  }

  const { proposal, confirmToken } = buildProposeVendorRequestProposal(
    draftOut.commitPayload,
    draftOut.summary
  );

  if (jarvisThreadEnabled()) {
    await recordThreadForStaffRun({
      traceId: ctx.traceId,
      actorKey: ctx.staffActorKey,
      transportChannel: "portal",
      routerParameter: {
        From: ctx.staffActorKey,
        _portalPageContextJson: ctx.pageContext ? JSON.stringify(ctx.pageContext) : "",
      },
      staffRun: {
        brain: "jarvis_plan",
        replyText: draftOut.summary,
        proposal,
      },
    });
  }

  const humanId = String(draftOut.commitPayload?.humanTicketId || humanTicketId).trim();
  const enrichedTarget =
    (await enrichTicketForCopilot({
      humanTicketId: humanId,
      ticketRowId: draftOut.commitPayload?.ticketRowId,
      unitLabel: unit,
      propertyCode,
    })) || null;

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "vendor_request_proposed",
    data: { human_ticket_id: humanId, dispatch: parsed.dispatch },
  });

  const vendorDisplayName = String(draftOut.commitPayload?.vendorDisplayName || "").trim();
  const dispatchLabel = parsed.dispatch ? "with dispatch SMS" : "assign only";

  return {
    needs_confirm: true,
    op: "propose_vendor_request",
    summary_human: draftOut.summary,
    human_ticket_id: humanId,
    unit_label: unit || undefined,
    vendor_name: vendorDisplayName || undefined,
    dispatch: parsed.dispatch,
    target: enrichedTarget,
    confirm_token: confirmToken,
    speak: vendorDisplayName
      ? `Assign ${vendorDisplayName} to ${humanId} ${dispatchLabel}. Say yes?`
      : `${draftOut.summary} Say yes?`,
  };
}

/**
 * @param {object | null | undefined} receipt
 * @param {string} propertyCode
 * @param {string} unitLabel
 */
function receiptMatchesCreateTarget(receipt, propertyCode, unitLabel) {
  if (!receipt || String(receipt.committed_op || "") !== PROPOSAL_OPS.CREATE_SERVICE_REQUEST) {
    return false;
  }
  const pc = String(receipt.property_code || receipt.propertyCode || "")
    .trim()
    .toUpperCase();
  const ul = String(receipt.unit_label || receipt.unitLabel || "").trim();
  const wantPc = String(propertyCode || "")
    .trim()
    .toUpperCase();
  const wantUl = String(unitLabel || "").trim();
  if (pc && wantPc && pc !== wantPc) return false;
  if (ul && wantUl && ul !== wantUl) return false;
  return true;
}

/**
 * @param {object | null | undefined} thread
 * @param {string} propertyCode
 * @param {string} unitLabel
 */
function lastCreateContextFromThread(thread, propertyCode, unitLabel) {
  const receipt = thread?.lastReceipt;
  if (!receiptMatchesCreateTarget(receipt, propertyCode, unitLabel)) return null;
  return {
    property_code: String(receipt.property_code || propertyCode || "")
      .trim()
      .toUpperCase(),
    unit_label: String(receipt.unit_label || unitLabel || "").trim(),
    preferred_window: String(receipt.preferred_window || receipt.preferredWindow || "").trim(),
    issue_text: String(receipt.issue_text || receipt.issueText || "").trim(),
    human_ticket_id: String(receipt.human_ticket_id || "").trim(),
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function proposeCreateServiceRequest(args, ctx) {
  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Create ticket proposals need JARVIS_PLAN_ENABLED=1 on the server.",
    };
  }

  const issueText = String(
    args.issue_text || args.issueText || args.issue || args.description || ""
  ).trim();
  if (issueText.length < 2) {
    return {
      error: "missing_issue",
      message: "Need issue_text — what is wrong (e.g. dishwasher not draining).",
    };
  }

  const unitLabel = String(
    args.unit_label || args.unitLabel || args.unit || ctx.scope?.anchor?.unit || ctx.pageContext?.unit || ""
  ).trim();
  if (!unitLabel) {
    return {
      error: "missing_unit",
      message: "Need unit_label — which apartment (e.g. 303).",
    };
  }

  const propResolved = await resolveJarvisPropertyForCreate({
    propertyHint: args.property_code || args.propertyCode,
    searchText: [args.location_phrase, args.locationPhrase, issueText]
      .filter(Boolean)
      .join(" "),
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    traceId: ctx.traceId,
  });
  if (!propResolved.ok) {
    return { error: propResolved.error, message: propResolved.message };
  }

  const propertyCode = propResolved.propertyCode;
  const category = String(args.category || "General").trim() || "General";
  const urgRaw = String(args.urgency || "Normal").trim().toUpperCase();
  const urgency = urgRaw === "URGENT" || urgRaw === "HIGH" ? "Urgent" : "Normal";

  let thread = null;
  if (jarvisThreadEnabled() && ctx.staffActorKey) {
    const sb = getSupabase();
    if (sb) {
      thread = await findLatestJarvisThreadForActor(sb, ctx.staffActorKey, "portal");
    }
  }

  const priorCreate = lastCreateContextFromThread(thread, propertyCode, unitLabel);
  let preferredWindow = String(
    args.preferred_window ||
      args.preferredWindow ||
      args.window ||
      args.schedule ||
      args.access_window ||
      ""
  ).trim();
  if (!preferredWindow && priorCreate?.preferred_window) {
    preferredWindow = priorCreate.preferred_window;
  }

  if (jarvisThreadEnabled() && ctx.staffActorKey) {
    const sb = getSupabase();
    if (sb) {
      if (!thread) {
        thread = await findLatestJarvisThreadForActor(sb, ctx.staffActorKey, "portal");
      }
      const awaiting = await findAwaitingProposalForActor(sb, ctx.staffActorKey, "portal");
      const awaitingOp = String(awaiting?.proposal?.op || "").trim();
      if (awaitingOp === PROPOSAL_OPS.CREATE_SERVICE_REQUEST) {
        const summaryHuman = String(awaiting.proposal.summary_human || "").trim();
        const token = String(awaiting.proposal.confirm_token || "").trim();
        emit({
          level: "info",
          trace_id: ctx.traceId || null,
          log_kind: "jarvis_voice_proposal",
          event: "create_service_request_already_pending",
          data: { property_code: propertyCode, unit_label: unitLabel },
        });
        return {
          needs_confirm: true,
          op: "create_service_request",
          summary_human: summaryHuman,
          property_code: propertyCode,
          unit_label: unitLabel,
          confirm_token: token,
          already_pending: true,
          speak: summaryHuman
            ? `${summaryHuman} Confirm that one first — then I'll do the next ticket.`
            : "Confirm the pending ticket first — then I'll do the next one.",
        };
      }

      const recentDup = findRecentDuplicateCreate(thread, {
        propertyCode,
        unitLabel,
        issueText,
      });
      if (recentDup) {
        const humanId = String(recentDup.human_ticket_id || "").trim();
        emit({
          level: "info",
          trace_id: ctx.traceId || null,
          log_kind: "jarvis_voice_proposal",
          event: "create_service_request_recent_duplicate_blocked",
          data: {
            property_code: propertyCode,
            unit_label: unitLabel,
            human_ticket_id: humanId || undefined,
          },
        });
        return {
          error: "recently_created",
          human_ticket_id: humanId || undefined,
          message: humanId
            ? `Same issue was just logged on ${humanId} for ${propertyCode} unit ${unitLabel}.`
            : `That same issue was just created for ${propertyCode} unit ${unitLabel}.`,
          speak: humanId
            ? `That issue is already on ${humanId}. Different problem? Say the other issue.`
            : "That issue was just created. Different problem?",
        };
      }
    }
  }

  const issuePreview =
    issueText.slice(0, 60) + (issueText.length > 60 ? "…" : "");
  const windowBit = preferredWindow ? ` · ${preferredWindow}` : "";
  const summary = `Create service request — ${propertyCode} unit ${unitLabel}: ${issuePreview}${windowBit}`;

  const { proposal, confirmToken } = buildCreateServiceRequestProposal(
    {
      propertyCode,
      unitLabel,
      issueText,
      category,
      urgency,
      preferredWindow,
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
        _portalPageContextJson: ctx.pageContext ? JSON.stringify(ctx.pageContext) : "",
      },
      staffRun: {
        brain: "jarvis_plan",
        replyText: summary,
        resolution: { needsConfirm: true, proposal },
      },
      scopeSnapshot: ctx.scope
        ? {
            anchor: {
              ...(ctx.scope.anchor || {}),
              propertyCode,
              unit: unitLabel,
            },
          }
        : null,
    });
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "create_service_request_proposed",
    data: { property_code: propertyCode, unit_label: unitLabel },
  });

  const multiTicketHint =
    priorCreate && priorCreate.human_ticket_id
      ? ` (${priorCreate.human_ticket_id} already created this session — same unit/window reused)`
      : "";

  return {
    needs_confirm: true,
    op: "create_service_request",
    summary_human: summary,
    property_code: propertyCode,
    unit_label: unitLabel,
    issue_text: issueText,
    category,
    urgency,
    preferred_window: preferredWindow || undefined,
    confirm_token: confirmToken,
    reused_schedule: !!(priorCreate?.preferred_window && !args.preferred_window && !args.preferredWindow),
    speak: preferredWindow
      ? `Create ${propertyCode} unit ${unitLabel}: ${issuePreview}, schedule ${preferredWindow}. Say yes?${multiTicketHint}`
      : `Create ${propertyCode} unit ${unitLabel}: ${issuePreview}. Say yes?${multiTicketHint}`,
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function proposeScheduleTicket(args, ctx) {
  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Schedule proposals need JARVIS_PLAN_ENABLED=1 on the server.",
    };
  }

  const pendingGuard = await guardPendingProposalBeforeNewPropose(ctx);
  if (pendingGuard) return pendingGuard;

  const preferredWindow = String(
    args.preferred_window || args.preferredWindow || args.window || args.schedule || ""
  ).trim();
  if (preferredWindow.length < 2) {
    return {
      error: "missing_window",
      message: "Need preferred_window — e.g. today 1–5pm, tomorrow morning.",
    };
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
    return await ambiguousTicketResult(resolved);
  }

  const target = resolved.target;
  const humanId = String(target.humanTicketId || "").trim().toUpperCase();
  if (!humanId) {
    return {
      error: "no_ticket_id",
      message: "Could not determine ticket id — say the ticket id or unit first.",
    };
  }

  const sb = getSupabase();
  let ticketKey = "";
  if (sb) {
    const { data: row } = await sb
      .from("tickets")
      .select("ticket_key, status, is_imported_history")
      .eq("ticket_id", humanId)
      .maybeSingle();
    if (row?.is_imported_history === true) {
      return { error: "ticket_blocked", message: "Historical tickets cannot be scheduled." };
    }
    const status = String(row?.status || "").toLowerCase();
    if (status === "deleted" || status === "completed") {
      return {
        error: "ticket_blocked",
        message: `Ticket ${humanId} is ${row?.status} — cannot schedule.`,
      };
    }
    ticketKey = String(row?.ticket_key || "").trim();
  }

  if (jarvisThreadEnabled() && ctx.staffActorKey) {
    const sbThread = getSupabase();
    if (sbThread) {
      const thread = await findLatestJarvisThreadForActor(sbThread, ctx.staffActorKey, "portal");
      const recentSched = findRecentDuplicateSchedule(thread, {
        humanTicketId: humanId,
        preferredWindow,
      });
      if (recentSched) {
        return {
          error: "recently_committed",
          human_ticket_id: humanId,
          message: `${humanId} was just scheduled for ${preferredWindow}.`,
          speak: `Already scheduled ${humanId} for that window.`,
        };
      }
    }
  }

  const enrichedTarget = (await enrichTicketForCopilot(target)) || target;
  const summary = `Schedule ${humanId}${target.unitLabel ? ` unit ${target.unitLabel}` : ""}: ${preferredWindow}`;

  const { proposal, confirmToken } = buildScheduleTicketProposal(
    {
      humanTicketId: humanId,
      ticketRowId: target.ticketRowId,
      ticketKey,
      propertyCode: target.propertyCode,
      unitLabel: target.unitLabel,
      preferredWindow,
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
        _portalPageContextJson: ctx.pageContext ? JSON.stringify(ctx.pageContext) : "",
      },
      staffRun: {
        brain: "jarvis_plan",
        replyText: summary,
        resolution: {
          needsConfirm: true,
          proposal,
        },
      },
      scopeSnapshot: ctx.scope
        ? {
            anchor: {
              ...(ctx.scope.anchor || {}),
              humanTicketId: humanId,
              ticketRowId: target.ticketRowId,
              unit: target.unitLabel,
              propertyCode: target.propertyCode,
            },
          }
        : null,
    });
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "schedule_ticket_proposed",
    data: { human_ticket_id: humanId, window_len: preferredWindow.length },
  });

  return {
    needs_confirm: true,
    op: "schedule_ticket",
    summary_human: summary,
    human_ticket_id: humanId,
    unit_label: target.unitLabel,
    preferred_window: preferredWindow,
    status_to: "Scheduled",
    target: enrichedTarget,
    confirm_token: confirmToken,
    speak: formatProposeConfirmSpeak("Schedule", enrichedTarget, preferredWindow),
  };
}

/**
 * @param {string} op
 * @param {object} args
 * @param {object} ctx
 * @param {object} opts
 * @param {(target: object, humanId: string) => { draft: object, summary: string, speak: string, emitEvent: string }} opts.build
 */
async function proposeTicketLifecycle(op, args, ctx, opts) {
  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Ticket edits need JARVIS_PLAN_ENABLED=1 on the server.",
    };
  }

  const pendingGuard = await guardPendingProposalBeforeNewPropose(ctx);
  if (pendingGuard) return pendingGuard;

  const resolved = await resolveProposalTicketTarget({
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    humanTicketId: args.human_ticket_id || args.humanTicketId,
    unitLabel: args.unit_label || args.unitLabel || args.unit,
    propertyCode: args.property_code || args.propertyCode,
    issueHint: args.issue_hint || args.issueHint,
  });

  if (!resolved.ok) {
    return await ambiguousTicketResult(resolved);
  }

  const target = resolved.target;
  const humanId = String(target.humanTicketId || "")
    .trim()
    .toUpperCase();
  if (!humanId) {
    return {
      error: "no_ticket_id",
      message: "Could not determine ticket id — say the ticket id or unit first.",
    };
  }

  const sb = getSupabase();
  if (sb) {
    const { data: row } = await sb
      .from("tickets")
      .select("status, is_imported_history")
      .eq("ticket_id", humanId)
      .maybeSingle();
    if (row?.is_imported_history === true) {
      return { error: "ticket_blocked", message: "Historical tickets cannot be edited." };
    }
    const status = String(row?.status || "").toLowerCase();
    if (
      (op === PROPOSAL_OPS.CANCEL_TICKET ||
        op === PROPOSAL_OPS.CLOSE_TICKET ||
        op === PROPOSAL_OPS.SET_TICKET_STATUS ||
        op === PROPOSAL_OPS.SET_TICKET_CATEGORY ||
        op === PROPOSAL_OPS.UPDATE_TICKET_ISSUE) &&
      (status === "deleted" || status === "completed")
    ) {
      return {
        error: "ticket_blocked",
        message: `Ticket ${humanId} is ${row?.status} — cannot change it.`,
      };
    }
  }

  const pack = opts.build(target, humanId);
  if (pack.error) {
    return { error: pack.error, message: pack.message };
  }

  const enrichedTarget = (await enrichTicketForCopilot(target)) || target;
  const { proposal, confirmToken } = buildTicketLifecycleProposal(op, pack.draft, pack.summary);

  if (jarvisThreadEnabled()) {
    await recordThreadForStaffRun({
      traceId: ctx.traceId,
      actorKey: ctx.staffActorKey,
      transportChannel: "portal",
      routerParameter: {
        From: ctx.staffActorKey,
        _portalPageContextJson: ctx.pageContext ? JSON.stringify(ctx.pageContext) : "",
      },
      staffRun: {
        brain: "jarvis_plan",
        replyText: pack.summary,
        resolution: { needsConfirm: true, proposal },
      },
      scopeSnapshot: ctx.scope
        ? {
            anchor: {
              ...(ctx.scope.anchor || {}),
              humanTicketId: humanId,
              ticketRowId: target.ticketRowId,
              unit: target.unitLabel,
              propertyCode: target.propertyCode,
            },
          }
        : null,
    });
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: pack.emitEvent,
    data: { human_ticket_id: humanId, op },
  });

  return {
    needs_confirm: true,
    op,
    summary_human: pack.summary,
    human_ticket_id: humanId,
    unit_label: target.unitLabel,
    target: enrichedTarget,
    confirm_token: confirmToken,
    speak: pack.speak,
    ...(pack.extra || {}),
  };
}

async function proposeSetTicketStatus(args, ctx) {
  const statusRaw = String(args.status_to || args.statusTo || args.status || "").trim();
  const statusTo = normalizeVoiceTicketStatus(statusRaw);
  return proposeTicketLifecycle(PROPOSAL_OPS.SET_TICKET_STATUS, args, ctx, {
    build(target, humanId) {
      if (!statusTo) {
        return {
          error: "missing_status",
          message: "Need status — open, in progress, scheduled, completed.",
        };
      }
      const summary = `Set ${humanId} status to ${statusTo}`;
      return {
        draft: {
          humanTicketId: humanId,
          ticketRowId: target?.ticketRowId,
          propertyCode: target?.propertyCode,
          unitLabel: target?.unitLabel,
          statusTo,
        },
        summary,
        speak: `${summary}. Say yes?`,
        emitEvent: "set_ticket_status_proposed",
        extra: { status_to: statusTo },
      };
    },
  });
}

async function proposeSetTicketCategory(args, ctx) {
  const category = String(args.category || "").trim();
  return proposeTicketLifecycle(PROPOSAL_OPS.SET_TICKET_CATEGORY, args, ctx, {
    build(target, humanId) {
      if (!category) {
        return {
          error: "missing_category",
          message: "Need category — Plumbing, Appliance, Electrical, HVAC, etc.",
        };
      }
      const summary = `Set ${humanId} category to ${category}`;
      return {
        draft: {
          humanTicketId: humanId,
          ticketRowId: target?.ticketRowId,
          propertyCode: target?.propertyCode,
          unitLabel: target?.unitLabel,
          category,
        },
        summary,
        speak: `${summary}. Say yes?`,
        emitEvent: "set_ticket_category_proposed",
        extra: { category },
      };
    },
  });
}

async function proposeUpdateTicketIssue(args, ctx) {
  const issueText = String(
    args.issue_text || args.issueText || args.issue || args.message || ""
  ).trim();
  return proposeTicketLifecycle(PROPOSAL_OPS.UPDATE_TICKET_ISSUE, args, ctx, {
    build(target, humanId) {
      if (issueText.length < 2) {
        return {
          error: "missing_issue",
          message: "Need the new issue description from staff.",
        };
      }
      const preview =
        issueText.slice(0, 80) + (issueText.length > 80 ? "…" : "");
      const summary = `Update ${humanId} issue: ${preview}`;
      return {
        draft: {
          humanTicketId: humanId,
          ticketRowId: target?.ticketRowId,
          propertyCode: target?.propertyCode,
          unitLabel: target?.unitLabel,
          issueText,
        },
        summary,
        speak: `Change ${humanId} issue to "${preview}". Say yes?`,
        emitEvent: "update_ticket_issue_proposed",
        extra: { issue_text: issueText },
      };
    },
  });
}

async function proposeCloseTicket(args, ctx) {
  return proposeTicketLifecycle(PROPOSAL_OPS.CLOSE_TICKET, args, ctx, {
    build(target, humanId) {
      const summary = `Mark ${humanId} complete`;
      return {
        draft: {
          humanTicketId: humanId,
          ticketRowId: target?.ticketRowId,
          propertyCode: target?.propertyCode,
          unitLabel: target?.unitLabel,
        },
        summary,
        speak: `${summary}. Say yes?`,
        emitEvent: "close_ticket_proposed",
      };
    },
  });
}

async function proposeCancelTicket(args, ctx) {
  return proposeTicketLifecycle(PROPOSAL_OPS.CANCEL_TICKET, args, ctx, {
    build(target, humanId) {
      const summary = `Cancel / delete ${humanId}`;
      return {
        draft: {
          humanTicketId: humanId,
          ticketRowId: target?.ticketRowId,
          propertyCode: target?.propertyCode,
          unitLabel: target?.unitLabel,
        },
        summary,
        speak: `Remove ${humanId} — deleted. Say yes?`,
        emitEvent: "cancel_ticket_proposed",
      };
    },
  });
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function proposeBookAmenity(args, ctx) {
  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Amenity proposals need JARVIS_PLAN_ENABLED=1 on the server.",
    };
  }
  if (!accessEngineEnabled()) {
    return {
      error: "access_engine_disabled",
      message: "Access engine is disabled — set PROPERA_ACCESS_ENGINE_ENABLED=1.",
    };
  }

  const amenityName = String(
    args.amenity_name || args.amenityName || args.location_name || args.locationName || ""
  ).trim();
  const unitLabel = String(args.unit_label || args.unitLabel || args.unit || "").trim();
  const tenantName = String(args.tenant_name || args.tenantName || "").trim();
  const notes = String(args.notes || "").trim();
  const bookingDate = String(
    args.booking_date || args.bookingDate || args.date || args.date_phrase || ""
  ).trim();
  const startTime = String(args.start_time || args.startTime || "").trim();
  const endTime = String(args.end_time || args.endTime || "").trim();

  const propResolved = await resolveJarvisPropertyForCreate({
    propertyHint: args.property_code || args.propertyCode,
    searchText: args.location_phrase || args.locationPhrase,
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    traceId: ctx.traceId,
  });
  if (!propResolved.ok) {
    return {
      error: propResolved.error || "missing_property",
      message: propResolved.message || "Which property?",
    };
  }
  const propertyCode = propResolved.propertyCode;

  if (!amenityName) {
    return { error: "missing_amenity", message: "Which amenity — gameroom, sauna, terrace?" };
  }
  if (!unitLabel) {
    return { error: "missing_unit", message: "Which unit is this booking for?" };
  }
  if (!bookingDate || !startTime || !endTime) {
    return {
      error: "missing_time",
      message: "Need date and start/end times — e.g. tomorrow 3pm to 5pm.",
    };
  }

  const locResolved = await resolveAccessLocation({ propertyCode, locationHint: amenityName });
  if (!locResolved.ok) {
    return {
      error: locResolved.error,
      message: locResolved.message,
      candidates: locResolved.candidates,
    };
  }

  const tenantResolved = await resolveAmenityTenant({
    propertyCode,
    unitLabel,
    tenantNameHint: tenantName,
  });
  if (!tenantResolved.ok) {
    return {
      error: tenantResolved.error,
      message: tenantResolved.message,
      candidates: tenantResolved.candidates,
    };
  }

  const times = buildAmenityBookingTimes({ bookingDate, startTime, endTime });
  if (!times.ok) {
    return { error: times.error, message: times.message };
  }

  const location = locResolved.location;
  const summary =
    `Book ${location.name} — ${propertyCode} unit ${unitLabel}` +
    (tenantResolved.tenantName ? ` (${tenantResolved.tenantName})` : "") +
    `: ${times.label}`;

  const { proposal, confirmToken } = buildBookAmenityProposal(
    {
      locationId: location.id,
      locationName: location.name,
      propertyCode,
      unitLabel,
      tenantId: tenantResolved.tenantId,
      tenantName: tenantResolved.tenantName,
      startAt: times.startAt,
      endAt: times.endAt,
      bookingLabel: times.label,
      notes,
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
        _portalPageContextJson: ctx.pageContext ? JSON.stringify(ctx.pageContext) : "",
      },
      staffRun: {
        brain: "jarvis_plan",
        replyText: summary,
        resolution: { needsConfirm: true, proposal },
      },
      scopeSnapshot: ctx.scope
        ? {
            anchor: {
              ...(ctx.scope.anchor || {}),
              propertyCode,
              unit: unitLabel,
            },
          }
        : null,
    });
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "book_amenity_proposed",
    data: { property_code: propertyCode, location_id: location.id },
  });

  return {
    needs_confirm: true,
    op: PROPOSAL_OPS.BOOK_AMENITY_RESERVATION,
    summary_human: summary,
    property_code: propertyCode,
    unit_label: unitLabel,
    amenity_name: location.name,
    booking_label: times.label,
    confirm_token: confirmToken,
    speak: `Book ${location.name} for unit ${unitLabel}, ${times.label}. Say yes?`,
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function proposeSetAmenitySchedule(args, ctx) {
  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Amenity proposals need JARVIS_PLAN_ENABLED=1 on the server.",
    };
  }
  if (!accessEngineEnabled()) {
    return {
      error: "access_engine_disabled",
      message: "Access engine is disabled — set PROPERA_ACCESS_ENGINE_ENABLED=1.",
    };
  }

  const amenityName = String(
    args.amenity_name || args.amenityName || args.location_name || args.locationName || ""
  ).trim();
  let schedules = normalizeScheduleRows(args.schedules);

  const openTime = String(args.open_time || args.openTime || "").trim();
  const closeTime = String(args.close_time || args.closeTime || "").trim();
  const daysRaw = args.days || args.day_pattern || args.dayPattern;

  if (!schedules.length && openTime && closeTime) {
    let dayList = [0, 1, 2, 3, 4, 5, 6];
    const daysStr = String(daysRaw || "all").trim().toLowerCase();
    if (daysStr === "weekdays" || daysStr === "weekday") dayList = [1, 2, 3, 4, 5];
    else if (daysStr === "weekends" || daysStr === "weekend") dayList = [0, 6];
    schedules = dayList.map((dayOfWeek) => ({
      dayOfWeek,
      openTime,
      closeTime,
    }));
  }

  if (!amenityName) {
    return { error: "missing_amenity", message: "Which amenity — gameroom, sauna, terrace?" };
  }
  if (!schedules.length) {
    return {
      error: "missing_schedules",
      message:
        "Need weekly hours — pass schedules array or open_time, close_time, and days (all/weekdays/weekends).",
    };
  }

  const propResolved = await resolveJarvisPropertyForCreate({
    propertyHint: args.property_code || args.propertyCode,
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    traceId: ctx.traceId,
  });
  if (!propResolved.ok) {
    return {
      error: propResolved.error || "missing_property",
      message: propResolved.message || "Which property?",
    };
  }
  const propertyCode = propResolved.propertyCode;

  const locResolved = await resolveAccessLocation({ propertyCode, locationHint: amenityName });
  if (!locResolved.ok) {
    return {
      error: locResolved.error,
      message: locResolved.message,
      candidates: locResolved.candidates,
    };
  }

  const location = locResolved.location;
  const hoursSummary = formatScheduleSummary(schedules);
  const summary = `Set ${location.name} hours at ${propertyCode}: ${hoursSummary}`;

  const { proposal, confirmToken } = buildSetAmenityScheduleProposal(
    {
      locationId: location.id,
      locationName: location.name,
      propertyCode,
      schedules,
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
        _portalPageContextJson: ctx.pageContext ? JSON.stringify(ctx.pageContext) : "",
      },
      staffRun: {
        brain: "jarvis_plan",
        replyText: summary,
        resolution: { needsConfirm: true, proposal },
      },
    });
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "set_amenity_schedule_proposed",
    data: { property_code: propertyCode, location_id: location.id },
  });

  return {
    needs_confirm: true,
    op: PROPOSAL_OPS.SET_AMENITY_SCHEDULE,
    summary_human: summary,
    property_code: propertyCode,
    amenity_name: location.name,
    schedule_summary: hoursSummary,
    confirm_token: confirmToken,
    speak: `Set ${location.name} hours to ${hoursSummary}. Say yes?`,
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function proposeCancelAmenity(args, ctx) {
  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Amenity cancel needs JARVIS_PLAN_ENABLED=1.",
    };
  }
  if (!accessEngineEnabled()) {
    return {
      error: "access_engine_disabled",
      message: "Access engine is disabled — set PROPERA_ACCESS_ENGINE_ENABLED=1.",
    };
  }

  const propResolved = await resolveJarvisPropertyForCreate({
    propertyHint: args.property_code || args.propertyCode,
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    traceId: ctx.traceId,
  });
  if (!propResolved.ok) {
    return {
      error: propResolved.error || "missing_property",
      message: propResolved.message || "Which property?",
    };
  }

  const hit = await resolveAccessReservation({
    propertyCode: propResolved.propertyCode,
    unitLabel: args.unit_label || args.unitLabel || args.unit,
    amenityName: args.amenity_name || args.amenityName,
    bookingDate: args.booking_date || args.bookingDate || args.date || "today",
    startTime: args.start_time || args.startTime || args.time,
    reservationId: args.reservation_id || args.reservationId,
  });

  if (!hit.ok) {
    return {
      error: hit.error,
      message: hit.message,
      candidates: hit.candidates,
    };
  }

  const r = hit.reservation;
  if (r.status === "CANCELLED") {
    return {
      error: "already_cancelled",
      message: "That booking is already cancelled.",
    };
  }

  const bookingLabel = formatBookingLabel(r);
  const place = r.locationName || args.amenity_name || "amenity";
  const unitLabel = String(r.unitLabel || args.unit_label || "").trim();
  const summary = `Cancel ${place}${unitLabel ? ` unit ${unitLabel}` : ""}: ${bookingLabel}`;

  const { proposal, confirmToken } = buildCancelAmenityProposal(
    {
      reservationId: r.id,
      locationName: place,
      propertyCode: propResolved.propertyCode,
      unitLabel,
      tenantName: r.tenantName,
      bookingLabel,
      status: r.status,
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
        _portalPageContextJson: ctx.pageContext ? JSON.stringify(ctx.pageContext) : "",
      },
      staffRun: {
        brain: "jarvis_plan",
        replyText: summary,
        resolution: { needsConfirm: true, proposal },
      },
    });
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "cancel_amenity_proposed",
    data: { reservation_id: r.id },
  });

  return {
    needs_confirm: true,
    op: PROPOSAL_OPS.CANCEL_AMENITY_RESERVATION,
    summary_human: summary,
    property_code: propResolved.propertyCode,
    unit_label: unitLabel,
    amenity_name: place,
    booking_label: bookingLabel,
    confirm_token: confirmToken,
    speak: `Cancel ${place}${unitLabel ? ` for unit ${unitLabel}` : ""}, ${bookingLabel}. Say yes?`,
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function proposeUpdateAmenityPolicy(args, ctx) {
  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Policy updates need JARVIS_PLAN_ENABLED=1.",
    };
  }
  if (!accessEngineEnabled()) {
    return {
      error: "access_engine_disabled",
      message: "Access engine is disabled — set PROPERA_ACCESS_ENGINE_ENABLED=1.",
    };
  }

  const amenityName = String(
    args.amenity_name || args.amenityName || args.location_name || args.locationName || ""
  ).trim();
  const patch = pickPolicyPatch(args);

  if (!amenityName) {
    return { error: "missing_amenity", message: "Which amenity?" };
  }
  if (!Object.keys(patch).length) {
    return {
      error: "missing_policy_fields",
      message:
        "What should change — max block minutes, min block, advance notice, or bookings per day?",
    };
  }

  const propResolved = await resolveJarvisPropertyForCreate({
    propertyHint: args.property_code || args.propertyCode,
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    traceId: ctx.traceId,
  });
  if (!propResolved.ok) {
    return {
      error: propResolved.error || "missing_property",
      message: propResolved.message || "Which property?",
    };
  }
  const propertyCode = propResolved.propertyCode;

  const locResolved = await resolveAccessLocation({ propertyCode, locationHint: amenityName });
  if (!locResolved.ok) {
    return {
      error: locResolved.error,
      message: locResolved.message,
      candidates: locResolved.candidates,
    };
  }

  const location = locResolved.location;
  const current = await getAccessPolicyForLocation(location.id);
  const mergedPreview = { ...(current || {}), ...patch };
  const changeSummary = formatPolicyChangeSummary(current, mergedPreview);
  const summary = `Update ${location.name} rules at ${propertyCode}: ${changeSummary}`;

  const { proposal, confirmToken } = buildUpdateAmenityPolicyProposal(
    {
      locationId: location.id,
      locationName: location.name,
      propertyCode,
      policyPatch: patch,
      policySummary: changeSummary,
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
        _portalPageContextJson: ctx.pageContext ? JSON.stringify(ctx.pageContext) : "",
      },
      staffRun: {
        brain: "jarvis_plan",
        replyText: summary,
        resolution: { needsConfirm: true, proposal },
      },
    });
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "update_amenity_policy_proposed",
    data: { location_id: location.id, patch },
  });

  return {
    needs_confirm: true,
    op: PROPOSAL_OPS.UPDATE_AMENITY_POLICY,
    summary_human: summary,
    property_code: propertyCode,
    amenity_name: location.name,
    policy_summary: changeSummary,
    confirm_token: confirmToken,
    speak: `Update ${location.name} rules: ${changeSummary}. Say yes?`,
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function proposeSendCommunicationCampaign(args, ctx) {
  const blocked = await guardPendingProposalBeforeNewPropose(ctx);
  if (blocked) return blocked;

  if (!jarvisPlanEnabled()) {
    return {
      error: "jarvis_plan_disabled",
      message: "Tenant broadcast proposals need JARVIS_PLAN_ENABLED=1 on the server.",
    };
  }
  if (!communicationEngineEnabled()) {
    return {
      error: "communication_engine_disabled",
      message:
        "Communication Engine is not enabled. Set PROPERA_COMMUNICATION_ENGINE_ENABLED=1 on propera-v2.",
    };
  }

  const brief = String(
    args.brief || args.message_brief || args.message || args.notice || ""
  ).trim();
  if (brief.length < 5) {
    return {
      error: "missing_brief",
      message: "Need a brief — what should tenants be told?",
    };
  }

  const audienceScope = String(args.audience_scope || args.audienceScope || "property")
    .trim()
    .toLowerCase();

  if (audienceScope === "portfolio" && !jarvisCommPortfolioEnabled()) {
    return {
      error: "portfolio_broadcast_disabled",
      message:
        "Portfolio-wide broadcasts are disabled. Name a property, floor, unit, or tenant — e.g. all tenants at Penn.",
    };
  }

  const audienceOut = await resolveCommunicationAudience({
    audienceScope,
    propertyHint: args.property_code || args.propertyCode,
    floor: args.floor,
    unitLabel: args.unit_label || args.unitLabel || args.unit,
    tenantName: args.tenant_name || args.tenantName,
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    traceId: ctx.traceId,
  });
  if (!audienceOut.ok) {
    return { error: audienceOut.error, message: audienceOut.message };
  }

  const prepared = await prepareCommunicationCampaignDraft({
    brief,
    audienceKind: audienceOut.audienceKind,
    audienceFilter: audienceOut.audienceFilter,
    commType: args.comm_type || args.commType,
    title: args.title,
    traceId: ctx.traceId,
    createdBy: "JARVIS_VOICE",
  });
  if (!prepared.ok) {
    return {
      error: prepared.error || "prepare_failed",
      message: prepared.message || "Could not prepare the tenant broadcast.",
      campaign_id: prepared.campaignId,
    };
  }

  const draftPayload = {
    ...prepared,
    propertyCode: audienceOut.propertyCode || "",
    unitLabel: audienceOut.unitLabel || "",
    tenantName: audienceOut.tenantName || "",
  };

  const { proposal, confirmToken } = buildSendCommunicationCampaignProposal(
    draftPayload,
    prepared.summary
  );

  if (jarvisThreadEnabled()) {
    await recordThreadForStaffRun({
      traceId: ctx.traceId,
      actorKey: ctx.staffActorKey,
      transportChannel: "portal",
      routerParameter: {
        From: ctx.staffActorKey,
        _portalPageContextJson: ctx.pageContext ? JSON.stringify(ctx.pageContext) : "",
      },
      staffRun: {
        brain: "jarvis_plan",
        replyText: prepared.summary,
        resolution: { needsConfirm: true, proposal },
      },
      scopeSnapshot: ctx.scope,
    });
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: "send_communication_campaign_proposed",
    data: {
      campaign_id: prepared.campaignId,
      will_send: prepared.willSend,
      audience_kind: prepared.audienceKind,
    },
  });

  const previewSnippet = String(prepared.messageBody || "").slice(0, 90);
  const sampleNames = (prepared.recipientsSample || [])
    .slice(0, 3)
    .map((r) => String(r.name || "").trim())
    .filter(Boolean);
  const sampleBit = sampleNames.length ? ` Includes ${sampleNames.join(", ")}.` : "";
  const speak =
    `${prepared.audienceLabel}: ${prepared.willSend} recipient${prepared.willSend === 1 ? "" : "s"}. ` +
    `${previewSnippet}${prepared.messageBody.length > 90 ? "…" : ""}.${sampleBit} Say yes to send?`;

  return {
    needs_confirm: true,
    op: PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN,
    summary_human: prepared.summary,
    audience_label: prepared.audienceLabel,
    will_send: prepared.willSend,
    message_body: prepared.messageBody,
    final_message_preview: prepared.finalMessagePreview,
    sms_segments: prepared.smsSegments,
    campaign_id: prepared.campaignId,
    confirm_token: confirmToken,
    speak,
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
      const hit = await refreshCommCampaignProposalHit(
        sb,
        await findAwaitingProposalForActor(sb, ctx.staffActorKey, "portal")
      );
      confirmToken = String(hit?.proposal?.confirm_token || "").trim();
    }
  }

  const result = await executeJarvisConfirm({
    confirmToken,
    traceId: ctx.traceId,
    staffActorKey: ctx.staffActorKey,
    pageContext: ctx.pageContext,
    staffContext: ctx.staffContext,
    confirmedFromThread: !ctx.pendingConfirmToken,
    routerParameter: {
      From: ctx.staffActorKey,
      _portalPageContextJson: ctx.pageContext ? JSON.stringify(ctx.pageContext) : "",
    },
  });

  if (result.error === "nothing_pending") {
    return { error: "nothing_pending", message: result.replyText };
  }
  if (result.error === "expired") {
    return { error: "expired", message: result.replyText };
  }
  if (result.error === "confirm_in_flight") {
    return { error: "confirm_in_flight", message: result.replyText, speak: result.replyText };
  }
  if (!result.ok) {
    emit({
      level: "warn",
      trace_id: ctx.traceId || null,
      log_kind: "jarvis_voice_proposal",
      event: "proposal_commit_failed",
      data: {
        op: result.op,
        error: result.error,
        detail: String(result.resolution?.error || result.replyText || "").slice(0, 240),
      },
    });
    return {
      error: result.error || "commit_failed",
      message: result.replyText,
      speak: result.replyText,
    };
  }

  emit({
    level: "info",
    trace_id: ctx.traceId || null,
    log_kind: "jarvis_voice_proposal",
    event: result.idempotent ? "proposal_commit_idempotent" : "proposal_committed",
    data: { op: result.op, proposal_id: result.proposal_id, idempotent: !!result.idempotent },
  });

  return {
    committed: true,
    already_committed: result.idempotent === true,
    op: result.op,
    reply: result.reply,
    human_ticket_id: result.human_ticket_id,
    multi_ticket: result.multi_ticket,
    speak: result.idempotent ? result.reply : undefined,
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
    return await ambiguousTicketResult(resolved);
  }

  const enriched = await enrichTicketForCopilot(resolved.target);
  const t = enriched || resolved.target;
  const issueLabel = formatTicketChoiceLabel(t);
  return {
    found: true,
    target: t,
    reason: resolved.reason,
    message:
      `Open ticket` +
      (t.unitLabel ? ` unit ${t.unitLabel}` : "") +
      (issueLabel ? ` — ${issueLabel}` : ""),
    speak: formatResolvedTicketSpeak(t),
  };
}

module.exports = {
  proposeAppendServiceNote,
  proposeAttachTicketCost,
  proposeVendorRequest,
  proposeCreateServiceRequest,
  proposeScheduleTicket,
  proposeSetTicketStatus,
  proposeSetTicketCategory,
  proposeUpdateTicketIssue,
  proposeCloseTicket,
  proposeCancelTicket,
  proposeBookAmenity,
  proposeSetAmenitySchedule,
  proposeCancelAmenity,
  proposeUpdateAmenityPolicy,
  proposeSendCommunicationCampaign,
  confirmPendingProposal,
  resolveOpenTicket,
  formatDisambiguationSpeak,
  formatCandidateLine,
};
