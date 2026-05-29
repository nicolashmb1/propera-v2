/**
 * Resolve unit / ticket hints from natural-language Jarvis Ask questions.
 */

const HUMAN_TICKET_RE = /\b([A-Za-z0-9]{2,12}-\d{6}-\d{4})\b/i;

function normUnit(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s/g, "");
}

/**
 * @param {string} question
 */
function extractHumanTicketIdFromQuestion(question) {
  const m = String(question || "").match(HUMAN_TICKET_RE);
  return m ? String(m[1]).trim().toUpperCase() : "";
}

/**
 * @param {string} question
 */
function extractUnitHintFromQuestion(question) {
  const s = String(question || "").toLowerCase();
  let m = s.match(/\b(?:unit|apt|apartment|#)\s*([a-z0-9][a-z0-9-]*)\b/i);
  if (m) return String(m[1]).trim();
  m = s.match(/\b([0-9]{2,4}[a-z]?)\s+ticket\b/i);
  if (m) return String(m[1]).trim();
  m = s.match(/\bticket\s+(?:for\s+)?(?:unit\s+)?([0-9]{2,4}[a-z]?)\b/i);
  if (m) return String(m[1]).trim();
  m = s.match(/\bwhat(?:'s| is| about)\s+([0-9]{2,4}[a-z]?)\b/i);
  if (m) return String(m[1]).trim();
  m = s.match(/\babout\s+([0-9]{2,4}[a-z]?)\s+ticket\b/i);
  if (m) return String(m[1]).trim();
  return "";
}

/**
 * Pick ticket target from question + scope open tickets.
 * @param {import("../operationalScope/types").OperationalScope} scope
 * @param {string} question
 */
function resolveTicketTargetFromQuestion(scope, question) {
  const opens = scope.propertyOpenTickets || [];
  const anchor = scope.anchor || {};
  const q = String(question || "").trim();

  const humanId = extractHumanTicketIdFromQuestion(q);
  if (humanId) {
    const byHuman = opens.filter(
      (t) =>
        String(t.humanTicketId || "")
          .trim()
          .toUpperCase() === humanId
    );
    if (byHuman.length === 1) {
      return {
        ticketRowId: byHuman[0].ticketRowId,
        humanTicketId: byHuman[0].humanTicketId,
        unitLabel: byHuman[0].unitLabel,
        reason: "QUESTION_HUMAN_TICKET_ID",
      };
    }
    return {
      ticketRowId: "",
      humanTicketId: humanId,
      unitLabel: "",
      reason: "QUESTION_HUMAN_TICKET_ID_DIRECT",
    };
  }

  const unitHint = extractUnitHintFromQuestion(q) || String(anchor.unit || "").trim();
  if (!unitHint) return null;

  const want = normUnit(unitHint);
  if (!want) return null;

  const matches = opens.filter((t) => normUnit(t.unitLabel) === want);
  if (matches.length === 1) {
    return {
      ticketRowId: matches[0].ticketRowId,
      humanTicketId: matches[0].humanTicketId,
      unitLabel: matches[0].unitLabel,
      reason: "QUESTION_UNIT_SINGLE",
    };
  }
  if (matches.length > 1) {
    return {
      reason: "QUESTION_UNIT_AMBIGUOUS",
      unitLabel: unitHint,
      candidates: matches.slice(0, 8),
    };
  }
  return {
    reason: "QUESTION_UNIT_NO_OPEN_TICKET",
    unitLabel: unitHint,
  };
}

module.exports = {
  normUnit,
  extractHumanTicketIdFromQuestion,
  extractUnitHintFromQuestion,
  resolveTicketTargetFromQuestion,
};
