/**
 * GAS ports — do not reimplement behavior here.
 * - `escRe_`, `isAddressInContext_`: `14_DIRECTORY_SESSION_DAL.gs` ~1101, ~2211
 * - `isBlockedAsAddress_`: `16_ROUTER_ENGINE.gs` ~2449 (list from `PROPERTY_ADDRESSES`)
 */
const { getPropertyAddresses } = require("../../config/propertyAddresses");

function escRe_(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} text
 * @param {{ num: string, hints?: string[], suffixes?: string[] }} addr
 */
function isAddressInContext_(text, addr) {
  const t = String(text || "").toLowerCase();
  const num = String(addr.num);

  if (!new RegExp("\\b" + num + "\\b").test(t)) return false;

  for (let i = 0; i < (addr.hints || []).length; i++) {
    const h = String(addr.hints[i]).toLowerCase();
    const re1 = new RegExp(
      "\\b" + num + "\\b(?:\\s+\\w+){0,3}\\s+" + escRe_(h) + "\\b",
      "i"
    );
    const re2 = new RegExp(
      "\\b" + escRe_(h) + "\\b(?:\\s+\\w+){0,3}\\s+\\b" + num + "\\b",
      "i"
    );
    if (re1.test(t) || re2.test(t)) return true;
  }

  for (let j = 0; j < (addr.suffixes || []).length; j++) {
    const suf = String(addr.suffixes[j]).toLowerCase();
    const reS = new RegExp(
      "\\b" + num + "\\b(?:\\s+\\w+){0,2}\\s+\\b" + escRe_(suf) + "\\b",
      "i"
    );
    if (reS.test(t)) return true;
  }

  return false;
}

/**
 * @param {string} text
 * @param {string} numCandidate
 */
function isBlockedAsAddress_(text, numCandidate) {
  const cand = String(numCandidate || "").trim();
  if (!cand) return false;

  const list = getPropertyAddresses();

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (String(a && a.num || "") === cand && isAddressInContext_(text, a)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  escRe_,
  isAddressInContext_,
  isBlockedAsAddress_,
};
