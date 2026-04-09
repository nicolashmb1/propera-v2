  /**
  * ISSUE_CLASSIFICATION_ENGINE.gs
  *
  * Cohesive extraction from PROPERA MAIN (deterministic issue classification).
  * Owns:
  * - clause taxonomy helpers
  * - scoring helpers
  * - title/details normalization
  * - deterministic subcategory/urgency detection
  *
  * Non-authoritative:
  * - no resolver/lifecycle writes
  * - no outbound decisions
  */

  var ISSUE_PROBLEM_THRESHOLD_ = 30;

  // ============================================================
  // ISSUE NORMALIZER (deterministic, conservative)
  // Turns: "hey can someone take a look at my tub that is clogged"
  // Into:  "tub is clogged"
  // ============================================================
  function normalizeIssueText_(s) {
    var t = String(s || "").trim();
    if (!t) return "";

    // Lower for pattern checks, but preserve original words by rewriting t itself
    var lower = t.toLowerCase();

    // Strip common openers
    t = t.replace(/^\s*(hi|hey|hello)\b[\s\,\.\-:]*/i, "");
    t = t.replace(/^\s*(please|pls)\b[\s\,\.\-:]*/i, "");

    // Strip "can someone / can you / could you" wrappers
    t = t.replace(/^\s*(can|could|would)\s+(someone|you|anyone)\s+/i, "");
    t = t.replace(/^\s*i\s+need\s+help\s+(with|on)\s+/i, "");
    t = t.replace(/^\s*i\s+need\s+/i, "");
    t = t.replace(/^\s*need\s+help\s+(with|on)\s+/i, "");
    t = t.replace(/^\s*need\s+/i, "");

    // Strip opener verbs only when they appear as leading wrappers.
    // Avoid deleting meaningful words mid-sentence (e.g. "check of the refrigerator").
    t = t.replace(/^\s*(take\s+a\s+look\s+at|look\s+at|check|inspect)\s+/i, "");

    // Normalize possessive-ish noise
    t = t.replace(/\bmyu\b/ig, "my"); // observed typo

    // Collapse whitespace and trailing punctuation
    t = t.replace(/\s+/g, " ").trim();
    // Strip trailing service-request wrappers so issue stays symptom-first.
    // Example: "sink clogged can you send someone" -> "sink clogged"
    t = t.replace(/\s*(?:[,;:\-]\s*)?(?:please\s+)?(?:can|could|would)\s+you\s+send\s+(?:someone|somebody)(?:\s+(?:over|out))?\s*$/i, "");
    t = t.replace(/\s*(?:[,;:\-]\s*)?(?:please\s+)?send\s+(?:someone|somebody)(?:\s+(?:over|out))?\s*$/i, "");
    t = t.replace(/[\,\.\;\:\-]+$/g, "").trim();

    return t;
  }

  // ============================================================
  // MIXED PROPERTY + MULTI-ISSUE EXTRACTOR (router/core safe helper)
  // Goal: never drop issue content.
  // Example: "morris. sink clogged, and intercom not working"
  //   -> ["sink clogged", "intercom not working"]
  // ============================================================
  function extractMixedIssuesAfterProperty_(lower, propTokenLower) {
    var s = String(lower || "").trim();
    if (!s) return [];

    // Remove property token if it appears early (start-of-message common case)
    var p = String(propTokenLower || "").trim();
    if (p) {
      var idx0 = s.indexOf(p);
      if (idx0 === 0) {
        s = s.slice(p.length).trim();
      } else if (idx0 > 0 && idx0 < 10) {
        // tolerate small prefix noise
        s = (s.slice(0, idx0) + " " + s.slice(idx0 + p.length)).trim();
      }
    }

    // Strip leading punctuation/joiners
    s = s.replace(/^[\s\.\,\-\:;]+/, "").trim();
    if (!s) return [];

    // Split into clauses (keep order) - no \s+and\s+ to keep "washer not draining and leaves water" intact
    var parts = s
      .replace(/\s+/g, " ")
      .split(/(?:\.\s+|,\s+|;\s+|\s+\-\s+|\s+also\s+|\s+but\s+)/i);

    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var t = String(parts[i] || "").trim();
      if (!t) continue;
      if (t.length < 4) continue;
      // Normalize for better summaries
      if (typeof normalizeIssueText_ === "function") {
        try { t = normalizeIssueText_(t); } catch (_) {}
      }
      if (!t) continue;
      if ((typeof isProblemClauseForAdmission_ === "function") && !isProblemClauseForAdmission_(t)) continue;
      out.push(t);
    }
    return out;
  }

  /** Best-effort strip of greeting + contact-attempt preface so actionable check runs on payload. */
  function extractIssuePayload_(s) {
    var t = String(s || "").trim();
    if (!t) return "";

    // remove leading greeting
    t = t.replace(/^\s*(hi|hey|hello|good (morning|afternoon|evening))\b[\s\,\.\-:]*/i, "");

    // Strip contact-attempt only when it appears near the start (prevents eating the real issue)
    t = t.replace(/^\s*(i\s+)?(called|call(ed)?|reach(ed)?|left a message|no answer|did not get anyone)\b[\s\S]{0,80}\b(my|the)\b/i, "$3 ");

    t = t.replace(/\s+/g, " ").trim();
    return t;
  }

  /** Returns true if clause looks like resolved/dismissed (fixed itself, no worries, etc.). */
  function isResolvedOrDismissedClause_(c) {
    var t = String(c || "").toLowerCase();
    return /\b(fixed\s+itself|no\s+worries|all\s+good|resolved|not\s+an\s+issue|no\s+longer|went\s+away|never\s*mind|nevermind|ignore\s+that|disregard|nothing\s+to\s+worry)\b/.test(t);
  }

  /** Returns true if clause describes an attempted check/fix/action rather than the actual problem. Used to prefer symptom/problem as issue title. */
  function isAttemptedFixClause_(text) {
    var t = String(text || "").toLowerCase().trim();
    if (!t) return false;
    // Leading action patterns (generic)
    if (/^\s*(checked|tried|replaced|reset|restarted|turned\s+off|turned\s+on|switched|unplugged|plugged\s+back|tested|flipped|tripped|pressed|adjusted|cleaned|cleared)\b/.test(t)) return true;
    // Passive / "was done" patterns
    if (/\b(breaker|outlet|thermostat|switch|circuit)\s+was\s+(checked|reset|tripped|tested|flipped)\b/.test(t)) return true;
    if (/\b(battery|filter)\s+was\s+replaced\b/.test(t)) return true;
    if (/\b(outlet|gfci)\s+was\s+reset\b/.test(t)) return true;
    // Short clause that is only an action (no clear symptom)
    if (/^\s*(i\s+)?(already\s+)?(checked|tried|reset|replaced|restarted)\s+/.test(t) && t.length < 55) return true;
    return false;
  }

  function issueHasIssueNounKeyword_(text) {
    var t = String(text || "").toLowerCase();
    return /\b(ac|a\/c|heat|heater|sink|toilet|leak|water|breaker|outlet|door|lock|window|thermostat|shower|tub|faucet|drain|pipe|stove|oven|range|burner|washer|dryer|fridge|refrigerator|dishwasher|microwave|light|intercom)\b/.test(t);
  }

  function issueIsRequestClausePattern_(text) {
    var t = String(text || "").toLowerCase().trim();
    if (!t) return false;
    if (/(^|\b)(need|have|send|get|schedule|dispatch|let|can|could|please)\b/.test(t)
        && /(someone|maintenance|team|you|it)\b/.test(t)) return true;
    if (/\b(need\s+someone|need\s+maintenance|need\s+someone\s+to\s+(check|look|inspect|fix|repair)|have\s+someone|have\s+maintenance|can\s+someone|could\s+someone|please\s+have|send\s+someone|let\s+me\s+know|come\s+out|check\s+it|look\s+at\s+it)\b/.test(t)) return true;
    return false;
  }

  function issueClassifyClauseType_(c) {
    var t = String(c || "").toLowerCase().trim();
    if (!t) return "other";

    if (typeof looksLikeGreetingOnly_ === "function" && looksLikeGreetingOnly_(t)) return "greeting";
    if (typeof looksLikeAckOnly_ === "function" && looksLikeAckOnly_(t)) return "ack";
    if (typeof isScheduleWindowLike_ === "function" && isScheduleWindowLike_(t)) return "schedule";

    if (/\?$/.test(t)) return "question";
    if (/^\s*(when|what|how|why|can you|could you|is there|any chance|do you|will you)\b/.test(t)) return "question";
    if (/\b(even after|maintenance came|tried adjusting|like they told|has been going on|going on for|getting frustrated|honestly getting|freezing at night|living room is freezing|over a month|over a week)\b/.test(t)) return "context";

    if (typeof isAttemptedFixClause_ === "function" && isAttemptedFixClause_(t)) return "attempt";
    if (/^\s*(i tried|i've tried|i have tried)\b/i.test(t)) return "attempt";
    if (/\b(drain cleaner|plunged|plunging|reset|restarted|adjusted|turned the thermostat)\b/.test(t)) return "attempt";

    if (typeof isScheduleIntentOnly_ === "function" && isScheduleIntentOnly_(t)) return "request";
    if (issueIsRequestClausePattern_(t)) return "request";
    if (t.length < 25 && !issueHasIssueNounKeyword_(t)) return "other";
    if ((typeof looksActionableIssue_ === "function") && looksActionableIssue_(t)) return "problem";
    if (/\b(again|second|2nd|third|3rd|another|still|same issue|happened before|last time)\b/.test(t)) return "context";
    if (typeof isResolvedOrDismissedClause_ === "function" && isResolvedOrDismissedClause_(t)) return "other";

    return "other";
  }

  function issueIsProblemClauseForAdmission_(text) {
    var t = String(text || "").trim();
    if (!t) return false;
    return issueClassifyClauseType_(t) === "problem";
  }

  function issueScoreClause_(c, type) {
    var t = String(c || "").toLowerCase().trim();
    if (!t) return -999;

    if (type === "greeting" || type === "ack") return -500;
    if (type === "schedule") return -50;
    if (type === "request") return -50;
    if (type === "question") return -50;
    if (type === "attempt") return -250;
    if (typeof isResolvedOrDismissedClause_ === "function" && isResolvedOrDismissedClause_(t)) return -300;

    var score = 0;
    if (/(not working|doesn'?t work|broken|won'?t|wont|stopped|leak|clog|smell|noise|sparks|tripping|overflow|backup|no heat|no hot|not heating|not cooling)/.test(t)) score += 60;
    if (/(sink|toilet|shower|tub|faucet|drain|pipe|stove|oven|range|burner|knob|washer|dryer|fridge|refrigerator|dishwasher|microwave|door|lock|window|outlet|light|breaker|thermostat|\bac\b|a\/c|heater|\bheat\b|intercom)/.test(t)) score += 35;
    if (/(gas|smoke|fire|sparks|arcing|carbon monoxide|co alarm|flooding|sewage|backing up)/.test(t)) score += 80;
    if (type === "context") score += 10;
    if (t.length >= 20) score += 10;
    if (t.length >= 40) score += 10;
    if (/(time frame|when can|what time|availability|available|come by|stop by|tomorrow|today|morning|afternoon|evening)/.test(t)) score -= 25;

    return score;
  }

  function issueScoreClauseWithPos_(c, type, idx, total) {
    var score = issueScoreClause_(c, type);
    if (typeof isResolvedOrDismissedClause_ === "function" && isResolvedOrDismissedClause_(c)) score -= 200;
    if (typeof isAttemptedFixClause_ === "function" && isAttemptedFixClause_(c)) score -= 180;
    if (total >= 6) {
      var frac = (total <= 1) ? 0 : (idx / (total - 1));
      score += Math.round(frac * 18);
    }
    return score;
  }

  function issueNormalizeTitle_(clause) {
    var t = String(clause || "").trim();
    if (!t) return "";
    t = t.replace(/^\s*(also|and|but|so)\b[\s\,\.\-:;]*/i, "");
    t = t.replace(/^\s*(just\s+)?(wanted to|want to|need to)\s+/i, "");
    t = t.replace(/^\s*(is there|any chance|can you|could you|would you)\b[\s\,\.\-:]*/i, "");
    t = t.replace(/^\s*(this is|it'?s)\s+(the\s+)?(2nd|second|3rd|third)\b[\s\,\.\-:]*/i, "");
    if (typeof normalizeIssueText_ === "function") {
      try { t = normalizeIssueText_(t); } catch (_) {}
    }
    t = t.replace(/\b(is there a time frame|any time frame|when can you|what time frame)\b[\s\S]*$/i, "").trim();
    t = t.replace(/[\,\.\;\:\-]+$/g, "").trim();
    return t;
  }

  function issueEnsureParenQualifier_(title, q) {
    var t = String(title || "").trim();
    var qual = String(q || "").trim();
    if (!t || !qual) return t;
    if (/\)\s*$/.test(t)) return t;
    return t + " (" + qual + ")";
  }

  function issueFinalizeTitlePolish_(title, fullCleaned) {
    var t = String(title || "").trim();
    if (!t) return "";
    var lowerFull = String(fullCleaned || "").toLowerCase();
    var qual = "";
    if (/\b(second|2nd)\b/.test(lowerFull)) qual = "second";
    else if (/\b(third|3rd)\b/.test(lowerFull)) qual = "third";
    else if (/\bagain\b|\bstill\b|\bsame issue\b/.test(lowerFull)) qual = "repeat";
    if (/\bstove\b/.test(lowerFull) && /\bknob\b/.test(lowerFull) && /\b(second|2nd)\b/.test(lowerFull)) {
      return issueEnsureParenQualifier_(t, "second knob");
    }
    if (qual === "second") return issueEnsureParenQualifier_(t, "second time");
    if (qual === "third") return issueEnsureParenQualifier_(t, "third time");
    if (qual === "repeat") return issueEnsureParenQualifier_(t, "repeat");
    return t;
  }

  function issueBuildCombinedTitleFromClauses_(clauses) {
    if (!clauses || !clauses.length) return "";
    var parts = [];
    for (var i = 0; i < clauses.length; i++) {
      var c = clauses[i];
      if (!c || !c.title) continue;
      var t = String(c.title).trim();
      if (!t) continue;
      if (typeof normalizeIssueText_ === "function") {
        try { t = normalizeIssueText_(t); } catch (_) {}
      }
      t = t.replace(/^\s*also\s+/i, "").trim();
      if (t) parts.push(t);
    }
    return parts.join("; ");
  }

  function issueBuildDetails_(clauses, coreIdx) {
    if (!clauses || !clauses.length) return "";
    var out = [];
    for (var i = 0; i < clauses.length; i++) {
      if (i === coreIdx) continue;
      var c = clauses[i] || {};
      if (!c.text) continue;
      if (c.type === "greeting" || c.type === "ack") continue;
      if (c.type === "schedule") continue;
      if (c.type === "context" || c.type === "request") continue;
      var text = String(c.text || "").trim();
      if (!text) continue;
      if (text.length > 220) text = text.slice(0, 220);
      out.push(text);
    }
    var joined = out.join(" | ").trim();
    if (joined.length > 450) joined = joined.slice(0, 450);
    return joined;
  }

  function issueDetectSubcategory_(title, details) {
    var t = (String(title || "") + " " + String(details || "")).toLowerCase();
    if (!t.trim()) return "";
    if (/\bstove\b|\boven\b|\brange\b/.test(t) && /\bknob\b/.test(t)) return "Stove knob";
    if (/\bclog\b|\bclogged\b|\bdrain\b/.test(t)) return "Clog";
    if (/\bleak\b|\bleaking\b|\bdrip\b/.test(t)) return "Leak";
    if (/\bno heat\b|\bheat\b/.test(t)) return "No heat";
    if (/\block\b|\bkey\b|\blocked out\b/.test(t)) return "Lock/Key";
    return "";
  }

  function issueDetectUrgency_(title, details) {
    var t = (String(title || "") + " " + String(details || "")).toLowerCase();
    var detectorMaint = /\b(battery|batteries|beeping|beep|chirping|chirp|replacement|replace|low battery|new battery)\b/.test(t) && /\b(detector|alarm|smoke alarm|co alarm)\b/.test(t);
    var activeDanger = /\b(smell smoke|smoke coming from|see smoke|flames|on fire|burning|gas smell|smell gas)\b/.test(t) || /\bco alarm\s+(going off|alarming)\b/.test(t);
    if (detectorMaint && !activeDanger) return "normal";
    if (/(gas smell|smell gas|carbon monoxide|co alarm|smoke|fire|sparks|arcing|electrical arc)/.test(t)) return "urgent";
    if (/(flooding|flood|sewage|backing up|overflowing)/.test(t)) return "urgent";
    if (/(no heat|heat not working|no hot water|hot water not working)/.test(t)) return "high";
    if (/(no power|power out|lost power)/.test(t)) return "high";
    if (/(leak|leaking|water leak)/.test(t)) return "high";
    return "normal";
  }

  function issueStripPreamble_(s) {
    var t = String(s || "").trim();
    if (!t) return "";

    t = t.replace(/^\s*(hi|hey|hello|good (morning|afternoon|evening))\b[\s\,\.\-:]*/i, "");
    t = t.replace(/^\s*[a-z]{2,}\s*,\s*/i, "");
    t = t.replace(/^\s*(this is|it'?s)\b[\s\S]{0,40}?\b(at|in|from)?\s*/i, "");
    t = t.replace(/^\s*(apt|apartment|unit|rm|room|suite|ste|#)\s*[\w\-]{1,6}\b[\s\,\.\-:]*?/i, "");
    t = t.replace(/^\s*\d{1,5}\s+[a-z]{2,}\b[\s\,\.\-:]*?/i, "");

    if (typeof extractIssuePayload_ === "function") {
      try { t = extractIssuePayload_(t); } catch (_) {}
    }

    t = t.replace(
      /^\s*(?:i'?m\s+)?[a-z]{2,}(?:\s+[a-z]{1,}){0,4}\s+(?:from|in)\s+(?:apt|apartment|unit|rm|room|suite|ste|#)\s*[\w\-]{1,6}(?:\s+at\s+[a-z0-9\s'\-]{1,30})?\b[\s\,\.\-:;]*/i,
      ""
    );

    t = t.replace(/\s+/g, " ").trim();
    return t;
  }

  function issueSplitClauses_(s) {
    var t = String(s || "").trim();
    if (!t) return [];
    t = t.replace(/\s+/g, " ").trim();
    var parts = t.split(/(?:\.\s+|\?\s+|!\s+|;\s+|,\s+|\s+\-\s+|\s+also\s+|\s+but\s+|\s+however\s+|\s+plus\s+)/i);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = String(parts[i] || "").trim();
      if (!p) continue;
      if (p.length < 3) continue;
      out.push(p);
    }
    return out;
  }

  function issueMaybeSplitProblemClause_(text) {
    var t = String(text || "").trim();
    if (!t) return [];
    if (!/\band\b/i.test(t)) return [t];
    var nounAlt =
      "sink|toilet|shower|tub|faucet|drain|pipe|stove|oven|range|burner|washer|dryer|fridge|refrigerator|freezer|dishwasher|microwave|light|hallway|corridor|intercom|door|lock|window|thermostat|ac|a\\/c|heater|outlet|breaker";
    try {
      var rxSplit = new RegExp("\\s+and\\s+(?=(?:the\\s+)?(?:" + nounAlt + ")\\b)", "i");
      var parts = t.split(rxSplit).map(function (x) { return String(x || "").trim(); }).filter(function (x) { return x.length >= 4; });
      if (parts.length < 2) return [t];
      var nounRe = new RegExp("\\b(?:" + nounAlt + ")\\b", "i");
      var n0 = nounRe.test(parts[0]);
      var n1 = nounRe.test(parts[1]);
      if (!n0 || !n1) return [t];
      return parts;
    } catch (_) {}
    return [t];
  }

  function issueParseDeterministic_(rawText, opts) {
    opts = opts || {};
    var raw = String(rawText || "").trim();
    if (!raw) return { title: "", details: "", category: "", subcategory: "", urgency: "normal", clauses: [], debug: "" };

    var cleaned = issueStripPreamble_(raw);
    var clausesRaw = issueSplitClauses_(cleaned);

    var clauses = [];
    for (var i = 0; i < clausesRaw.length; i++) {
      var c = String(clausesRaw[i] || "").trim();
      if (!c) continue;

      if (typeof isScheduleWindowLike_ === "function" && isScheduleWindowLike_(c)) {
        clauses.push({ text: c, title: "", type: "schedule", score: -999 });
        continue;
      }

      var baseType = issueClassifyClauseType_(c);
      var partsToProcess = (baseType === "problem") ? issueMaybeSplitProblemClause_(c) : [c];
      if (!partsToProcess || !partsToProcess.length) partsToProcess = [c];

      for (var pIdx = 0; pIdx < partsToProcess.length; pIdx++) {
        var part = String(partsToProcess[pIdx] || "").trim();
        if (!part) continue;

        if (typeof isScheduleWindowLike_ === "function" && isScheduleWindowLike_(part)) {
          clauses.push({ text: part, title: "", type: "schedule", score: -999 });
          continue;
        }

        var type = issueClassifyClauseType_(part);
        var score = issueScoreClauseWithPos_(part, type, i + (pIdx * 0.1), clausesRaw.length);
        var title = "";
        if (type === "problem") title = issueNormalizeTitle_(part);
        clauses.push({ text: part, title: title, type: type, score: score });
      }
    }

    var bestIdx = -1;
    var bestScore = -999999;
    for (var j = 0; j < clauses.length; j++) {
      var it = clauses[j];
      if (!it || it.type !== "problem") continue;
      if (it.score > bestScore) { bestScore = it.score; bestIdx = j; }
    }
    var core = (bestIdx >= 0) ? clauses[bestIdx] : null;

    try {
      if (typeof logDevSms_ === "function" && typeof isAttemptedFixClause_ === "function") {
        for (var d = 0; d < clauses.length; d++) {
          if (d === bestIdx) continue;
          var cl = clauses[d];
          if (cl && cl.type === "problem" && cl.text && isAttemptedFixClause_(cl.text)) {
            logDevSms_("", "", "ISSUE_PICK_DEPRIORITIZE_ATTEMPT_FIX clause=[" + String(cl.text).slice(0, 60) + "]");
          }
        }
      }
    } catch (_) {}

    var titleOut = core && core.title ? core.title : "";
    if (titleOut && typeof normalizeIssueText_ === "function") {
      try { titleOut = normalizeIssueText_(titleOut); } catch (_) {}
    }
    titleOut = issueFinalizeTitlePolish_(titleOut, cleaned);
    var detailsOut = issueBuildDetails_(clauses, bestIdx);

    var cat = "";
    try {
      if (typeof localCategoryFromText_ === "function") {
        cat = localCategoryFromText_((titleOut + " " + detailsOut).trim()) || localCategoryFromText_(titleOut) || "";
      }
    } catch (_) {}
    var subcat = issueDetectSubcategory_(titleOut, detailsOut);
    var urgency = issueDetectUrgency_(titleOut, detailsOut);

    var outClauses = [];
    var seen = {};
    for (var m = 0; m < clauses.length; m++) {
      var c3 = clauses[m];
      if (!c3 || c3.type !== "problem") continue;
      var tt = c3.title ? String(c3.title).toLowerCase().trim() : "";
      if (!tt || seen[tt]) continue;
      seen[tt] = 1;
      outClauses.push({ text: c3.text, title: c3.title, type: c3.type, score: c3.score });
    }

    var problemSpanCount = 0;
    for (var psc = 0; psc < clauses.length; psc++) {
      if (clauses[psc] && clauses[psc].type === "problem") problemSpanCount++;
    }

    return {
      title: titleOut,
      details: detailsOut,
      category: cat || "",
      subcategory: subcat || "",
      urgency: urgency || "normal",
      clauses: outClauses,
      problemSpanCount: problemSpanCount,
      bestClauseText: (core && core.text) ? String(core.text).trim() : "",
      debug: "picked=" + bestIdx + " score=" + bestScore + " nClauses=" + clauses.length
    };
  }

  function issueSchemaExtractEnabled_() {
    try {
      var sp = PropertiesService.getScriptProperties();
      return String(sp.getProperty("ENABLE_SCHEMA_EXTRACT") || "").trim() === "1";
    } catch (_) { return false; }
  }

  function issueShouldUseSchemaExtract_(t) {
    var s = String(t || "").trim();
    if (!s) return { use: false, reason: "" };
    if (s.length >= 220) return { use: true, reason: "len" };
    var clauses = issueSplitClauses_(s);
    if (clauses && clauses.length >= 6) return { use: true, reason: "clauses" };
    if (/\b(also|another|plus|in addition)\b/i.test(s)) return { use: true, reason: "also" };
    if ((typeof isScheduleWindowLike_ === "function") && isScheduleWindowLike_(s) &&
        (typeof looksActionableIssue_ === "function") && looksActionableIssue_(s)) {
      return { use: true, reason: "schedmix" };
    }
    return { use: false, reason: "" };
  }

  function issueIsValidSchemaIssues_(obj) {
    if (!obj || typeof obj !== "object") return false;
    var arr = obj.issues;
    if (!Array.isArray(arr) || arr.length < 1) return false;
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (!it || typeof it !== "object") return false;
      var sum = String(it.summary || "").trim();
      if (!sum) return false;
    }
    return true;
  }

  function issueExtractSchema_(rawText, lang, phone) {
    var apiKey = "";
    try {
      var sp = PropertiesService.getScriptProperties();
      apiKey = String(sp.getProperty("OPENAI_API_KEY") || "").trim();
    } catch (_) {}
    if (!apiKey) return null;

    var input = String(rawText || "").trim();
    if (input.length > 1500) input = input.slice(0, 1500);

    var modelName = "gpt-4.1-mini";
    try {
      var sp2 = PropertiesService.getScriptProperties();
      var m = String(sp2.getProperty("OPENAI_MODEL_EXTRACT") || "").trim();
      if (m) modelName = m;
    } catch (_) {}

    var system =
      "You extract maintenance issues and access notes from tenant messages.\n" +
      "Return JSON ONLY. No explanations.\n\n" +
      "Required JSON:\n" +
      "- issues: array of { trade, category, summary, tenant_description }\n" +
      "  trade: plumbing|electrical|hvac|appliance|general|other\n" +
      "  category: short category\n" +
      "  summary: one-line maintenance summary (required)\n" +
      "  tenant_description: raw tenant wording (optional)\n" +
      "- access_notes: string with availability/window (e.g. 'weekdays after 5pm', 'tomorrow out until 7')\n" +
      "- urgency: normal|urgent\n" +
      "- sentiment: neutral|frustrated\n" +
      "- issue_count: number of issues\n\n" +
      "Rules:\n" +
      "- Extract ALL distinct maintenance problems. Separate by trade.\n" +
      "- Ignore troubleshooting attempts (plunging, drain cleaner, reset, restarted, adjusted thermostat).\n" +
      "- Ignore emotion/frustration as an issue.\n" +
      "- Put availability/schedule in access_notes only.\n" +
      "- All summary, category, trade labels, and access_notes MUST be English (semantic normalization).";

    var user = "Message: " + JSON.stringify(input);

    var r = (typeof openaiChatJson_ === "function")
      ? openaiChatJson_({
          apiKey: apiKey,
          model: modelName,
          system: system,
          user: user,
          timeoutMs: 15000,
          phone: phone,
          logLabel: "SCHEMA_EXTRACT",
          maxRetries: 2
        })
      : { ok: false };
    if (r.err === "cooldown") {
      try { logDevSms_(phone || "", "", "SCHEMA_GATE skip=1 reason=[cooldown]"); } catch (_) {}
      return null;
    }
    if (!r.ok || !r.json) return null;
    var out = r.json;
    if (!issueIsValidSchemaIssues_(out)) return null;
    out.issue_count = (out.issues && out.issues.length) || 0;
    return out;
  }

  function issueApplySchemaToDraft_(dir, dirRow, schema, phone) {
    if (!dir || !dirRow || dirRow < 2 || !schema || !issueIsValidSchemaIssues_(schema)) return;
    var issues = schema.issues || [];
    if (!issues.length) return;

    var primary = String((issues[0] && issues[0].summary) || "").trim();
    if (!primary) return;

    var accessNotes = String(schema.access_notes || "").trim();
    var pendingRow = (typeof dalGetPendingRow_ === "function") ? dalGetPendingRow_(dir, dirRow) : 0;
    var existingIssue = String(dir.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_ISSUE : 5).getValue() || "").trim();

    if (primary && primary !== existingIssue) {
      if (pendingRow <= 0 && typeof sessionUpsertNoLock_ === "function" && phone) {
        var sessBuf = [];
        for (var j = 1; j < issues.length; j++) {
          var s = String((issues[j] && issues[j].summary) || "").trim();
          if (s) sessBuf.push({ rawText: s.slice(0, 500), createdAt: new Date().toISOString(), sourceStage: "SCHEMA" });
        }
        if (sessBuf.length > 50) sessBuf = sessBuf.slice(-50);
        sessionUpsertNoLock_(phone, { draftIssue: primary, issueBufJson: JSON.stringify(sessBuf) }, "applySchemaIssuesToDraft_");
      }
      if (typeof dalSetPendingIssueNoLock_ === "function") {
        dalSetPendingIssueNoLock_(dir, dirRow, primary);
      } else {
        dir.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_ISSUE : 5).setValue(primary);
      }
      if (typeof dalSetLastUpdatedNoLock_ === "function") dalSetLastUpdatedNoLock_(dir, dirRow);
      try { logDevSms_(phone || "", "", "DRAFT_APPLY_SCHEMA issue=[" + primary.slice(0, 60) + "] n=" + issues.length); } catch (_) {}
    }

    if (typeof appendIssueBufferItem_ === "function") {
      if (issues.length >= 2) appendIssueBufferItem_(dir, dirRow, primary, "SCHEMA");
      for (var k = 1; k < issues.length; k++) {
        var txt = String((issues[k] && issues[k].summary) || "").trim();
        if (txt) appendIssueBufferItem_(dir, dirRow, txt, "SCHEMA");
      }
    }

    if (accessNotes && pendingRow < 2) {
      if (typeof sessionUpsertNoLock_ === "function" && phone) {
        try { sessionUpsertNoLock_(phone, { draftScheduleRaw: accessNotes.slice(0, 500) }, "applySchemaIssuesToDraft_sched"); } catch (_) {}
      }
      if (typeof DIR_COL !== "undefined") {
        var draftCol = DIR_COL.DRAFT_SCHEDULE_RAW;
        var existingDraft = String(dir.getRange(dirRow, draftCol).getValue() || "").trim();
        if (!existingDraft) {
          dir.getRange(dirRow, draftCol).setValue(accessNotes.slice(0, 500));
          try { logDevSms_(phone || "", "", "DRAFT_APPLY_SCHEMA access_notes_draft=[" + accessNotes.slice(0, 40) + "]"); } catch (_) {}
        }
      }
    }
  }


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (post-split restore)
// issueIsClear_
// ─────────────────────────────────────────────────────────────────



  function issueIsClear_(issueSummary, issueConf, effectiveMessage) {
    const summary = String(issueSummary || "").trim();
    const conf = Number(issueConf || 0);

    const overrideCat = detectCategoryOverride_(effectiveMessage);
    const localClear = localIssueIsClear_(effectiveMessage);

    const summaryClear = summary.length >= 6;
    const confClear = conf >= 60;

    return !!overrideCat || !!localClear || summaryClear || confClear;
  }


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (dependency wave 2)
// localIssueIsClear_
// ─────────────────────────────────────────────────────────────────




  

  function localIssueIsClear_(text) {
    const t = String(text || "").toLowerCase();

    // Clear electrical problems
    if (/(outlet|outlets|no power|lost power|breaker|tripped|gfci|gfi|reset button|sparking|burning smell|light(s)? not working|switch not working|flicker)/.test(t)) {
      return true;
    }

    // Clear plumbing problems
    if (/(leak|leaking|clog|clogged|toilet (overflow|backed up|not flushing)|water backup|backing up)/.test(t)) {
      return true;
    }

    // Clear HVAC problems
    if (/(no heat|heat not working|no hot water|ac not working|not cooling|thermostat not working)/.test(t)) {
      return true;
    }

    // Clear appliance problems
    if (/(washer not draining|dryer not heating|dishwasher not draining|fridge not cooling|oven not heating)/.test(t)) {
      return true;
    }

    // Generic: enough words + "not working"
    if (t.length >= 18 && /\bnot working\b/.test(t)) return true;

    return false;
  }
