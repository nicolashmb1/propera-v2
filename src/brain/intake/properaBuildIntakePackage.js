/**
 * GAS `properaBuildIntakePackage_` — V2 slice (`07_PROPERA_INTAKE_PACKAGE.gs` ~610–950).
 * - Deterministic path: regex property/unit/issue (same helpers as maintenance draft) + `evaluateEmergencySignal_`.
 * - LLM path (optional): `OPENAI_API_KEY` + `INTAKE_LLM_ENABLED=1` → structured JSON → canonize → merge safety from rules.
 */
const {
  extractUnitFromBody,
  resolvePropertyExplicitOnly,
  detectPropertyFromBody,
  extractPropertyHintFromBody,
} = require("../staff/lifecycleExtract");
const {
  evaluateEmergencySignal_,
} = require("../../dal/ticketDefaults");
const { properaStructuredSignalEmpty } = require("./structuredSignal");
const { properaCanonizeStructuredSignal } = require("./canonizeStructuredSignal");
const {
  properaExtractStructuredSignalLLM,
} = require("./openaiStructuredSignal");
const {
  openaiApiKey,
  openaiModelExtract,
  intakeLlmEnabled,
} = require("../../config/env");
const { emitTimed } = require("../../logging/structuredLog");
const { appendEventLog } = require("../../dal/appendEventLog");
const {
  parseIssueDeterministic,
} = require("../gas/issueParseDeterministic");
const {
  inferLocationTypeFromText,
  normalizeLocationType,
} = require("../shared/commonArea");

/**
 * GAS `properaFallbackStructuredSignalFromDeterministicParse_` — `07_PROPERA_INTAKE_PACKAGE.gs` ~1434–1501.
 * Property: explicit code first, then menu/variant detection (V2 DB parity), then weak hint.
 * @returns {{ sig: object, parsedIssueDeterministic: object }}
 */
function signalFromDeterministic(tRaw, phone, known, propertiesList) {
  void phone;
  const parsed = parseIssueDeterministic(tRaw, {});
  const clauses = Array.isArray(parsed.clauses) ? parsed.clauses : [];
  const issues = [];
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    if (!c || String(c.type || "problem") !== "problem") continue;
    const txt = String(c.text || "").trim();
    const tit = String(c.title || txt || "").trim();
    if (!tit && !txt) continue;
    issues.push({
      title: tit.slice(0, 280),
      summary: tit.slice(0, 500),
      tenantDescription: txt.slice(0, 900),
      locationArea: "",
      locationDetail: "",
      locationType: inferLocationTypeFromText(txt),
      category: String(parsed.category || "").trim(),
      urgency:
        String(parsed.urgency || "normal").toLowerCase() === "urgent"
          ? "urgent"
          : "normal",
    });
  }
  if (!issues.length) {
    const one = String(parsed.title || parsed.bestClauseText || "").trim();
    const oneFinal = one || String(tRaw).slice(0, 400);
    if (oneFinal) {
      issues.push({
        title: oneFinal.slice(0, 280),
        summary: oneFinal.slice(0, 500),
        tenantDescription: String(tRaw).slice(0, 900),
        locationArea: "",
        locationDetail: "",
        locationType: inferLocationTypeFromText(oneFinal),
        category: String(parsed.category || "").trim(),
        urgency: "normal",
      });
    }
  }

  const sig = properaStructuredSignalEmpty();
  sig.extractionSource = "deterministic_v2";
  sig.turnType = "OPERATIONAL_ONLY";
  sig.intentType = "MAINTENANCE_REPORT";
  sig.actorType = "TENANT";
  sig.issues = issues;
  sig.confidence = 0.35;

  const explicitCode = resolvePropertyExplicitOnly(tRaw, propertiesList || []);
  const propertyCode =
    explicitCode ||
    extractPropertyHintFromBody(tRaw, known, propertiesList || []);
  sig.propertyCode = propertyCode || "";
  sig.unit = String(extractUnitFromBody(tRaw) || "").trim();

  return { sig, parsedIssueDeterministic: parsed };
}

/**
 * Collapse structured `issues[]` into one maintenance string for merge / draft display.
 * Multiple LLM issues are joined with " and "; **finalize ticket count** comes from the same
 * `structuredSignal.issues[]` via `finalizeTicketGroups.reconcileFinalizeTicketRows` (GAS parity),
 * not from punctuation splitting.
 */
function issueHeadFromStructuredIssues(issuesArr) {
  const arr = Array.isArray(issuesArr) ? issuesArr : [];
  const heads = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (!it || typeof it !== "object") continue;
    const h = String(it.summary || it.title || "").trim();
    if (!h) continue;
    const k = h.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(k)) continue;
    seen.add(k);
    heads.push(h);
  }
  if (!heads.length) return "";
  if (heads.length === 1) return heads[0];
  return heads.join(" and ");
}

function issueClausePartsFromStructuredIssues(issuesArr) {
  const arr = Array.isArray(issuesArr) ? issuesArr : [];
  const heads = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (!it || typeof it !== "object") continue;
    const h = String(it.summary || it.title || "").trim();
    if (!h) continue;
    const k = h.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(k)) continue;
    seen.add(k);
    heads.push(h);
  }
  return heads;
}

function firstIssueLocationType(issuesArr, fallbackText) {
  const arr = Array.isArray(issuesArr) ? issuesArr : [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (!it || typeof it !== "object") continue;
    const t = String(it.locationType || "").trim();
    if (t) return normalizeLocationType(t);
  }
  return inferLocationTypeFromText(fallbackText);
}

function locationPackFromIssue(issueHead, bodyForText, issuesArr) {
  const locText = String(issueHead || bodyForText || "").trim();
  const locType = firstIssueLocationType(issuesArr, locText);
  return {
    locationType: locType,
    locationArea: "",
    locationDetail: "",
    locationScopeBroad: locType,
    locationScopeRefined: locType,
    locationSource: "structured_signal",
    locationConfidence: 0.55,
    locationText: locText,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.bodyTrim
 * @param {string} [opts.mergedBodyTrim]
 * @param {string} opts.phone
 * @param {string} [opts.lang]
 * @param {object|null} [opts.baseVarsRef]
 * @param {object|null} [opts.cigContext]
 * @param {Set<string>} opts.knownPropertyCodesUpper
 * @param {Array<{ code: string, display_name?: string }>} [opts.propertiesList]
 * @param {object[]} [opts.mediaSignals]
 * @param {string} [opts.traceId] — request trace for structured logs
 * @param {number} [opts.traceStartMs] — HTTP entry time for `elapsed_ms` on log lines
 * @returns {Promise<object>} — intake package (input to `compileTurn`)
 */
async function properaBuildIntakePackage(opts) {
  const traceId = String(opts.traceId || "").trim();
  const traceStartMs =
    opts.traceStartMs != null && isFinite(Number(opts.traceStartMs))
      ? Number(opts.traceStartMs)
      : null;
  const phone = String(opts.phone || "").trim();
  const tRaw = String(
    opts.mergedBodyTrim != null ? opts.mergedBodyTrim : opts.bodyTrim || ""
  ).trim();
  const lang = String(opts.lang || "en").toLowerCase();
  const known = opts.knownPropertyCodesUpper;
  const cigContext = opts.cigContext || null;
  const mediaSignals = Array.isArray(opts.mediaSignals)
    ? opts.mediaSignals.filter((x) => x && typeof x === "object")
    : [];

  let sig = null;
  let parsedIssueDeterministic = null;
  let llmStructuredUsed = false;
  const apiKey = openaiApiKey();
  const llmOn = !!(apiKey && intakeLlmEnabled() && tRaw);

  if (!apiKey) {
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId || null,
      log_kind: "brain",
      event: "INTAKE_LLM_SKIPPED",
      data: { reason: "no_openai_api_key", crumb: "intake_llm_skipped" },
    });
  } else if (!intakeLlmEnabled()) {
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId || null,
      log_kind: "brain",
      event: "INTAKE_LLM_SKIPPED",
      data: { reason: "intake_llm_disabled", crumb: "intake_llm_skipped" },
    });
  } else if (!tRaw) {
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId || null,
      log_kind: "brain",
      event: "INTAKE_LLM_SKIPPED",
      data: { reason: "empty_text", crumb: "intake_llm_skipped" },
    });
  }

  if (llmOn) {
    const model = openaiModelExtract();
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId || null,
      log_kind: "brain",
      event: "INTAKE_LLM_REQUEST",
      data: { model, text_len: tRaw.length, crumb: "intake_llm_request" },
    });
    const ex = await properaExtractStructuredSignalLLM({
      text: tRaw,
      phone,
      apiKey,
      lang,
      context: cigContext,
      model,
    });
    emitTimed(traceStartMs, {
      level: ex.ok ? "info" : "warn",
      trace_id: traceId || null,
      log_kind: "brain",
      event: "INTAKE_LLM_RESPONSE",
      data: {
        ok: !!ex.ok,
        err: ex.err ? String(ex.err) : "",
        has_signal: !!(ex.ok && ex.signal),
        crumb: "intake_llm_response",
      },
    });
    if (ex.ok && ex.signal) {
      sig = properaCanonizeStructuredSignal(
        ex.signal,
        phone,
        "llm",
        tRaw,
        Array.isArray(opts.propertiesList) ? opts.propertiesList : []
      );
      llmStructuredUsed = true;
    }
  }

  if (!sig || !sig.issues || !sig.issues.length) {
    const built = signalFromDeterministic(
      tRaw,
      phone,
      known,
      Array.isArray(opts.propertiesList) ? opts.propertiesList : []
    );
    sig = built.sig;
    parsedIssueDeterministic = built.parsedIssueDeterministic;
  }
  sig.mediaSignals = mediaSignals;

  const em = evaluateEmergencySignal_(tRaw);
  if (em && em.isEmergency) {
    sig.safety = sig.safety || {};
    sig.safety.isEmergency = true;
    if (em.emergencyType) sig.safety.emergencyType = String(em.emergencyType || "").trim();
    sig.safety.skipScheduling = !!em.skipScheduling;
    sig.safety.requiresImmediateInstructions = !!em.requiresImmediateInstructions;
  }

  const issueHead = issueHeadFromStructuredIssues(sig.issues);
  const issuePartsForMeta = issueClausePartsFromStructuredIssues(sig.issues);

  let propObj = null;
  if (String(sig.propertyCode || "").trim()) {
    propObj = {
      code: String(sig.propertyCode || "").trim(),
      name: String(sig.propertyName || "").trim(),
    };
  }

  const locPack = locationPackFromIssue(issueHead, tRaw, sig.issues);

  let issueMetaOut = null;
  if (parsedIssueDeterministic) {
    const p = parsedIssueDeterministic;
    issueMetaOut = {
      title: String(p.title || issueHead || "").trim(),
      details: String(p.details || "").trim(),
      bestClauseText: String(p.bestClauseText || issueHead || "").trim(),
      clauses: Array.isArray(p.clauses) ? p.clauses : [],
      problemSpanCount:
        p.problemSpanCount != null ? Number(p.problemSpanCount) : 0,
      source: "issue_parse_deterministic",
      category: String(p.category || "").trim(),
      subcategory: String(p.subcategory || "").trim(),
      urgency: String(p.urgency || "normal").trim(),
      debug: String(p.debug || "").trim(),
    };
  } else if (issueHead) {
    if (llmStructuredUsed && issuePartsForMeta.length > 1) {
      issueMetaOut = {
        title: String(issuePartsForMeta[0] || issueHead).trim(),
        details: "",
        bestClauseText: issueHead,
        clauses: issuePartsForMeta.map((h) => ({
          text: h,
          title: h,
          type: "problem",
        })),
        problemSpanCount: issuePartsForMeta.length,
        source: "llm_structured_multi",
        category: "",
        subcategory: "",
        urgency: "normal",
        debug: "",
      };
    } else {
      issueMetaOut = {
        title: issueHead,
        bestClauseText: issueHead,
        clauses: [{ text: issueHead, title: issueHead, type: "problem" }],
        problemSpanCount: 1,
        source: "package_v2",
        category: "",
        urgency: "normal",
      };
    }
  }

  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId || null,
    log_kind: "brain",
    event: "INTAKE_PACKAGE_RESOLVED",
    data: {
      extraction_source: sig.extractionSource || "",
      llm_structured_used: llmStructuredUsed,
      crumb: "intake_package_resolved",
    },
  });

  if (traceId) {
    const extraction = String(sig.extractionSource || "").trim();
    const brainPath = llmStructuredUsed
      ? "llm_structured"
      : extraction === "deterministic_v2"
        ? "deterministic_v2"
        : extraction || "deterministic";
    await appendEventLog({
      traceId,
      log_kind: "brain",
      event: "INTAKE_BRAIN_PATH",
      payload: {
        brain_path: brainPath,
        llm_structured_used: llmStructuredUsed,
        extraction_source: extraction,
        intake_llm_eligible: !!(apiKey && intakeLlmEnabled() && tRaw),
        summary: llmStructuredUsed
          ? "Intake: LLM structured extract"
          : "Intake: deterministic (" + (extraction || "v2") + ")",
      },
    });
  }

  const pkg = {
    __openerInterpreted: true,
    __properaIntakePackage: true,
    packageVersion: 3,
    property: propObj,
    unit: String(sig.unit || "").trim(),
    turnType: String(sig.turnType || "UNKNOWN")
      .toUpperCase()
      .trim(),
    conversationMove: String(sig.conversationMove || "NONE")
      .toUpperCase()
      .trim(),
    statusQueryType: String(sig.statusQueryType || "NONE")
      .toUpperCase()
      .trim(),
    conversationalReply: String(sig.conversationalReply || "").trim().slice(0, 600),
    issue: issueHead,
    issueHint: issueHead,
    issueMeta: issueMetaOut,
    schedule:
      sig.schedule && sig.schedule.raw ? { raw: String(sig.schedule.raw) } : null,
    safety: {
      isEmergency: !!(sig.safety && sig.safety.isEmergency),
      emergencyType: String((sig.safety && sig.safety.emergencyType) || "").trim(),
      skipScheduling: !!(sig.safety && sig.safety.skipScheduling),
      requiresImmediateInstructions: !!(
        sig.safety && sig.safety.requiresImmediateInstructions
      ),
    },
    location: locPack,
    missingSlots: {
      propertyMissing: !(propObj && propObj.code),
      unitMissing: !String(sig.unit || "").trim(),
      issueMissing: !String(issueHead || "").trim(),
      scheduleMissing: !(sig.schedule && String(sig.schedule.raw || "").trim()),
    },
    domainHint: String(sig.domainHint || "MAINTENANCE")
      .toUpperCase()
      .trim(),
    structuredSignal: sig,
    lang,
    langSource: sig.extractionSource === "deterministic_v2" ? "deterministic_v2" : "llm+canon",
    langConfidence: sig.confidence != null ? Math.min(1, Math.max(0, sig.confidence)) : 0.8,
    originalText: tRaw,
    semanticTextEnglish: tRaw,
    media: mediaSignals,
    assetHint: "",
    mediaVisionInterpreted: false,
    mediaVisionConfidence: 0,
  };

  pkg.issue = String(pkg.issue || "").trim();
  pkg.issueHint = String(pkg.issue || "").trim();
  if (!pkg.issue && pkg.missingSlots) pkg.missingSlots.issueMissing = true;

  return pkg;
}

module.exports = {
  properaBuildIntakePackage,
  parseIssueDeterministic,
  signalFromDeterministic,
  issueHeadFromStructuredIssues,
  issueClausePartsFromStructuredIssues,
};
