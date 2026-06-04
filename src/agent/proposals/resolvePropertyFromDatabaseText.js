/**
 * DB-driven property match from spoken address / street number (no hardcoded names).
 * Uses `properties.address` (+ code, display names via gather) from listPropertiesForMenu.
 */

const { resolvePropertyForGather, normalizePropText } = require("../../adapters/tenantAgent/resolvePropertyForGather");

/**
 * @param {string} a
 * @param {string} b
 */
function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (s === t) return 0;
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * @param {string} address
 */
function streetNumberFromAddress(address) {
  const m = normalizePropText(address).match(/^(\d{1,5})\b/);
  return m ? m[1] : "";
}

/**
 * @param {string} address
 */
function streetTokensFromAddress(address) {
  return normalizePropText(address)
    .split(" ")
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t));
}

/**
 * @param {string} token
 * @param {string} speechNorm
 */
function streetTokenInSpeech(token, speechNorm) {
  const tok = String(token || "").trim();
  if (!tok || !speechNorm) return false;
  if (speechNorm.includes(tok)) return true;
  if (tok.length >= 4 && speechNorm.includes(tok.slice(0, 4))) return true;
  const words = speechNorm.split(" ").filter((w) => w.length >= 3);
  for (const w of words) {
    if (tok.startsWith(w) && w.length >= 3) return true;
    if (tok.length >= 5 && w.length >= 4 && levenshtein(w, tok) <= 2) return true;
  }
  return false;
}

/**
 * @param {string} text
 * @param {object} row
 */
function scoreAddressMatch(text, row) {
  const speech = normalizePropText(text);
  const addr = String(row.address || "").trim();
  if (!speech || !addr) return 0;

  const num = streetNumberFromAddress(addr);
  const tokens = streetTokensFromAddress(addr);
  let score = 0;

  const hasNum = num && new RegExp(`\\b${num}\\b`).test(speech);
  if (hasNum) score += 12;

  let tokenHits = 0;
  for (const tok of tokens) {
    if (streetTokenInSpeech(tok, speech)) tokenHits += 1;
  }
  score += tokenHits * 6;

  if (hasNum && tokenHits === 0) score += 4;

  return score;
}

/**
 * @param {string} text
 * @param {object[]} propertiesList
 * @returns {{
 *   status: 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED',
 *   property_code: string | null,
 *   candidates: Array<{ property_code: string, display_name: string, address?: string }>,
 *   reason: string,
 * }}
 */
function resolvePropertyByAddressHint(text, propertiesList) {
  const list = Array.isArray(propertiesList) ? propertiesList : [];
  const speech = normalizePropText(text);
  if (!speech) {
    return { status: "UNRESOLVED", property_code: null, candidates: [], reason: "empty" };
  }

  const scored = [];
  for (const row of list) {
    const code = String(row.code || "").trim().toUpperCase();
    if (!code || code === "GLOBAL") continue;
    const score = scoreAddressMatch(text, row);
    if (score <= 0) continue;
    scored.push({
      score,
      property_code: code,
      display_name:
        String(row.display_name || row.display_name_short || row.short_name || code).trim() ||
        code,
      address: String(row.address || "").trim(),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) {
    return { status: "UNRESOLVED", property_code: null, candidates: [], reason: "no_address_match" };
  }

  const top = scored[0];
  const nearTop = scored.filter((s) => s.score >= top.score - 2);
  if (nearTop.length === 1 || top.score >= (nearTop[1]?.score || 0) + 4) {
    return {
      status: "RESOLVED",
      property_code: top.property_code,
      candidates: nearTop,
      reason: "address_match",
    };
  }

  return {
    status: "AMBIGUOUS",
    property_code: null,
    candidates: nearTop.slice(0, 4),
    reason: "multiple_address_matches",
  };
}

/**
 * Full DB-driven resolution: code/name (gather) then address.
 * @param {string} text
 * @param {object[]} propertiesList
 * @param {Set<string>} knownUpper
 */
function resolvePropertyFromDatabaseText(text, propertiesList, knownUpper) {
  const raw = String(text || "").trim();
  if (!raw) {
    return { status: "UNRESOLVED", property_code: null, candidates: [], reason: "empty" };
  }

  const gathered = resolvePropertyForGather(raw, propertiesList, knownUpper);
  if (gathered.status === "RESOLVED" && gathered.property_code) {
    return { ...gathered, reason: gathered.reason || "gather" };
  }
  if (gathered.status === "AMBIGUOUS") {
    return gathered;
  }

  const byAddr = resolvePropertyByAddressHint(raw, propertiesList);
  if (byAddr.status === "RESOLVED" || byAddr.status === "AMBIGUOUS") {
    return byAddr;
  }

  return { status: "UNRESOLVED", property_code: null, candidates: [], reason: "no_match" };
}

/**
 * Compact roster for Jarvis session prompt (from DB rows only).
 * @param {object[]} propertiesList
 */
function formatPropertyCatalogForJarvis(propertiesList) {
  const list = Array.isArray(propertiesList) ? propertiesList : [];
  const lines = list
    .filter((p) => String(p.code || "").trim().toUpperCase() !== "GLOBAL")
    .map((p) => {
      const code = String(p.code || "").trim().toUpperCase();
      const name = String(p.display_name_short || p.short_name || p.display_name || code).trim();
      const addr = String(p.address || "").trim();
      return addr ? `${code} (${name}) — ${addr}` : `${code} (${name})`;
    });
  if (!lines.length) return "";
  return "Properties (database): " + lines.join("; ");
}

module.exports = {
  resolvePropertyByAddressHint,
  resolvePropertyFromDatabaseText,
  formatPropertyCatalogForJarvis,
  scoreAddressMatch,
  streetNumberFromAddress,
};
