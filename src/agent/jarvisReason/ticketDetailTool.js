/**
 * Jarvis reasoning — single-ticket deep read ("what's the deal with 301?").
 *
 * Reuses the existing read helpers so there is one source of truth for ticket
 * detail + cost summary. Read-only.
 * @see src/agent/jarvisAsk/gatherJarvisFacts.js
 */

const {
  loadFocusTicketDetail,
  loadTicketCostSummary,
} = require("../jarvisAsk/gatherJarvisFacts");

/**
 * @param {object} params — see TICKET_DETAIL_TOOL_SCHEMA
 * @returns {Promise<object>} read-only ticket fact pack
 */
async function getTicketDetail(params) {
  const p = params || {};
  const humanTicketId = String(p.humanTicketId || p.ticketId || "").trim();
  const ticketRowId = String(p.ticketRowId || "").trim();
  if (!humanTicketId && !ticketRowId) return { ok: false, error: "missing_ticket_ref" };

  const detail = await loadFocusTicketDetail({ ticketRowId, humanTicketId }).catch(() => null);
  if (!detail) return { ok: false, error: "ticket_not_found" };

  const cost = await loadTicketCostSummary(detail.ticketRowId).catch(() => null);

  return {
    ok: true,
    ticket: {
      id: detail.humanTicketId || detail.ticketRowId,
      property: detail.property,
      unit: detail.unit,
      status: detail.status,
      category: detail.category,
      priority: detail.priority,
      assignee: detail.assignee,
      scheduledWindow: detail.preferredWindow || "",
      tenant: detail.tenantName,
      serviceNotes: detail.serviceNotes,
      created: String(detail.createdAt || "").slice(0, 10),
      updated: String(detail.updatedAt || "").slice(0, 10),
      closed: String(detail.closedAt || "").slice(0, 10),
      issue: detail.messagePreview,
      timeline: detail.timeline,
    },
    cost: cost
      ? {
          entryCount: cost.entryCount,
          companyCents: cost.companyCents,
          tenantChargeCents: cost.tenantCents,
        }
      : null, // null => no cost rows or finance disabled
  };
}

/** OpenAI function-calling schema. */
const TICKET_DETAIL_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "get_ticket_detail",
    description:
      "Get the full story for ONE ticket: status, category, priority, assignee, schedule window, " +
      "tenant, service notes, recent timeline, and cost summary. Read-only. Use for 'what's the deal " +
      "with 301', 'is 312 handled yet'. Provide the human ticket id (e.g. PENN-051926-7149) when known.",
    parameters: {
      type: "object",
      properties: {
        humanTicketId: { type: "string", description: "Human ticket id, e.g. PENN-051926-7149." },
        ticketRowId: { type: "string", description: "Internal ticket row UUID, if known." },
      },
      additionalProperties: false,
    },
  },
};

module.exports = {
  getTicketDetail,
  TICKET_DETAIL_TOOL_SCHEMA,
};
