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

/**
 * PARITY GAP: heuristic — not GAS `detectPropertyFromBody_` / full intake property resolution.
 * See docs/PARITY_LEDGER.md §1.
 *
 * @param {string} body
 * @param {Set<string>} knownUpper — property codes / tokens
 */
function extractPropertyHintFromBody(body, knownUpper) {
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
  extractPropertyHintFromBody,
  extractWorkItemIdHintFromBody,
  buildSuggestedPromptsForCandidates,
  issueLabelFromMetadata,
};
