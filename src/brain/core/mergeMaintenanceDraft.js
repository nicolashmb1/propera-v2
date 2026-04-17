/**
 * Merge one inbound turn into maintenance draft slots.
 *
 * PARITY GAP: deterministic slice only — not full GAS `draftUpsertFromTurn_` / canonical merge.
 * See docs/PARITY_LEDGER.md §2.
 */
const {
  extractUnitFromBody,
  resolvePropertyExplicitOnly,
  detectPropertyFromBody,
} = require("../staff/lifecycleExtract");
const { parseMaintenanceDraft } = require("./parseMaintenanceDraft");

/**
 * @param {string} bodyTrim
 * @param {Array<{ code: string, display_name: string }>} propertiesList
 */
function resolvePropertyFromReply(bodyTrim, propertiesList) {
  const t = String(bodyTrim || "").trim();
  if (!t || !propertiesList || propertiesList.length === 0) return "";

  const known = new Set(
    propertiesList.map((p) => String(p.code || "").trim().toUpperCase())
  );
  const strict = resolvePropertyExplicitOnly(t, propertiesList);
  if (strict) return strict;
  const hint = detectPropertyFromBody(t, propertiesList, known);
  if (hint) return hint;

  const tl = t.toLowerCase();
  for (const p of propertiesList) {
    const code = String(p.code || "").toUpperCase();
    const dn = String(p.display_name || "").toLowerCase();
    if (code && tl.includes(code.toLowerCase())) return code;
    if (dn && (tl.includes(dn) || dn.includes(tl))) return code;
  }
  return "";
}

/**
 * @param {object} o
 * @param {string} o.bodyText
 * @param {string} o.expected — ISSUE | PROPERTY | UNIT | SCHEDULE | SCHEDULE_PRETICKET | FINALIZE_DRAFT | ''
 * @param {string} [o.draft_issue]
 * @param {string} [o.draft_property]
 * @param {string} [o.draft_unit]
 * @param {string} [o.draft_schedule_raw]
 * @param {{ propertyCode?: string, unitLabel?: string, issueText?: string, scheduleRaw?: string, openerNext?: string }} [o.parsedDraft] — compile/async parse output
 * @param {Set<string>} o.knownPropertyCodesUpper
 * @param {Array<{ code: string, display_name: string }>} o.propertiesList
 */
function mergeMaintenanceDraftTurn(o) {
  const bodyText = String(o.bodyText || "").trim();
  const exp = String(o.expected || "ISSUE").toUpperCase();
  const known = o.knownPropertyCodesUpper || new Set();
  const propertiesList = o.propertiesList || [];

  let issue = String(o.draft_issue != null ? o.draft_issue : "").trim();
  let prop = String(o.draft_property != null ? o.draft_property : "").trim();
  let unit = String(o.draft_unit != null ? o.draft_unit : "").trim();
  let sched = String(o.draft_schedule_raw != null ? o.draft_schedule_raw : "").trim();

  const parsed =
    o.parsedDraft && typeof o.parsedDraft === "object"
      ? {
          propertyCode: String(o.parsedDraft.propertyCode || "").trim().toUpperCase(),
          unitLabel: String(o.parsedDraft.unitLabel || "").trim(),
          issueText: String(o.parsedDraft.issueText || "").trim(),
          scheduleRaw: String(o.parsedDraft.scheduleRaw || "").trim(),
          openerNext: String(o.parsedDraft.openerNext || "").trim().toUpperCase(),
        }
      : parseMaintenanceDraft(bodyText, known, propertiesList);
  const hasParsedDraft = !!(o.parsedDraft && typeof o.parsedDraft === "object");

  if (!issue && parsed.issueText) issue = parsed.issueText;
  if (!prop && parsed.propertyCode) prop = parsed.propertyCode;
  // Do not copy parsed.unitLabel here — issue/property turns use noisy free text; unit is only
  // set on UNIT stage (or fast path in handleInboundCore before merge).

  if (exp === "ISSUE" || exp === "") {
    if (hasParsedDraft && parsed.issueText) {
      issue = parsed.issueText;
    } else if (bodyText) {
      const p2 = parseMaintenanceDraft(bodyText, known, propertiesList);
      issue = p2.issueText || bodyText;
    }
    if (!prop && parsed.propertyCode) prop = parsed.propertyCode;
  } else if (exp === "PROPERTY") {
    const r = resolvePropertyFromReply(bodyText, propertiesList);
    if (r) prop = r;
  } else if (exp === "UNIT") {
    let u = extractUnitFromBody(bodyText);
    if (!u && /^\s*([0-9]+[a-z]?)\s*$/i.test(bodyText)) {
      u = bodyText.trim();
    }
    if (u) unit = u;
  } else if (exp === "SCHEDULE" || exp === "SCHEDULE_PRETICKET") {
    if (hasParsedDraft && parsed.scheduleRaw) sched = parsed.scheduleRaw;
    else if (bodyText) sched = bodyText;
  }

  return {
    draft_issue: issue,
    draft_property: prop,
    draft_unit: unit,
    draft_schedule_raw: sched,
  };
}

module.exports = {
  mergeMaintenanceDraftTurn,
  resolvePropertyFromReply,
};
