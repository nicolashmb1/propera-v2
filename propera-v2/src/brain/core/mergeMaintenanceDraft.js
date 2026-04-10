/**
 * Merge one inbound turn into maintenance draft slots.
 *
 * PARITY GAP: deterministic slice only — not full GAS `draftUpsertFromTurn_` / canonical merge.
 * See docs/PARITY_LEDGER.md §2.
 */
const {
  extractUnitFromBody,
  extractPropertyHintFromBody,
} = require("../staff/lifecycleExtract");
const { parseMaintenanceDraft } = require("./parseMaintenanceDraft");

/**
 * @param {string} bodyTrim
 * @param {Array<{ code: string, display_name: string }>} propertiesList
 */
function resolvePropertyFromReply(bodyTrim, propertiesList) {
  const t = String(bodyTrim || "").trim();
  if (!t || !propertiesList || propertiesList.length === 0) return "";

  const n = parseInt(t, 10);
  if (String(n) === t && n >= 1 && n <= propertiesList.length) {
    return propertiesList[n - 1].code.toUpperCase();
  }

  const known = new Set(propertiesList.map((p) => p.code.toUpperCase()));
  const hint = extractPropertyHintFromBody(t, known);
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

  const parsed = parseMaintenanceDraft(bodyText, known);

  if (!issue && parsed.issueText) issue = parsed.issueText;
  if (!prop && parsed.propertyCode) prop = parsed.propertyCode;
  // Do not copy parsed.unitLabel here — issue/property turns use noisy free text; unit is only
  // set on UNIT stage (or fast path in handleInboundCore before merge).

  if (exp === "ISSUE" || exp === "") {
    if (bodyText) {
      const p2 = parseMaintenanceDraft(bodyText, known);
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
    if (bodyText) sched = bodyText;
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
