/**
 * Jarvis live voice tools — read (Ask) + write (propose → confirm).
 */
const { handleJarvisAskTurn } = require("../agent/jarvisAsk/handleJarvisAskTurn");
const { jarvisAskEnabled, jarvisPlanEnabled, accessEngineEnabled, communicationEngineEnabled } = require("../config/env");
const { emit } = require("../logging/structuredLog");
const {
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
  dismissPendingProposal,
  resolveOpenTicket,
} = require("./jarvisVoiceProposals");
const { listOpenServiceTickets } = require("./listOpenServiceTickets");
const { queryServiceHistoryVoice } = require("./queryServiceHistoryVoice");
const {
  lookupAmenityBookingVoice,
  getAmenityBookingRulesVoice,
} = require("../agent/access/lookupAmenityBookingVoice");
const { listAccessLocationsForPortal } = require("../dal/accessEngine");
const { resolveJarvisPropertyForCreate } = require("../agent/proposals/resolveJarvisProperty");

const JARVIS_VOICE_SESSION_TOOLS = [
  {
    type: "function",
    name: "end_voice_session",
    description:
      "End the live call when staff says goodbye, hang up, that's all, we're done, end call, or similar. " +
      "Say a brief goodbye first, then call this tool.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Optional short reason, e.g. staff_done." },
      },
      required: [],
    },
  },
];

const JARVIS_VOICE_READ_TOOLS = [
  {
    type: "function",
    name: "list_open_service_tickets",
    description:
      "List ALL open service/maintenance tickets — portfolio-wide or for one property. " +
      "Use when staff asks for every open service, full backlog, all open tickets, or what's open company-wide. " +
      "NOT for only their assigned work — this is the complete open list.",
    parameters: {
      type: "object",
      properties: {
        property_code: {
          type: "string",
          description: "Optional property filter, e.g. PENN. Omit for full portfolio list.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "query_service_history",
    description:
      "Count/search past service tickets by issue type and time window (read-only analytics). " +
      "Use for: how many refrigerator issues last 30 days, icemaker problems at PENN, dishwasher tickets this month, etc. " +
      "For icemaker use issue_keywords [\"icemaker\"] — do not pass generic words like \"ice\" or \"maker\" alone. " +
      "Searches category + issue text in the database — not just open tickets.",
    parameters: {
      type: "object",
      properties: {
        issue_keywords: {
          type: "array",
          items: { type: "string" },
          description: "Issue terms, e.g. [\"refrigerator\"] or [\"dishwasher\"].",
        },
        issue_label: {
          type: "string",
          description: "Human label for readback, e.g. refrigerator.",
        },
        days_back: {
          type: "number",
          description: "Lookback window in days. Default 30.",
        },
        property_code: {
          type: "string",
          description: "Optional property filter, e.g. PENN.",
        },
        analysis: {
          type: "string",
          enum: ["summary", "distinct_units", "repeat_units", "unit_breakdown"],
          description:
            "How to analyze matched tickets. distinct_units = how many different units; " +
            "repeat_units = units with 2+ tickets; unit_breakdown = count per unit. " +
            "Re-use same issue_keywords/days_back for follow-ups.",
        },
      },
      required: ["issue_keywords"],
    },
  },
  {
    type: "function",
    name: "ask_propera",
    description:
      "Read-only: current ticket detail, unit status, costs, timeline, property situation. " +
      "For historical counts (how many X last N days) use query_service_history instead.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Staff question in natural language." },
      },
      required: ["question"],
    },
  },
  {
    type: "function",
    name: "resolve_open_ticket",
    description:
      "Find the open ticket before proposing a note or cost. " +
      "Use whenever staff names a ticket id (e.g. MURR-053026-4247), unit (303), or issue — works from overview or any page.",
    parameters: {
      type: "object",
      properties: {
        unit_label: { type: "string", description: "Unit number, e.g. 303" },
        property_code: { type: "string", description: "Property code, e.g. PENN" },
        human_ticket_id: { type: "string", description: "Ticket id if known" },
        issue_hint: {
          type: "string",
          description: "Issue keyword to disambiguate, e.g. dishwasher, microwave",
        },
      },
      required: [],
    },
  },
];

const JARVIS_VOICE_WRITE_TOOLS = [
  {
    type: "function",
    name: "propose_append_service_note",
    description:
      "Propose appending a field service note to an open ticket. Does NOT write until staff confirms. " +
      "Include model numbers, diagnosis, parts needed — exact words from staff.",
    parameters: {
      type: "object",
      properties: {
        note_text: {
          type: "string",
          description:
            "Lean field note only — what staff observed or did on site (e.g. needs replacement, ordered part X, replaced gasket). " +
            "Do NOT repeat unit, property, issue, or schedule — those belong on the ticket or other ops.",
        },
        unit_label: { type: "string" },
        property_code: { type: "string" },
        human_ticket_id: { type: "string" },
        issue_hint: { type: "string", description: "e.g. dishwasher" },
      },
      required: ["note_text"],
    },
  },
  {
    type: "function",
    name: "propose_attach_ticket_cost",
    description:
      "Propose attaching a vendor/company cost to an open ticket. Does NOT post until staff confirms. " +
      "Use when staff says they spent money on parts, hardware, etc.",
    parameters: {
      type: "object",
      properties: {
        amount_dollars: {
          type: "number",
          description: "Cost in dollars, e.g. 42.50 for forty-two fifty.",
        },
        amount_cents: { type: "number", description: "Alternative: cost in cents." },
        entry_type: {
          type: "string",
          description: "parts, hardware, labor, etc. Default parts.",
        },
        vendor_name: { type: "string", description: "e.g. Home Depot, Grainger" },
        unit_label: { type: "string" },
        property_code: { type: "string" },
        human_ticket_id: { type: "string" },
        issue_hint: { type: "string" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "propose_create_service_request",
    description:
      "Propose creating ONE new maintenance ticket (property + unit + single issue). Does NOT create until staff confirms. " +
      "For multiple issues same unit (fridge AND AC): call this tool separately for EACH issue — one ticket per call, one confirm each. " +
      "Reuse property_code, unit_label, preferred_window from the first ticket unless staff says otherwise. " +
      "If staff gives visit time in the same request, include preferred_window — one confirm creates and schedules.",
    parameters: {
      type: "object",
      properties: {
        issue_text: {
          type: "string",
          description:
            "ONE issue only — e.g. refrigerator not working. For two tickets, call this tool twice with different issue_text.",
        },
        unit_label: { type: "string", description: "Apartment/unit, e.g. 303" },
        property_code: {
          type: "string",
          description:
            "Property: code (PENN), short name (Murray), or street address (702 Pennsylvania, 618, 318 Westgrand). Resolved from database — not hardcoded.",
        },
        location_phrase: {
          type: "string",
          description:
            "Optional combined location words from staff, e.g. 402 penn — helps resolve property when spoken together.",
        },
        category: {
          type: "string",
          description: "Optional: Plumbing, Appliance, Electrical, General, etc.",
        },
        urgency: { type: "string", description: "Optional: Normal or Urgent" },
        preferred_window: {
          type: "string",
          description:
            "Optional visit/access window in same request, e.g. today 11am, go in at 11am, tomorrow 1-5pm. Creates ticket and schedules on one confirm.",
        },
      },
      required: ["issue_text", "unit_label"],
    },
  },
  {
    type: "function",
    name: "propose_schedule_ticket",
    description:
      "Propose scheduling an open ticket (access window / visit time). Does NOT schedule until staff confirms. " +
      "NOT a service note. Requires an existing ticket — resolve_open_ticket first if needed.",
    parameters: {
      type: "object",
      properties: {
        preferred_window: {
          type: "string",
          description: "Raw schedule phrase, e.g. today 1-5pm, tomorrow 9-11am, after 3pm Friday.",
        },
        human_ticket_id: { type: "string" },
        unit_label: { type: "string" },
        property_code: { type: "string" },
        issue_hint: { type: "string" },
      },
      required: ["preferred_window"],
    },
  },
  {
    type: "function",
    name: "propose_set_ticket_status",
    description:
      "Propose changing an open ticket status (open, in progress, scheduled). Does NOT save until staff confirms. " +
      "Use for: mark in progress, set to open, change status. For complete use propose_close_ticket; for delete use propose_cancel_ticket.",
    parameters: {
      type: "object",
      properties: {
        status_to: {
          type: "string",
          description: "Target status: Open, In Progress, Scheduled.",
        },
        human_ticket_id: { type: "string" },
        unit_label: { type: "string" },
        property_code: { type: "string" },
        issue_hint: { type: "string" },
      },
      required: ["status_to"],
    },
  },
  {
    type: "function",
    name: "propose_set_ticket_category",
    description:
      "Propose changing ticket category (Plumbing, Appliance, Electrical, HVAC, etc.). Does NOT save until confirm.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "New category from staff." },
        human_ticket_id: { type: "string" },
        unit_label: { type: "string" },
        property_code: { type: "string" },
        issue_hint: { type: "string" },
      },
      required: ["category"],
    },
  },
  {
    type: "function",
    name: "propose_update_ticket_issue",
    description:
      "Propose editing the ticket issue / problem description (message_raw). Does NOT save until confirm. " +
      "Use exact wording from staff — not a service note.",
    parameters: {
      type: "object",
      properties: {
        issue_text: {
          type: "string",
          description: "New issue description replacing the ticket issue field.",
        },
        human_ticket_id: { type: "string" },
        unit_label: { type: "string" },
        property_code: { type: "string" },
        issue_hint: { type: "string", description: "Current issue keyword to find ticket." },
      },
      required: ["issue_text"],
    },
  },
  {
    type: "function",
    name: "propose_close_ticket",
    description:
      "Propose marking a ticket complete / closed (status Completed). Does NOT save until confirm. " +
      "Use when staff says done, complete, close ticket, mark finished.",
    parameters: {
      type: "object",
      properties: {
        human_ticket_id: { type: "string" },
        unit_label: { type: "string" },
        property_code: { type: "string" },
        issue_hint: { type: "string" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "propose_cancel_ticket",
    description:
      "Propose canceling / soft-deleting a ticket. Does NOT delete until confirm. " +
      "Use when staff says cancel ticket, delete ticket, void ticket.",
    parameters: {
      type: "object",
      properties: {
        human_ticket_id: { type: "string" },
        unit_label: { type: "string" },
        property_code: { type: "string" },
        issue_hint: { type: "string" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "propose_vendor_request",
    description:
      "Propose assigning a vendor/trade to an open ticket. Default includes dispatch SMS unless staff says assign only or no dispatch.",
    parameters: {
      type: "object",
      properties: {
        trade: {
          type: "string",
          description: "Trade: plumber, electric, hvac, appliance, etc.",
        },
        assign_only: {
          type: "boolean",
          description: "True when staff wants assign without dispatch SMS.",
        },
        assignment_note: { type: "string" },
        unit_label: { type: "string" },
        property_code: { type: "string" },
        human_ticket_id: { type: "string" },
        issue_hint: { type: "string" },
      },
      required: ["trade"],
    },
  },
  {
    type: "function",
    name: "confirm_pending_proposal",
    description:
      "Commit the pending proposal after staff says yes. Call once when they confirm — not before propose, not repeatedly.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "dismiss_pending_proposal",
    description:
      "Cancel the pending proposal when staff says no, cancel, never mind, forget it, or wants something else instead. " +
      "Clears the stuck confirm card so a new action can be proposed.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

const JARVIS_VOICE_ACCESS_READ_TOOLS = [
  {
    type: "function",
    name: "list_amenity_locations",
    description:
      "List bookable amenities (gameroom, sauna, terrace, etc.) for a property. " +
      "Use before booking or setting hours when staff asks what amenities exist.",
    parameters: {
      type: "object",
      properties: {
        property_code: {
          type: "string",
          description: "Property code or name, e.g. PENN. Omit to list portfolio amenities.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "lookup_amenity_booking",
    description:
      "Find an amenity booking and read the access PIN for staff. " +
      "Use for: what's the pin for unit 216 gameroom at 3pm, lookup booking, door code for reservation.",
    parameters: {
      type: "object",
      properties: {
        unit_label: { type: "string", description: "Tenant unit, e.g. 216." },
        property_code: { type: "string", description: "Property code or name, e.g. PENN." },
        amenity_name: {
          type: "string",
          description: "Optional amenity name when multiple exist, e.g. gameroom.",
        },
        booking_date: {
          type: "string",
          description: "Date: today, tomorrow, or YYYY-MM-DD. Default today.",
        },
        start_time: {
          type: "string",
          description: "Approx start time to match, e.g. 3pm.",
        },
        reservation_id: {
          type: "string",
          description: "Optional reservation UUID if already known.",
        },
      },
      required: ["unit_label"],
    },
  },
  {
    type: "function",
    name: "get_amenity_booking_rules",
    description:
      "Read current booking rules for an amenity — max block, min block, advance notice, daily limit. " +
      "Use before changing rules or when staff asks what the limits are.",
    parameters: {
      type: "object",
      properties: {
        amenity_name: { type: "string", description: "Amenity name, e.g. gameroom." },
        property_code: { type: "string", description: "Property code or name, e.g. PENN." },
      },
      required: ["amenity_name"],
    },
  },
];

const JARVIS_VOICE_ACCESS_WRITE_TOOLS = [
  {
    type: "function",
    name: "propose_book_amenity",
    description:
      "Propose booking an amenity for a tenant (staff override — skips advance notice). " +
      "Does NOT book until staff confirms. Use when staff says schedule/book gameroom, sauna, etc.",
    parameters: {
      type: "object",
      properties: {
        amenity_name: {
          type: "string",
          description: "Amenity name, e.g. gameroom, sauna, terrace.",
        },
        unit_label: { type: "string", description: "Tenant unit, e.g. 502." },
        property_code: {
          type: "string",
          description: "Property code or name, e.g. PENN.",
        },
        booking_date: {
          type: "string",
          description: "Date: today, tomorrow, or YYYY-MM-DD.",
        },
        start_time: { type: "string", description: "Start time, e.g. 3pm or 15:00." },
        end_time: { type: "string", description: "End time, e.g. 5pm or 17:00." },
        tenant_name: {
          type: "string",
          description: "Optional tenant name when multiple occupants in unit.",
        },
        notes: { type: "string", description: "Optional staff note for audit trail." },
      },
      required: ["amenity_name", "unit_label", "booking_date", "start_time", "end_time"],
    },
  },
  {
    type: "function",
    name: "propose_set_amenity_hours",
    description:
      "Propose setting weekly operating hours for an amenity. Does NOT save until staff confirms. " +
      "Use when staff wants to configure open/close hours (not a one-off tenant booking).",
    parameters: {
      type: "object",
      properties: {
        amenity_name: { type: "string", description: "Amenity name, e.g. gameroom." },
        property_code: { type: "string", description: "Property code or name, e.g. PENN." },
        open_time: { type: "string", description: "Open time HH:MM, e.g. 08:00." },
        close_time: { type: "string", description: "Close time HH:MM, e.g. 23:00." },
        days: {
          type: "string",
          description: "all, weekdays, or weekends — used with open_time/close_time.",
        },
        schedules: {
          type: "array",
          description: "Optional per-day rows: [{ day_of_week: 0-6, open_time, close_time }].",
          items: {
            type: "object",
            properties: {
              day_of_week: { type: "number" },
              open_time: { type: "string" },
              close_time: { type: "string" },
            },
          },
        },
      },
      required: ["amenity_name"],
    },
  },
  {
    type: "function",
    name: "propose_cancel_amenity_booking",
    description:
      "Propose cancelling an amenity booking. Does NOT cancel until staff confirms. " +
      "Use when staff says cancel gameroom booking, cancel unit 216 reservation, etc.",
    parameters: {
      type: "object",
      properties: {
        unit_label: { type: "string", description: "Tenant unit, e.g. 216." },
        property_code: { type: "string", description: "Property code or name." },
        amenity_name: { type: "string", description: "Optional amenity name." },
        booking_date: {
          type: "string",
          description: "Date: today, tomorrow, or YYYY-MM-DD. Default today.",
        },
        start_time: { type: "string", description: "Approx start time, e.g. 3pm." },
        reservation_id: { type: "string", description: "Optional reservation id." },
      },
      required: ["unit_label"],
    },
  },
  {
    type: "function",
    name: "propose_update_amenity_policy",
    description:
      "Propose changing amenity booking rules (max block, min block, advance notice, daily limit). " +
      "Does NOT save until staff confirms. Use for: change max block to 3 hours, allow 2 hour bookings.",
    parameters: {
      type: "object",
      properties: {
        amenity_name: { type: "string", description: "Amenity name, e.g. gameroom." },
        property_code: { type: "string", description: "Property code or name." },
        max_duration_min: {
          type: "number",
          description: "Maximum booking block in minutes (max block allowed).",
        },
        min_duration_min: {
          type: "number",
          description: "Minimum booking block in minutes.",
        },
        advance_booking_min: {
          type: "number",
          description: "Minimum advance notice in minutes.",
        },
        max_per_tenant_day: {
          type: "number",
          description: "Max bookings per tenant per day.",
        },
        requires_approval: {
          type: "boolean",
          description: "Whether staff must approve each booking.",
        },
      },
      required: ["amenity_name"],
    },
  },
];

const JARVIS_VOICE_COMM_WRITE_TOOLS = [
  {
    type: "function",
    name: "propose_send_communication_campaign",
    description:
      "Propose a tenant SMS broadcast (building notice, policy reminder, etc.). " +
      "Does NOT send until staff confirms. Use when staff asks to message/text/notify tenants — " +
      "all tenants at a property, all properties, a floor, one unit, or one tenant. " +
      "Pass the message brief in plain language; the Communication Engine composes tenant-facing copy.",
    parameters: {
      type: "object",
      properties: {
        brief: {
          type: "string",
          description:
            "What tenants should be told, e.g. remove all belongings from parking spots by Friday.",
        },
        audience_scope: {
          type: "string",
          enum: ["portfolio", "property", "floor", "unit", "tenant"],
          description:
            "Who receives the message. portfolio = all properties; property = all tenants at one building; " +
            "floor = one floor; unit = one apartment; tenant = one person in a unit.",
        },
        property_code: {
          type: "string",
          description: "Property code or name when audience is not portfolio-wide, e.g. PENN.",
        },
        floor: {
          type: "string",
          description: "Floor number when audience_scope is floor, e.g. 3.",
        },
        unit_label: {
          type: "string",
          description: "Unit number when audience_scope is unit or tenant, e.g. 303.",
        },
        tenant_name: {
          type: "string",
          description: "Tenant name when audience_scope is tenant (optional if only one in unit).",
        },
        comm_type: {
          type: "string",
          description:
            "Optional category override: BUILDING_UPDATE, POLICY_REMINDER, MAINTENANCE_NOTICE, EMERGENCY_ALERT, LEASE_ADMIN.",
        },
        title: {
          type: "string",
          description: "Optional short campaign title for staff records.",
        },
      },
      required: ["brief", "audience_scope"],
    },
  },
];

function jarvisVoiceToolSchemas() {
  const tools = [...JARVIS_VOICE_READ_TOOLS, ...JARVIS_VOICE_SESSION_TOOLS];
  if (accessEngineEnabled()) tools.push(...JARVIS_VOICE_ACCESS_READ_TOOLS);
  if (jarvisPlanEnabled()) tools.push(...JARVIS_VOICE_WRITE_TOOLS);
  if (jarvisPlanEnabled() && accessEngineEnabled()) tools.push(...JARVIS_VOICE_ACCESS_WRITE_TOOLS);
  if (jarvisPlanEnabled() && communicationEngineEnabled()) tools.push(...JARVIS_VOICE_COMM_WRITE_TOOLS);
  return tools;
}

/**
 * @param {string} name
 * @param {object} args
 * @param {object} ctx
 */
const JARVIS_VOICE_READ_TOOL_NAMES = new Set([
  "query_service_history",
  "list_open_service_tickets",
  "ask_propera",
  "resolve_open_ticket",
  "list_amenity_locations",
  "lookup_amenity_booking",
  "get_amenity_booking_rules",
]);

const JARVIS_VOICE_WRITE_TOOL_NAMES = new Set([
  "propose_append_service_note",
  "propose_attach_ticket_cost",
  "propose_vendor_request",
  "propose_create_service_request",
  "propose_schedule_ticket",
  "propose_set_ticket_status",
  "propose_set_ticket_category",
  "propose_update_ticket_issue",
  "propose_close_ticket",
  "propose_cancel_ticket",
  "propose_book_amenity",
  "propose_set_amenity_hours",
  "propose_cancel_amenity_booking",
  "propose_update_amenity_policy",
  "propose_send_communication_campaign",
  "confirm_pending_proposal",
  "dismiss_pending_proposal",
]);

function staffAffirmsUtterance(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return /\b(yes|yeah|yep|yup|confirm|confirmed|go ahead|do it|correct|right|sure|ok|okay|please do|sounds good|that's fine|thats fine|affirmative)\b/.test(
    t
  );
}

function voiceStaffSpeechSeen(ctx) {
  return ctx.staffSpeechSeen === true || voiceStaffTurnCount(ctx) >= 1;
}

function voiceStaffTurnCount(ctx) {
  const n = Number(ctx.staffTurnCount);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function voiceConfirmIssuedTurn(ctx) {
  const n = Number(ctx.confirmTokenIssuedAtTurn);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function voiceToolGate(tool, ctx) {
  const turns = voiceStaffTurnCount(ctx);
  const spoke = voiceStaffSpeechSeen(ctx);
  if (tool === "end_voice_session") return null;

  const isWrite = JARVIS_VOICE_WRITE_TOOL_NAMES.has(tool);
  if (!JARVIS_VOICE_READ_TOOL_NAMES.has(tool) && isWrite && !spoke) {
    return {
      error: "awaiting_staff_speech",
      message: "Wait until staff speaks before write actions.",
      speak: "I'm listening — tell me what you need.",
    };
  }

  if (tool === "confirm_pending_proposal") {
    const token = String(ctx.pendingConfirmToken || "").trim();
    if (!token) {
      return {
        error: "no_session_proposal",
        message: "Propose an action in this call before confirming.",
        speak: "I haven't proposed anything yet.",
      };
    }
    const affirmed = staffAffirmsUtterance(ctx.lastStaffTranscript);
    if (!affirmed && turns <= voiceConfirmIssuedTurn(ctx)) {
      return {
        error: "confirm_after_readback",
        message: "Wait for staff to say yes after the readback.",
        speak: "Say yes if that looks right.",
      };
    }
    return null;
  }
  return null;
}

async function runJarvisVoiceTool(name, args, ctx) {
  const tool = String(name || "").trim();
  const a = args && typeof args === "object" ? args : {};

  if (!ctx.staffContext?.isStaff) {
    return { error: "not_staff", message: "Only authenticated staff can use Jarvis tools." };
  }

  const gate = voiceToolGate(tool, ctx);
  if (gate) {
    emit({
      level: "info",
      trace_id: ctx.traceId || null,
      log_kind: "jarvis_voice_tool",
      event: "tool_gated",
      data: { tool, error: gate.error, staff_turn_count: voiceStaffTurnCount(ctx) },
    });
    return gate;
  }

  if (tool === "query_service_history") {
    const result = await queryServiceHistoryVoice(a, ctx);
    emit({
      level: "info",
      trace_id: ctx.traceId || null,
      log_kind: "jarvis_voice_tool",
      event: "query_service_history",
      data: {
        count: result.count ?? null,
        days_back: result.days_back ?? null,
        property_code: result.property_code || null,
        analysis: result.analysis || null,
        distinct_units: result.distinct_unit_count ?? null,
        repeat_units: result.repeat_unit_count ?? null,
        issue_keywords: Array.isArray(a.issue_keywords)
          ? a.issue_keywords
          : a.issue_keywords
            ? [String(a.issue_keywords)]
            : [],
      },
    });
    return result;
  }

  if (tool === "list_open_service_tickets") {
    const result = await listOpenServiceTickets(a, ctx);
    emit({
      level: "info",
      trace_id: ctx.traceId || null,
      log_kind: "jarvis_voice_tool",
      event: "list_open_service_tickets",
      data: {
        total: result.total,
        property_code: result.property_code || null,
      },
    });
    return result;
  }

  if (tool === "ask_propera") {
    const question = String(a.question || "").trim();
    if (!question) return { error: "missing_question", message: "Need a question." };
    if (!jarvisAskEnabled()) {
      return { error: "jarvis_ask_disabled", message: "Jarvis Ask is not enabled." };
    }

    const routerParameter = {
      Body: question,
      From: String(ctx.staffActorKey || "").trim(),
      _transportChannel: "portal",
    };
    if (ctx.pageContext) {
      routerParameter._portalPageContextJson = JSON.stringify(ctx.pageContext);
    }
    if (ctx.scope) {
      routerParameter._operationalScopeJson = JSON.stringify(ctx.scope);
    }

    const result = await handleJarvisAskTurn({
      traceId: String(ctx.traceId || ""),
      routerParameter,
      staffContext: ctx.staffContext,
    });

    emit({
      level: "info",
      trace_id: ctx.traceId || null,
      log_kind: "jarvis_voice_tool",
      event: "ask_propera",
      data: { question_len: question.length },
    });

    return {
      answer: String(result.replyText || "").trim() || "No answer available.",
      read_only: true,
    };
  }

  if (tool === "end_voice_session") {
    ctx.onSessionEndRequested?.();
    return {
      end_session: true,
      message: "Session ending.",
      speak: "Goodbye.",
    };
  }

  if (tool === "resolve_open_ticket") {
    return resolveOpenTicket(a, ctx);
  }

  if (tool === "propose_append_service_note") {
    const result = await proposeAppendServiceNote(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_attach_ticket_cost") {
    const result = await proposeAttachTicketCost(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_vendor_request") {
    const result = await proposeVendorRequest(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_create_service_request") {
    const result = await proposeCreateServiceRequest(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_schedule_ticket") {
    const result = await proposeScheduleTicket(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_set_ticket_status") {
    const result = await proposeSetTicketStatus(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_set_ticket_category") {
    const result = await proposeSetTicketCategory(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_update_ticket_issue") {
    const result = await proposeUpdateTicketIssue(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_close_ticket") {
    const result = await proposeCloseTicket(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_cancel_ticket") {
    const result = await proposeCancelTicket(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_book_amenity") {
    const result = await proposeBookAmenity(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_set_amenity_hours") {
    const result = await proposeSetAmenitySchedule(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_cancel_amenity_booking") {
    const result = await proposeCancelAmenity(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_update_amenity_policy") {
    const result = await proposeUpdateAmenityPolicy(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "propose_send_communication_campaign") {
    const result = await proposeSendCommunicationCampaign(a, ctx);
    if (result.needs_confirm && result.confirm_token) {
      ctx.onPendingConfirm?.(result.confirm_token);
    }
    return result;
  }

  if (tool === "lookup_amenity_booking") {
    if (!accessEngineEnabled()) {
      return { error: "access_engine_disabled", message: "Access engine is disabled on the server." };
    }
    return lookupAmenityBookingVoice(a, ctx);
  }

  if (tool === "get_amenity_booking_rules") {
    if (!accessEngineEnabled()) {
      return { error: "access_engine_disabled", message: "Access engine is disabled on the server." };
    }
    return getAmenityBookingRulesVoice(a, ctx);
  }

  if (tool === "list_amenity_locations") {
    if (!accessEngineEnabled()) {
      return { error: "access_engine_disabled", message: "Access engine is disabled on the server." };
    }
    const propResolved = await resolveJarvisPropertyForCreate({
      propertyHint: a.property_code || a.propertyCode,
      scope: ctx.scope,
      pageContext: ctx.pageContext,
      traceId: ctx.traceId,
    });
    const propertyCode = propResolved.ok ? propResolved.propertyCode : "";
    const rows = await listAccessLocationsForPortal(
      propertyCode ? { propertyCode } : {}
    );
    const active = rows.filter((r) => r.active !== false);
    if (!active.length) {
      return {
        count: 0,
        message: propertyCode
          ? `No amenities at ${propertyCode}.`
          : "No amenities configured in the portfolio.",
        locations: [],
      };
    }
    const locations = active.map((r) => ({
      id: r.id,
      name: r.name,
      property_code: r.propertyCode,
      slug: r.slug,
    }));
    const names = locations
      .slice(0, 8)
      .map((l) => `${l.name} (${l.property_code})`)
      .join(", ");
    return {
      count: locations.length,
      property_code: propertyCode || undefined,
      locations,
      message: propertyCode
        ? `${locations.length} amenit${locations.length === 1 ? "y" : "ies"} at ${propertyCode}: ${names}.`
        : `${locations.length} amenities: ${names}.`,
    };
  }

  if (tool === "confirm_pending_proposal") {
    const result = await confirmPendingProposal(ctx);
    if (result.committed) {
      ctx.onPendingConfirm?.("");
    }
    return result;
  }

  if (tool === "dismiss_pending_proposal") {
    return dismissPendingProposal(ctx);
  }

  return { error: "unknown_tool", tool };
}

module.exports = {
  JARVIS_VOICE_TOOL_SCHEMAS: jarvisVoiceToolSchemas(),
  jarvisVoiceToolSchemas,
  runJarvisVoiceTool,
  staffAffirmsUtterance,
};
