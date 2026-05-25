/**
 * Parse tenant selection when multiple related tickets were offered.
 */
const { intakeExplicitNewTicketMarkers } = require("../../brain/core/intakeAttachClassify");

/**
 * @param {string} bodyText
 * @param {object[] | undefined} candidates
 * @returns {object | null}
 */
function parseRelatedTicketSelection(bodyText, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return null;

  const raw = String(bodyText || "").trim();
  if (!raw) return null;

  if (intakeExplicitNewTicketMarkers(raw)) return null;
  if (/\b(new issue|different issue|separate issue|something else)\b/i.test(raw)) {
    return null;
  }

  const compact = raw.toLowerCase();

  for (const t of list) {
    const tid = String(t.ticket_id || "").trim();
    const tkey = String(t.ticket_key || "").trim();
    if (tid && compact.includes(tid.toLowerCase())) return t;
    if (tkey && compact.includes(tkey.toLowerCase())) return t;
  }

  const numMatch = compact.match(/^(\d)\b/);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    if (idx >= 0 && idx < list.length) return list[idx];
  }

  return null;
}

module.exports = { parseRelatedTicketSelection };
