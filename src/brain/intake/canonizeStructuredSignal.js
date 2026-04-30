/**
 * GAS `properaCanonizeStructuredSignal_` — subset sufficient for V2 package build
 * (`07_PROPERA_INTAKE_PACKAGE.gs` ~1287–1397).
 *
 * Ported: actor/turn/safety/issues/schedule/confidence; property grounding vs message text (GAS resolver chain when `propertiesList` is provided).
 * Not ported: full GAS vision/CIG slots, media queue semantics, every legacy template field — see PARITY_LEDGER §2.
 * Unit field: `normalizeUnit_` (`17_PROPERTY_SCHEDULE_ENGINE.gs` ~2247–2258) via `extractUnitGas.js`.
 */
const {
  resolvePropertyExplicitOnly,
  resolvePropertyFromTextStrict,
} = require("../staff/lifecycleExtract");
const { normalizeUnit_ } = require("../shared/extractUnitGas");
const { properaStructuredSignalEmpty } = require("./structuredSignal");

function normalizeDomainHint(dh) {
  const u = String(dh || "")
    .toUpperCase()
    .trim();
  const allowed = [
    "MAINTENANCE",
    "AMENITY",
    "LEASING",
    "CLEANING",
    "CONFLICT",
    "GENERAL",
    "UNKNOWN",
  ];
  return allowed.indexOf(u) >= 0 ? u : "UNKNOWN";
}

/**
 * @param {object} raw
 * @param {string} phone
 * @param {string} extractionSource
 * @param {string} messageText
 * @param {Array<{ code: string, display_name?: string, ticket_prefix?: string, short_name?: string, address?: string, aliases?: string[] }>} [propertiesList] — when non-empty, GAS-style grounding (`resolvePropertyExplicitOnly` + strict `resolvePropertyFromText_`); when omitted/empty, legacy word-boundary check on raw `propertyCode`
 */
function properaCanonizeStructuredSignal(
  raw,
  phone,
  extractionSource,
  messageText,
  propertiesList
) {
  void phone;
  const out = properaStructuredSignalEmpty();
  if (!raw || typeof raw !== "object") return out;
  const r = raw;

  const at = String(r.actorType || "")
    .toUpperCase()
    .trim();
  if (at === "TENANT" || at === "STAFF") out.actorType = at;
  const om = String(r.operationMode || "WRITE")
    .toUpperCase()
    .trim();
  out.operationMode = om === "READ" ? "READ" : "WRITE";
  out.intentType = String(r.intentType || "").trim().slice(0, 120);
  out.propertyCode = String(r.propertyCode || "").trim().slice(0, 64);
  out.propertyName = String(r.propertyName || "").trim().slice(0, 120);
  out.unit = normalizeUnit_(String(r.unit || ""));
  out.queryType = String(r.queryType || "").trim().slice(0, 80);

  const tt2 = String(r.turnType || "")
    .toUpperCase()
    .trim();
  if (
    tt2 === "OPERATIONAL_ONLY" ||
    tt2 === "CONVERSATIONAL_ONLY" ||
    tt2 === "MIXED" ||
    tt2 === "STATUS_QUERY" ||
    tt2 === "UNKNOWN"
  ) {
    out.turnType = tt2;
  }

  const cm2 = String(r.conversationMove || "")
    .toUpperCase()
    .trim();
  const cmAllowed = [
    "THANKS",
    "ACK",
    "GREETING",
    "GOODBYE",
    "QUESTION",
    "APOLOGY",
    "FRUSTRATION",
    "NONE",
  ];
  if (cmAllowed.indexOf(cm2) >= 0) out.conversationMove = cm2;

  const sq2 = String(r.statusQueryType || "")
    .toUpperCase()
    .trim();
  const sqAllowed = ["NONE", "SCHEDULE", "ETA", "OWNER", "GENERAL_STATUS"];
  if (sqAllowed.indexOf(sq2) >= 0) out.statusQueryType = sq2;

  if (out.turnType !== "STATUS_QUERY") out.statusQueryType = "NONE";
  const cr2 = String(r.conversationalReply || "").trim().slice(0, 600);
  if (out.turnType === "CONVERSATIONAL_ONLY" || out.turnType === "STATUS_QUERY")
    out.conversationalReply = cr2;
  else out.conversationalReply = "";

  out.confidence = Number(r.confidence);
  if (!isFinite(out.confidence) || out.confidence < 0) out.confidence = 0;
  if (out.confidence > 1) out.confidence = 1;

  try {
    out.actionSignals =
      r.actionSignals && typeof r.actionSignals === "object" ? r.actionSignals : {};
  } catch (_) {
    out.actionSignals = {};
  }
  try {
    out.targetHints =
      r.targetHints && typeof r.targetHints === "object" ? r.targetHints : {};
  } catch (_) {
    out.targetHints = {};
  }

  try {
    const amb = r.ambiguity;
    if (amb && typeof amb === "object") {
      out.ambiguity = {
        flags: Array.isArray(amb.flags)
          ? amb.flags.map((x) => String(x || "").trim()).filter(Boolean)
          : [],
        notes: String(amb.notes || "").trim().slice(0, 500),
      };
    }
  } catch (_) {}

  out.domainHint = normalizeDomainHint(r.domainHint);

  try {
    const saf = r.safety || {};
    out.safety = {
      isEmergency: !!saf.isEmergency,
      emergencyType: String(saf.emergencyType || "").trim(),
      skipScheduling: !!saf.skipScheduling,
      requiresImmediateInstructions: !!saf.requiresImmediateInstructions,
    };
  } catch (_) {}

  const issuesIn = Array.isArray(r.issues) ? r.issues : [];
  const issues = [];
  for (let i = 0; i < issuesIn.length; i++) {
    const it = issuesIn[i];
    if (!it || typeof it !== "object") continue;
    let summary = String(it.summary || it.title || "").trim();
    let title = String(it.title || it.summary || "").trim();
    if (!summary && !title) continue;
    if (!summary) summary = title;
    if (!title) title = summary;
    let lt = String(it.locationType || "UNIT")
      .toUpperCase()
      .trim();
    if (lt !== "UNIT" && lt !== "COMMON_AREA") lt = "UNIT";
    let ur = String(it.urgency || "normal")
      .toLowerCase()
      .trim();
    if (ur !== "urgent") ur = "normal";
    issues.push({
      title: title.slice(0, 280),
      summary: summary.slice(0, 500),
      tenantDescription: String(it.tenantDescription || "").trim().slice(0, 900),
      locationArea: String(it.locationArea || "").trim().slice(0, 80),
      locationDetail: String(it.locationDetail || "").trim().slice(0, 120),
      locationType: lt,
      category: String(it.category || "").trim().slice(0, 80),
      urgency: ur,
    });
  }
  out.issues = issues;

  const sched = r.schedule;
  if (sched && typeof sched === "object" && String(sched.raw || "").trim()) {
    out.schedule = { raw: String(sched.raw).trim().slice(0, 500) };
  } else {
    const an = String(r.access_notes || "").trim();
    if (an) out.schedule = { raw: an.slice(0, 500) };
    else out.schedule = null;
  }

  out.extractionSource = String(extractionSource || "").trim() || "llm";

  // GAS `properaCanonizeStructuredSignal_` ~1399–1426: property must be explicitly grounded in current message text.
  const msgText = String(messageText || "").trim();
  const props = Array.isArray(propertiesList) ? propertiesList : [];
  if (msgText && props.length > 0) {
    let explicit = resolvePropertyExplicitOnly(msgText, props);
    let nameFromRow = "";
    if (explicit) {
      const row = props.find(
        (p) =>
          String(p && p.code ? p.code : "")
            .trim()
            .toUpperCase() === explicit
      );
      nameFromRow = row
        ? String(row.display_name || "").trim()
        : "";
    }
    if (!explicit) {
      const hit = resolvePropertyFromTextStrict(msgText, props);
      if (hit && hit.code) {
        explicit = hit.code;
        nameFromRow = String(hit.name || "").trim();
      }
    }
    if (explicit) {
      out.propertyCode = explicit;
      out.propertyName = nameFromRow || out.propertyName;
    } else {
      out.propertyCode = "";
      out.propertyName = "";
    }
  } else if (msgText && out.propertyCode) {
    const re = new RegExp(
      "\\b" + out.propertyCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b",
      "i"
    );
    if (!re.test(msgText)) {
      out.propertyCode = "";
      out.propertyName = "";
    }
  }

  return out;
}

module.exports = { properaCanonizeStructuredSignal, normalizeDomainHint };
