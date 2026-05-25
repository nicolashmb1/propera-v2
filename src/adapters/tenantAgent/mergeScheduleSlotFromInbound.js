/**
 * Pull visit-window text into preferredWindow — adapter slot merge (deterministic parse often leaves it in issue).
 */
const { MIN_SCHEDULE_LEN } = require("../../dal/ticketPreferredWindow");
const { hasProblemSignal } = require("../../brain/core/splitIssueGroups");
const { getGatherSafety } = require("./detectGatherSafety");

const SCHEDULE_ONLY_RE =
  /^(asap|today|tomorrow|anytime|flexible|morning|afternoon|evening|weekend)(?:\s|$)|\b(tomorrow|today)\s+(morning|afternoon|evening)\b|\b\d{1,2}\s*(?:am|pm)\b/i;

/**
 * @param {string} bodyText
 * @returns {boolean}
 */
function isScheduleOnlyReply(bodyText) {
  const s = String(bodyText || "").trim();
  if (s.length < MIN_SCHEDULE_LEN || s.length > 80) return false;
  if (hasProblemSignal(s) && !SCHEDULE_ONLY_RE.test(s)) return false;
  return SCHEDULE_ONLY_RE.test(s);
}

/**
 * @param {object} partial
 * @param {string} bodyText
 * @returns {object}
 */
function mergeScheduleSlotFromInbound(partial, bodyText) {
  const next = { ...(partial || {}) };
  if (String(next.location_kind || "").trim().toLowerCase() === "common_area") {
    delete next.preferredWindow;
    delete next.preferred_window;
    return next;
  }
  if (getGatherSafety(next)?.skipScheduling) {
    delete next.preferredWindow;
    delete next.preferred_window;
    delete next._schedule_retry_pending;
    return next;
  }
  const body = String(bodyText || "").trim();
  const retryPending = !!next._schedule_retry_pending;

  if (
    !retryPending &&
    String(next.preferredWindow || "").trim().length >= MIN_SCHEDULE_LEN
  ) {
    return next;
  }

  const preferredLine = body.match(/(?:^|\n)\s*preferred:\s*(.+?)\s*$/im);
  if (preferredLine && String(preferredLine[1]).trim().length >= MIN_SCHEDULE_LEN) {
    next.preferredWindow = String(preferredLine[1]).trim();
    delete next._schedule_retry_pending;
  } else if (isScheduleOnlyReply(body) || retryPending) {
    if (body.length >= MIN_SCHEDULE_LEN) {
      next.preferredWindow = body;
      delete next._schedule_retry_pending;
    }
  }

  let issue = String(next.issue || "").trim();
  if (issue) {
    const embeddedPreferred = issue.match(/\.\s*preferred:\s*(.+)$/i);
    if (embeddedPreferred) {
      if (!next.preferredWindow) {
        next.preferredWindow = String(embeddedPreferred[1]).trim();
      }
      issue = issue.replace(/\.\s*preferred:\s*.+$/i, "").trim();
    }
    const trailingAsap = issue.match(/^(.+?)\s+(asap)\.?$/i);
    if (trailingAsap) {
      if (!next.preferredWindow) next.preferredWindow = "ASAP";
      issue = String(trailingAsap[1]).trim();
    }
    next.issue = issue;
  }

  return next;
}

module.exports = {
  mergeScheduleSlotFromInbound,
  isScheduleOnlyReply,
};
