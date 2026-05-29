/**
 * Jarvis / staff agent — portal page context envelope (hint only, not truth).
 * @see docs/STAFF_AGENT_V1.md
 * @see docs/PROPERA_JARVIS_NORTH_STAR.md § App context is a hint
 */

/**
 * Normalize portal page context from router parameter.
 * @param {Record<string, string | undefined>} routerParameter
 * @returns {object | null}
 */
function readPortalPageContext(routerParameter) {
  const p = routerParameter || {};
  let raw = p._portalPageContextJson;
  if (!raw) {
    try {
      const nest = JSON.parse(String(p._portalPayloadJson || "{}"));
      raw = nest.portal_page_context ?? nest.portalPageContext;
      if (raw && typeof raw === "object") return normalizePortalPageContext(raw);
    } catch (_) {
      return null;
    }
    return null;
  }
  try {
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    return normalizePortalPageContext(j);
  } catch (_) {
    return null;
  }
}

/**
 * @param {unknown} raw
 */
function normalizePortalPageContext(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const propertyCode = String(
    o.property_code ?? o.propertyCode ?? ""
  )
    .trim()
    .toUpperCase();
  const unit = String(o.unit ?? o.subject_unit ?? "").trim();
  const ticketRowId = String(o.ticket_row_id ?? o.ticketRowId ?? "").trim();
  const humanTicketId = String(o.human_ticket_id ?? o.humanTicketId ?? "")
    .trim()
    .toUpperCase();
  const surface = String(o.surface ?? "").trim().toLowerCase();
  const pathname = String(o.pathname ?? "").trim();
  const ticketLabel = String(o.ticket_label ?? o.ticketLabel ?? "").trim();

  if (!propertyCode && !ticketRowId && !humanTicketId && !unit) return null;

  return {
    surface,
    pathname,
    propertyCode,
    unit,
    ticketRowId,
    humanTicketId,
    ticketLabel,
  };
}

/**
 * Deictic phrases — "schedule this ticket", "close this one".
 * @param {string} body
 */
function bodyReferencesPageTicket(body) {
  const b = String(body || "")
    .toLowerCase()
    .replace(/^#\s*/, "");
  if (!b) return false;
  return (
    /\b(this|that)\s+(ticket|one)\b/.test(b) ||
    /\bschedule\s+this\b/.test(b) ||
    /\bclose\s+this\b/.test(b) ||
    /\bmark\s+this\b/.test(b) ||
    /\bnote\s+on\s+this\b/.test(b) ||
    /\bfor\s+this\s+ticket\b/.test(b)
  );
}

module.exports = {
  readPortalPageContext,
  normalizePortalPageContext,
  bodyReferencesPageTicket,
};
