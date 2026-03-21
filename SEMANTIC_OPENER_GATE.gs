/**
 * SEMANTIC_OPENER_GATE.gs
 *
 * Phase 2 — Gate consolidation (intake boundary):
 * - One gated bundle per inbound turn (16B order): smartExtract (clarity) → inferLocation → schema extract.
 * - When schema extract runs, skip smartExtract in the bundle (schema subsumes issue structuring for long/multi-issue).
 * - Downstream callers reuse results via globalThis.__sopPhase2Intake (same execution only).
 * - processTicket_ may skip advisory classify_ LLM when schema/smartExtract intake is sufficient (hardEmergency_ still wins).
 * - Non-authoritative for routing: deterministic resolver/lifecycle/ticket authority unchanged.
 */

/** Map schema extract trade → Sheet1 CAT-style category label. */
function sopPhase2TradeToCategory_(trade) {
  var t = String(trade || "").toLowerCase().trim();
  var m = {
    plumbing: "Plumbing",
    electrical: "Electrical",
    hvac: "HVAC",
    appliance: "Appliance",
    general: "General",
    other: "Other"
  };
  return m[t] || "";
}

/** Best-effort normalize short issue category string from schema JSON. */
function sopPhase2NormalizeIssueCategoryField_(s) {
  var lower = String(s || "").toLowerCase().trim();
  if (!lower) return "";
  var allowed = {
    appliance: "Appliance", cleaning: "Cleaning", electrical: "Electrical", general: "General",
    hvac: "HVAC", "lock/key": "Lock/Key", lock: "Lock/Key", key: "Lock/Key",
    plumbing: "Plumbing", "paint/repair": "Paint/Repair", paint: "Paint/Repair", repair: "Paint/Repair",
    pest: "Pest", safety: "Safety", other: "Other"
  };
  if (allowed[lower]) return allowed[lower];
  for (var k in allowed) {
    if (lower.indexOf(k) >= 0) return allowed[k];
  }
  return "";
}

/**
 * Build classify_-shaped classification from intake bag (same execution as handleSmsCore_).
 * Returns null → caller runs classify_ LLM. Always honors hardEmergency_ first.
 */
function sopPhase2TryClassificationFromIntake_(messageRaw, unitFromText, afterHours) {
  var msg = String(messageRaw || "");
  try {
    if (typeof hardEmergency_ === "function") {
      var hard = hardEmergency_(msg);
      if (hard && hard.emergency) return hard;
    }
  } catch (_) {}

  var bag = null;
  try {
    bag = (typeof globalThis !== "undefined") ? globalThis.__sopPhase2Intake : null;
  } catch (_) {}
  if (!bag || bag.skippedBundle) return null;

  var sch = bag.schemaObj;
  if (sch && typeof isValidSchemaIssues_ === "function" && isValidSchemaIssues_(sch)) {
    var issues = sch.issues || [];
    var first = issues[0] || {};
    var trade = String(first.trade || "").toLowerCase().trim();
    var catFromTrade = sopPhase2TradeToCategory_(trade);
    if (!catFromTrade) catFromTrade = sopPhase2NormalizeIssueCategoryField_(first.category);
    if (!catFromTrade) {
      try {
        if (typeof localCategoryFromText_ === "function") catFromTrade = localCategoryFromText_(msg) || "";
      } catch (_) {}
    }
    if (!catFromTrade) catFromTrade = "General";

    var urgSchema = String(sch.urgency || "normal").toLowerCase();
    var urgSig = (typeof urgentSignals_ === "function") ? urgentSignals_(msg) : { urgent: false, reason: "" };
    var urgency = (urgSchema === "urgent" || urgSig.urgent) ? "Urgent" : "Normal";

    return {
      category: catFromTrade,
      emergency: false,
      emergencyType: "",
      confidence: 72,
      nextQuestions: [],
      safetyNote: "",
      urgency: urgency,
      urgencyReason: urgSig.reason || ""
    };
  }

  var se = bag.smartExtractResult;
  if (se && typeof se === "object" && Number(se.issueConfidence) >= 62) {
    var sum = String(se.issueSummary || "").trim();
    if (sum.length >= 6) {
      var catL = "";
      try {
        if (typeof localCategoryFromText_ === "function") {
          catL = localCategoryFromText_(msg) || localCategoryFromText_(sum) || "";
        }
      } catch (_) {}
      if (!catL) catL = "General";
      var urg2 = (typeof urgentSignals_ === "function") ? urgentSignals_(msg) : { urgent: false, reason: "" };
      var ic = Number(se.issueConfidence);
      return {
        category: catL,
        emergency: false,
        emergencyType: "",
        confidence: Math.min(85, isFinite(ic) ? ic : 0),
        nextQuestions: [],
        safetyNote: "",
        urgency: urg2.urgent ? "Urgent" : "Normal",
        urgencyReason: urg2.reason || ""
      };
    }
  }

  return null;
}

/** Same "unclear issue" heuristic as PROPERTY/UNIT/ISSUE smartExtract branches. */
function sopPhase2NeedsSmartExtractClarity_(mergedBodyTrim) {
  var t = String(mergedBodyTrim || "").trim();
  if (!t) return false;
  try {
    if (typeof looksActionableIssue_ === "function" && looksActionableIssue_(t)) return false;
    if (typeof issueIsClear_ === "function" && issueIsClear_("", 0, t)) return false;
  } catch (_) {}
  return true;
}

/**
 * Reuse opener smartExtract when stage handler passes the same canonical text (usually mergedBodyTrim).
 * Returns { ex, reused }; if callDirect, caller should run smartExtract_(apiKey, text) as before.
 */
function sopPhase2ResolveSmartExtract_(apiKey, phone, text) {
  var t = String(text || "").trim();
  var out = { ex: null, reused: false, callDirect: true };
  if (!t || !apiKey) return out;
  try {
    var bag = (typeof globalThis !== "undefined") ? globalThis.__sopPhase2Intake : null;
    if (!bag || bag.skippedBundle) return out;
    var canon = String(bag.mergedCanonicalForSmartExtract || "").trim();
    if (!canon || t !== canon) return out;
    out.callDirect = false;
    out.reused = true;
    out.ex = bag.smartExtractResult != null ? bag.smartExtractResult : null;
  } catch (_) {}
  return out;
}

/** Clear Phase-2 intake bag (call at start of handleSmsCore_). */
function sopPhase2Reset_() {
  try {
    if (typeof globalThis !== "undefined") globalThis.__sopPhase2Intake = null;
  } catch (_) {}
}

/**
 * True when intake should skip bundled semantic AI (structured portal/session, or fully deterministic slots).
 * Does not block deterministic fallbacks inside inferLocationType_ when callers run without prefetch.
 */
function sopPhase2ShouldSkipBundledIntakeAi_(opts) {
  opts = opts || {};
  var phone = String(opts.phone || "").trim();
  try {
    if (typeof sessionGet_ === "function") {
      var sess = sessionGet_(phone);
      if (sess && sess.structuredIntake) return { skip: true, reason: "structured_intake" };
    }
  } catch (_) {}
  var tf = opts.turnFacts || {};
  var iss = String(tf.issue || "").trim();
  if (tf.property && tf.property.code && String(tf.unit || "").trim() && iss.length >= 4) {
    try {
      if (typeof looksActionableIssue_ === "function" && looksActionableIssue_(iss)) {
        var longMsg = String(opts.mergedBodyTrim || "").length > 420;
        var schemaWould = false;
        try {
          if (typeof shouldUseSchemaExtract_ === "function") {
            var g = shouldUseSchemaExtract_(String(opts.mergedBodyTrim || ""));
            schemaWould = !!(g && g.use);
          }
        } catch (_) {}
        if (!longMsg && !schemaWould) return { skip: true, reason: "deterministic_slots_full" };
      }
    } catch (_) {}
  }
  return { skip: false, reason: "" };
}

/**
 * Phase 2 intake opener: run inferLocation once + schema extract once (when gated).
 * Stores results on globalThis.__sopPhase2Intake for reuse by buildDomainSignal_ / draftUpsert / finalize.
 */
function sopPhase2RunIntakeOpener_(opts) {
  opts = opts || {};

  var phone = String(opts.phone || "").trim();
  var mergedBodyTrim = String(opts.mergedBodyTrim || "").trim();
  var bodyTrim = String(opts.bodyTrim !== undefined ? opts.bodyTrim : opts.mergedBodyTrim || "").trim();
  var lang = String(opts.lang || "en").toLowerCase() || "en";
  var apiKey = String(opts.OPENAI_API_KEY || "").trim();
  var turnFacts = opts.turnFacts || {};

  var bag = {
    inferLocationResult: null,
    schemaObj: null,
    schemaExtractAttempted: false,
    smartExtractResult: null,
    smartExtractAttempted: false,
    mergedCanonicalForSmartExtract: "",
    log: "",
    skippedBundle: false,
    skipReason: ""
  };

  try {
    if (typeof globalThis !== "undefined") globalThis.__sopPhase2Intake = bag;
  } catch (_) {}

  var skipInfo = (typeof sopPhase2ShouldSkipBundledIntakeAi_ === "function")
    ? sopPhase2ShouldSkipBundledIntakeAi_(opts)
    : { skip: false, reason: "" };
  if (skipInfo && skipInfo.skip) {
    bag.skippedBundle = true;
    bag.skipReason = String(skipInfo.reason || "").trim() || "skip";
    bag.log = "bundle_skip=" + bag.skipReason;
    try {
      if (typeof logDevSms_ === "function") logDevSms_(phone, "", "SOP_PHASE2 skip=1 reason=" + bag.skipReason);
    } catch (_) {}
    return bag;
  }

  if (!apiKey) {
    bag.log = "no_api_key";
    return bag;
  }

  var schemaGateUse = false;
  if (bodyTrim && typeof isSchemaExtractEnabled_ === "function" && isSchemaExtractEnabled_()) {
    try {
      if (typeof shouldUseSchemaExtract_ === "function") {
        var gp = shouldUseSchemaExtract_(bodyTrim);
        schemaGateUse = !!(gp && gp.use);
      }
    } catch (_) {}
  }

  // 16B: smartExtract first — skip when schema path runs (multi-issue / long extract subsumes).
  if (!schemaGateUse && mergedBodyTrim && typeof smartExtract_ === "function") {
    if (typeof sopPhase2NeedsSmartExtractClarity_ === "function" && sopPhase2NeedsSmartExtractClarity_(mergedBodyTrim)) {
      bag.smartExtractAttempted = true;
      try {
        bag.smartExtractResult = smartExtract_(apiKey, mergedBodyTrim);
        bag.log += "smartx=1;";
        bag.mergedCanonicalForSmartExtract = mergedBodyTrim || bodyTrim;
      } catch (e0) {
        try {
          if (typeof logDevSms_ === "function") logDevSms_(phone, "", "SOP_PHASE2_SMARTX_ERR " + String(e0 && e0.message ? e0.message : e0));
        } catch (_) {}
      }
    } else {
      bag.log += "smartx_skip=clear;";
    }
  } else if (schemaGateUse) {
    bag.log += "smartx_skip=schema_path;";
  }

  var locInput = mergedBodyTrim || bodyTrim;
  if (locInput && typeof inferLocationType_ === "function") {
    try {
      bag.inferLocationResult = inferLocationType_(apiKey, locInput, phone);
      bag.log += "loc=1;";
    } catch (e) {
      try {
        if (typeof logDevSms_ === "function") logDevSms_(phone, "", "SOP_PHASE2_LOC_ERR " + String(e && e.message ? e.message : e));
      } catch (_) {}
    }
  }

  if (bodyTrim && typeof isSchemaExtractEnabled_ === "function" && isSchemaExtractEnabled_()) {
    var gatePre = { use: false, reason: "" };
    try {
      if (typeof shouldUseSchemaExtract_ === "function") gatePre = shouldUseSchemaExtract_(bodyTrim) || gatePre;
    } catch (_) {}
    if (gatePre.use) {
      bag.schemaExtractAttempted = true;
      if (typeof isOpenAICooldown_ === "function" && isOpenAICooldown_()) {
        bag.log += "schema_cooldown;";
        try {
          if (typeof logDevSms_ === "function") logDevSms_(phone, (bodyTrim || "").slice(0, 40), "SOP_PHASE2_SCHEMA skip=1 reason=[cooldown]");
        } catch (_) {}
      } else if (typeof extractIssuesSchema_ === "function") {
        try {
          bag.schemaObj = extractIssuesSchema_(bodyTrim, lang, phone);
          bag.log += "schema=1;";
        } catch (e2) {
          try {
            if (typeof logDevSms_ === "function") logDevSms_(phone, "", "SOP_PHASE2_SCHEMA_ERR " + String(e2 && e2.message ? e2.message : e2));
          } catch (_) {}
        }
      }
    } else {
      bag.log += "schema_gate=0;";
    }
  }

  try {
    if (typeof logDevSms_ === "function") {
      logDevSms_(phone, "", "SOP_PHASE2 bundle log=[" + bag.log + "]");
    }
  } catch (_) {}

  return bag;
}
