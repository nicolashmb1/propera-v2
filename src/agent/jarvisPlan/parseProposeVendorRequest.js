/**
 * Natural-language draft for propose_vendor_request (Jarvis Plan).
 * Brain validates + commits via assignVendorToTicket on confirm.
 */

const {
  bodyReferencesPageTicket,
  readPortalPageContext,
} = require("../contextEnvelope");

const INTENT_RE =
  /\b(?:schedule|assign|dispatch|send|get|call|book)\b.*\b(?:vendor|plumber|electric|electrician|hvac|handyman|contractor)\b|\b(?:vendor|plumber)\b.*\b(?:for|to)\b/i;

const TICKET_ID_RE = /([A-Za-z0-9]{2,12}-\d{6}-\d{4})/i;

const TRADE_HINTS = [
  { key: "plumber", wordRe: /\b(plumb(?:er|ing)?)\b/i, vendorRe: /plumb/i },
  { key: "electric", wordRe: /\b(electric(?:ian)?)\b/i, vendorRe: /electric/i },
  { key: "hvac", wordRe: /\b(hvac|heating|cooling)\b/i, vendorRe: /hvac|heat|cool/i },
  { key: "handyman", wordRe: /\b(handyman|general)\b/i, vendorRe: /handy|general/i },
];

/**
 * @param {string} body
 */
function extractTradeKey(body) {
  const b = String(body || "");
  for (const h of TRADE_HINTS) {
    if (h.wordRe.test(b)) return h.key;
  }
  if (/\bvendor\b/i.test(b)) return "vendor";
  return "";
}

/**
 * @param {string} body
 * @returns {{ unit: string, propertyCode: string } | null}
 */
function extractUnitAndProperty(body) {
  const b = String(body || "").trim();
  let m = b.match(
    /\b(?:for|at|on|to)\s+(?:unit\s+)?#?(\d+[A-Za-z]?)\s+(?:at\s+)?([A-Za-z]{2,12})\b/i
  );
  if (m) {
    return { unit: String(m[1] || "").trim(), propertyCode: String(m[2] || "").trim().toUpperCase() };
  }
  m = b.match(/\bunit\s+#?(\d+[A-Za-z]?)\s+(?:at\s+)?([A-Za-z]{2,12})\b/i);
  if (m) {
    return { unit: String(m[1] || "").trim(), propertyCode: String(m[2] || "").trim().toUpperCase() };
  }
  m = b.match(/\b#?(\d+[A-Za-z]?)\s+([A-Za-z]{2,12})\b/);
  if (m && !TICKET_ID_RE.test(m[0])) {
    return { unit: String(m[1] || "").trim(), propertyCode: String(m[2] || "").trim().toUpperCase() };
  }
  return null;
}

/**
 * @param {string} body
 * @param {Record<string, string | undefined>} routerParameter
 * @returns {{
 *   kind: "propose_vendor";
 *   tradeKey: string;
 *   humanTicketId: string;
 *   ticketRowId: string;
 *   propertyCode: string;
 *   unit: string;
 *   dispatch: boolean;
 *   assignmentNote: string;
 * } | null}
 */
function parseProposeVendorRequest(body, routerParameter) {
  const b = String(body || "").trim();
  if (!b || b.length < 8) return null;
  if (/\$\$/.test(b)) return null;
  if (!INTENT_RE.test(b)) return null;

  const page = readPortalPageContext(routerParameter || {});
  const ticketM = b.match(TICKET_ID_RE);
  const humanTicketId = ticketM ? String(ticketM[1] || "").trim().toUpperCase() : "";

  let propertyCode = "";
  let unit = "";
  const loc = extractUnitAndProperty(b);
  if (loc) {
    propertyCode = loc.propertyCode;
    unit = loc.unit;
  }

  if (page) {
    if (!propertyCode && page.propertyCode) propertyCode = page.propertyCode;
    if (!unit && page.unit) unit = page.unit;
    if (!humanTicketId && page.humanTicketId) {
      /* use below */
    }
  }

  const ticketRowId =
    page && page.ticketRowId && (bodyReferencesPageTicket(b) || humanTicketId)
      ? String(page.ticketRowId).trim()
      : "";

  const dispatch = !/\b(?:no\s+dispatch|assign\s+only|without\s+(?:sms|text|dispatch))\b/i.test(
    b
  );

  const assignmentNote = b.slice(0, 200);

  return {
    kind: "propose_vendor",
    tradeKey: extractTradeKey(b),
    humanTicketId: humanTicketId || (page && bodyReferencesPageTicket(b) ? page.humanTicketId : ""),
    ticketRowId: ticketRowId || (page && bodyReferencesPageTicket(b) ? page.ticketRowId : ""),
    propertyCode,
    unit,
    dispatch,
    assignmentNote,
  };
}

/**
 * @param {string} tradeKey
 */
function tradeHintForVendorMatch(tradeKey) {
  const h = TRADE_HINTS.find((x) => x.key === tradeKey);
  return h ? h.vendorRe : null;
}

module.exports = {
  parseProposeVendorRequest,
  extractTradeKey,
  tradeHintForVendorMatch,
  TRADE_HINTS,
};
