/**
 * Port of GAS `extractUnit_` — `17_PROPERTY_SCHEDULE_ENGINE.gs` ~2260–2318.
 * `isBlockedAsAddress_` is the GAS port in `../gas/addressContext.js` (`16_ROUTER_ENGINE.gs` ~2449).
 */
const { isBlockedAsAddress_ } = require("../gas/addressContext");

/**
 * @param {string} text
 * @returns {string} digits-only unit or ""
 */
function extractUnit(text) {
  const t = String(text || "");

  function accept_(u) {
    const num = String(u || "").trim();
    if (!/^\d{1,5}$/.test(num)) return "";

    try {
      const uEsc = String(num).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (
        new RegExp(
          "\\b(?:from|at|in|for)\\s*" +
            uEsc +
            "\\s*(?:-|–)\\s*\\d{1,2}\\s*(?:am|pm)\\b",
          "i"
        ).test(t) ||
        new RegExp(
          "\\b" + uEsc + "\\s*(?:-|–)\\s*\\d{1,2}\\s*(?:am|pm)\\b",
          "i"
        ).test(t) ||
        new RegExp(
          "\\b(?:from|at|in|for)\\s*" + uEsc + "\\s*(?:am|pm)\\b",
          "i"
        ).test(t) ||
        new RegExp("\\b" + uEsc + "\\s*(?:am|pm)\\b", "i").test(t) ||
        new RegExp("\\b" + uEsc + "\\b.{0,10}\\b(?:am|pm)\\b", "i").test(t)
      ) {
        return "";
      }
    } catch (_) {}

    if (isBlockedAsAddress_(t, num)) return "";
    if (/^20\d{2}$/.test(num)) return "";
    if (/^\d{5}$/.test(num)) return "";
    return num;
  }

  let m = t.match(
    /\b(?:unit|apt|apartment|suite|ste|rm|room)\.?\s*[:#-]?\s*(\d{1,5})\b/i
  );
  if (m && m[1]) {
    const u = accept_(m[1]);
    if (u) return u;
  }

  m = t.match(/#\s*(\d{1,5})\b/);
  if (m && m[1]) {
    const u = accept_(m[1]);
    if (u) return u;
  }

  m = t.match(/\b(?:for|at|in|from)\s+(\d{1,5})\b/i);
  if (m && m[1]) {
    const u = accept_(m[1]);
    if (u) return u;
  }

  const nums = t.match(/\b\d{2,5}\b/g) || [];
  for (let i = nums.length - 1; i >= 0; i--) {
    const u = accept_(nums[i]);
    if (u) return u;
  }

  return "";
}

module.exports = { extractUnit, isBlockedAsAddress_ };
