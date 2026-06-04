/**
 * Natural-language draft for append_service_note (Jarvis Plan typed mode).
 */

const { readPortalPageContext } = require("../contextEnvelope");

const TICKET_ID_RE = /([A-Za-z0-9]{2,12}-\d{6}-\d{4})/i;

const NOTE_LINE_RE =
  /^(?:note|service\s+note|append\s+(?:service\s+)?note)\s*[:—-]\s*(.+)$/i;

/**
 * @param {string} body
 * @param {Record<string, string | undefined>} routerParameter
 * @returns {{
 *   kind: "append_service_note";
 *   noteText: string;
 *   humanTicketId: string;
 *   ticketRowId: string;
 *   propertyCode: string;
 *   unit: string;
 * } | null}
 */
function parseProposeAppendServiceNote(body, routerParameter) {
  const b = String(body || "").trim();
  if (!b || b.length < 6) return null;
  if (/\$\$/.test(b)) return null;

  const m = b.match(NOTE_LINE_RE);
  if (!m) return null;

  let noteText = String(m[1] || "").trim();
  if (noteText.length < 3) return null;

  const page = readPortalPageContext(routerParameter || {});
  const ticketM = b.match(TICKET_ID_RE);
  let humanTicketId = ticketM ? String(ticketM[1] || "").trim().toUpperCase() : "";

  if (humanTicketId && noteText.toUpperCase().startsWith(humanTicketId)) {
    noteText = noteText.slice(humanTicketId.length).replace(/^[\s,:-]+/, "").trim();
  }

  const unitM = b.match(/\b(?:unit\s+)?#?(\d+[A-Za-z]?)\s+(?:at\s+)?([A-Za-z]{2,12})\b/i);
  const unit = unitM ? String(unitM[1] || "").trim() : String(page?.unit || "").trim();
  const propertyCode = unitM
    ? String(unitM[2] || "").trim().toUpperCase()
    : String(page?.property_code || page?.propertyCode || "").trim().toUpperCase();

  const ticketRowId = String(page?.ticket_row_id || page?.ticketRowId || "").trim();
  if (!humanTicketId) {
    humanTicketId = String(page?.human_ticket_id || page?.humanTicketId || "")
      .trim()
      .toUpperCase();
  }

  if (!noteText) return null;

  return {
    kind: "append_service_note",
    noteText: noteText.slice(0, 2000),
    humanTicketId,
    ticketRowId,
    propertyCode,
    unit,
  };
}

module.exports = { parseProposeAppendServiceNote, NOTE_LINE_RE };
