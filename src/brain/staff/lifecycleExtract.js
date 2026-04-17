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

function buildPropertyVariantSet(prop) {
  const out = new Set();
  const code = String(prop && prop.code ? prop.code : "")
    .trim()
    .toUpperCase();
  const displayName = String(prop && prop.display_name ? prop.display_name : "").trim();
  if (code) out.add(code);
  if (displayName) out.add(displayName);
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
 * @param {Array<{ code: string, display_name?: string, aliases?: string[] }>} propertiesList
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
 * @param {Array<{ code: string, display_name?: string, aliases?: string[] }>} propertiesList
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
          aliases: Array.isArray(p && p.aliases) ? p.aliases : [],
        }))
        .filter((p) => p.code)
    : [];

  const tokens = t.split(" ").filter(Boolean);
  const digit = tokens.find((x) => /^[1-9]$/.test(x));
  if (digit && props.length) {
    const idx = parseInt(digit, 10) - 1;
    if (idx >= 0 && idx < props.length) return props[idx].code;
  }

  const compact = t.replace(/\s+/g, "");
  const allCodes = new Set(props.map((p) => p.code));
  if (knownUpper && knownUpper.size) {
    for (const k of knownUpper) allCodes.add(String(k || "").trim().toUpperCase());
  }
  for (const code of allCodes) {
    const lc = String(code || "").toLowerCase();
    if (!lc) continue;
    if (compact === lc || compact.includes(lc)) return String(code || "").toUpperCase();
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
 * PARITY GAP: partial GAS `detectPropertyFromBody_` parity (menu/index, code token, strong-name token);
 * no `_variants` map / ticketPrefix variants from GAS property directory.
 * See docs/PARITY_LEDGER.md §1.
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
  buildSuggestedPromptsForCandidates,
  issueLabelFromMetadata,
};
