/**
 * Resolve open work item from portal page context when body uses deictic reference.
 * Brain still validates ticket exists and action is allowed.
 */
const { bodyReferencesPageTicket } = require("./contextEnvelope");
const { getSupabase } = require("../db/supabase");

/**
 * @param {object} opts
 * @param {string} opts.bodyTrim
 * @param {object | null} opts.pageContext
 * @param {Array<{ workItemId: string, unitId?: string, propertyId?: string, ticketKey?: string, ticketHumanId?: string }>} opts.openWis
 */
async function resolveWorkItemFromPageContext(opts) {
  const body = String(opts.bodyTrim || "").trim();
  const pageContext = opts.pageContext;
  const openWis = opts.openWis || [];

  if (!pageContext || openWis.length === 0) return { wiId: "", reason: "" };
  if (!bodyReferencesPageTicket(body)) return { wiId: "", reason: "" };

  const humanId = String(pageContext.humanTicketId || "")
    .trim()
    .toUpperCase();
  if (humanId) {
    const byHuman = openWis.filter(
      (w) =>
        String(w.ticketHumanId || "")
          .trim()
          .toUpperCase() === humanId
    );
    if (byHuman.length === 1) {
      return { wiId: byHuman[0].workItemId, reason: "PAGE_CONTEXT_HUMAN_TICKET" };
    }
  }

  const ticketRowId = String(pageContext.ticketRowId || "").trim();
  if (ticketRowId) {
    const sb = getSupabase();
    if (sb) {
      const { data: ticket } = await sb
        .from("tickets")
        .select("ticket_key")
        .eq("id", ticketRowId)
        .maybeSingle();
      const key = ticket && ticket.ticket_key ? String(ticket.ticket_key).trim() : "";
      if (key) {
        const byKey = openWis.filter((w) => String(w.ticketKey || "").trim() === key);
        if (byKey.length === 1) {
          return { wiId: byKey[0].workItemId, reason: "PAGE_CONTEXT_TICKET_ROW" };
        }
      }
    }
  }

  const prop = String(pageContext.propertyCode || "").toUpperCase();
  const unit = String(pageContext.unit || "")
    .toLowerCase()
    .replace(/\s/g, "");
  if (prop && unit) {
    const candidates = openWis.filter((w) => {
      const wProp = String(w.propertyId || "").toUpperCase();
      const wUnit = String(w.unitId || "")
        .toLowerCase()
        .replace(/\s/g, "");
      return wProp === prop && wUnit === unit;
    });
    if (candidates.length === 1) {
      return { wiId: candidates[0].workItemId, reason: "PAGE_CONTEXT_PROPERTY_UNIT" };
    }
  }

  return { wiId: "", reason: "PAGE_CONTEXT_NO_MATCH" };
}

module.exports = { resolveWorkItemFromPageContext };
