/**
 * Adapter conversation status helpers — complete = ticket exists, follow-up rules apply.
 */

const STATUS_COMPLETE = new Set(["handoff_done", "complete"]);

/**
 * @param {object | null | undefined} conv
 * @returns {boolean}
 */
function isConversationComplete(conv) {
  const s = String(conv && conv.status ? conv.status : "")
    .trim()
    .toLowerCase();
  return STATUS_COMPLETE.has(s);
}

module.exports = {
  isConversationComplete,
  STATUS_COMPLETE,
};
