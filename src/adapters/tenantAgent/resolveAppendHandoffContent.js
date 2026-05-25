/**
 * Build brain append payload from pending follow-up + confirmation reply.
 * Confirmation phrases ("yep same", "same one") must never become the ticket note.
 */

const CONFIRM_ONLY_RE =
  /^(yes|yeah|yep|yup|yea|ok|okay|sure|correct|right|same|same one|same issue|yes same|yep same|yeah same|same request|same ticket|existing|that one|the same|this one|original|one|1|two|2|no|nope|nah)(\s+(issue|one|request|ticket|please|thanks|thank you))?\.?$/i;

/**
 * @param {string} text
 * @returns {boolean}
 */
function isSameOrNewConfirmationOnly(text) {
  const raw = String(text || "").trim();
  if (!raw) return true;
  return CONFIRM_ONLY_RE.test(raw.replace(/\s+/g, " ").trim());
}

/**
 * Remove leading confirmation boilerplate; return substantive tail if any.
 * @param {string} text
 * @returns {string}
 */
function stripSameOrNewConfirmation(text) {
  let s = String(text || "").trim();
  if (!s) return "";

  const patterns = [
    /^(yes|yeah|yep|yup)\s+same(\s+(issue|one|request|ticket))?[,.\s-]*/i,
    /^(same one|same issue|same request|same ticket|same problem|same thing)[,.\s-]*/i,
    /^(it'?s|that'?s)\s+the\s+same(\s+(one|issue|request|ticket))?[,.\s-]*/i,
    /^(add|attach)\s+(this|it)\s+(to\s+)?(that|the|my)(\s+(one|request|ticket))?[,.\s-]*/i,
    /^(yes|yeah|yep|yup|yea|ok|okay|sure|correct|right)[,.\s-]+(?!same\b)/i,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const re of patterns) {
      const next = s.replace(re, "").trim();
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
  }

  s = s.replace(/^[,.\s-]+/, "").trim();
  if (!s || isSameOrNewConfirmationOnly(s)) return "";
  return s;
}

/**
 * @param {object} o
 * @param {object} [o.pending]
 * @param {string} [o.confirmBodyText]
 * @param {string} [o.confirmMediaJson]
 * @param {string} [o.llmAppendNote]
 * @returns {{ message: string, mediaJson: string }}
 */
function resolveAppendHandoffContent(o) {
  const pending = o.pending && typeof o.pending === "object" ? o.pending : {};
  const confirmBodyText = String(o.confirmBodyText || "").trim();
  const pendingBody = String(pending.bodyText || "").trim();
  const mediaJson = String(pending.mediaJson || o.confirmMediaJson || "").trim();
  const llmNote = String(o.llmAppendNote || "").trim();

  /** @type {string[]} */
  const parts = [];

  if (pendingBody && !isSameOrNewConfirmationOnly(pendingBody)) {
    parts.push(pendingBody);
  }

  const strippedConfirm = stripSameOrNewConfirmation(confirmBodyText);
  if (
    strippedConfirm &&
    !isSameOrNewConfirmationOnly(strippedConfirm) &&
    !parts.some((p) => p.toLowerCase() === strippedConfirm.toLowerCase())
  ) {
    parts.push(strippedConfirm);
  }

  if (
    llmNote &&
    !isSameOrNewConfirmationOnly(llmNote) &&
    !parts.some((p) => p.toLowerCase() === llmNote.toLowerCase())
  ) {
    parts.push(llmNote);
  }

  let message = parts.join(". ").replace(/\.\s*\./g, ".").trim();

  if (isSameOrNewConfirmationOnly(message)) {
    message = "";
  }

  return { message, mediaJson };
}

module.exports = {
  isSameOrNewConfirmationOnly,
  stripSameOrNewConfirmation,
  resolveAppendHandoffContent,
};
