/**
 * Text extraction for staff target resolution — ported from 25_STAFF_RESOLVER.gs
 *
 * **Unit:** delegates to GAS `extractUnit_` port — `src/brain/shared/extractUnitGas.js`
 * (`17_PROPERTY_SCHEDULE_ENGINE.gs` ~2260). Do not reintroduce ad-hoc regex here.
 */
const { extractUnit } = require("../shared/extractUnitGas");

function extractUnitFromBody(body) {
  return extractUnit(body);
}

function normalizePropText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCommonBuildingWords(text) {
  return String(text || "")
    .replace(/\b(the|at|apartments?|apt|residences?|building|tower|complex|homes?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPropertyVariantSet(prop) {
  const out = new Set();
  const code = String(prop && prop.code ? prop.code : "")
    .trim()
    .toUpperCase();
  const displayName = String(prop && prop.display_name ? prop.display_name : "").trim();
  const ticketPrefix = String(prop && prop.ticket_prefix ? prop.ticket_prefix : "").trim();
  const shortName = String(prop && prop.short_name ? prop.short_name : "").trim();
  const address = String(prop && prop.address ? prop.address : "").trim();
  if (code) out.add(code);
  if (displayName) out.add(displayName);
  if (ticketPrefix) out.add(ticketPrefix);
  if (shortName) out.add(shortName);
  if (address) out.add(address);
  const stripped = stripCommonBuildingWords(normalizePropText(displayName));
  if (stripped) out.add(stripped);
  const lastWord = stripped.split(" ").slice(-1)[0] || "";
  if (lastWord) out.add(lastWord);
  const addressTokens = normalizePropText(address).split(" ").filter(Boolean);
  for (const tok of addressTokens) out.add(tok);
  const aliases = Array.isArray(prop && prop.aliases) ? prop.aliases : [];
  for (const a of aliases) {
    const alias = String(a || "").trim();
    if (alias) out.add(alias);
  }
  return out;
}

/**
 * GAS `resolvePropertyExplicitOnly_` parity slice:
 * - exact code token or exact normalized variant only
 * - no fuzzy / no broad contains
 *
 * @param {string} text
 * @param {Array<{ code: string, display_name?: string, ticket_prefix?: string, short_name?: string, address?: string, aliases?: string[] }>} propertiesList
 * @returns {string}
 */
function resolvePropertyExplicitOnly(text, propertiesList) {
  const t = normalizePropText(text);
  if (!t) return "";
  const props = Array.isArray(propertiesList) ? propertiesList : [];
  for (const p of props) {
    const code = String(p && p.code ? p.code : "")
      .trim()
      .toUpperCase();
    if (!code) continue;
    const codeNorm = normalizePropText(code);
    if (codeNorm && t === codeNorm) return code;
    const variants = Array.from(
      buildPropertyVariantSet({
        code,
        display_name: p && p.display_name ? p.display_name : "",
        ticket_prefix: p && p.ticket_prefix ? p.ticket_prefix : "",
        short_name: p && p.short_name ? p.short_name : "",
        address: p && p.address ? p.address : "",
        aliases: Array.isArray(p && p.aliases) ? p.aliases : [],
      })
    )
      .map((v) => normalizePropText(v))
      .filter(Boolean);
    for (const v of variants) {
      if (t === v) return code;
    }
  }
  return "";
}

/**
 * GAS parity slice for detectPropertyFromBody_:
 * 1) standalone menu digit
 * 2) code/compact token match
 * 3) strong-name token contains (stopwords filtered)
 *
 * @param {string} body
 * @param {Array<{ code: string, display_name?: string, ticket_prefix?: string, short_name?: string, address?: string, aliases?: string[] }>} propertiesList
 * @param {Set<string>} [knownUpper]
 * @returns {string}
 */
function detectPropertyFromBody(body, propertiesList, knownUpper) {
  const raw = String(body || "");
  const t = normalizePropText(raw);
  if (!t) return "";

  const props = Array.isArray(propertiesList)
    ? propertiesList
        .map((p) => ({
          code: String(p && p.code ? p.code : "")
            .trim()
            .toUpperCase(),
          display_name: String(p && p.display_name ? p.display_name : "").trim(),
          ticket_prefix: String(p && p.ticket_prefix ? p.ticket_prefix : "").trim(),
          short_name: String(p && p.short_name ? p.short_name : "").trim(),
          address: String(p && p.address ? p.address : "").trim(),
          aliases: Array.isArray(p && p.aliases) ? p.aliases : [],
        }))
        .filter((p) => p.code)
    : [];

  const tokens = t.split(" ").filter(Boolean);
  /** GAS `detectPropertyFromBody_`: menu digit `[1-5]` only */
  const digit = tokens.find((x) => /^[1-5]$/.test(x));
  if (digit && props.length) {
    const idx = parseInt(digit, 10) - 1;
    if (idx >= 0 && idx < props.length) return props[idx].code;
  }

  const compact = t.replace(/\s+/g, "");
  /** GAS step 2: per-property `code` and `ticketPrefix` against compact text */
  for (const p of props) {
    const code = String(p.code || "")
      .toLowerCase()
      .replace(/\s/g, "");
    const ticketPrefix = String(p.ticket_prefix || "")
      .toLowerCase()
      .replace(/\s/g, "");
    if (code && (compact === code || compact.includes(code))) return p.code;
    if (ticketPrefix && (compact === ticketPrefix || compact.includes(ticketPrefix)))
      return p.code;
  }
  if (knownUpper && knownUpper.size) {
    for (const k of knownUpper) {
      const ku = String(k || "")
        .trim()
        .toUpperCase();
      const lc = String(k || "")
        .toLowerCase()
        .replace(/\s/g, "");
      if (!lc) continue;
      if (compact === lc || compact.includes(lc)) return ku;
    }
  }

  const STOP = {
    the: 1,
    grand: 1,
    at: 1,
    apt: 1,
    apartment: 1,
    unit: 1,
  };
  for (const p of props) {
    const variants = Array.from(buildPropertyVariantSet(p))
      .map((x) => normalizePropText(x))
      .filter(Boolean);
    for (const key of variants) {
      if (!key) continue;
      if (t === key) return p.code;
      const keyTokens = key.split(" ").filter(Boolean);
      const strongHit = keyTokens.some(
        (kt) => !STOP[kt] && kt.length >= 4 && t.includes(kt)
      );
      if (strongHit) return p.code;
    }
  }

  return "";
}

/**
 * Fallback when `propertiesList` is unavailable: `detectPropertyFromBody` with `knownUpper` only,
 * then regex heuristics for `CODE 12` / token patterns.
 *
 * @param {string} body
 * @param {Set<string>} knownUpper — property codes / tokens
 */
function extractPropertyHintFromBody(body, knownUpper) {
  const fromDetect = detectPropertyFromBody(body, [], knownUpper);
  if (fromDetect) return fromDetect;
  const t = String(body || "").trim();
  if (!knownUpper || knownUpper.size === 0) return "";

  let code;
  let m;
  const re1 = /\b([A-Za-z]{2,10})\s+[0-9]/g;
  while ((m = re1.exec(t)) !== null) {
    code = String(m[1] || "")
      .trim()
      .toUpperCase();
    if (knownUpper.has(code)) return code;
  }
  const re2 = /\b([0-9]+[a-z]?)\s+([A-Za-z]{2,10})\b/gi;
  while ((m = re2.exec(t)) !== null) {
    code = String(m[2] || "")
      .trim()
      .toUpperCase();
    if (knownUpper.has(code)) return code;
  }
  const re3 = /\b([A-Za-z]{2,10})\b/g;
  while ((m = re3.exec(t)) !== null) {
    code = String(m[1] || "")
      .trim()
      .toUpperCase();
    if (knownUpper.has(code)) return code;
  }
  return "";
}

function extractWorkItemIdHintFromBody(body) {
  const t = String(body || "").trim();
  const wiPrefix = t.match(/\b(WI_[a-zA-Z0-9]+)\b/i);
  if (wiPrefix) return String(wiPrefix[1] || "").trim();
  const suffix = t.match(/\b([a-zA-Z0-9]{8,})\b/);
  return suffix ? String(suffix[1] || "").trim() : "";
}

/** @see 25_STAFF_RESOLVER.gs staffEscapeRe_ */
function staffEscapeRe(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip property/unit prefixes so schedule text can be parsed alone.
 * @see 25_STAFF_RESOLVER.gs staffExtractScheduleRemainderFromTarget_
 */
function staffExtractScheduleRemainderFromTarget(bodyTrim, unitFromBody, propertyHint) {
  let remainder = String(bodyTrim || "").trim();
  if (!remainder) return "";
  if (propertyHint) {
    const reP0 = new RegExp(
      "^\\s*" + staffEscapeRe(propertyHint) + "\\b\\s*",
      "i"
    );
    remainder = remainder.replace(reP0, "");
  }
  if (unitFromBody) {
    const u = staffEscapeRe(unitFromBody);
    remainder = remainder.replace(
      new RegExp("^\\s*(?:unit|apt)\\s*[:\\s]*" + u + "\\b\\s*", "i"),
      ""
    );
    remainder = remainder.replace(
      new RegExp("^\\s*#\\s*" + u + "\\b\\s*", "i"),
      ""
    );
    remainder = remainder.replace(
      new RegExp("^\\s*no\\.?\\s*" + u + "\\b\\s*", "i"),
      ""
    );
    remainder = remainder.replace(new RegExp("^\\s*" + u + "\\b\\s*", "i"), "");
  }
  if (propertyHint) {
    const reP1 = new RegExp(
      "^\\s*" + staffEscapeRe(propertyHint) + "\\b\\s*",
      "i"
    );
    remainder = remainder.replace(reP1, "");
  }
  remainder = remainder.replace(/^[\s,:;\-]+/, "").trim();
  return remainder;
}

function issueLabelFromMetadata(metadataJson) {
  if (!metadataJson || typeof metadataJson !== "object") return "";
  const s = String(
    metadataJson.issueSummary ||
      metadataJson.issue ||
      metadataJson.title ||
      metadataJson.summary ||
      ""
  ).trim();
  return s.slice(0, 80).toLowerCase();
}

/** @see 25_STAFF_RESOLVER.gs STAFF_RESOLVER_SCORE_THRESHOLD_ / MARGIN_ */
const STAFF_RESOLVER_SCORE_THRESHOLD = 0.3;
const STAFF_RESOLVER_SCORE_MARGIN = 0.2;

/**
 * @see 25_STAFF_RESOLVER.gs extractIssueHintsForStaff_
 * @param {string} bodyTrim
 * @returns {{ fixtures: string[], modifiers: string[] }}
 */
function extractIssueHintsForStaff(bodyTrim) {
  const t = String(bodyTrim || "").toLowerCase();
  const fixtures = [];
  const modifiers = [];

  function addOnce(arr, val) {
    if (!val) return;
    if (arr.indexOf(val) >= 0) return;
    arr.push(val);
  }

  if (/\bsink\b/.test(t)) addOnce(fixtures, "SINK");
  if (/\b(fridge|refrigerator)\b/.test(t)) addOnce(fixtures, "REFRIGERATOR");
  if (/\btoilet\b/.test(t)) addOnce(fixtures, "TOILET");
  if (/\b(tub|bathtub)\b/.test(t)) addOnce(fixtures, "BATHTUB");
  if (/\bshower\b/.test(t)) addOnce(fixtures, "SHOWER");
  if (/\boutlet\b/.test(t)) addOnce(fixtures, "OUTLET");
  if (/\bwasher\b/.test(t)) addOnce(fixtures, "WASHER");
  if (/\bdryer\b/.test(t)) addOnce(fixtures, "DRYER");
  if (/\bstove|oven\b/.test(t)) addOnce(fixtures, "STOVE");

  if (/\bclogged\b/.test(t)) addOnce(modifiers, "CLOGGED");
  if (/\bleak(s|ing)?\b/.test(t)) addOnce(modifiers, "LEAKING");
  if (/\bnot working\b/.test(t)) addOnce(modifiers, "NOT_WORKING");
  if (/\bno (hot )?water\b/.test(t)) addOnce(modifiers, "NO_WATER");
  if (/\b(no heat|heat(ing)? isn'?t working)\b/.test(t)) addOnce(modifiers, "NO_HEAT");

  return { fixtures, modifiers };
}

/**
 * @see 25_STAFF_RESOLVER.gs scoreCandidatesByIssueHints_
 * @param {Array<{ workItemId: string, metadata_json?: object }>} candidates
 * @param {string} bodyTrim
 * @returns {{ best: object, bestScore?: number, secondScore?: number } | { tie: true }}
 */
function scoreCandidatesByIssueHints(candidates, bodyTrim) {
  const hints = extractIssueHintsForStaff(bodyTrim);
  const fixtures = hints.fixtures || [];
  const modifiers = hints.modifiers || [];
  if (fixtures.length === 0 && modifiers.length === 0) {
    return { tie: true };
  }
  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const label = issueLabelFromMetadata(c.metadata_json);
    let score = 0;
    for (let f = 0; f < fixtures.length; f++) {
      const token = String(fixtures[f]).toLowerCase();
      if (label.indexOf(token) >= 0) score += 0.4;
    }
    for (let m = 0; m < modifiers.length; m++) {
      const token = String(modifiers[m]).toLowerCase();
      if (label.indexOf(token) >= 0) score += 0.3;
    }
    scored.push({ candidate: c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored.length > 1 ? scored[1] : { score: 0 };
  if (
    best.score >= STAFF_RESOLVER_SCORE_THRESHOLD &&
    best.score - second.score >= STAFF_RESOLVER_SCORE_MARGIN
  ) {
    return {
      best: best.candidate,
      bestScore: best.score,
      secondScore: second.score,
    };
  }
  return { tie: true };
}

/**
 * @param {Array<{ workItemId: string, unitId?: string, propertyId?: string }>} candidates
 * @param {Array<{ metadata_json?: object }>} [fullRows] — parallel to candidates for labels
 */
function buildSuggestedPromptsForCandidates(candidates, fullRows) {
  const out = [];
  const seen = {};
  const limit = Math.min(candidates.length, 6);
  for (let i = 0; i < limit; i++) {
    const c = candidates[i];
    const unit = String(c.unitId || "").trim() || "unit";
    const meta = fullRows && fullRows[i] ? fullRows[i].metadata_json : null;
    const label = issueLabelFromMetadata(meta);
    let prompt;
    if (label && label.length > 0) {
      const short = label.split(/\s+/).slice(0, 2).join(" ");
      prompt = unit + " " + short + " done";
    } else {
      prompt = unit + " done";
    }
    const key = String(prompt).toLowerCase().trim();
    if (key && !seen[key]) {
      seen[key] = 1;
      out.push(prompt);
    }
  }
  return out;
}

module.exports = {
  extractUnit,
  extractUnitFromBody,
  resolvePropertyExplicitOnly,
  detectPropertyFromBody,
  extractPropertyHintFromBody,
  extractWorkItemIdHintFromBody,
  staffEscapeRe,
  staffExtractScheduleRemainderFromTarget,
  buildSuggestedPromptsForCandidates,
  issueLabelFromMetadata,
  extractIssueHintsForStaff,
  scoreCandidatesByIssueHints,
};
