/**
 * Conservative property resolution for tenant agent gather — never guess among multiple matches.
 */
const {
  phraseInNormalizedText,
  resolvePropertyFromTextStrict,
} = require("../../brain/staff/lifecycleExtract");

/**
 * @param {string} text
 * @returns {string}
 */
function normalizePropText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
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
 * @param {object} row
 * @returns {string}
 */
function propertyDisplayLabel(row) {
  return (
    String(row.display_name || "").trim() ||
    String(row.display_name_short || "").trim() ||
    String(row.short_name || "").trim() ||
    String(row.code || "").trim()
  );
}

/**
 * @param {object} row
 * @returns {string}
 */
function propertyCodeUpper(row) {
  return String(row.code || "")
    .trim()
    .toUpperCase();
}

/**
 * @param {object} row
 * @returns {{ property_code: string, display_name: string }}
 */
function candidateFromRow(row) {
  const property_code = propertyCodeUpper(row);
  return {
    property_code,
    display_name: propertyDisplayLabel(row) || property_code,
  };
}

/**
 * @param {string} text
 * @param {object[]} propertiesList
 * @returns {Map<string, { property_code: string, display_name: string }>}
 */
function stripPropertyLeadIns(text) {
  let t = normalizePropText(text);
  for (let i = 0; i < 4 && t; i++) {
    const next = t.replace(/^(?:for|at|from|in|the|it(?:'s| is)?|this is)\s+/, "").trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Bare shared brand token fallback — matches properties whose display name contains the token.
 * DB-driven: no hardcoded property names. Used when a short token matches multiple properties.
 * @param {string} text
 * @param {object[]} propertiesList
 * @returns {Map<string, { property_code: string, display_name: string }>}
 */
function collectBrandTokenCandidates(text, propertiesList) {
  const matched = new Map();
  const t = stripPropertyLeadIns(text);
  if (!t || t.length < 3) return matched;

  const props = Array.isArray(propertiesList) ? propertiesList : [];
  const tokens = t.split(" ").filter((tok) => tok.length >= 3);
  for (const tok of tokens) {
    for (const row of props) {
      const label = normalizePropText(propertyDisplayLabel(row));
      if (label.includes(tok)) {
        const code = propertyCodeUpper(row);
        if (code) matched.set(code, candidateFromRow(row));
      }
    }
  }
  return matched;
}

// Keep backward-compatible alias
const collectGrandBrandCandidates = collectBrandTokenCandidates;

function collectPropertyCandidates(text, propertiesList) {
  const t = normalizePropText(text);
  const matched = new Map();
  if (!t) return matched;

  const props = Array.isArray(propertiesList) ? propertiesList : [];

  for (const row of props) {
    const code = propertyCodeUpper(row);
    if (!code) continue;
    const cand = candidateFromRow(row);
    const dn = normalizePropText(row.display_name);
    const sn = normalizePropText(row.short_name);
    const dns = normalizePropText(row.display_name_short);
    const codeNorm = normalizePropText(code);

    if (codeNorm && (t === codeNorm || phraseInNormalizedText(t, codeNorm))) {
      matched.set(code, cand);
      continue;
    }
    if (dns && (t === dns || phraseInNormalizedText(t, dns))) {
      matched.set(code, cand);
      continue;
    }
    if (sn && (t === sn || phraseInNormalizedText(t, sn))) {
      matched.set(code, cand);
      continue;
    }
    if (dn && (t === dn || phraseInNormalizedText(t, dn))) {
      matched.set(code, cand);
      continue;
    }
    if (dn && t.length >= 3 && phraseInNormalizedText(dn, t)) {
      matched.set(code, cand);
    }
  }

  const strict = resolvePropertyFromTextStrict(text, props);
  if (strict && strict.code) {
    const row = props.find((p) => propertyCodeUpper(p) === strict.code);
    if (row) matched.set(strict.code, candidateFromRow(row));
  }

  if (!matched.size) {
    for (const [code, cand] of collectBrandTokenCandidates(text, props)) {
      matched.set(code, cand);
    }
  }

  const stripped = stripPropertyLeadIns(text);
  if (stripped && stripped !== t) {
    for (const row of props) {
      const code = propertyCodeUpper(row);
      if (!code) continue;
      const cand = candidateFromRow(row);
      const dn = normalizePropText(row.display_name);
      if (dn && (stripped === dn || phraseInNormalizedText(stripped, dn))) {
        matched.set(code, cand);
      }
    }
  }

  const tokens = t.split(" ").filter((tok) => tok.length >= 3);
  for (const tok of tokens) {
    for (const row of props) {
      const code = propertyCodeUpper(row);
      const targets = [
        normalizePropText(row.display_name_short),
        normalizePropText(row.short_name),
        normalizePropText(code),
      ].filter(Boolean);
      for (const target of targets) {
        if (tok === target || (target.length >= 3 && levenshtein(tok, target) === 1)) {
          matched.set(code, candidateFromRow(row));
        }
      }
    }
  }

  return matched;
}

/**
 * @param {string} body
 * @param {object[]} [propertiesList] — active properties from DB; used to avoid hardcoding names
 * @returns {boolean}
 */
function bodyHasPropertyIntent(body, propertiesList) {
  const s = String(body || "").trim();
  if (!s) return false;
  if (/^\d{1,4}[a-z]?$/i.test(s)) return false;
  if (/\b(?:wrong|instead|rather)\b/i.test(s)) return true;
  if (/\b(building|property|location)\b/i.test(s)) return true;
  if (
    /^(asap|today|tomorrow|anytime|flexible|morning|afternoon|evening|weekend)\b/i.test(s)
  ) return false;
  if (/\b(tomorrow|today)\s+(morning|afternoon|evening)\b/i.test(s)) return false;
  if (/\bafter\s+\d/i.test(s)) return false;

  // DB-driven: check if any property name/code/alias appears in text
  const props = Array.isArray(propertiesList) ? propertiesList : [];
  if (props.length) {
    const norm = normalizePropText(s);
    for (const p of props) {
      const targets = [
        normalizePropText(p.code),
        normalizePropText(p.display_name),
        normalizePropText(p.short_name),
        normalizePropText(p.display_name_short),
      ].filter(Boolean);
      for (const t of targets) {
        if (t.length >= 3 && (norm === t || norm.includes(t) || t.includes(norm))) return true;
      }
    }
    return false;
  }

  // Fallback when no properties list provided (keeps existing behavior for callers that don't pass it)
  return false;
}

/**
 * @param {string} text
 * @param {Array<{ property_code: string, display_name: string }>} candidates
 * @returns {Array<{ property_code: string, display_name: string }>}
 */
function applyPropertyNegations(text, candidates) {
  let out = candidates.slice();
  const s = String(text || "");
  for (const c of candidates) {
    const code = String(c.property_code || "").trim();
    const short = String(c.display_name || "").trim();
    if (!code) continue;
    if (new RegExp(`\\bnot\\s+${code}\\b`, "i").test(s)) {
      out = out.filter((x) => x.property_code !== c.property_code);
      continue;
    }
    if (short && new RegExp(`\\bnot\\s+${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s)) {
      out = out.filter((x) => x.property_code !== c.property_code);
    }
  }
  return out;
}

/**
 * @param {string} text
 * @param {Array<{ property_code: string, display_name: string }>} candidates
 * @param {object[]} propertiesList
 * @returns {Array<{ property_code: string, display_name: string }>}
 */
function narrowCandidatesByDiscriminator(text, candidates, propertiesList) {
  if (candidates.length <= 1) return candidates;
  const STOP = { grand: 1, the: 1, at: 1, not: 1 };
  const tokens = normalizePropText(text)
    .split(" ")
    .filter((tok) => tok.length >= 3 && !STOP[tok]);
  if (!tokens.length) return candidates;

  const narrowed = candidates.filter((c) => {
    const row = (propertiesList || []).find(
      (p) => propertyCodeUpper(p) === c.property_code
    );
    if (!row) return false;
    const targets = [
      normalizePropText(row.display_name_short),
      normalizePropText(row.short_name),
      normalizePropText(row.code),
      normalizePropText(row.display_name),
    ].filter(Boolean);
    return tokens.some((tok) =>
      targets.some(
        (target) => tok === target || (target.length >= 3 && levenshtein(tok, target) === 1)
      )
    );
  });
  return narrowed.length ? narrowed : candidates;
}

/**
 * @param {string} text
 * @param {object[]} propertiesList
 * @param {Set<string>} [_knownUpper]
 * @returns {{
 *   status: 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED',
 *   property_code: string | null,
 *   confidence: number,
 *   candidates: Array<{ property_code: string, display_name: string }>,
 *   reason: string,
 * }}
 */
function resolvePropertyForGather(text, propertiesList, _knownUpper) {
  void _knownUpper;
  let candidates = Array.from(collectPropertyCandidates(text, propertiesList).values());
  candidates = applyPropertyNegations(text, candidates);
  candidates = narrowCandidatesByDiscriminator(text, candidates, propertiesList);

  if (candidates.length === 1) {
    return {
      status: "RESOLVED",
      property_code: candidates[0].property_code,
      confidence: 0.96,
      candidates,
      reason: "single_match",
    };
  }
  if (candidates.length > 1) {
    return {
      status: "AMBIGUOUS",
      property_code: null,
      confidence: 0.55,
      candidates,
      reason: "multiple_matches",
    };
  }
  return {
    status: "UNRESOLVED",
    property_code: null,
    confidence: 0,
    candidates: [],
    reason: "no_match",
  };
}

module.exports = {
  resolvePropertyForGather,
  collectPropertyCandidates,
  collectGrandBrandCandidates,
  bodyHasPropertyIntent,
  propertyDisplayLabel,
  normalizePropText,
  stripPropertyLeadIns,
};
