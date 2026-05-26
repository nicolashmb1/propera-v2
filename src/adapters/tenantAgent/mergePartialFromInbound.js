/**
 * Merge inbound text into adapter partial package using existing maintenance parse (no finalize).
 */
const { parseMaintenanceDraftAsync } = require("../../brain/core/parseMaintenanceDraft");
const { isAddressInContext_ } = require("../../brain/gas/addressContext");
const { extractUnitFromBody } = require("../../brain/staff/lifecycleExtract");
const { resolveHandoffCategory } = require("./resolveHandoffCategory");
const { applyGatherLocationFields } = require("./resolveGatherLocation");
const {
  resolvePropertyForGather,
  bodyHasPropertyIntent,
} = require("./resolvePropertyForGather");

/**
 * @param {string} body
 * @returns {string}
 */
function leadingUnitFromBody(body) {
  const m = String(body || "")
    .trim()
    .match(/^(\d{1,4}[a-z]?)\s*[.:\-]\s*/i);
  return m ? String(m[1]).trim() : "";
}

/**
 * @param {string} body
 * @returns {boolean}
 */
function isUnitOnlyReply(body) {
  const s = String(body || "").trim();
  return /^(?:#|unit|apt|apartment)\s*\d{1,4}[a-z]?$/i.test(s) || /^\d{1,4}[a-z]?$/i.test(s);
}

/**
 * @param {object} next
 * @param {object} prev
 * @param {object} resolution
 */
function applyPropertyResolution(next, prev, resolution) {
  if (resolution.status === "RESOLVED" && resolution.property_code) {
    next.property = resolution.property_code;
    delete next._property_candidates;
    return;
  }
  if (resolution.status === "AMBIGUOUS") {
    delete next.property;
    next._property_candidates = resolution.candidates;
    return;
  }
  if (prev.property) {
    next.property = prev.property;
  }
}

const STREET_SUFFIXES = new Set([
  "ave",
  "avenue",
  "st",
  "street",
  "rd",
  "road",
  "blvd",
  "boulevard",
  "dr",
  "drive",
  "ln",
  "lane",
  "ct",
  "court",
  "pl",
  "place",
  "ter",
  "terrace",
  "way",
  "pkwy",
  "parkway",
]);

/**
 * @param {object[]} propertiesList
 * @param {string} propertyCode
 * @returns {object | null}
 */
function propertyRowByCode(propertiesList, propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!code) return null;
  return (
    (Array.isArray(propertiesList) ? propertiesList : []).find(
      (p) => String(p && p.code ? p.code : "").trim().toUpperCase() === code
    ) || null
  );
}

/**
 * Build GAS-style address context from `properties.address`.
 * @param {object | null} row
 * @returns {{ num: string, hints: string[], suffixes: string[] } | null}
 */
function propertyAddressContext(row) {
  const address = String((row && row.address) || "").trim();
  if (!address) return null;
  const m = address.match(/^\s*(\d{1,5})\s+(.+)$/);
  if (!m) return null;

  const num = String(m[1] || "").trim();
  const tail = String(m[2] || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!num || !tail) return null;

  const hints = [];
  const suffixes = [];
  for (const tok of tail.split(" ")) {
    if (!tok) continue;
    if (STREET_SUFFIXES.has(tok)) suffixes.push(tok);
    else hints.push(tok);
  }
  return { num, hints, suffixes };
}

/**
 * @param {string} body
 * @returns {boolean}
 */
function hasExplicitUnitMarker(body) {
  return /\b(?:unit|apt|apartment|suite|ste|room|rm)\.?\s*[:#-]?\s*\d{1,5}[a-z]?\b/i.test(
    String(body || "")
  );
}

/**
 * @param {string} body
 * @param {string} unit
 * @param {string} propertyCode
 * @param {object[]} propertiesList
 * @returns {boolean}
 */
function unitLooksLikeResolvedPropertyAddress(body, unit, propertyCode, propertiesList) {
  const candidate = String(unit || "").trim();
  if (!candidate || hasExplicitUnitMarker(body)) return false;
  if (!/^\d{1,5}$/.test(candidate)) return false;
  const row = propertyRowByCode(propertiesList, propertyCode);
  const addr = propertyAddressContext(row);
  if (!addr) return false;
  if (addr.num !== candidate) return false;
  return isAddressInContext_(body, addr);
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeForUnitHeuristic(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {object | null} row
 * @returns {string[]}
 */
function propertyTextVariants(row) {
  if (!row) return [];
  const out = new Set();
  const add = (v) => {
    const t = normalizeForUnitHeuristic(v);
    if (t) out.add(t);
  };
  add(row.code);
  add(row.display_name_short);
  add(row.short_name);
  add(row.display_name);
  const addr = propertyAddressContext(row);
  if (addr) {
    for (const h of addr.hints || []) add(h);
  }
  return Array.from(out).sort((a, b) => b.length - a.length);
}

/**
 * `512 westfield` should be treated as a likely unit when Westfield's address row is not 512.
 * @param {string} body
 * @param {string} propertyCode
 * @param {object[]} propertiesList
 * @returns {string}
 */
function inferUnitFromNumberBeforeResolvedProperty(body, propertyCode, propertiesList) {
  if (hasExplicitUnitMarker(body)) return "";
  const row = propertyRowByCode(propertiesList, propertyCode);
  const variants = propertyTextVariants(row);
  const t = normalizeForUnitHeuristic(body);
  for (const v of variants) {
    const m = t.match(new RegExp("\\b(\\d{1,5})\\s+" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i"));
    if (!m || !m[1]) continue;
    const candidate = String(m[1] || "").trim();
    if (unitLooksLikeResolvedPropertyAddress(body, candidate, propertyCode, propertiesList)) {
      return "";
    }
    return candidate;
  }
  return "";
}

/**
 * @param {object} partial
 * @param {string} bodyText
 * @param {Set<string>} knownPropertyCodesUpper
 * @param {object[]} propertiesList
 * @param {{ traceId?: string }} [opts]
 * @returns {Promise<object>}
 */
async function mergePartialFromInboundMessage(
  partial,
  bodyText,
  knownPropertyCodesUpper,
  propertiesList,
  opts
) {
  const prev = { ...(partial || {}) };
  const body = String(bodyText || "").trim();
  if (!body) return prev;

  const parsed = await parseMaintenanceDraftAsync(body, knownPropertyCodesUpper, {
    propertiesList,
    traceId: opts && opts.traceId ? opts.traceId : "",
  });

  const next = { ...prev };

  if (bodyHasPropertyIntent(body) || !String(prev.property || "").trim()) {
    const resolution = resolvePropertyForGather(
      body,
      propertiesList,
      knownPropertyCodesUpper
    );
    applyPropertyResolution(next, prev, resolution);
  } else if (prev.property) {
    next.property = prev.property;
  }

  const leadingUnit = leadingUnitFromBody(body);
  if (leadingUnit && !parsed.unitLabel) {
    next.unit = leadingUnit;
  }
  if (parsed.unitLabel) {
    next.unit = String(parsed.unitLabel).trim();
  }
  if (
    !String(next.unit || "").trim() &&
    String(next.property || prev.property || "").trim() &&
    isUnitOnlyReply(body)
  ) {
    const unitHint = extractUnitFromBody(body) || leadingUnitFromBody(body);
    if (unitHint) next.unit = unitHint;
  }
  if (
    !String(next.unit || "").trim() &&
    String(next.property || prev.property || "").trim()
  ) {
    const propertyCode = String(next.property || prev.property || "").trim();
    const inferred = inferUnitFromNumberBeforeResolvedProperty(
      body,
      propertyCode,
      propertiesList
    );
    if (inferred) next.unit = inferred;
  }
  if (parsed.issueText && String(parsed.issueText).trim().length >= 2) {
    const issue = String(parsed.issueText).trim();
    const prevIssue = String(next.issue || "").trim();
    if (!prevIssue || issue.length >= prevIssue.length) {
      next.issue = issue;
    }
  }
  if (parsed.scheduleRaw) {
    next.preferredWindow = String(parsed.scheduleRaw).trim();
  }
  if (
    String(next.unit || "").trim() &&
    String(next.property || prev.property || "").trim() &&
    unitLooksLikeResolvedPropertyAddress(
      body,
      next.unit,
      String(next.property || prev.property || "").trim(),
      propertiesList
    )
  ) {
    delete next.unit;
  }
  if (next.issue) {
    const cat = resolveHandoffCategory(next);
    if (cat) next.category = cat;
  }
  applyGatherLocationFields(next, { body, prev, parsed });

  return next;
}

module.exports = {
  mergePartialFromInboundMessage,
  leadingUnitFromBody,
  isUnitOnlyReply,
  applyPropertyResolution,
  propertyAddressContext,
  unitLooksLikeResolvedPropertyAddress,
  inferUnitFromNumberBeforeResolvedProperty,
};
