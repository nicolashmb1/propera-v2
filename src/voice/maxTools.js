/**
 * Max voice tools — read/create via tenantMaintenanceService (brain / pipeline only).
 * NO direct tickets or work_items writes.
 */
const { getSupabase } = require("../db/supabase");
const { emit } = require("../logging/structuredLog");
const { normalizePhoneE164 } = require("../utils/phone");
const { resolvePortalPropertyCode } = require("../brain/core/portalStructuredCreateDraft");

const MAX_TOOL_SCHEMAS = [
  {
    type: "function",
    name: "get_ticket_status",
    description: "Recent open tickets when resident asks about existing requests — not for new issues.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum recent tickets to return. Default 3.",
        },
        property: {
          type: "string",
          description: "Property name or code (required if caller not on roster).",
        },
        unit_label: {
          type: "string",
          description: "Unit number (required if caller not on roster).",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "create_ticket",
    description:
      "Submit maintenance request after resident confirmed yes. " +
      "issue_description must be ONLY what the resident said — never invent dishwasher, leak, appliance, etc. " +
      "Do not use for neighbor complaints, amenity booking, or non-repair topics.",
    parameters: {
      type: "object",
      properties: {
        property: {
          type: "string",
          description:
            "Building/property as the resident said it, e.g. 'The Grand at Penn' or 'PENN'. Required if phone not on roster.",
        },
        unit_label: {
          type: "string",
          description: "Unit number, e.g. '502'. Required if phone not on roster.",
        },
        issue_description: {
          type: "string",
          description:
            "Exact issue in the resident's words from THIS call only. Never invent or assume (no made-up dishwasher, leak, etc.).",
        },
        location: {
          type: "string",
          description:
            "Room or area, e.g. 'kitchen' or 'bathroom'. Infer from the fixture when obvious " +
            "(refrigerator/stove/dishwasher → kitchen; toilet/shower → bathroom). " +
            "Do not leave blank when inference is clear; only ask the resident when truly ambiguous.",
        },
        urgency: {
          type: "string",
          enum: ["routine", "urgent", "emergency"],
          description:
            "routine unless resident clearly stated emergency (active flood, gas, fire, no heat, etc.)",
        },
        resident_confirmed: {
          type: "boolean",
          description: "Must be true — resident explicitly said yes to your read-back summary.",
        },
      },
      required: ["issue_description", "location", "urgency", "resident_confirmed"],
    },
  },
  {
    type: "function",
    name: "get_scheduled_appointment",
    description:
      "Confirmed appointment lookup only — not after new create_ticket, not for availability preferences.",
    parameters: {
      type: "object",
      properties: {
        property: {
          type: "string",
          description: "Property name or code (required if caller not on roster).",
        },
        unit_label: {
          type: "string",
          description: "Unit number (required if caller not on roster).",
        },
      },
      required: [],
    },
  },
];

function rosterToTenantCtx(rosterRow) {
  if (!rosterRow) return null;
  return {
    phone: rosterRow.phone_e164,
    propertyCode: rosterRow.property_code,
    unitLabel: rosterRow.unit_label,
    tenantId: rosterRow.roster_id,
  };
}

const {
  listTenantTickets,
  getTenantTicket,
  createVoiceMaintenanceTicket,
} = require("../tenant/tenantMaintenanceService");

/** Merge non-empty tool args into call-scoped intake draft (voice bridge retries). */
function mergeVoiceIntakeDraft(draft, args) {
  const merged = { ...(draft || {}) };
  for (const [key, value] of Object.entries(args || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    merged[key] = value;
  }
  return merged;
}

function createTicketRejection(missingFields, message, extra = {}) {
  return {
    created: false,
    recovery: "retry_create_ticket",
    missing_fields: missingFields,
    message,
    ...extra,
  };
}

async function loadPropertyMenu(sb) {
  if (!sb) return { known: new Set(), list: [] };
  const { listPropertiesForMenu } = require("../dal/intakeSession");
  const list = await listPropertiesForMenu();
  const known = new Set(
    list.map((p) => String(p.code || "").trim().toUpperCase()).filter(Boolean)
  );
  return { known, list };
}

async function resolveTenantCtx(ctx, args, sb) {
  const rosterCtx = rosterToTenantCtx(ctx.rosterRow ?? null);
  if (rosterCtx) return rosterCtx;

  const phone = normalizePhoneE164(ctx.callerPhone);
  const propertyRaw = String(args?.property || "").trim();
  const unit = String(args?.unit_label || "").trim();
  if (!phone || !propertyRaw || !unit) return null;

  let propertyCode = propertyRaw.toUpperCase();
  const menu = await loadPropertyMenu(sb);
  if (menu.list.length) {
    const resolved = resolvePortalPropertyCode(propertyRaw, menu.known, menu.list);
    if (resolved) propertyCode = resolved;
  }

  return {
    phone,
    propertyCode,
    unitLabel: unit,
    tenantId: "",
  };
}

function statusLabelForVoice(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "completed" || s === "complete" || s === "done" || s === "closed") return "completed";
  if (s === "in progress" || s === "in_progress") return "in progress";
  return s || "open";
}

async function runTool(toolName, args, ctx) {
  const sb = ctx.sb || getSupabase();

  switch (toolName) {
    case "get_ticket_status":
      return getTicketStatus(args, ctx, sb, ctx.traceId);
    case "create_ticket":
      return createTicket(args, ctx, ctx.traceId);
    case "get_scheduled_appointment":
      return getScheduledAppointment(args, ctx, sb, ctx.traceId);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

async function getTicketStatus(args, ctx, sb, traceId) {
  const tenantCtx = await resolveTenantCtx(ctx, args, sb);
  if (!tenantCtx) {
    return {
      found: false,
      message:
        "Need property/building name and unit number to look up requests for this caller.",
    };
  }

  const limit = Math.min(Math.max(1, parseInt(args.limit, 10) || 3), 10);

  try {
    const rows = await listTenantTickets(sb, tenantCtx, { status: "all", limit });
    if (!rows.length) {
      return { found: false, message: "No recent maintenance requests found for this unit." };
    }

    const tickets = rows.map((t) => ({
      id: t.ticketId || t.id,
      status: statusLabelForVoice(t.status),
      issue: t.title || t.description || "Maintenance request",
      assignee: t.assignee || null,
      updated: t.updatedAt || t.createdAt || null,
    }));

    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "voice_tool",
      event: "get_ticket_status_ok",
      data: { count: tickets.length },
    });

    return { found: true, tickets };
  } catch (err) {
    emit({
      level: "error",
      trace_id: traceId,
      log_kind: "voice_tool",
      event: "get_ticket_status_error",
      data: { error: String(err?.message || err) },
    });
    return { found: false, message: "Could not retrieve tickets at this time." };
  }
}

async function createTicket(args, ctx, traceId) {
  const merged = mergeVoiceIntakeDraft(ctx.intakeDraft, args);

  const missing = [];
  if (merged.resident_confirmed !== true) missing.push("resident_confirmed");
  const issue = String(merged.issue_description || "").trim();
  const area = String(merged.location || "").trim();
  if (!issue || issue.length < 5) missing.push("issue_description");
  if (!area) missing.push("location");

  if (merged.resident_confirmed !== true) {
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "voice_tool",
      event: "create_ticket_rejected",
      data: { reason: "not_confirmed", missing_fields: missing },
    });
    return createTicketRejection(missing, "Do not submit yet. Read back the issue and ask the resident to confirm yes or no first.");
  }

  const tenantCtx = await resolveTenantCtx(ctx, merged, ctx.sb || getSupabase());
  if (!tenantCtx) {
    if (!merged.property) missing.push("property");
    if (!merged.unit_label) missing.push("unit_label");
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "voice_tool",
      event: "create_ticket_rejected",
      data: { reason: "no_tenant_ctx", missing_fields: missing },
    });
    return createTicketRejection(
      missing,
      "Need property/building name and unit number, confirm with the resident, then submit with all fields filled in."
    );
  }

  const urgency = String(merged.urgency || "routine").trim().toLowerCase();
  const unitLabel = String(tenantCtx.unitLabel || "").trim();

  if (!issue || issue.length < 5) {
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "voice_tool",
      event: "create_ticket_rejected",
      data: { reason: "issue_too_short", missing_fields: missing },
    });
    return createTicketRejection(
      missing,
      "Issue description missing or too short. Reconstruct issue_description from this conversation and retry create_ticket with all required fields — do not re-interview the resident."
    );
  }
  if (!area && !unitLabel) {
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "voice_tool",
      event: "create_ticket_rejected",
      data: { reason: "no_location", missing_fields: missing },
    });
    return createTicketRejection(
      missing,
      "Need location (room/area). Infer from the fixture if obvious, or use what the resident already said — then retry with full arguments."
    );
  }

  const locationDetail = unitLabel
    ? area
      ? `unit ${unitLabel} ${area}`
      : `unit ${unitLabel}`
    : area;

  const description = `${issue} — ${locationDetail}`;

  try {
    const result = await createVoiceMaintenanceTicket(
      tenantCtx,
      {
        category: urgency === "emergency" ? "Emergency" : "General",
        description,
        location: locationDetail,
        locationKind: "unit",
        urgency,
      },
      traceId
    );

    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "voice_tool",
      event: "ticket_created_via_voice",
      data: {
        ticket_id: result.ticketId || result.humanId,
        property_code: tenantCtx.propertyCode,
        unit_label: tenantCtx.unitLabel,
        urgency,
        roster_matched: !!(ctx.rosterRow),
      },
    });

    return {
      created: true,
      ticket_id: result.ticketId || result.humanId || result.id,
      message:
        `Maintenance request logged. Reference: ${result.ticketId || result.humanId || "confirmed"}. ` +
        "No appointment is scheduled yet — the maintenance team will contact the resident to arrange a visit. " +
        "Do not call get_scheduled_appointment for this request unless the resident later asks about an existing booking.",
    };
  } catch (err) {
    emit({
      level: "error",
      trace_id: traceId,
      log_kind: "voice_tool",
      event: "create_ticket_error",
      data: { error: String(err?.message || err), code: err?.code },
    });
    return {
      created: false,
      recovery: "retry_create_ticket",
      missing_fields: [],
      message:
        err?.code === "VALIDATION_ERROR"
          ? "Need a clearer description. Retry create_ticket once with issue_description, location, urgency, and resident_confirmed from this call."
          : err?.code === "PIPELINE_ERROR" && String(err?.message || "").includes("property")
            ? "Could not match that property name — ask the resident to repeat the building name, then retry."
            : "Could not create the request right now. Retry create_ticket once with full arguments; if that fails, offer office callback.",
    };
  }
}

async function getScheduledAppointment(args, ctx, sb, traceId) {
  const tenantCtx = await resolveTenantCtx(ctx, args, sb);
  if (!tenantCtx) {
    return {
      found: false,
      message: "Need property and unit number to check appointments for this caller.",
    };
  }

  try {
    const open = await listTenantTickets(sb, tenantCtx, { status: "open", limit: 5 });
    const appointments = [];

    for (const row of open) {
      const detail = await getTenantTicket(sb, tenantCtx, row.id);
      if (!detail?.timeline?.length) continue;

      for (const ev of detail.timeline) {
        const action = String(ev.action || "").toLowerCase();
        if (
          action.includes("schedule") ||
          action.includes("appointment") ||
          action.includes("vendor eta") ||
          action.includes("eta")
        ) {
          appointments.push({
            issue: detail.title || detail.description || "Maintenance request",
            when: ev.time || "",
            detail: ev.action,
            status: statusLabelForVoice(detail.status),
          });
          break;
        }
      }
    }

    if (!appointments.length) {
      return { found: false, message: "No upcoming scheduled appointments found on open requests." };
    }

    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "voice_tool",
      event: "get_scheduled_appointment_ok",
      data: { count: appointments.length },
    });

    return { found: true, appointments };
  } catch (err) {
    emit({
      level: "error",
      trace_id: traceId,
      log_kind: "voice_tool",
      event: "get_scheduled_appointment_error",
      data: { error: String(err?.message || err) },
    });
    return { found: false, message: "Could not check appointments at this time." };
  }
}

module.exports = {
  MAX_TOOL_SCHEMAS,
  runTool,
  rosterToTenantCtx,
  resolveTenantCtx,
  mergeVoiceIntakeDraft,
};
