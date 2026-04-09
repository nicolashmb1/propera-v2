/**
 * PROPERA_INTAKE_PACKAGE.gs
 *
 * Cohesive group: INTAKE SEMANTIC ENGINE (Pack B)
 * Ownership:
 * - Build canonical intake package from inbound text/media.
 * - Semantic normalization only; no stage-routing side effects.
 *
 * Single canonical structured result from the opener/package layer — the only
 * place that may interpret raw inbound text for operational intake meaning.
 *
 * Flow (target):
 *   Adapter (normalize) → properaBuildIntakePackage_ → brain + fast lane consume package only
 *
 * SEMANTIC RULE: operational fields (issue, issueHint, issueMeta, location.locationText for brain, etc.)
 * are English-normalized. Original user text is kept only on originalText for audit/expression context.
 * Lang for templates / Outgate: pkg.lang (single source; no re-detection downstream).
 *
 * @typedef {Object} ProperaIntakePackage
 * @property {boolean} __properaIntakePackage
 * @property {number} packageVersion
 * @property {string} lang - BCP-47-like short code for rendering only (e.g. en, es, pt)
 * @property {string} langSource - how lang was chosen (heuristic, hint, translate)
 * @property {number} langConfidence - 0..1
 * @property {string} originalText - raw inbound text (non-English allowed; not for brain semantics)
 * @property {string} issueHint - canonical English one-line issue summary for prompts / brain
 * @property {(!Object|null)} property - { code, name } or null
 * @property {string} unit
 * @property {string} issue - canonical English issue (same family as issueHint; may be fuller)
 * @property {(!Object|null)} issueMeta - canonical English structured issue (clauses/titles in English)
 * @property {(!Object|null)} schedule - { raw } — semantic string English-normalized when source was not English
 * @property {string} semanticTextEnglish - English text used for opener + Phase-2 AI lanes (not for rendering)
 * @property {Object} safety - isEmergency, emergencyType, skipScheduling, requiresImmediateInstructions
 * @property {Object} location - canonical English location only (single source for brain/domain/ticket):
 *   locationType (UNIT|COMMON_AREA|BUILDING_SYSTEM|EXTERIOR), locationArea (e.g. BATHROOM|HALLWAY),
 *   optional locationDetail, locationSource, locationConfidence (0..1), legacy locationScopeBroad / locationScopeRefined, locationText
 * @property {string} domainHint - advisory operational lane hint (MAINTENANCE|AMENITY|LEASING|CLEANING|CONFLICT|GENERAL|UNKNOWN), set once in opener
 * @property {Object} missingSlots - propertyMissing, unitMissing, issueMissing, scheduleMissing
 * @property {Array<{url:string,contentType:string,source:string}>} media - raw inbound attachments (canonical): one interpretation via opener vision when image
 * @property {string} assetHint - English equipment/fixture hint from opener vision (if any)
 * @property {boolean} mediaVisionInterpreted - true when opener vision ran successfully for at least one image
 * @property {number} mediaVisionConfidence - 0..1 from opener vision JSON
 */

var PROPERA_DOMAIN_HINTS_ = { MAINTENANCE: 1, AMENITY: 1, LEASING: 1, CLEANING: 1, CONFLICT: 1, GENERAL: 1, UNKNOWN: 1 };

function properaNormalizeDomainHint_(s) {
  var u = String(s || "").toUpperCase().trim();
  if (PROPERA_DOMAIN_HINTS_[u]) return u;
  return "UNKNOWN";
}

function properaHasFailureLanguage_(text) {
  var t = String(text || "").toLowerCase();
  if (!t) return false;
  var pats = [
    /\bnot\s+working\b/i,
    /\bisn'?t\s+working\b/i,
    /\bis\s+not\s+working\b/i,
    /\bstopped\s+working\b/i,
    /\bbroken\b/i,
    /\bnot\s+functioning\b/i,
    /\bmalfunction(?:ing)?\b/i,
    /\bnot\s+turning\s+on\b/i,
    /\bno\s+power\b/i,
    /\bdoesn'?t\s+work\b/i,
    /\bdoes\s+not\s+work\b/i,
    /\bissue\s+with\b/i,
    /\bproblem\s+with\b/i,
    /\bnot\s+operating\b/i,
    /\b(no|não|nao)\s+funciona\b/i,
    /\b(no|não|nao)\s+est(á|a)\b/i,
    /\b(no|não|nao)\s+trabalha\b/i,
    /\bnon\s+funziona\b/i,
    /\bne\s+fonctionne\s+pas\b/i
  ];
  for (var i = 0; i < pats.length; i++) {
    if (pats[i].test(t)) return true;
  }
  return false;
}

/**
 * Single advisory domain hint from English-normalized text + light package shape (opener only).
 */
function properaInferDomainHint_(englishText, langCode, pkg) {
  var t = String(englishText || "").trim();
  var low = t.toLowerCase();
  if (!t) return "UNKNOWN";

  var maintenance = 0;
  var cleaning = 0;
  var amenity = 0;
  var leasing = 0;

  if (/\b(lease|leasing|rental application|application for|apply for|tour|showing|showing request|roommate|sublet|sublease)\b/i.test(low)) leasing += 3;
  if (/\b(move-?in|move in|qualif(y|ication)|co-?signer|cosigner|security deposit|rent amount|listed rent)\b/i.test(low)) leasing += 2;
  if (/\b(available units|any units available|apartment availability)\b/i.test(low)) leasing += 2;

  if (/\b(reserve|book|booking|reservation)\b/i.test(low) && /\b(gym|pool|clubhouse|grill|bbq|party room|amenity room|tennis|squash|rooftop)\b/i.test(low)) amenity += 5;
  if (/\b(hours for|access to)\b.*\b(gym|pool|clubhouse)\b/i.test(low)) amenity += 2;
  if (/\bcommunity room\b.*\b(reserve|book)\b/i.test(low)) amenity += 3;

  if (/\b(clean(ing)?(\s+service)?(\s+my)?\s+(apartment|apt|unit|place|home|house)|housekeeping|maid service|deep clean|move-?out clean|sanitize my)\b/i.test(low)) cleaning += 4;
  if (/\b(scrub|mop|vacuum)\b.*\b(apartment|unit|floor)\b/i.test(low)) cleaning += 2;

  if (pkg && String(pkg.issue || "").trim()) maintenance += 2;
  if (/\b(clogged|clog|leak|leaking|broken|not working|doesn'?t work|does not work|won'?t work|will not work|needs?\s+(repair|fix|fixed)|need\s+repair|out of order|spark(ing)?|smell gas|no hot water|flooded|backup|backed up|malfunction|won'?t drain|stopped working|isn'?t working)\b/i.test(low)) {
    maintenance += 3;
  }
  if (typeof looksActionableIssue_ === "function" && looksActionableIssue_(t)) maintenance += 2;
  if (properaHasFailureLanguage_(t)) maintenance += 2;

  var strongCount = 0;
  if (leasing >= 3) strongCount++;
  if (amenity >= 3) strongCount++;
  if (cleaning >= 3) strongCount++;
  if (maintenance >= 3) strongCount++;
  if (strongCount >= 2) return "CONFLICT";

  if (leasing >= 3) return "LEASING";
  if (amenity >= 3) return "AMENITY";
  if (cleaning >= 3 && maintenance >= 3) return "CONFLICT";
  if (cleaning >= 3 && maintenance < 2) return "CLEANING";
  if (maintenance >= 3) return "MAINTENANCE";
  if (cleaning >= 2) return "CLEANING";
  if (maintenance >= 2) return "MAINTENANCE";

  if (/\b(help|question|info|information|not sure|unclear)\b/i.test(low) && maintenance < 2 && cleaning < 2 && amenity < 2 && leasing < 2) {
    return "GENERAL";
  }

  return "UNKNOWN";
}

/** Ticket/finalize: collapse building/exterior scopes to COMMON_AREA for legacy sheet rules. */
function properaNormalizeLocationTypeForTicket_(locationType) {
  var u = String(locationType || "UNIT").toUpperCase().trim();
  if (u === "BUILDING_SYSTEM" || u === "EXTERIOR") return "COMMON_AREA";
  if (u === "COMMON_AREA" || u === "UNIT") return u;
  return "UNIT";
}

function properaLocationClauses_(text) {
  var s = String(text || "").trim();
  if (!s) return [];
  s = s.replace(/\s+/g, " ");
  var parts = s.split(/\s*[.!?]+\s*|\s+(?:also|and\s+also|i\s+also|plus|btw|by\s+the\s+way)\s+/i);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = String(parts[i] || "").trim();
    if (p.length >= 3) out.push(p);
  }
  return out.length ? out : [];
}

function properaLocationIssueScore_(clause) {
  var lower = String(clause || "").toLowerCase();
  var strong = [
    "leaking", "leak", "clogged", "broken", "not working", "stop working", "stopped working", "beeping", "no heat", "flooded",
    "light out", "lights out", "won't work", "doesn't work", "stuck", " is out", " out "
  ];
  var score = 0;
  var i;
  for (i = 0; i < strong.length; i++) {
    if (lower.indexOf(strong[i]) >= 0) score += 2;
  }
  var weak = ["my sink", "hallway", "gym", "lobby", "bathroom", "kitchen", "elevator", "stairwell"];
  for (i = 0; i < weak.length; i++) {
    if (lower.indexOf(weak[i]) >= 0) score += 1;
  }
  return score;
}

function properaLocationPickDominantClause_(clauses) {
  if (!clauses || !clauses.length) return null;
  if (clauses.length === 1) return clauses[0];
  var best = null;
  var bestScore = 0;
  for (var i = 0; i < clauses.length; i++) {
    var sc = properaLocationIssueScore_(clauses[i]);
    if (sc > bestScore) {
      bestScore = sc;
      best = clauses[i];
    }
  }
  return bestScore > 0 ? best : clauses[0];
}

function properaClassifyLocationBroad_(lower, clause) {
  var t = String(clause || "").trim();
  if (/\b(boiler room|mechanical room|chiller plant|fire pump room|sprinkler riser|main water line|electrical room|hvac room|elevator machine room|lift machine room)\b/i.test(lower)) {
    return { locationType: "BUILDING_SYSTEM", confidence: 0.86, source: "package_opener_kw" };
  }
  if (/\b(building exterior|exterior wall|outside wall|facade|loading dock|curb line|sidewalk damage|fence line|retaining wall)\b/i.test(lower)) {
    return { locationType: "EXTERIOR", confidence: 0.84, source: "package_opener_kw" };
  }
  if (/\b(laundry room|laundry area)\b/i.test(lower) && !/\b(my|our)\s+laundry\b/i.test(lower)) {
    return { locationType: "COMMON_AREA", confidence: 0.87, source: "package_opener_kw" };
  }
  if (/\b(gym|fitness center|fitness room)\b/i.test(lower)) {
    return { locationType: "COMMON_AREA", confidence: 0.88, source: "package_opener_kw" };
  }
  var commonSignals = [
    "hallway", "corridor", "lobby", "stairwell", "staircase", "elevator", " mail room", "mailroom", "package room",
    "trash room", "garbage room", "parking garage", "parking lot", "parking deck",
    "basement", "cellar", "rooftop", "the roof", " roof ", "common area", "amenity room", "club room", "vestibule", "entry lobby",
    "building lobby", "breezeway", "portico", "mail area"
  ];
  var c;
  for (c = 0; c < commonSignals.length; c++) {
    if (lower.indexOf(commonSignals[c]) >= 0) {
      return { locationType: "COMMON_AREA", confidence: 0.88, source: "package_opener_kw" };
    }
  }
  if (/\bthe\s+lift\b|\blift\s+is\b|\blift\s+to\b/i.test(lower)) {
    return { locationType: "COMMON_AREA", confidence: 0.84, source: "package_opener_kw" };
  }
  var unitPhrases = [
    "my sink", "my toilet", "my shower", "my bathroom", "my kitchen", "my bedroom", "my apartment", "my unit",
    "inside my apartment", "in my unit", "in apt ", "in unit ", "my ac", "my heat", "my window", "my lock",
    "my ceiling", "my wall", "my stove", "my fridge", "my dishwasher", "my smoke detector", "smoke detector is",
    "my tub", "my heater", "my dryer", "my washer", "my microwave", "my oven", "in my bathroom", "in my kitchen",
    "bathroom sink", "kitchen sink", "living room", "bedroom ", "master bedroom", "guest bathroom", "powder room",
    "mudroom", "foyer", "entryway", "my laundry"
  ];
  var u;
  for (u = 0; u < unitPhrases.length; u++) {
    if (lower.indexOf(unitPhrases[u]) >= 0) {
      return { locationType: "UNIT", confidence: 0.85, source: "package_opener_kw" };
    }
  }
  var hasUnitRef = /\b(apt|apartment|unit|#)\s*\d{1,5}\b/i.test(t) || /\b\d{1,5}\s*(apt|unit)\b/i.test(lower);
  var residentialIssue = /\b(smoke detector|battery|clogged|leak|leaking|toilet|sink|shower|fridge|stove|ac|heat|window|lock|beeping|broken|not working|stop working)\b/i.test(lower);
  if (hasUnitRef && residentialIssue) {
    return { locationType: "UNIT", confidence: 0.75, source: "package_opener_kw" };
  }
  return { locationType: "UNIT", confidence: 0.55, source: "package_opener_default" };
}

function properaClassifyLocationArea_(lower, locType) {
  var lt = String(locType || "UNIT").toUpperCase();
  var j;
  if (lt === "BUILDING_SYSTEM" || lt === "EXTERIOR") return "";
  if (lt === "COMMON_AREA") {
    var commonPairs = [
      [/hallway|corridor/, "HALLWAY"],
      [/lobby|vestibule|entry lobby|building lobby/, "LOBBY"],
      [/stairwell|staircase|\bstairs\b/, "STAIRWELL"],
      [/\belevator\b|\bthe lift\b/, "ELEVATOR"],
      [/mail room|mailroom|package room|mail area/, "MAILROOM"],
      [/fitness center|fitness room|\bgym\b/, "GYM"],
      [/parking garage|parking lot|parking deck|parking\b/, "PARKING"],
      [/rooftop|\broof\b/, "ROOF"],
      [/basement|cellar/, "BASEMENT"],
      [/laundry room|laundry area/, "LAUNDRY"]
    ];
    for (j = 0; j < commonPairs.length; j++) {
      if (commonPairs[j][0].test(lower)) return commonPairs[j][1];
    }
    return "";
  }
  var unitPairs = [
    [/kitchen|galley|dishwasher/, "KITCHEN"],
    [/bathroom|restroom|\bbath\b|shower|toilet|vanity|powder room/, "BATHROOM"],
    [/bedroom|master suite/, "BEDROOM"],
    [/living room|family room|great room/, "LIVING_ROOM"],
    [/entryway|foyer|mudroom/, "ENTRYWAY"],
    [/laundry|\bwashing machine\b|\bdryer\b/, "LAUNDRY"],
    [/\bwasher\b/, "LAUNDRY"]
  ];
  for (j = 0; j < unitPairs.length; j++) {
    if (unitPairs[j][0].test(lower)) {
      if (unitPairs[j][1] === "LAUNDRY" && /\bdishwasher\b/i.test(lower)) continue;
      return unitPairs[j][1];
    }
  }
  return "";
}

/** Map free-text / model output to canonical locationArea tokens (align with properaClassifyLocationArea_). */
function properaNormalizeVisionLocationArea_(s) {
  var low = String(s || "").trim().toLowerCase().replace(/[\s_]+/g, " ");
  if (!low) return "";
  var pairs = [
    [/bathroom|restroom|\bbath\b|shower|toilet|vanity/, "BATHROOM"],
    [/kitchen|galley/, "KITCHEN"],
    [/living\s*room|family\s*room|great\s*room/, "LIVING_ROOM"],
    [/bedroom|master\s*suite/, "BEDROOM"],
    [/laundry|\bwashing\s*machine\b|\bwasher\b|\bdryer\b/, "LAUNDRY"],
    [/hallway|corridor/, "HALLWAY"],
    [/lobby|vestibule/, "LOBBY"],
    [/elevator|\blift\b/, "ELEVATOR"],
    [/stairwell|staircase|\bstairs\b/, "STAIRWELL"],
    [/entryway|foyer|mudroom|intercom|buzzer|doorbell/, "ENTRYWAY"],
    [/fitness|\bgym\b/, "GYM"],
    [/parking|garage/, "PARKING"],
    [/basement|cellar/, "BASEMENT"],
    [/rooftop|\broof\b/, "ROOF"],
    [/exterior|outside|facade/, "EXTERIOR"],
    [/mail\s*room|mailroom|package\s*room/, "MAILROOM"]
  ];
  var j;
  for (j = 0; j < pairs.length; j++) {
    if (pairs[j][0].test(low)) return pairs[j][1];
  }
  return "";
}

function properaExtractLocationDetail_(lower) {
  if (/\blights?\b/i.test(lower)) return "light";
  var fixtures = ["sink", "toilet", "outlet", "fan", "faucet", "disposal", "microwave", "oven", "stove", "shower", "tub", "lock", "window", "door", "handle", "knob", "ceiling", "breaker", "panel", "detector"];
  var i;
  for (i = 0; i < fixtures.length; i++) {
    var f = fixtures[i];
    var re = new RegExp("\\b" + f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (re.test(lower)) return f;
  }
  return "";
}

/**
 * Single canonical location interpret for English-normalized intake text (opener only).
 */
function properaInferCanonicalLocationPack_(englishText, phone) {
  var t = String(englishText || "").trim();
  var phoneSafe = String(phone || "").trim();
  var base = {
    locationType: "UNIT",
    locationArea: "",
    locationDetail: "",
    locationSource: "package_opener_default",
    locationConfidence: 0.5,
    locationScopeBroad: "UNIT",
    locationScopeRefined: "UNIT",
    locationText: t
  };
  if (!t) return base;

  var clauses = properaLocationClauses_(t);
  var clause = clauses.length === 1 ? clauses[0] : properaLocationPickDominantClause_(clauses);
  if (!clause) clause = t;
  var lower = clause.toLowerCase().replace(/\s+/g, " ");

  var broad = properaClassifyLocationBroad_(lower, clause);
  var locType = String(broad.locationType || "UNIT").toUpperCase();
  if (locType !== "UNIT" && locType !== "COMMON_AREA" && locType !== "BUILDING_SYSTEM" && locType !== "EXTERIOR") locType = "UNIT";
  var conf = Number(broad.confidence);
  if (!isFinite(conf)) conf = 0.55;
  if (conf > 1) conf = 1;
  if (conf < 0) conf = 0;
  var src = String(broad.source || "package_opener");

  var area = properaClassifyLocationArea_(lower, locType);
  var detail = properaExtractLocationDetail_(lower);

  var refined = area ? area : (locType === "COMMON_AREA" || locType === "BUILDING_SYSTEM" || locType === "EXTERIOR" ? locType : "UNIT");

  var out = {
    locationType: locType,
    locationArea: area,
    locationDetail: detail,
    locationSource: src,
    locationConfidence: conf,
    locationScopeBroad: locType,
    locationScopeRefined: refined,
    locationText: t
  };
  try {
    if (typeof logDevSms_ === "function") {
      logDevSms_(phoneSafe, "", "PACKAGE_LOC type=[" + locType + "] area=[" + (area || "") + "] detail=[" + (detail || "") + "] conf=" + String(conf) + " src=[" + src + "]");
    }
  } catch (_) {}
  return out;
}

/** Mixed-scope helper: treat building/exterior like common for span bucketing. */
function properaLocationIsCommonLikePack_(pack) {
  if (!pack || typeof pack !== "object") return false;
  var u = String(pack.locationType || "").toUpperCase();
  return u === "COMMON_AREA" || u === "BUILDING_SYSTEM" || u === "EXTERIOR";
}

/**
 * Lightweight detector (no second pass in render/brain). pt/es/it/fr/en.
 */
function properaDetectInboundLang_(text, hintLang) {
  var t = String(text || "").trim();
  var hint = String(hintLang || "en").toLowerCase().replace(/_/g, "-");
  if (hint.indexOf("-") > 0) hint = hint.split("-")[0];
  if (!t) {
    return { lang: hint && hint.length === 2 ? hint : "en", confidence: 0.4, source: "hint_empty" };
  }

  var scores = { en: 0, es: 0, pt: 0, it: 0, fr: 0 };

  if (/\b(my|the|isn't|is not|not working|washer|washing machine|dishwasher|broken|please|apartment|apt|hey|can someone)\b/i.test(t)) scores.en += 3;
  if (/\b(hello|thanks|thank you|pls|fix)\b/i.test(t)) scores.en += 1;

  if (/[ãõâêôáéíóúàèìòùç]/i.test(t)) {
    scores.pt += 2;
    scores.es += 1;
  }
  if (/\b(não|nao|n\xE3o|minha|meu|tá|está|estou|você|voce|máquina|maquina|lavar|trabalhando|consertar|apto|olá|ola|oie)\b/i.test(t)) scores.pt += 4;
  if (/\b(casa|banheiro|privada)\b/i.test(t)) scores.pt += 1;

  if (/ñ|¿|¡/.test(t)) scores.es += 3;
  if (/\b(mi|mis|no funciona|no está|lavador|lavadora|lavavajillas|hola|buenos|gracias)\b/i.test(t)) scores.es += 4;

  if (/\b(non funziona|la mia|lavatrice|buongiorno|grazie)\b/i.test(t)) scores.it += 4;

  if (/\b(ne fonctionne pas|lave-linge|merci|bonjour)\b/i.test(t)) scores.fr += 4;

  var best = "en";
  var bestScore = scores.en;
  var k;
  for (k in scores) {
    if (!Object.prototype.hasOwnProperty.call(scores, k) || k === "en") continue;
    if (scores[k] > bestScore) {
      bestScore = scores[k];
      best = k;
    }
  }

  var confidence = 0.55;
  if (bestScore >= 4) confidence = 0.88;
  else if (bestScore >= 2) confidence = 0.72;
  else if (bestScore <= 1 && scores.en >= 2) {
    best = "en";
    confidence = 0.82;
  } else if (bestScore <= 1 && hint && hint.length === 2 && hint !== "en") {
    best = hint;
    confidence = 0.5;
    return { lang: best, confidence: confidence, source: "hint_weak_signal" };
  }

  return { lang: best, confidence: confidence, source: "heuristic" };
}

/**
 * Normalize full inbound text to English for ONE semantic parse (LanguageApp).
 * Returns { text, used }; on failure returns original text and used=false.
 */
function properaNormalizeSemanticTextToEnglish_(text, sourceLang) {
  var s = String(text || "").trim();
  var sl = String(sourceLang || "en").toLowerCase();
  if (sl.indexOf("-") > 0) sl = sl.split("-")[0];
  if (!s || sl === "en") return { text: s, used: false };

  try {
    if (typeof LanguageApp !== "undefined" && LanguageApp.translate) {
      var out = LanguageApp.translate(s, sl, "en");
      out = String(out || "").trim();
      if (out) return { text: out, used: true };
    }
  } catch (e) {
    try {
      if (typeof logDevSms_ === "function") {
        logDevSms_("", "", "PACKAGE_TRANSLATE_ERR " + String(e && e.message ? e.message : e));
      }
    } catch (_) {}
  }
  return { text: s, used: false };
}

/**
 * Ensure issueMeta string fields remain English (after parse on normalized text they should already be).
 */
function properaStampIssueMetaEnglish_(issueMeta) {
  if (!issueMeta || typeof issueMeta !== "object") return;
  try {
    issueMeta.semanticLocale = "en";
  } catch (_) {}
}

/**
 * Heuristic English summary when LanguageApp cannot translate (never emit source-language semantics).
 */
function properaSemanticEnglishFallbackFromRaw_(rawInbound, sourceLang) {
  var raw = String(rawInbound || "").trim();
  var sl = String(sourceLang || "en").toLowerCase();
  if (sl.indexOf("-") > 0) sl = sl.split("-")[0];
  if (!raw || sl === "en") return "";
  var low = raw.toLowerCase();
  if (/\b(washing machine|washer|lavar|lavatrice|lave-linge|machine à laver|maquina de lavar|máquina de lavar|lavadora|lavador)\b/i.test(raw)) {
    return "washing machine is not working";
  }
  if (/\b(dishwasher|lavavajillas|lave-vaisselle|lavastoviglie|maquina de louca)\b/i.test(raw)) {
    return "dishwasher is not working";
  }
  if (properaHasFailureLanguage_(raw)) {
    return "appliance or equipment is not working";
  }
  return "maintenance issue reported";
}

function properaCoerceStringToEnglishMeaning_(s, sourceLang, rawInboundForFallback) {
  var t = String(s || "").trim();
  var sl = String(sourceLang || "en").toLowerCase();
  if (sl.indexOf("-") > 0) sl = sl.split("-")[0];
  if (!t || sl === "en") return t;
  var tr = properaNormalizeSemanticTextToEnglish_(t, sl);
  if (tr && tr.used && tr.text) return String(tr.text).trim();
  return properaSemanticEnglishFallbackFromRaw_(rawInboundForFallback || t, sl);
}

function properaNormalizeIssueMetaToEnglish_(issueMeta, sourceLang, rawInboundForFallback) {
  if (!issueMeta || typeof issueMeta !== "object") return;
  var sl = String(sourceLang || "en").toLowerCase();
  if (sl.indexOf("-") > 0) sl = sl.split("-")[0];
  if (sl === "en") return;
  try {
    if (issueMeta.title) {
      issueMeta.title = properaCoerceStringToEnglishMeaning_(issueMeta.title, sl, rawInboundForFallback);
    }
  } catch (_) {}
  try {
    if (issueMeta.bestClauseText) {
      issueMeta.bestClauseText = properaCoerceStringToEnglishMeaning_(issueMeta.bestClauseText, sl, rawInboundForFallback);
    }
  } catch (_) {}
  try {
    if (Array.isArray(issueMeta.clauses)) {
      for (var ci = 0; ci < issueMeta.clauses.length; ci++) {
        var cl = issueMeta.clauses[ci];
        if (cl && cl.text) {
          cl.text = properaCoerceStringToEnglishMeaning_(cl.text, sl, rawInboundForFallback);
        }
      }
    }
  } catch (_) {}
}

/**
 * After opener, guarantee no non-English remains in semantic fields when lang !== en.
 * When fullInboundTranslated, opener already ran on English — do not re-translate fields with sourceLang.
 */
function properaEnsurePackageSemanticFieldsEnglish_(pkg, sourceLang, fullInboundTranslated, originalRaw) {
  if (!pkg || typeof pkg !== "object") return;
  var sl = String(sourceLang || "en").toLowerCase();
  if (sl.indexOf("-") > 0) sl = sl.split("-")[0];
  if (sl === "en") return;
  var raw = String(originalRaw || "").trim();
  if (fullInboundTranslated) {
    try {
      if (!String(pkg.issue || "").trim() && raw) {
        var fb0 = properaSemanticEnglishFallbackFromRaw_(raw, sl);
        if (fb0) {
          pkg.issue = fb0;
          if (!pkg.issueMeta) {
            pkg.issueMeta = {
              title: fb0,
              bestClauseText: fb0,
              clauses: [{ text: fb0 }],
              category: "",
              urgency: "normal",
              problemSpanCount: 1,
              source: "opener_fallback_en"
            };
          }
        }
      }
    } catch (_) {}
    return;
  }
  try {
    if (String(pkg.issue || "").trim()) {
      pkg.issue = properaCoerceStringToEnglishMeaning_(pkg.issue, sl, raw || pkg.issue);
    }
  } catch (_) {}
  try {
    if (pkg.location && typeof pkg.location === "object" && String(pkg.location.locationText || "").trim()) {
      pkg.location.locationText = properaCoerceStringToEnglishMeaning_(pkg.location.locationText, sl, raw || pkg.location.locationText);
    }
  } catch (_) {}
  try {
    if (pkg.schedule && typeof pkg.schedule === "object" && String(pkg.schedule.raw || "").trim()) {
      pkg.schedule.raw = properaCoerceStringToEnglishMeaning_(pkg.schedule.raw, sl, raw || pkg.schedule.raw);
    }
  } catch (_) {}
  try {
    if (pkg.issueMeta) properaNormalizeIssueMetaToEnglish_(pkg.issueMeta, sl, raw);
  } catch (_) {}
  try {
    if (!String(pkg.issue || "").trim() && raw) {
      var fb = properaSemanticEnglishFallbackFromRaw_(raw, sl);
      if (fb) {
        pkg.issue = fb;
        if (!pkg.issueMeta) {
          pkg.issueMeta = {
            title: fb,
            bestClauseText: fb,
            clauses: [{ text: fb }],
            category: "",
            urgency: "normal",
            problemSpanCount: 1,
            source: "opener_fallback_en"
          };
        }
      }
    }
  } catch (_) {}
}

/**
 * The only supported builder for package shape in production paths.
 * Lang detect + English surface → ONE LLM extraction (StructuredSignal) → canonization → package.
 * Deterministic parse runs ONLY when properaFallbackStructuredSignalFromDeterministicParse_ is invoked (no AI / invalid JSON).
 */
function properaBuildIntakePackage_(opts) {
  opts = opts || {};
  if (typeof properaExtractStructuredSignalLLM_ !== "function" || typeof properaCanonizeStructuredSignal_ !== "function") {
    try {
      if (typeof logDevSms_ === "function") {
        logDevSms_(String(opts.phone || ""), "", "PACKAGE_BUILD_ERR structured_signal_helpers_missing");
      }
    } catch (_) {}
    return null;
  }

  var phone = String(opts.phone || "").trim();
  var tRaw = String(opts.mergedBodyTrim != null ? opts.mergedBodyTrim : opts.bodyTrim || "").trim();
  var hint = String(opts.lang || "en").toLowerCase();

  var mediaPackage = [];
  try {
    var ev = opts.inboundEvent || null;
    if (ev && typeof parseCanonicalMediaArrayFromEvent_ === "function") {
      var rawM = parseCanonicalMediaArrayFromEvent_(ev) || [];
      var mi;
      for (mi = 0; mi < rawM.length; mi++) {
        var mx = rawM[mi];
        if (!mx || typeof mx !== "object") continue;
        var mu = String(mx.url || "").trim();
        if (!mu) continue;
        var mct = String(mx.contentType || mx.mimeType || "").trim();
        var msrc = String(mx.source || "unknown").trim().toLowerCase();
        if (!msrc) msrc = "unknown";
        mediaPackage.push({ url: mu, contentType: mct, source: msrc });
      }
    }
  } catch (_) {}

  var det = properaDetectInboundLang_(tRaw, hint);
  var tSemantic = tRaw;
  var translated = false;
  if (det.lang !== "en" && tRaw) {
    var tr = properaNormalizeSemanticTextToEnglish_(tRaw, det.lang);
    if (tr && tr.text) {
      tSemantic = tr.text;
      translated = !!tr.used;
    }
  }

  var apiKeyVision = String(opts.OPENAI_API_KEY || "").trim();
  if (!apiKeyVision) {
    try {
      apiKeyVision = String(PropertiesService.getScriptProperties().getProperty("OPENAI_API_KEY") || "").trim();
    } catch (_) {}
  }
  var mediaVisionInterpreted = false;
  var mediaVisionConfidence = 0;
  var assetHint = "";
  var visionLocRaw = "";
  var visionIssueHint = "";
  var firstImageItem = null;
  var mj;
  for (mj = 0; mj < mediaPackage.length; mj++) {
    var typChk = String(mediaPackage[mj].contentType || "").trim().toLowerCase().split(";")[0];
    if (typChk && typChk.indexOf("image/") === 0) {
      firstImageItem = mediaPackage[mj];
      break;
    }
  }
  if (firstImageItem && apiKeyVision && typeof properaOpenerVisionIntakeOnce_ === "function") {
    var vRes = properaOpenerVisionIntakeOnce_(phone, apiKeyVision, firstImageItem, tSemantic);
    if (vRes && vRes.ok && String(vRes.issueHint || "").trim()) {
      visionIssueHint = String(vRes.issueHint).trim();
      assetHint = String(vRes.assetHint || "").trim();
      visionLocRaw = String(vRes.locationArea || "").trim();
      mediaVisionConfidence = typeof vRes.confidence === "number" ? vRes.confidence : 0;
      mediaVisionInterpreted = true;
      try {
        if (typeof logDevSms_ === "function") logDevSms_(phone, "", "PACKAGE_MEDIA_VISION ok=1");
      } catch (_) {}
    }
  }

  var tForExtraction = tSemantic;
  if (mediaVisionInterpreted && visionIssueHint) tForExtraction = visionIssueHint;

  var sig = null;
  var extOk = false;
  if (apiKeyVision && tForExtraction) {
    var ex = properaExtractStructuredSignalLLM_({
      text: tForExtraction,
      phone: phone,
      apiKey: apiKeyVision,
      lang: det.lang,
      context: opts.cigContext || null
    });
    if (ex && ex.ok && ex.signal) {
      sig = properaCanonizeStructuredSignal_(ex.signal, phone, "llm", tSemantic || tRaw);
      extOk = true;
    }
  }
  if ((!sig || !sig.issues || !sig.issues.length) && tForExtraction && typeof properaFallbackStructuredSignalFromDeterministicParse_ === "function") {
    // Phase 3 — Kill fallback misuse:
    // If LLM produced a valid non-operational turn classification, do NOT wrap it into fake issues.
    const tt = sig && sig.turnType ? String(sig.turnType).toUpperCase().trim() : "";
    const nonOpTurn = (tt === "CONVERSATIONAL_ONLY" || tt === "STATUS_QUERY" || tt === "UNKNOWN");
    if (sig && nonOpTurn) {
      try {
        if (typeof logDevSms_ === "function") logDevSms_(phone, "", "PACKAGE_FALLBACK_SKIP reason=[" + tt + "]");
      } catch (_) {}
    } else {
      sig = properaFallbackStructuredSignalFromDeterministicParse_(tForExtraction, phone);
      extOk = false;
    }
  }
  if (!sig) sig = properaStructuredSignalEmpty_();

  if (mediaVisionInterpreted && visionIssueHint && (!sig.issues || !sig.issues.length)) {
    sig.issues = [{
      title: visionIssueHint.slice(0, 280),
      summary: visionIssueHint.slice(0, 500),
      tenantDescription: String(tSemantic || "").trim().slice(0, 900),
      locationArea: String(visionLocRaw || "").trim().slice(0, 80),
      locationDetail: "",
      locationType: "UNIT",
      category: String(assetHint || "").slice(0, 80),
      urgency: "normal"
    }];
    sig.extractionSource = (extOk && sig.extractionSource ? sig.extractionSource + "+" : "") + "vision_issue_fill";
  }

  try {
    if (typeof evaluateEmergencySignal_ === "function" && tSemantic) {
      var em = evaluateEmergencySignal_(tSemantic, { phone: phone });
      if (em && em.isEmergency) {
        sig.safety = sig.safety || {};
        sig.safety.isEmergency = true;
        if (em.emergencyType) sig.safety.emergencyType = String(em.emergencyType || "").trim();
        sig.safety.skipScheduling = !!em.skipScheduling;
        sig.safety.requiresImmediateInstructions = !!em.requiresImmediateInstructions;
      }
    }
  } catch (_) {}

  var slotFillApplied = false;
  var scheduleFillApplied = false;
  try {
    var _pcs = "";
    if (opts.baseVarsRef && typeof opts.baseVarsRef === "object") {
      _pcs = String(opts.baseVarsRef.__pendingCollectStage || "").trim().toUpperCase();
    }
    if (!_pcs) _pcs = String(opts.pendingCollectStage || "").trim().toUpperCase();
    if (typeof properaTryNormalizeStructuredSignalForPendingSlots_ === "function") {
      var _sfn = properaTryNormalizeStructuredSignalForPendingSlots_(sig, tForExtraction, phone, _pcs);
      if (_sfn && _sfn.sig) sig = _sfn.sig;
      slotFillApplied = !!(_sfn && _sfn.slotFillApplied);
    }
    // Opportunistic schedule capture in slot-collection stages:
    // if tenant answers unit/property and also includes availability, keep both.
    if ((_pcs === "PROPERTY" || _pcs === "PROPERTY_AND_UNIT" || _pcs === "UNIT" || _pcs === "ISSUE" || _pcs === "DETAIL" || _pcs === "SCHEDULE" || _pcs === "SCHEDULE_PRETICKET" || _pcs === "FINALIZE_DRAFT") && sig && typeof sig === "object") {
      var _schedRawAny = String((sig.schedule && sig.schedule.raw) || "").trim();
      var _textAny = String(tForExtraction || "").trim();
      if (!_schedRawAny && _textAny) {
        var _looksSchedAny = false;
        try { if (typeof isScheduleLike_ === "function") _looksSchedAny = !!isScheduleLike_(_textAny); } catch (_) {}
        if (!_looksSchedAny) _looksSchedAny = /\b(today|tomorrow|tonight|morning|afternoon|evening|am|pm|after|before|between|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(_textAny);
        if (_looksSchedAny) _schedRawAny = _textAny.slice(0, 500);
      }
      if (_schedRawAny) {
        sig.schedule = { raw: _schedRawAny };
        sig.turnType = "OPERATIONAL_ONLY";
        sig.conversationMove = "NONE";
        sig.statusQueryType = "NONE";
        sig.conversationalReply = "";
        // If this turn produced only schedule-like synthetic issue text, drop it.
        var _dropSchedOnlyIssue = false;
        try {
          if (Array.isArray(sig.issues) && sig.issues.length === 1) {
            var _i0 = sig.issues[0] || {};
            var _i0txt = String(_i0.summary || _i0.title || "").trim();
            var _i0Sched = false;
            try { if (typeof isScheduleLike_ === "function") _i0Sched = !!isScheduleLike_(_i0txt); } catch (_) {}
            if (!_i0Sched) _i0Sched = /\b(today|tomorrow|tonight|morning|afternoon|evening|am|pm|after|before|between|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(_i0txt);
            _dropSchedOnlyIssue = !!_i0Sched;
          }
        } catch (_) {}
        if (_dropSchedOnlyIssue) sig.issues = [];
        if (!sig.propertyCode && opts.baseVarsRef && opts.baseVarsRef.__priorPendingPropertyCode) {
          sig.propertyCode = String(opts.baseVarsRef.__priorPendingPropertyCode || "").trim();
          sig.propertyName = String(opts.baseVarsRef.__priorPendingPropertyName || "").trim();
        }
        if (!String(sig.unit || "").trim() && opts.baseVarsRef && opts.baseVarsRef.__priorPendingUnit) {
          sig.unit = String(opts.baseVarsRef.__priorPendingUnit || "").trim();
          try { if (typeof normalizeUnit_ === "function") sig.unit = normalizeUnit_(sig.unit) || sig.unit; } catch (_) {}
        }
        scheduleFillApplied = true;
      }
    }
    if ((_pcs === "SCHEDULE" || _pcs === "SCHEDULE_PRETICKET" || _pcs === "FINALIZE_DRAFT") && sig && typeof sig === "object") {
      var _schedRaw = String((sig.schedule && sig.schedule.raw) || "").trim();
      if (!_schedRaw) {
        var _looksSched = false;
        try { if (typeof isScheduleLike_ === "function") _looksSched = !!isScheduleLike_(tForExtraction); } catch (_) {}
        if (!_looksSched) _looksSched = /\b(today|tomorrow|tonight|morning|afternoon|evening|am|pm|after|before|between|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(String(tForExtraction || ""));
        if (_looksSched) _schedRaw = String(tForExtraction || "").trim().slice(0, 500);
      }
      if (_schedRaw) {
        sig.schedule = { raw: _schedRaw };
        sig.issues = [];
        sig.turnType = "OPERATIONAL_ONLY";
        sig.conversationMove = "NONE";
        sig.statusQueryType = "NONE";
        sig.conversationalReply = "";
        if (!sig.propertyCode && opts.baseVarsRef && opts.baseVarsRef.__priorPendingPropertyCode) {
          sig.propertyCode = String(opts.baseVarsRef.__priorPendingPropertyCode || "").trim();
          sig.propertyName = String(opts.baseVarsRef.__priorPendingPropertyName || "").trim();
        }
        if (!String(sig.unit || "").trim() && opts.baseVarsRef && opts.baseVarsRef.__priorPendingUnit) {
          sig.unit = String(opts.baseVarsRef.__priorPendingUnit || "").trim();
          try { if (typeof normalizeUnit_ === "function") sig.unit = normalizeUnit_(sig.unit) || sig.unit; } catch (_) {}
        }
        var _is = String(sig.intentType || "").trim();
        if (!_is || _is === "MAINTENANCE_REPORT") sig.intentType = "SCHEDULE_SLOT_FILL";
        scheduleFillApplied = true;
      }
    }
  } catch (_) {}

  var firstIss = sig.issues && sig.issues[0] ? sig.issues[0] : null;
  var issueHead = firstIss ? String(firstIss.summary || firstIss.title || "").trim() : "";
  var _priorIss = "";
  if (opts.baseVarsRef && typeof opts.baseVarsRef === "object") {
    _priorIss = String(opts.baseVarsRef.__priorPendingIssue || "").trim();
  }
  if (!issueHead && (slotFillApplied || scheduleFillApplied) && _priorIss) issueHead = _priorIss;

  var propObj = null;
  if (String(sig.propertyCode || "").trim()) {
    propObj = {
      code: String(sig.propertyCode || "").trim(),
      name: String(sig.propertyName || "").trim()
    };
  }

  var locPack = typeof properaLocationPackFromSignalIssue_ === "function"
    ? properaLocationPackFromSignalIssue_(sig, phone)
    : {
        locationType: "UNIT",
        locationArea: "",
        locationDetail: "",
        locationScopeBroad: "UNIT",
        locationScopeRefined: "UNIT",
        locationSource: "structured_signal",
        locationConfidence: 0.55,
        locationText: issueHead
      };

  try {
    if (mediaVisionInterpreted && visionLocRaw && locPack && typeof locPack === "object") {
      var vArea = properaNormalizeVisionLocationArea_(visionLocRaw);
      if (vArea) {
        var curA = String(locPack.locationArea || "").trim();
        var curC = Number(locPack.locationConfidence);
        if (!curA || !isFinite(curC) || curC < 0.72) {
          locPack.locationArea = vArea;
          var ltCur = String(locPack.locationType || "UNIT").toUpperCase();
          if (ltCur === "UNIT") locPack.locationScopeRefined = vArea;
          locPack.locationSource = "package_opener_vision";
          locPack.locationConfidence = Math.max(isFinite(curC) ? curC : 0.5, 0.78);
        }
      }
    }
  } catch (_) {}

  var issueMetaOut = typeof properaIssueMetaFromStructuredSignal_ === "function"
    ? properaIssueMetaFromStructuredSignal_(sig)
    : null;
  if (!issueMetaOut && String(issueHead || "").trim()) {
    issueMetaOut = {
      title: issueHead,
      bestClauseText: issueHead,
      clauses: [{ text: issueHead, title: issueHead, type: "problem" }],
      problemSpanCount: 1,
      source: (slotFillApplied || scheduleFillApplied) ? "prior_draft_slot_fill" : "package_fallback",
      category: "",
      urgency: "normal"
    };
  }

  var pkg = {
    __openerInterpreted: true,
    __properaIntakePackage: true,
    packageVersion: 3,
    property: propObj,
    unit: String(sig.unit || "").trim(),
    // Phase 2 — carry CIG turn classification fields through intake package.
    turnType: String(sig.turnType || "UNKNOWN").toUpperCase().trim(),
    conversationMove: String(sig.conversationMove || "NONE").toUpperCase().trim(),
    statusQueryType: String(sig.statusQueryType || "NONE").toUpperCase().trim(),
    conversationalReply: String(sig.conversationalReply || "").trim().slice(0, 600),
    issue: issueHead,
    issueHint: issueHead,
    issueMeta: issueMetaOut,
    schedule: sig.schedule && sig.schedule.raw ? { raw: String(sig.schedule.raw) } : null,
    safety: {
      isEmergency: !!(sig.safety && sig.safety.isEmergency),
      emergencyType: String((sig.safety && sig.safety.emergencyType) || "").trim(),
      skipScheduling: !!(sig.safety && sig.safety.skipScheduling),
      requiresImmediateInstructions: !!(sig.safety && sig.safety.requiresImmediateInstructions)
    },
    location: locPack,
    missingSlots: {
      propertyMissing: !(propObj && propObj.code),
      unitMissing: !String(sig.unit || "").trim(),
      issueMissing: !String(issueHead || "").trim(),
      scheduleMissing: !(sig.schedule && String(sig.schedule.raw || "").trim())
    },
    domainHint: typeof properaNormalizeDomainHint_ === "function"
      ? properaNormalizeDomainHint_(sig.domainHint || "UNKNOWN")
      : String(sig.domainHint || "UNKNOWN").toUpperCase().trim(),
    structuredSignal: sig
  };

  pkg.lang = det.lang;
  pkg.langSource = det.source + (translated ? "+translate" : "");
  pkg.langConfidence = det.confidence;
  pkg.originalText = tRaw;
  pkg.semanticTextEnglish = tForExtraction;
  pkg.media = mediaPackage;
  pkg.assetHint = assetHint;
  pkg.mediaVisionInterpreted = mediaVisionInterpreted;
  pkg.mediaVisionConfidence = mediaVisionConfidence;

  properaEnsurePackageSemanticFieldsEnglish_(pkg, det.lang, translated, tRaw);
  pkg.issue = String(pkg.issue || "").trim();
  pkg.issueHint = String(pkg.issue || "").trim();
  if (pkg.issueMeta) properaStampIssueMetaEnglish_(pkg.issueMeta);
  if (!pkg.issue && pkg.missingSlots) pkg.missingSlots.issueMissing = true;

  try {
    if (typeof logDevSms_ === "function") {
      logDevSms_(phone, "", "PACKAGE_LANG lang=[" + pkg.lang + "] conf=" + String(pkg.langConfidence) + " src=[" + pkg.langSource + "] translated=" + (translated ? "1" : "0"));
      logDevSms_(phone, "", "PACKAGE_SIGNAL src=[" + String((sig && sig.extractionSource) || "") + "] issues=" + String((sig && sig.issues) ? sig.issues.length : 0));
    }
  } catch (_) {}

  // Keep pkg.turnType aligned with structuredSignal (same object ref); CIG reads top-level first.
  try {
    if (pkg.structuredSignal && typeof pkg.structuredSignal === "object") {
      var _stt = String(pkg.structuredSignal.turnType || "").trim().toUpperCase();
      if (_stt === "OPERATIONAL_ONLY") pkg.turnType = "OPERATIONAL_ONLY";
    }
  } catch (_) {}

  return pkg;
}

/**
 * Next abstract progression step from package missing slots only (no sheet, no raw text).
 */
function properaIntakeNextProgressFromPackage_(pkg) {
  var ms = pkg && pkg.missingSlots;
  if (!ms) return "";
  if (ms.propertyMissing) return (ms.unitMissing && !ms.issueMissing) ? "PROPERTY_AND_UNIT" : "PROPERTY";
  if (ms.unitMissing) return "UNIT";
  if (ms.issueMissing) return "ISSUE";
  if (ms.scheduleMissing) return "SCHEDULE";
  return "FINALIZE_READY";
}

function properaBrainMapProgressToDurableStage_(progress, pkg) {
  var p = String(progress || "").toUpperCase();
  if (!p) return "";
  if (pkg && pkg.safety && pkg.safety.isEmergency) return "EMERGENCY_DONE";
  if (p === "SCHEDULE") return "SCHEDULE_PRETICKET";
  if (p === "FINALIZE_READY") return "FINALIZE_DRAFT";
  if (p === "PROPERTY_AND_UNIT") return "PROPERTY";
  return p;
}

/** Pre-ticket funnel rank; higher = later. Stops brain from overwriting canonical when canonical is ahead (e.g. package says unitMissing but IntakeMemory already has unit → SCHEDULE_PRETICKET). */
function properaIntakeStageRank_(s) {
  var x = String(s || "").trim().toUpperCase();
  var order = {
    "": 0,
    "PROPERTY": 15,
    "PROPERTY_AND_UNIT": 15,
    "UNIT": 25,
    "ISSUE": 35,
    "SCHEDULE_PRETICKET": 45,
    "SCHEDULE": 55,
    "FINALIZE_DRAFT": 65,
    "EMERGENCY_DONE": 75
  };
  return order[x] != null ? order[x] : 0;
}

/**
 * Brain entry: sync session + ctx + Directory pending stage from package only (pre-ticket).
 * Does not scan raw body text. Returns { ok, stage, progress } or { ok: false }.
 */
function properaBrainConsumeIntakePackage_(phone, dir, dirRow, pkg, pendingRow) {
  if (!phone || !dir || dirRow < 2 || !pkg || typeof pkg !== "object") return { ok: false };
  if (!pkg.__properaIntakePackage && !pkg.__openerInterpreted) return { ok: false };
  var pr = Number(pendingRow || 0) || 0;
  if (pr >= 2) return { ok: false };

  var progress = properaIntakeNextProgressFromPackage_(pkg);
  var stage = properaBrainMapProgressToDurableStage_(progress, pkg);
  if (!stage) return { ok: false };

  var stageFromBrain = stage;
  try {
    if (stageFromBrain !== "EMERGENCY_DONE" && typeof ensureCanonicalIntakeSheet_ === "function" && typeof canonicalIntakeLoadNoLock_ === "function") {
      var sh0 = ensureCanonicalIntakeSheet_();
      var cRec = canonicalIntakeLoadNoLock_(sh0, phone);
      var canonNext = (cRec && cRec.activeIntake) ? String(cRec.expectedNext || "").trim().toUpperCase() : "";
      if (canonNext && properaIntakeStageRank_(stageFromBrain) < properaIntakeStageRank_(canonNext)) {
        stage = canonNext;
        try {
          if (typeof logDevSms_ === "function") {
            logDevSms_(phone, "", "BRAIN_FROM_PACKAGE_CANONICAL_AHEAD brainStage=[" + stageFromBrain + "] appliedStage=[" + stage + "] canonExpected=[" + canonNext + "]");
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  var expiryMins = (stage === "SCHEDULE" || stage === "SCHEDULE_PRETICKET") ? 30 : 10;
  var pendingExpiresAtIso = new Date(Date.now() + expiryMins * 60 * 1000).toISOString();

  var renderLang = String(pkg.lang || "en").toLowerCase().replace(/_/g, "-");
  if (renderLang.indexOf("-") > 0) renderLang = renderLang.split("-")[0];
  if (!renderLang || renderLang.length < 2) renderLang = "en";

  if (typeof sessionUpsert_ === "function") {
    sessionUpsert_(phone, {
      stage: stage,
      expected: stage,
      expiresAtIso: pendingExpiresAtIso,
      lang: renderLang
    }, "brain_from_package");
  }
  if (typeof ctxUpsert_ === "function") {
    ctxUpsert_(phone, {
      pendingExpected: stage,
      pendingExpiresAt: pendingExpiresAtIso,
      lang: renderLang
    }, "brain_from_package");
  }
  try {
    if (typeof dalSetPendingStage_ === "function") {
      dalSetPendingStage_(dir, dirRow, stage, phone, "brain_from_package");
    }
  } catch (_) {}

  var _ms = {};
  try {
    _ms = pkg.missingSlots || {};
  } catch (_) {}
  try {
    if (typeof logDevSms_ === "function") {
      logDevSms_(phone, "", "BRAIN_FROM_PACKAGE expected=[" + stage + "] progress=[" + progress + "] p=" + (_ms.propertyMissing ? "1" : "0") + " u=" + (_ms.unitMissing ? "1" : "0") + " i=" + (_ms.issueMissing ? "1" : "0") + " s=" + (_ms.scheduleMissing ? "1" : "0"));
    }
  } catch (_) {}

  return { ok: true, stage: stage, progress: progress };
}

// Multi-ticket commit issues: use properaCommitIssuesFromPackage_ (PROPERA_STRUCTURED_SIGNAL.gs) only — no re-parse / buffer re-derivation.


// ===================================================================
// PACK B MERGE: Structured Signal internals moved here
// Canonical Pack B file owns all semantic extraction/runtime helpers.
// ===================================================================

/**
 * PROPERA_STRUCTURED_SIGNAL.gs
 *
 * North Compass — single inbound interpretation artifact after AI extraction:
 *   Signal normalize → ONE LLM extraction → canonization → package / brain
 *
 * StructuredSignal is the only operational meaning carrier from extraction.
 * intentType / operationMode / actorType are *extraction hypotheses* for the resolver;
 * the brain remains authoritative (PROPERA_GUARDRAILS.md §1).
 *
 * @typedef {Object} StructuredSignalIssue
 * @property {string} title
 * @property {string} summary
 * @property {string} tenantDescription
 * @property {string} locationArea
 * @property {string} locationDetail
 * @property {string} locationType — UNIT|COMMON_AREA
 * @property {string} category
 * @property {string} urgency — normal|urgent
 *
 * @typedef {Object} StructuredSignal
 * @property {string} actorType — TENANT|STAFF|UNKNOWN
 * @property {string} operationMode — WRITE|READ
 * @property {string} intentType
 * @property {string} propertyCode
 * @property {string} propertyName
 * @property {string} unit
 * @property {StructuredSignalIssue[]} issues
 * @property {{raw:string}|null} schedule
 * @property {Object} actionSignals
 * @property {string} queryType
 * @property {Object} targetHints
 * @property {number} confidence
 * @property {{flags:Array,notes:string}} ambiguity
 * @property {string} domainHint
 * @property {{isEmergency:boolean,emergencyType:string,skipScheduling:boolean,requiresImmediateInstructions:boolean}} safety
 * @property {string} extractionSource — llm|fallback_parse
 */

function properaStructuredSignalEmpty_() {
  return {
    actorType: "UNKNOWN",
    operationMode: "WRITE",
    intentType: "",
    propertyCode: "",
    propertyName: "",
    unit: "",
    turnType: "UNKNOWN",
    conversationMove: "NONE",
    statusQueryType: "NONE",
    conversationalReply: "",
    issues: [],
    schedule: null,
    actionSignals: {},
    queryType: "",
    targetHints: {},
    confidence: 0,
    ambiguity: { flags: [], notes: "" },
    domainHint: "UNKNOWN",
    safety: { isEmergency: false, emergencyType: "", skipScheduling: false, requiresImmediateInstructions: false },
    extractionSource: ""
  };
}

/** Validate raw LLM object has at least one issue with summary/title. */
function properaRawStructuredSignalIsValid_(obj) {
  if (!obj || typeof obj !== "object") return false;

  // Phase 2 — accept non-operational turns as valid.
  // This prevents discarding correct conversational/status classification.
  var tt = String(obj.turnType || "").toUpperCase().trim();
  if (tt === "CONVERSATIONAL_ONLY" || tt === "STATUS_QUERY" || tt === "MIXED" || tt === "UNKNOWN") return true;

  var sched = obj.schedule;
  if (sched && typeof sched === "object" && String(sched.raw || "").trim()) return true;
  var arr = obj.issues;
  if (!Array.isArray(arr) || arr.length < 1) return false;
  for (var i = 0; i < arr.length; i++) {
    var it = arr[i];
    if (!it || typeof it !== "object") return false;
    var sum = String(it.summary || it.title || "").trim();
    if (!sum) return false;
  }
  return true;
}

/**
 * Single LLM call — full StructuredSignal JSON. No parallel heuristic interpreter.
 * @param {{text:string,phone:string,apiKey:string,lang:string}} opts
 * @returns {{ ok: boolean, signal: Object|null, err: string }}
 */
function properaExtractStructuredSignalLLM_(opts) {
  opts = opts || {};
  var phone = String(opts.phone || "").trim();
  var apiKey = String(opts.apiKey || "").trim();
  var input = String(opts.text || "").trim();
  if (!apiKey || !input) return { ok: false, signal: null, err: "missing_key_or_text" };
  if (input.length > 3500) input = input.slice(0, 3500);

  var modelName = "gpt-4.1-mini";
  try {
    var sp2 = PropertiesService.getScriptProperties();
    var m = String(sp2.getProperty("OPENAI_MODEL_EXTRACT") || "").trim();
    if (m) modelName = m;
  } catch (_) {}

  var system =
    "You are the ONLY interpreter of this inbound message for a property operations system.\n" +
    "Return JSON ONLY. No markdown, no commentary.\n\n" +
    "Schema (all keys required; use \"\" or [] or null or {} where unknown):\n" +
    "- actorType: TENANT | STAFF | UNKNOWN\n" +
    "- operationMode: WRITE | READ\n" +
    "- intentType: short label for the maintenance/request intent (hypothesis for routing, not authority)\n" +
    "- propertyCode: known building code ONLY if directly stated in the current message text, else \"\"\n" +
    "- propertyName: building name ONLY if directly stated in the current message text, else \"\"\n" +
    "- unit: apartment/unit if stated, else \"\"\n" +
    "- issues: array of { title, summary, tenantDescription, locationArea, locationDetail, locationType, category, urgency }\n" +
    "  title: short headline; summary: one-line English summary (required); tenantDescription: optional raw phrasing;\n" +
    "  locationType: UNIT | COMMON_AREA; locationArea/locationDetail: English; category: short; urgency: normal | urgent\n" +
    "- schedule: { \"raw\": string } or null — availability / time window only, else null\n" +
    "- actionSignals: object (booleans or strings the ops engine may use as hints)\n" +
    "- queryType: \"\" or short label if this is a question not a work request\n" +
    "- targetHints: object (hints only)\n" +
    "- turnType: OPERATIONAL_ONLY | CONVERSATIONAL_ONLY | MIXED | STATUS_QUERY | UNKNOWN\n" +
    "- conversationMove: THANKS | ACK | GREETING | GOODBYE | QUESTION | APOLOGY | FRUSTRATION | NONE\n" +
    "- statusQueryType: NONE | SCHEDULE | ETA | OWNER | GENERAL_STATUS\n" +
    "- conversationalReply: string — brief natural reply candidate for CONVERSATIONAL_ONLY or STATUS_QUERY turns; empty string otherwise\n" +
    "- confidence: number 0..1\n" +
    "- ambiguity: { \"flags\": string[], \"notes\": string }\n" +
    "- domainHint: MAINTENANCE | AMENITY | LEASING | CLEANING | CONFLICT | GENERAL | UNKNOWN\n" +
    "- safety: { \"isEmergency\": bool, \"emergencyType\": string, \"skipScheduling\": bool, \"requiresImmediateInstructions\": bool }\n\n" +
    "Rules:\n" +
    "- Extract ALL distinct maintenance problems as separate issues.\n" +
    "- English for summary/title and operational strings.\n" +
    "- Put availability only in schedule.raw, not inside issue summaries.\n" +
    "- Ignore troubleshooting narrative as separate issues unless it describes a remaining defect.\n" +
    "- Slot grounding is strict: only fill property, unit, and schedule when that slot is actually present in the current message text.\n" +
    "- For property, NEVER infer from unit number alone, issue type, prior turns, authenticated identity, known tenant/building mapping, supplied context, or schedule text.\n" +
    "- Context may help classify the turn, but context must not create property values that are absent from the current message.\n" +
    "- If property is not explicitly named in the current message, return propertyCode=\"\" and propertyName=\"\".\n" +
    "- It is better to leave property empty than to guess.\n" +
    "\n" +
    "Turn classification (required, all keys required):\n" +
    "- turnType:\n" +
    "  CONVERSATIONAL_ONLY: message is purely social (thanks, greeting, acknowledgment, small talk, emoji-only, venting) with NO maintenance/operational content and NO status question.\n" +
    "  OPERATIONAL_ONLY: message contains maintenance request, issue report, slot answer (property, unit, schedule), or explicit operational instruction with no significant conversational wrapper.\n" +
    "  MIXED: message contains BOTH conversational and operational content. Extract only the operational part into issues/schedule/property/unit.\n" +
    "  STATUS_QUERY: message asks about existing work (when, who, status, ETA, scheduled time). Not a new issue.\n" +
    "  UNKNOWN: cannot classify.\n" +
    "- conversationMove: the social gesture in the message. NONE when purely operational.\n" +
    "- statusQueryType: what the tenant is asking about. NONE unless turnType is STATUS_QUERY.\n" +
    "- conversationalReply: brief natural reply for CONVERSATIONAL_ONLY or STATUS_QUERY turns. Empty string for OPERATIONAL_ONLY. Keep under 2 sentences. Do not invent facts. Do not promise actions.\n" +
    "\n" +
    "Rules for turn classification:\n" +
    "- If the entire message is a social gesture (thanks, ok, got it, lol, emoji, greeting, goodbye, venting) with no maintenance issue, schedule, property, or unit — turnType is CONVERSATIONAL_ONLY. issues MUST be [].\n" +
    "- If the message answers a pending question (provides property name, unit number, schedule preference) — turnType is OPERATIONAL_ONLY even if it starts with \"ok\" or \"thanks\".\n" +
    "- If the message is BOTH social and operational — turnType is MIXED. Put operational data into issues/schedule/property/unit. The social part only affects conversationMove.\n" +
    "- If the message asks about status of existing work — turnType is STATUS_QUERY. issues MUST be [].\n" +
    "\n" +
    "Context guidance (Phase 6):\n" +
    "- If context.activeExpectedSlot is set and the message looks like an answer to that slot, treat it as OPERATIONAL_ONLY (or MIXED if it also contains social content), even if it starts with \"ok\" or \"thanks\".\n" +
    "- If context.lastOutboundType indicates we just confirmed something, and the message is pure acknowledgment, treat it as CONVERSATIONAL_ONLY.\n" +
    "- Do not invent facts: only use facts present in the message.\n";

  var ctxObj = (opts.context && typeof opts.context === "object") ? opts.context : null;
  var ctxStr = "";
  if (ctxObj) {
    try {
      ctxStr = "\ncontext=" + JSON.stringify(ctxObj);
      if (ctxStr.length > 1800) ctxStr = ctxStr.slice(0, 1800);
    } catch (_) { ctxStr = ""; }
  }

  var user = "lang_hint=" + JSON.stringify(String(opts.lang || "en")) + "\nmessage=" + JSON.stringify(input) + ctxStr;

  var r = (typeof openaiChatJson_ === "function")
    ? openaiChatJson_({
        apiKey: apiKey,
        model: modelName,
        system: system,
        user: user,
        timeoutMs: 22000,
        phone: phone,
        logLabel: "STRUCTURED_SIGNAL_EXTRACT",
        maxRetries: 2
      })
    : { ok: false };
  if (r.err === "cooldown") {
    try { if (typeof logDevSms_ === "function") logDevSms_(phone, "", "STRUCTURED_SIGNAL skip=1 cooldown"); } catch (_) {}
    return { ok: false, signal: null, err: "cooldown" };
  }
  if (!r.ok || !r.json) return { ok: false, signal: null, err: "api_fail" };
  if (!properaRawStructuredSignalIsValid_(r.json)) return { ok: false, signal: null, err: "invalid_shape" };
  return { ok: true, signal: r.json, err: "" };
}

/**
 * Deterministic canonization: trim, enums, property match, no new meaning.
 * @param {Object} raw — LLM or fallback object
 * @param {string} phone
 * @param {string} extractionSource
 * @param {string} messageText
 * @returns {StructuredSignal}
 */
function properaCanonizeStructuredSignal_(raw, phone, extractionSource, messageText) {
  var out = properaStructuredSignalEmpty_();
  if (!raw || typeof raw !== "object") return out;
  var r = raw;
  var at = String(r.actorType || "").toUpperCase().trim();
  if (at === "TENANT" || at === "STAFF") out.actorType = at;
  var om = String(r.operationMode || "WRITE").toUpperCase().trim();
  out.operationMode = om === "READ" ? "READ" : "WRITE";
  out.intentType = String(r.intentType || "").trim().slice(0, 120);
  out.propertyCode = String(r.propertyCode || "").trim().slice(0, 64);
  out.propertyName = String(r.propertyName || "").trim().slice(0, 120);
  out.unit = String(r.unit || "").trim();
  if (typeof normalizeUnit_ === "function" && out.unit) {
    try { out.unit = normalizeUnit_(out.unit) || out.unit; } catch (_) {}
  }
  out.queryType = String(r.queryType || "").trim().slice(0, 80);

  // Phase 2 — preserve + sanitize CIG turn classification fields.
  var tt2 = String(r.turnType || "").toUpperCase().trim();
  if (tt2 === "OPERATIONAL_ONLY" || tt2 === "CONVERSATIONAL_ONLY" || tt2 === "MIXED" || tt2 === "STATUS_QUERY" || tt2 === "UNKNOWN") {
    out.turnType = tt2;
  }

  var cm2 = String(r.conversationMove || "").toUpperCase().trim();
  var cmAllowed = ["THANKS", "ACK", "GREETING", "GOODBYE", "QUESTION", "APOLOGY", "FRUSTRATION", "NONE"];
  if (cmAllowed.indexOf(cm2) >= 0) out.conversationMove = cm2;

  var sq2 = String(r.statusQueryType || "").toUpperCase().trim();
  var sqAllowed = ["NONE", "SCHEDULE", "ETA", "OWNER", "GENERAL_STATUS"];
  if (sqAllowed.indexOf(sq2) >= 0) out.statusQueryType = sq2;

  // Enforce contract shape: statusQueryType NONE unless STATUS_QUERY; conversationalReply only for conversational/status.
  if (out.turnType !== "STATUS_QUERY") out.statusQueryType = "NONE";
  var cr2 = String(r.conversationalReply || "").trim().slice(0, 600);
  if (out.turnType === "CONVERSATIONAL_ONLY" || out.turnType === "STATUS_QUERY") out.conversationalReply = cr2;
  else out.conversationalReply = "";

  out.confidence = Number(r.confidence);
  if (!isFinite(out.confidence) || out.confidence < 0) out.confidence = 0;
  if (out.confidence > 1) out.confidence = 1;
  try {
    out.actionSignals = r.actionSignals && typeof r.actionSignals === "object" ? r.actionSignals : {};
  } catch (_) {
    out.actionSignals = {};
  }
  try {
    out.targetHints = r.targetHints && typeof r.targetHints === "object" ? r.targetHints : {};
  } catch (_) {
    out.targetHints = {};
  }
  try {
    var amb = r.ambiguity;
    if (amb && typeof amb === "object") {
      out.ambiguity = {
        flags: Array.isArray(amb.flags) ? amb.flags.map(function (x) { return String(x || "").trim(); }).filter(Boolean) : [],
        notes: String(amb.notes || "").trim().slice(0, 500)
      };
    }
  } catch (_) {}

  var dh = String(r.domainHint || "").toUpperCase().trim();
  if (typeof properaNormalizeDomainHint_ === "function") out.domainHint = properaNormalizeDomainHint_(dh);
  else out.domainHint = dh || "UNKNOWN";

  try {
    var saf = r.safety || {};
    out.safety = {
      isEmergency: !!saf.isEmergency,
      emergencyType: String(saf.emergencyType || "").trim(),
      skipScheduling: !!saf.skipScheduling,
      requiresImmediateInstructions: !!saf.requiresImmediateInstructions
    };
  } catch (_) {}

  var issuesIn = Array.isArray(r.issues) ? r.issues : [];
  var issues = [];
  for (var i = 0; i < issuesIn.length; i++) {
    var it = issuesIn[i];
    if (!it || typeof it !== "object") continue;
    var summary = String(it.summary || it.title || "").trim();
    var title = String(it.title || it.summary || "").trim();
    if (!summary && !title) continue;
    if (!summary) summary = title;
    if (!title) title = summary;
    var lt = String(it.locationType || "UNIT").toUpperCase().trim();
    if (lt !== "UNIT" && lt !== "COMMON_AREA") lt = "UNIT";
    var ur = String(it.urgency || "normal").toLowerCase().trim();
    if (ur !== "urgent") ur = "normal";
    issues.push({
      title: title.slice(0, 280),
      summary: summary.slice(0, 500),
      tenantDescription: String(it.tenantDescription || "").trim().slice(0, 900),
      locationArea: String(it.locationArea || "").trim().slice(0, 80),
      locationDetail: String(it.locationDetail || "").trim().slice(0, 120),
      locationType: lt,
      category: String(it.category || "").trim().slice(0, 80),
      urgency: ur
    });
  }
  out.issues = issues;

  var sched = r.schedule;
  if (sched && typeof sched === "object" && String(sched.raw || "").trim()) {
    out.schedule = { raw: String(sched.raw).trim().slice(0, 500) };
  } else {
    var an = String(r.access_notes || "").trim();
    if (an) out.schedule = { raw: an.slice(0, 500) };
    else out.schedule = null;
  }

  out.extractionSource = String(extractionSource || "").trim() || "llm";

  // Property must be explicitly grounded in the current message text.
  // Do not let LLM guesses or issue text promote a building into truth.
  var msgText = String(messageText || "").trim();
  if (msgText) {
    try {
      // 1) exact-only (single-token/phrase replies like "penn")
      var explicitProp = (typeof resolvePropertyExplicitOnly_ === "function")
        ? resolvePropertyExplicitOnly_(msgText)
        : null;
      // 2) strict phrase-in-text fallback (e.g. "apt 402 at Penn")
      if (!explicitProp && typeof resolvePropertyFromText_ === "function") {
        explicitProp = resolvePropertyFromText_(msgText, { strict: true });
      }
      if (explicitProp && explicitProp.code) {
        out.propertyCode = String(explicitProp.code || "").trim();
        out.propertyName = String(explicitProp.name || out.propertyName || "").trim();
      } else {
        out.propertyCode = "";
        out.propertyName = "";
      }
    } catch (_) {}
  }
  if (out.propertyCode && typeof getPropertyByCode_ === "function") {
    try {
      var pc = getPropertyByCode_(out.propertyCode);
      if (pc && pc.name) out.propertyName = String(pc.name || out.propertyName || "").trim();
    } catch (_) {}
  }

  return out;
}

/**
 * Fallback ONLY when LLM missing or failed. Single parseIssueDeterministic_ pass — no parallel AI.
 */
function properaFallbackStructuredSignalFromDeterministicParse_(text, phone) {
  var out = properaStructuredSignalEmpty_();
  out.extractionSource = "fallback_parse";
  var t = String(text || "").trim();
  if (!t || typeof parseIssueDeterministic_ !== "function") return out;
  var parsed = null;
  try {
    parsed = parseIssueDeterministic_(t, {});
  } catch (_) {
    parsed = null;
  }
  if (!parsed) return out;
  var clauses = Array.isArray(parsed.clauses) ? parsed.clauses : [];
  var issues = [];
  for (var i = 0; i < clauses.length; i++) {
    var c = clauses[i];
    if (!c || String(c.type || "problem") !== "problem") continue;
    var txt = String(c.text || "").trim();
    var tit = String(c.title || txt || "").trim();
    if (!tit && !txt) continue;
    issues.push({
      title: tit.slice(0, 280),
      summary: tit.slice(0, 500),
      tenantDescription: txt.slice(0, 900),
      locationArea: "",
      locationDetail: "",
      locationType: "UNIT",
      category: String(parsed.category || "").trim(),
      urgency: String(parsed.urgency || "normal").toLowerCase() === "urgent" ? "urgent" : "normal"
    });
  }
  if (!issues.length) {
    var one = String(parsed.title || parsed.bestClauseText || "").trim();
    if (!one) one = t.slice(0, 400);
    if (one) {
      issues.push({
        title: one.slice(0, 280),
        summary: one.slice(0, 500),
        tenantDescription: t.slice(0, 900),
        locationArea: "",
        locationDetail: "",
        locationType: "UNIT",
        category: String(parsed.category || "").trim(),
        urgency: "normal"
      });
    }
  }
  out.issues = issues;
  out.intentType = "MAINTENANCE_REPORT";
  out.actorType = "TENANT";
  out.confidence = 0.35;
  if (typeof extractUnit_ === "function") {
    try {
      var u = extractUnit_(t);
      if (u && typeof normalizeUnit_ === "function") out.unit = normalizeUnit_(u) || String(u).trim();
      else if (u) out.unit = String(u).trim();
    } catch (_) {}
  }
  if (typeof resolvePropertyExplicitOnly_ === "function") {
    try {
      var pEx = resolvePropertyExplicitOnly_(t);
      if (pEx && pEx.code) {
        out.propertyCode = String(pEx.code || "").trim();
        out.propertyName = String(pEx.name || "").trim();
      }
    } catch (_) {}
  }
  return out;
}

/**
 * When Directory/ctx expect PROPERTY or PROPERTY_AND_UNIT, short replies like "Unit 405 at Murray"
 * must not become synthetic maintenance issues. Normalize signal to property+unit only.
 * @returns {{ sig: Object, slotFillApplied: boolean }}
 */
function properaTryNormalizeStructuredSignalForPendingSlots_(sig, rawText, phone, pendingCollectStage) {
  var out = { sig: sig, slotFillApplied: false };
  if (!sig || typeof sig !== "object") return out;
  var ps = String(pendingCollectStage || "").trim().toUpperCase();
  if (ps !== "PROPERTY" && ps !== "PROPERTY_AND_UNIT" && ps !== "UNIT") return out;
  var t = String(rawText || "").trim();
  if (!t || t.length > 200) return out;

  if (/\b(clog|clogged|leak|leaking|drain|draining|broken|stuck|smoke|fire|flood|mold|beep|overflow|not working|won'?t work|doesn'?t work|no hot water|hazard|infest)\b/i.test(t)) {
    return out;
  }

  var unitGuess = "";
  try {
    if (typeof extractUnit_ === "function") unitGuess = String(extractUnit_(t) || "").trim();
  } catch (_) {}
  if (!unitGuess) {
    var mu = t.match(/\b(?:apt|apartment|unit)\s*#?\s*([0-9]{1,4}[a-z]?)\b/i);
    if (mu && mu[1]) unitGuess = String(mu[1]).trim();
  }
  if (!unitGuess) {
    var mu2 = t.match(/^\s*#?\s*([0-9]{2,4}[a-z]?)\s+(?:at|@)\s+/i);
    if (mu2 && mu2[1]) unitGuess = String(mu2[1]).trim();
  }
  if (!unitGuess && ps === "UNIT") {
    // Allow bare unit-only replies like "301"
    var md = t.match(/^\s*#?\s*([0-9]{2,4}[a-z]?)\s*$/i);
    if (md && md[1]) unitGuess = String(md[1]).trim();
  }

  // UNIT-only slot fill (e.g. reply "301") should remain operational and never fall through as UNKNOWN.
  if (ps === "UNIT") {
    var haveUnitOnly = !!String(unitGuess || "").trim();
    if (!haveUnitOnly) return out;
    if (typeof normalizeUnit_ === "function") {
      try { sig.unit = normalizeUnit_(unitGuess) || unitGuess; } catch (_) { sig.unit = unitGuess; }
    } else {
      sig.unit = unitGuess;
    }
    sig.issues = [];
    sig.intentType = "PENDING_SLOT_FILL";
    sig.turnType = "OPERATIONAL_ONLY";
    sig.conversationMove = "NONE";
    sig.statusQueryType = "NONE";
    sig.conversationalReply = "";
  } else {
    var propResolved = null;
    try {
      if (typeof resolvePropertyFromText_ === "function") propResolved = resolvePropertyFromText_(t, { strict: false });
    } catch (_) {}
    if (!propResolved || !propResolved.code) {
      try {
        if (typeof resolvePropertyExplicitOnly_ === "function") propResolved = resolvePropertyExplicitOnly_(t);
      } catch (_) {}
    }

    var haveProp = !!(propResolved && propResolved.code);
    var haveUnit = !!String(unitGuess || "").trim();
    if (!haveUnit) return out;

    // PROPERTY_AND_UNIT expects both. PROPERTY can accept unit-only to avoid
    // short-token misclassification as conversational.
    if (ps === "PROPERTY_AND_UNIT" && !haveProp) {
      // Prevent LLM hallucination of propertyCode from "sticky" sig.propertyCode.
      sig.propertyCode = "";
      sig.propertyName = "";
      return out;
    }

    if (haveProp) {
      sig.propertyCode = String(propResolved.code || "").trim();
      sig.propertyName = String(propResolved.name || "").trim();
    } else {
      // If the message does not deterministically carry a property mention, clear
      // any LLM-produced propertyCode so we don't "invent" a building.
      sig.propertyCode = "";
      sig.propertyName = "";
    }
    if (typeof normalizeUnit_ === "function") {
      try { sig.unit = normalizeUnit_(unitGuess) || unitGuess; } catch (_) { sig.unit = unitGuess; }
    } else {
      sig.unit = unitGuess;
    }
    sig.issues = [];
    sig.intentType = "PENDING_SLOT_FILL";
    sig.turnType = "OPERATIONAL_ONLY";
    sig.conversationMove = "NONE";
    sig.statusQueryType = "NONE";
    sig.conversationalReply = "";
  }
  var src0 = String(sig.extractionSource || "").trim();
  sig.extractionSource = src0 ? src0 + "_pending_slot_fill" : "pending_slot_fill";
  out.slotFillApplied = true;
  try {
    if (typeof logDevSms_ === "function") {
      logDevSms_(String(phone || ""), "", "STRUCTURED_SIGNAL_SLOT_FILL prop=[" + sig.propertyCode + "] unit=[" + sig.unit + "] pending=[" + ps + "]");
    }
  } catch (_) {}
  return out;
}

/** Vars for ASK_PROPERTY_AND_UNIT_PACKAGED when multiple issues were extracted. */
function properaPackagedPropertyAskSupplement_(pkg) {
  var sup = { packagedIssueCount: 1, packagedIssuePairLine: "" };
  if (!pkg || typeof pkg !== "object") return sup;
  var n = 0;
  var pair = "";
  if (pkg.structuredSignal && Array.isArray(pkg.structuredSignal.issues)) {
    n = pkg.structuredSignal.issues.length;
    if (n >= 2) {
      var a = pkg.structuredSignal.issues[0];
      var b = pkg.structuredSignal.issues[1];
      var s0 = String((a && (a.summary || a.title)) || "").trim();
      var s1 = String((b && (b.summary || b.title)) || "").trim();
      if (s0 && s1) pair = s0 + " and " + s1;
    }
  }
  if (n < 2 && pkg.issueMeta && Array.isArray(pkg.issueMeta.clauses)) {
    var probs = [];
    var ci;
    for (ci = 0; ci < pkg.issueMeta.clauses.length; ci++) {
      var c = pkg.issueMeta.clauses[ci];
      if (!c || String(c.type || "problem") !== "problem") continue;
      var bit = String(c.title || c.text || "").trim();
      if (bit) probs.push(bit);
    }
    if (probs.length >= 2) {
      n = probs.length;
      pair = probs[0] + " and " + probs[1];
    }
  }
  sup.packagedIssueCount = n >= 2 ? n : 1;
  sup.packagedIssuePairLine = pair;
  return sup;
}

/** Build issueMeta-shaped object from StructuredSignal issues only (legacy consumers). */
function properaIssueMetaFromStructuredSignal_(sig) {
  if (!sig || !Array.isArray(sig.issues) || !sig.issues.length) return null;
  var clauses = [];
  for (var i = 0; i < sig.issues.length; i++) {
    var it = sig.issues[i];
    var text = String(it.tenantDescription || "").trim();
    var title = String(it.summary || it.title || "").trim();
    if (!text) text = title;
    if (!title) title = text;
    if (!text) continue;
    clauses.push({ text: text, title: title, type: "problem" });
  }
  if (!clauses.length) return null;
  var head = String(clauses[0].title || clauses[0].text || "").trim();
  return {
    title: head,
    bestClauseText: head,
    clauses: clauses,
    problemSpanCount: clauses.length,
    source: "structured_signal",
    category: String((sig.issues[0] && sig.issues[0].category) || "").trim(),
    urgency: String((sig.issues[0] && sig.issues[0].urgency) || "normal").toLowerCase() === "urgent" ? "urgent" : "normal"
  };
}

/** Map first issue location to Propera location pack (deterministic defaults). */
function properaLocationPackFromSignalIssue_(sig, phone) {
  var def = {
    locationType: "UNIT",
    locationArea: "",
    locationDetail: "",
    locationScopeBroad: "UNIT",
    locationScopeRefined: "UNIT",
    locationSource: "structured_signal",
    locationConfidence: 0.65,
    locationText: ""
  };
  if (!sig || !sig.issues || !sig.issues[0]) return def;
  var it0 = sig.issues[0];
  var lt = String(it0.locationType || "UNIT").toUpperCase();
  if (lt !== "COMMON_AREA") lt = "UNIT";
  def.locationType = lt;
  def.locationScopeBroad = lt;
  def.locationScopeRefined = lt;
  def.locationArea = String(it0.locationArea || "").trim();
  def.locationDetail = String(it0.locationDetail || "").trim();
  var desc = String(it0.summary || it0.title || "").trim();
  def.locationText = desc.slice(0, 240);
  if (typeof properaNormalizeLocationTypeForTicket_ === "function") {
    try { def.locationType = properaNormalizeLocationTypeForTicket_(def.locationType); } catch (_) {}
  }
  return def;
}

/**
 * Ticket-commit rows from StructuredSignal only (North Compass — no text re-parse).
 * @param {{structuredSignal:Object|null}} ctx — opts or turnFacts
 * @param {string} phone
 * @returns {{ issues: Array, source: string, debug: string }}
 */
function properaCommitIssuesFromPackage_(ctx, phone) {
  var phoneSafe = String(phone || "").trim();
  var slotFillOnly = !!(ctx && ctx.slotFillOnly);
  var attachRole = String((ctx && ctx.attachMessageRole) || "").trim().toLowerCase();
  if (slotFillOnly || attachRole === "slot_fill_only" || attachRole === "schedule_fill_only") {
    try {
      if (typeof logDevSms_ === "function") logDevSms_(phoneSafe, "", "COMMIT_ISSUES_FROM_SIGNAL_SKIP reason=[slot_fill_only]");
    } catch (_) {}
    return { issues: [], source: "slot_fill_only", debug: "issues=0 slot_fill_only=1" };
  }
  var sig = ctx && ctx.structuredSignal ? ctx.structuredSignal : null;
  if (!sig || !Array.isArray(sig.issues) || sig.issues.length < 1) {
    return { issues: [], source: "no_structured_signal", debug: "issues=0" };
  }
  var pendingPropertyCode = String((ctx && ctx.pendingPropertyCode) || "").trim().toUpperCase();
  var pendingPropertyName = String((ctx && ctx.pendingPropertyName) || "").trim().toLowerCase();
  var pendingUnit = String((ctx && ctx.pendingUnit) || "").trim().toUpperCase();
  function normalizeSlotToken_(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }
  function isPureSlotFillIssue_(tx) {
    var t = String(tx || "").trim();
    if (!t) return true;
    var tNorm = normalizeSlotToken_(t);
    if (!tNorm) return true;
    try { if (typeof canonicalInboundLooksScheduleOnly_ === "function" && canonicalInboundLooksScheduleOnly_(tNorm)) return true; } catch (_) {}
    if (pendingPropertyCode && tNorm === pendingPropertyCode.toLowerCase()) return true;
    if (pendingPropertyName && tNorm === normalizeSlotToken_(pendingPropertyName)) return true;
    if (pendingPropertyName) { var stripped = normalizeSlotToken_(pendingPropertyName.replace(/^the\s+grand\s+at\s+/i, "")); if (stripped && tNorm === stripped) return true; }
    if (pendingUnit) {
      var uNorm = pendingUnit.toLowerCase();
      if (tNorm === uNorm) return true;
      var uEsc = uNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if ((new RegExp("^\\s*(?:apt|apartment|unit|#)\\s*" + uEsc + "\\s*$", "i")).test(tNorm)) return true;
    }
    try { if (typeof intakeMaintenanceSymptomHeuristic_ === "function" && !intakeMaintenanceSymptomHeuristic_(tNorm) && /^[a-z0-9#\-]{1,24}$/i.test(tNorm)) return true; } catch (_) {}
    return false;
  }
  var issuesout = [];
  for (var j = 0; j < sig.issues.length; j++) {
    var it = sig.issues[j];
    var title = String(it.summary || it.title || "").trim();
    var tx = String(it.tenantDescription || it.summary || it.title || "").trim();
    if (isPureSlotFillIssue_(tx) || isPureSlotFillIssue_(title)) {
      try { if (typeof logDevSms_ === "function") logDevSms_(phoneSafe, "", "COMMIT_ISSUES_FROM_SIGNAL_SKIP issue=[" + String((title || tx) || "").slice(0, 80) + "] reason=[slot_fill_value]"); } catch (_) {}
      continue;
    }
    if (!title && !tx) continue;
    if (!title) title = tx;
    var lt = String(it.locationType || "UNIT").toUpperCase();
    if (lt !== "UNIT" && lt !== "COMMON_AREA") lt = "UNIT";
    var cat = String(it.category || "").trim();
    var urg = String(it.urgency || "normal").toLowerCase() === "urgent" ? "urgent" : "normal";
    issuesout.push({
      index: issuesout.length,
      rawText: tx.slice(0, 900) || title.slice(0, 900),
      normalizedTitle: title.slice(0, 500),
      category: cat,
      urgency: urg,
      locationType: lt,
      locationArea: String(it.locationArea || "").trim(),
      locationDetail: String(it.locationDetail || "").trim(),
      locationSource: "structured_signal",
      commonArea: lt === "COMMON_AREA",
      inUnit: lt === "UNIT"
    });
  }
  var debug = "issues=" + issuesout.length + " src=" + String(sig.extractionSource || "");
  try {
    if (typeof logDevSms_ === "function") {
      logDevSms_(phoneSafe, "", "COMMIT_ISSUES_FROM_SIGNAL count=" + issuesout.length + " " + debug);
    }
  } catch (_) {}
  return { issues: issuesout, source: String(sig.extractionSource || "structured_signal"), debug: debug };
}




