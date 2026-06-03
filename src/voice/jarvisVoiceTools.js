/**
 * Jarvis live voice tools — read (Ask) + write (propose → confirm).
 */
const { handleJarvisAskTurn } = require("../agent/jarvisAsk/handleJarvisAskTurn");
const { jarvisAskEnabled, jarvisPlanEnabled } = require("../config/env");
const { emit } = require("../logging/structuredLog");
const {
  proposeAppendServiceNote,
  confirmPendingProposal,
  resolveOpenTicket,
} = require("./jarvisVoiceProposals");

const JARVIS_VOICE_READ_TOOLS = [
  {
    type: "function",
    name: "ask_propera",
    description:
      "Read-only: open tickets, summaries, unit status, costs, timeline. Use for questions — never guess.",
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
          description: "Full service note line(s) to append — staff's words.",
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
    name: "confirm_pending_proposal",
    description:
      "Commit the last pending proposal after staff says yes/confirm. Only call when they clearly confirm.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

function jarvisVoiceToolSchemas() {
  const tools = [...JARVIS_VOICE_READ_TOOLS];
  if (jarvisPlanEnabled()) tools.push(...JARVIS_VOICE_WRITE_TOOLS);
  return tools;
}

/**
 * @param {string} name
 * @param {object} args
 * @param {object} ctx
 */
async function runJarvisVoiceTool(name, args, ctx) {
  const tool = String(name || "").trim();
  const a = args && typeof args === "object" ? args : {};

  if (!ctx.staffContext?.isStaff) {
    return { error: "not_staff", message: "Only authenticated staff can use Jarvis tools." };
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

  if (tool === "confirm_pending_proposal") {
    const result = await confirmPendingProposal(ctx);
    if (result.committed) {
      ctx.onPendingConfirm?.("");
    }
    return result;
  }

  return { error: "unknown_tool", tool };
}

module.exports = {
  JARVIS_VOICE_TOOL_SCHEMAS: jarvisVoiceToolSchemas(),
  jarvisVoiceToolSchemas,
  runJarvisVoiceTool,
};
