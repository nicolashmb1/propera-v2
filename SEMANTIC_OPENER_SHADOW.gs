/**
 * SEMANTIC_OPENER_SHADOW.gs
 *
 * Phase 1 (additive/shadow-only):
 * - Build a canonical semantic package snapshot candidate.
 * - Validate minimum package floor.
 * - Log package summary for divergence/replay analysis.
 *
 * This module is non-authoritative and must not change runtime decisions.
 */

/** Build sparse evidence map from available deterministic/media facts. */
function sopBuildEvidenceMapV1_(opts) {
  opts = opts || {};
  var ev = {};
  var body = String(opts.bodyRaw || "").trim();
  var merged = String(opts.mergedBodyTrim || "").trim();
  var mediaFacts = opts.mediaFacts || {};

  if (body) ev.rawText = [{ source: "bodyRaw", text: body.slice(0, 500) }];
  if (merged && merged !== body) ev.normalizedText = [{ source: "mergedBody", text: merged.slice(0, 500) }];

  var extracted = String(mediaFacts.extractedText || "").trim();
  if (extracted) ev.mediaExtractedText = [{ source: "imageSignalAdapter_", text: extracted.slice(0, 500) }];

  return ev;
}

/**
 * Compact snapshot of deterministic compile/turn inputs at shadow log time (for diff vs package).
 * Non-authoritative; mirrors what the brain path is about to consume from compileTurn_ output.
 */
function sopBuildFlowDecisionInputsV1_(turnFacts) {
  var tf = turnFacts || {};
  var prop = tf.property || null;
  var sched = (tf.schedule && tf.schedule.raw) ? String(tf.schedule.raw || "").trim() : "";
  var im = tf.issueMeta || null;
  var nClauses = 0;
  try {
    if (im && Array.isArray(im.clauses)) nClauses = im.clauses.length;
  } catch (_) {}
  return {
    propCode: prop && prop.code ? String(prop.code || "").trim().slice(0, 32) : "",
    propName: prop && prop.name ? String(prop.name || "").trim().slice(0, 48) : "",
    unit: String(tf.unit || "").trim().slice(0, 32),
    issueHead: String(tf.issue || "").trim().slice(0, 120),
    scheduleRaw: sched.slice(0, 120),
    issueMetaClauses: nClauses,
    hasMediaOnly: !!(tf.meta && tf.meta.hasMediaOnly)
  };
}

/** Return true when at least one issue is detected from deterministic turn facts. */
function sopHasIssueV1_(turnFacts) {
  var tf = turnFacts || {};
  var issue = String(tf.issue || "").trim();
  if (issue) return true;
  if (tf.issueMeta && tf.issueMeta.title) return true;
  if (tf.issueMeta && tf.issueMeta.clauses && tf.issueMeta.clauses.length) return true;
  return false;
}

/** Build minimum-valid canonical package candidate (v1 shadow). */
function sopShadowSnapshotFromTurn_(opts) {
  opts = opts || {};
  var turnFacts = opts.turnFacts || {};
  var mediaFacts = opts.mediaFacts || {};
  var bodyRaw = String(opts.bodyRaw || "").trim();
  var mergedBodyTrim = String(opts.mergedBodyTrim || bodyRaw).trim();
  var lang = String(opts.lang || "en").trim().toLowerCase() || "en";
  var traceId = String(opts.traceId || "").trim();
  if (!traceId) traceId = "SOP_" + String(Date.now());

  var issues = [];
  if (sopHasIssueV1_(turnFacts)) {
    var summary = String(turnFacts.issue || (turnFacts.issueMeta && (turnFacts.issueMeta.title || turnFacts.issueMeta.bestClauseText)) || "").trim();
    if (!summary) summary = String(mergedBodyTrim || bodyRaw || "").trim().slice(0, 180);
    issues.push({
      issueId: "ISSUE_1",
      rawIssuePhrase: summary,
      canonicalIssueSummary: summary,
      confidence: 0.55,
      evidenceRefs: ["rawText"]
    });
  }

  var prop = turnFacts.property || null;
  var unit = String(turnFacts.unit || "").trim();
  var sched = (turnFacts.schedule && turnFacts.schedule.raw) ? String(turnFacts.schedule.raw || "").trim() : "";

  var pkg = {
    packageVersion: "SOP_V1_SHADOW",
    envelope: {
      trace: {
        traceId: traceId,
        sourceAdapter: String(opts.sourceAdapter || "SMS").trim().toUpperCase(),
        inboundEventId: String(opts.inboundEventId || "").trim(),
        receivedAtIso: new Date().toISOString()
      }
    },
    sourceTextRef: {
      bodyPreview: bodyRaw.slice(0, 500),
      mergedPreview: mergedBodyTrim.slice(0, 500)
    },
    language: {
      sourceLanguage: lang || "en",
      replyLanguage: lang || "en"
    },
    issues: issues,
    no_issue_detected: issues.length === 0,
    propertyHint: {
      code: prop && prop.code ? String(prop.code || "").trim() : "",
      name: prop && prop.name ? String(prop.name || "").trim() : ""
    },
    unitHint: unit,
    scheduleHint: sched,
    ambiguities: [],
    missingHints: [],
    evidenceMap: sopBuildEvidenceMapV1_({
      bodyRaw: bodyRaw,
      mergedBodyTrim: mergedBodyTrim,
      mediaFacts: mediaFacts
    })
  };

  if (!pkg.propertyHint.code && !pkg.propertyHint.name) pkg.missingHints.push("property_hint");
  if (!pkg.unitHint) pkg.missingHints.push("unit_hint");
  if (!pkg.scheduleHint) pkg.ambiguities.push("schedule_unspecified");
  if (pkg.no_issue_detected) pkg.ambiguities.push("no_issue_detected");

  return pkg;
}

/** Minimum floor validation for shadow package contract. */
function sopIsMinimumValidPackageV1_(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  if (!pkg.envelope || !pkg.envelope.trace) return false;
  if (!pkg.sourceTextRef) return false;
  if (!pkg.language || !pkg.language.sourceLanguage || !pkg.language.replyLanguage) return false;
  if (!Array.isArray(pkg.issues)) return false;
  if (!pkg.no_issue_detected && pkg.issues.length < 1) return false;
  if (!Array.isArray(pkg.ambiguities)) return false;
  if (!Array.isArray(pkg.missingHints)) return false;
  if (!pkg.evidenceMap || typeof pkg.evidenceMap !== "object") return false;
  return true;
}

/** Shadow logging only. Must never alter deterministic behavior. */
function sopLogShadowPackageV1_(phone, pkg, meta) {
  meta = meta || {};
  var ok = sopIsMinimumValidPackageV1_(pkg);
  var nIssues = (pkg && Array.isArray(pkg.issues)) ? pkg.issues.length : 0;
  var lang = (pkg && pkg.language && pkg.language.sourceLanguage) ? String(pkg.language.sourceLanguage) : "";
  var traceId = (pkg && pkg.envelope && pkg.envelope.trace) ? String(pkg.envelope.trace.traceId || "") : "";
  var mode = String(meta.mode || "").trim().toUpperCase();
  var flowSnap = sopBuildFlowDecisionInputsV1_(meta.turnFacts);
  var msg = "SOP_SHADOW pkgValid=" + (ok ? "1" : "0") + " issues=" + nIssues + " noIssue=" + ((pkg && pkg.no_issue_detected) ? "1" : "0") + " lang=" + lang + " mode=" + mode + " trace=" + traceId;
  try {
    var flowJson = "";
    try { flowJson = JSON.stringify(flowSnap); } catch (_) { flowJson = "{}"; }
    if (flowJson.length > 400) flowJson = flowJson.slice(0, 400) + "...";
    msg += " flow=" + flowJson;
  } catch (_) {}
  try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", msg); } catch (_) {}
  try {
    if (typeof writeTimeline_ === "function") {
      writeTimeline_("SOP_SHADOW", {
        pkgValid: ok ? "1" : "0",
        issues: String(nIssues),
        noIssue: (pkg && pkg.no_issue_detected) ? "1" : "0",
        lang: lang,
        mode: mode,
        trace: traceId
      }, {
        traceId: traceId,
        packageValid: ok,
        issueCount: nIssues,
        flowInputs: flowSnap,
        packageHints: pkg ? {
          propCode: String((pkg.propertyHint && pkg.propertyHint.code) || ""),
          propName: String((pkg.propertyHint && pkg.propertyHint.name) || ""),
          unit: String(pkg.unitHint || ""),
          sched: String(pkg.scheduleHint || "").slice(0, 80),
          noIssue: !!pkg.no_issue_detected
        } : {}
      });
    }
  } catch (_) {}
}

