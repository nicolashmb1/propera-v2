/**
 * Jarvis voice — portfolio or property open service ticket list (read-only).
 */

const {
  listOpenTicketsForProperty,
  listAllOpenServiceTickets,
} = require("../agent/operationalScope/compileOperationalScope");
const { formatJarvisAskReply } = require("../agent/jarvisAsk/formatJarvisAskReply");

/**
 * @param {import("../operationalScope/types").OperationalScopeOpenTicket[]} tickets
 */
function sortTickets(tickets) {
  return [...(tickets || [])].sort((a, b) => {
    const au = /urgent|high/i.test(String(a.status || "") + String(a.summary || ""));
    const bu = /urgent|high/i.test(String(b.status || "") + String(b.summary || ""));
    if (au !== bu) return au ? -1 : 1;
    return String(a.humanTicketId || "").localeCompare(String(b.humanTicketId || ""));
  });
}

/**
 * @param {object} row
 */
function ticketBrief(row) {
  const prop = String(row.propertyCode || "").trim();
  const unit = String(row.unitLabel || "").trim();
  const sum = String(row.summary || "").trim().slice(0, 40);
  const bits = [prop, unit ? `unit ${unit}` : "", sum].filter(Boolean);
  return bits.join(" ").trim();
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function listOpenServiceTickets(args, ctx) {
  const propHint = String(
    args.property_code || args.propertyCode || ctx.pageContext?.propertyCode || ""
  )
    .trim()
    .toUpperCase();
  const scope = ctx.scope || {};
  const tickets = propHint
    ? await listOpenTicketsForProperty(propHint)
    : await listAllOpenServiceTickets();
  const sorted = sortTickets(tickets);
  const total = sorted.length;

  const textAnswer = formatJarvisAskReply(
    {
      scopeStory: scope.story || "",
      anchor: scope.anchor || {},
      openTicketsAtProperty: sorted,
      activeWork: [],
      intents: ["OPEN_LIST"],
    },
    propHint ? `open tickets at ${propHint}` : "all open service tickets portfolio"
  );

  const speakParts = sorted.slice(0, 8).map(ticketBrief).filter(Boolean);
  let speak;
  if (!total) {
    speak = propHint
      ? `No open service tickets at ${propHint} right now.`
      : "No open service tickets in the portfolio right now.";
  } else {
    speak =
      `${total} open service ticket${total === 1 ? "" : "s"}` +
      (propHint ? ` at ${propHint}` : " across the portfolio") +
      `. ${speakParts.join("; ")}` +
      (total > 8 ? " — and more in the chat panel." : ".");
  }

  return {
    total,
    property_code: propHint || undefined,
    tickets: sorted.slice(0, 25).map((t) => ({
      human_ticket_id: t.humanTicketId,
      property_code: t.propertyCode,
      unit_label: t.unitLabel,
      status: t.status,
      summary: t.summary,
    })),
    text: textAnswer,
    speak,
    read_only: true,
  };
}

module.exports = { listOpenServiceTickets, sortTickets, ticketBrief };
