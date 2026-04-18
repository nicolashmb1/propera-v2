/**
 * GAS `properaCanonizeStructuredSignal_` — subset sufficient for V2 package build
 * (`07_PROPERA_INTAKE_PACKAGE.gs` ~1287–1397).
 *
 * Ported: actor/turn/safety/issues/schedule/confidence; strict `propertyCode` grounding vs message text.
 * Not ported: full GAS vision/CIG slots, media queue semantics, every legacy template field — see PARITY_LEDGER §2.
 */
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
 */
function properaCanonizeStructuredSignal(raw, phone, extractionSource, messageText) {
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
  out.unit = String(r.unit || "").trim();

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
    out.schedule = null;
  }

  out.extractionSource = String(extractionSource || "").trim() || "llm";

  // V2: strict property grounding — only keep codes that appear as a token in message (GAS uses resolvePropertyExplicitOnly_).
  const msgText = String(messageText || "").trim();
  if (msgText && out.propertyCode) {
    const re = new RegExp("\\b" + out.propertyCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (!re.test(msgText)) {
      out.propertyCode = "";
      out.propertyName = "";
    }
  }

  return out;
}

module.exports = { properaCanonizeStructuredSignal, normalizeDomainHint };
