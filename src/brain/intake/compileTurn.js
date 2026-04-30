/**
 * GAS `compileTurn_` — `08_INTAKE_RUNTIME.gs` ~697–780.
 * Async: building the intake package may call OpenAI.
 *
 * @param {string|object} bodyTrim — raw message **or** prebuilt package (`__properaIntakePackage`)
 * @param {string} phone
 * @param {string} lang
 * @param {object|null} baseVars
 * @param {object|null} cigContext
 * @param {{ knownPropertyCodesUpper: Set, propertiesList?: Array<{ code: string, display_name?: string }>, traceId?: string, traceStartMs?: number }} buildOpts
 */
const { properaBuildIntakePackage } = require("./properaBuildIntakePackage");

async function compileTurn(bodyTrim, phone, lang, baseVars, cigContext, buildOpts) {
  let interpreted = null;
  if (
    bodyTrim &&
    typeof bodyTrim === "object" &&
    (bodyTrim.__openerInterpreted || bodyTrim.__properaIntakePackage)
  ) {
    interpreted = bodyTrim;
  } else {
    interpreted = await properaBuildIntakePackage({
      bodyTrim: String(bodyTrim || ""),
      mergedBodyTrim: String(bodyTrim || ""),
      phone: String(phone || ""),
      lang: String(lang || "en"),
      baseVarsRef: baseVars && typeof baseVars === "object" ? baseVars : null,
      cigContext: cigContext || null,
      knownPropertyCodesUpper:
        (buildOpts && buildOpts.knownPropertyCodesUpper) || new Set(),
      propertiesList:
        buildOpts && Array.isArray(buildOpts.propertiesList)
          ? buildOpts.propertiesList
          : [],
      traceId: (buildOpts && buildOpts.traceId) || "",
      traceStartMs: (buildOpts && buildOpts.traceStartMs) ?? null,
    });
  }
  return compileTurnFromInterpreted(interpreted, lang, String(bodyTrim || ""));
}

function compileTurnFromInterpreted(interpreted, lang, rawBodyFallback) {
  const safety = interpreted.safety || {
    isEmergency: false,
    emergencyType: "",
    skipScheduling: false,
    requiresImmediateInstructions: false,
  };
  let _lc = Number(interpreted.langConfidence);
  if (!isFinite(_lc)) _lc = 0;
  if (_lc > 1) _lc = 1;
  if (_lc < 0) _lc = 0;
  let _renderLang = String(interpreted.lang || lang || "en")
    .toLowerCase()
    .replace(/_/g, "-");
  if (_renderLang.indexOf("-") > 0) _renderLang = _renderLang.split("-")[0];
  if (!_renderLang || _renderLang.length < 2) _renderLang = "en";
  let _semEn = "";
  try {
    _semEn =
      interpreted.semanticTextEnglish != null
        ? String(interpreted.semanticTextEnglish).trim()
        : "";
  } catch (_) {}

  const originalFrom =
    interpreted.originalText != null
      ? String(interpreted.originalText)
      : typeof rawBodyFallback === "string"
        ? rawBodyFallback
        : "";

  return {
    __openerInterpreted: !!interpreted.__openerInterpreted,
    __properaIntakePackage: !!interpreted.__properaIntakePackage,
    packageVersion: interpreted.packageVersion || 1,
    lang: _renderLang,
    langSource: String(interpreted.langSource || ""),
    langConfidence: _lc,
    semanticTextEnglish: _semEn,
    issueHint: String(
      interpreted.issueHint != null ? interpreted.issueHint : interpreted.issue || ""
    ).trim(),
    originalText: originalFrom,
    property: interpreted.property || null,
    unit: interpreted.unit != null ? String(interpreted.unit || "") : "",
    issue: interpreted.issue != null ? String(interpreted.issue || "") : "",
    issueMeta: interpreted.issueMeta || null,
    schedule: interpreted.schedule || null,
    safety: {
      isEmergency: !!safety.isEmergency,
      emergencyType: String(safety.emergencyType || "").trim(),
      skipScheduling: !!safety.skipScheduling,
      requiresImmediateInstructions: !!safety.requiresImmediateInstructions,
    },
    location: interpreted.location || {
      locationType: "UNIT",
      locationArea: "",
      locationDetail: "",
      locationScopeBroad: "UNIT",
      locationScopeRefined: "UNIT",
      locationSource: "opener_default",
      locationConfidence: 0.5,
      locationText: String(
        interpreted.semanticTextEnglish || interpreted.issue || originalFrom || ""
      ),
    },
    missingSlots: interpreted.missingSlots || null,
    domainHint: String(
      interpreted.domainHint != null ? interpreted.domainHint : "UNKNOWN"
    )
      .toUpperCase()
      .trim(),
    media: Array.isArray(interpreted.media) ? interpreted.media : [],
    assetHint: String(interpreted.assetHint != null ? interpreted.assetHint : "").trim(),
    mediaVisionInterpreted: !!interpreted.mediaVisionInterpreted,
    mediaVisionConfidence: (function () {
      const c = Number(interpreted.mediaVisionConfidence);
      return isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
    })(),
    turnType: (function () {
      const fromPkg = String(interpreted.turnType || "")
        .trim()
        .toUpperCase();
      const fromSig = String(
        (interpreted.structuredSignal && interpreted.structuredSignal.turnType) || ""
      )
        .trim()
        .toUpperCase();
      if (fromPkg === "OPERATIONAL_ONLY" || fromSig === "OPERATIONAL_ONLY")
        return "OPERATIONAL_ONLY";
      if (fromPkg && fromPkg !== "UNKNOWN") return fromPkg;
      if (fromSig && fromSig !== "UNKNOWN") return fromSig;
      return String(fromPkg || fromSig || "UNKNOWN")
        .toUpperCase()
        .trim();
    })(),
    conversationMove: String(
      interpreted.conversationMove ||
        (interpreted.structuredSignal &&
          interpreted.structuredSignal.conversationMove) ||
        "NONE"
    )
      .toUpperCase()
      .trim(),
    statusQueryType: String(
      interpreted.statusQueryType ||
        (interpreted.structuredSignal &&
          interpreted.structuredSignal.statusQueryType) ||
        "NONE"
    )
      .toUpperCase()
      .trim(),
    conversationalReply: String(
      interpreted.conversationalReply ||
        (interpreted.structuredSignal &&
          interpreted.structuredSignal.conversationalReply) ||
        ""
    )
      .trim()
      .slice(0, 600),
    structuredSignal:
      interpreted.structuredSignal &&
      typeof interpreted.structuredSignal === "object"
        ? interpreted.structuredSignal
        : null,
  };
}

module.exports = {
  compileTurn,
  compileTurnFromInterpreted,
};
