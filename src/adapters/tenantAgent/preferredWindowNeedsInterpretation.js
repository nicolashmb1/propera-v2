/**
 * When tenant schedule text needs LLM interpretation (negation, contrast, multiple times).
 * Shape/complexity only — not conversational phrase routing.
 */

/**
 * @param {string} text
 * @returns {boolean}
 */
function needsPreferredWindowInterpretation(text) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return false;

  if (/\b(?:best time|better time|works best|preferred time)\b/.test(s)) return true;
  if (/\b(?:instead|rather|not before|not after)\b/.test(s)) return true;
  if (
    /\b(?:before|after)\b/.test(s) &&
    /\b(?:no good|not good|won't work|doesn't work|does not work|not ok|not okay|can't|cannot)\b/.test(
      s
    )
  ) {
    return true;
  }

  const clockMentions = s.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/g);
  if (clockMentions && clockMentions.length >= 2) return true;

  return false;
}

module.exports = {
  needsPreferredWindowInterpretation,
};
