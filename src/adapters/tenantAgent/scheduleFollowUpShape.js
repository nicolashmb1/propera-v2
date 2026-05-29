/**
 * Structural detection of visit-window text — shape of data, not phrase routing.
 */
const { hasProblemSignal } = require("../../brain/core/splitIssueGroups");
const { parsePreferredWindowShared } = require("../../brain/gas/parsePreferredWindowShared");
const { isScheduleOnlyReply } = require("./mergeScheduleSlotFromInbound");

const TIME_RANGE_LEAD_RE =
  /^\d{1,2}\s*(?:[-–—]|to)\s*\d{1,2}(?:\s*(?:am|pm|a\.m\.|p\.m\.))?/i;

const TIME_RANGE_ANYWHERE_RE =
  /\b\d{1,2}\s*(?:[-–—]|to)\s*\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)\b/i;

/**
 * Leading token looks like a clock window (e.g. "9-10 brow"), not a unit label.
 * @param {string} body
 * @returns {boolean}
 */
function bodyHasTimeWindowShape(body) {
  const s = String(body || "").trim();
  if (!s) return false;
  if (TIME_RANGE_LEAD_RE.test(s)) return true;
  if (TIME_RANGE_ANYWHERE_RE.test(s)) return true;
  return false;
}

/**
 * @param {string} body
 * @returns {boolean}
 */
function bodyLooksLikeUnitOnly(body) {
  const s = String(body || "").trim();
  if (!s || bodyHasTimeWindowShape(s)) return false;
  return /^(?:#|unit|apt|apartment)\s*\d{1,4}[a-z]?$/i.test(s) || /^\d{1,4}[a-z]?$/i.test(s);
}

/**
 * @param {string} bodyText
 * @returns {boolean}
 */
function isScheduleFollowUpContent(bodyText) {
  const body = String(bodyText || "").trim();
  if (body.length < 2 || body.length > 160) return false;
  if (bodyHasTimeWindowShape(body)) return true;
  if (isScheduleOnlyReply(body)) return true;
  if (hasProblemSignal(body) && !/\b(morning|afternoon|evening|tomorrow|today|am|pm)\b/i.test(body)) {
    return false;
  }
  try {
    const d = parsePreferredWindowShared(body, null, {});
    return !!(d && (d.label || d.start || d.end));
  } catch (_) {
    return false;
  }
}

module.exports = {
  bodyHasTimeWindowShape,
  bodyLooksLikeUnitOnly,
  isScheduleFollowUpContent,
};
