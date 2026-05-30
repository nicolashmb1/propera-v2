/**
 * Availability-only vendor SMS (no YES prefix) — port of GAS extractVendorAvailabilityText_.
 * @see propera-gas-reference/26_VENDOR_ENGINE.gs
 */

/**
 * @param {string} s
 * @returns {string} original-casing availability text, or ""
 */
function extractVendorAvailabilityText(s) {
  const t = String(s || "").trim();
  if (!t) return "";

  const x = t.replace(/[–—]/g, "-").toLowerCase();

  const hasDay =
    /\b(today|tomorrow|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/.test(
      x
    );

  const hasPart = /\b(morning|afternoon|evening)\b/.test(x);

  const hasTime =
    /\b\d{1,2}(:\d{2})?\s?(am|pm)?\s?-\s?\d{1,2}(:\d{2})?\s?(am|pm)?\b/.test(x) ||
    /\b\d{1,2}:\d{2}\s?(am|pm)\b/.test(x) ||
    /\b\d{1,2}\s?(am|pm)\b/.test(x);

  return hasDay && (hasTime || hasPart) ? t : "";
}

module.exports = {
  extractVendorAvailabilityText,
};
