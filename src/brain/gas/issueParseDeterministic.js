/**
 * GAS `parseIssueDeterministic_` / `issueParseDeterministic_` — `09_ISSUE_CLASSIFICATION_ENGINE.gs`
 * plus router/DAL helpers: `looksActionableIssue_`, `isScheduleIntentOnly_`, `isScheduleWindowLike_`
 * (`14_DIRECTORY_SESSION_DAL.gs`), `looksLikeGreetingOnly_`, `looksLikeAckOnly_` (`16_ROUTER_ENGINE.gs`).
 *
 * Category uses `localCategoryFromText` — `src/dal/ticketDefaults.js` (GAS `localCategoryFromText_`).
 */
const { localCategoryFromText } = require("../../dal/ticketDefaults");

function normalizeIssueText_(s) {
  let t = String(s || "").trim();
  if (!t) return "";
  t = t.replace(/^\s*(hi|hey|hello)\b[\s,.-:]*/i, "");
  t = t.replace(/^\s*(please|pls)\b[\s,.-:]*/i, "");
  t = t.replace(/^\s*(can|could|would)\s+(someone|you|anyone)\s+/i, "");
  t = t.replace(/^\s*i\s+need\s+help\s+(with|on)\s+/i, "");
  t = t.replace(/^\s*i\s+need\s+/i, "");
  t = t.replace(/^\s*need\s+help\s+(with|on)\s+/i, "");
  t = t.replace(/^\s*need\s+/i, "");
  t = t.replace(/^\s*(take\s+a\s+look\s+at|look\s+at|check|inspect)\s+/i, "");
  t = t.replace(/\bmyu\b/gi, "my");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(
    /\s*(?:[,;:\-]\s*)?(?:please\s+)?(?:can|could|would)\s+you\s+send\s+(?:someone|somebody)(?:\s+(?:over|out))?\s*$/i,
    ""
  );
  t = t.replace(/\s*(?:[,;:\-]\s*)?(?:please\s+)?send\s+(?:someone|somebody)(?:\s+(?:over|out))?\s*$/i, "");
  t = t.replace(/[,.;:]+$/g, "").trim();
  return t;
}

/** Dedupe key for issue lines (e.g. merge base + buffer before finalize). */
function normalizeIssueForCompare(s) {
  const t = normalizeIssueText_(s);
  return String(t || "").toLowerCase().trim();
}

function isResolvedOrDismissedClause_(c) {
  const t = String(c || "").toLowerCase();
  return /\b(fixed\s+itself|no\s+worries|all\s+good|resolved|not\s+an\s+issue|no\s+longer|went\s+away|never\s*mind|nevermind|ignore\s+that|disregard|nothing\s+to\s+worry)\b/.test(
    t
  );
}

function isAttemptedFixClause_(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (
    /^\s*(checked|tried|replaced|reset|restarted|turned\s+off|turned\s+on|switched|unplugged|plugged\s+back|tested|flipped|tripped|pressed|adjusted|cleaned|cleared)\b/.test(
      t
    )
  )
    return true;
  if (
    /\b(breaker|outlet|thermostat|switch|circuit)\s+was\s+(checked|reset|tripped|tested|flipped)\b/.test(t)
  )
    return true;
  if (/\b(battery|filter)\s+was\s+replaced\b/.test(t)) return true;
  if (/\b(outlet|gfci)\s+was\s+reset\b/.test(t)) return true;
  if (
    /^\s*(i\s+)?(already\s+)?(checked|tried|reset|replaced|restarted)\s+/.test(t) &&
    t.length < 55
  )
    return true;
  return false;
}

function looksLikeGreetingOnly_(s) {
  const t = String(s || "").toLowerCase().trim();
  if (!t) return false;
  return /^(hi|hello|hey|yo|sup|good (morning|afternoon|evening)|hola|bonjour|hii+|heyy+)[!.]*$/.test(
    t
  );
}

function looksLikeAckOnly_(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const s = raw.toLowerCase().trim();
  if (/^[\s👍👌🙏✅🙂😊😀😅😂❤️💯🙌]+$/u.test(raw)) return true;
  const t = s
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  const words = t.split(" ").filter(Boolean);
  const charLen = t.length;
  if (words.length > 5) return false;
  if (charLen > 40) return false;
  const ISSUE_HINTS = [
    "leak",
    "leaking",
    "water",
    "flood",
    "flooding",
    "drip",
    "dripping",
    "sink",
    "toilet",
    "tub",
    "shower",
    "clog",
    "clogged",
    "backed up",
    "broken",
    "broke",
    "not working",
    "doesnt work",
    "won't",
    "wont",
    "no heat",
    "heat",
    "heater",
    "hot water",
    "ac",
    "a/c",
    "air",
    "smoke",
    "fire",
    "alarm",
    "lock",
    "door",
    "key",
    "mold",
    "gas",
    "noise",
    "sparks",
    "electric",
    "power",
    "outlet",
    "light",
  ];
  for (const k of ISSUE_HINTS) {
    if (t.includes(k)) return false;
  }
  const EXACT = new Set([
    "ok",
    "okay",
    "k",
    "kk",
    "kk.",
    "ok.",
    "okay.",
    "got it",
    "gotcha",
    "sounds good",
    "all set",
    "cool",
    "great",
    "awesome",
    "perfect",
    "nice",
    "appreciate it",
    "much appreciated",
    "good",
    "good thanks",
  ]);
  if (EXACT.has(t)) return true;
  if (
    /\b(thx|tnx|tks|thks|thanx|thnx|thnks)\b/.test(t) ||
    /\bthank(s|you)?\b/.test(t) ||
    /\bthank\s*u\b/.test(t) ||
    /\bty\b/.test(t)
  ) {
    if (words.length <= 4) return true;
  }
  if (/\b(ok|okay|got it|received|noted|understood)\b/.test(t) && words.length <= 4)
    return true;
  return false;
}

function looksActionableIssue_(s) {
  const t = String(s || "").toLowerCase().trim();
  if (!t) return false;
  if (isResolvedOrDismissedClause_(t)) return false;
  if (t.length < 6) return false;
  if (/^(ok|okay|k|yes|no|yep|nope|sure|thanks|thank you|cool|great|\?)$/.test(t))
    return false;
  if (
    /(leak|leaking|drip|dripping|clog|backup|flood|water|toilet|sink|shower|tub|heater|\bac\b|a\/c|\bheat\b|no heat|no hot|hot water|electric|outlet|breaker|sparks|smoke|gas|odor|mold|roach|bug|mouse|lock|door|key|window|broken|not working|doesn'?t work|maintenance)/.test(
      t
    )
  )
    return true;
  if (
    /(not working|doesn'?t work|broken|won'?t|wont|stopped|stop\s+working|stops?\s+working|leak|clog|smell|noise|sparks|tripping|overflow|backup|no heat|no hot|not heating|not cooling|doesn'?t drain|not draining)/.test(
      t
    )
  )
    return true;
  return false;
}

function isScheduleIntentOnly_(s) {
  let t = String(s || "").toLowerCase().trim();
  if (!t || t.length > 120) return false;
  if (looksActionableIssue_(t)) return false;
  if (/\b(leak|clog|broken|not working|stopped|ac\b|heat\b|toilet|sink|gym|lobby|hallway)\b/.test(t))
    return false;
  const scheduleAsk =
    /\b(please\s+)?(have\s+)?(maintenance\s+)?(schedule|someone)\s+(to\s+)?(check|come|look|fix|repair|inspect)/.test(
      t
    ) ||
    /\b(when\s+can\s+(someone|you|maintenance)\s+come)\b/.test(t) ||
    /\b(please\s+)?(schedule|send)\s+(someone|maintenance|a\s+tech)/.test(t) ||
    /\b(need\s+someone\s+to\s+check)\b/.test(t) ||
    /\b(can\s+someone\s+come\s+(out|by))\b/.test(t);
  return scheduleAsk;
}

function isScheduleWindowLike_(s) {
  const t = String(s || "").toLowerCase().trim();
  if (!t) return false;
  const hasDay = /today|tomorrow/.test(t) || /\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/.test(t);
  const hasTime =
    /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(t) ||
    /\b\d{1,2}\s*-\s*\d{1,2}\s*(am|pm)?\b/.test(t);
  const hasAvailability =
    /\b(available|availability|free|home|around|can you come|come by|stop by|anytime)\b/.test(t);
  const hasDayPart = /\b(morning|afternoon|evening)\b/.test(t);
  if (hasDayPart && (hasDay || hasTime || hasAvailability)) return true;
  if (hasDay || hasTime) return true;
  return false;
}

function issueHasIssueNounKeyword_(text) {
  const t = String(text || "").toLowerCase();
  return /\b(ac|a\/c|heat|heater|sink|toilet|leak|water|breaker|outlet|door|lock|window|thermostat|shower|tub|faucet|drain|pipe|stove|oven|range|burner|washer|dryer|fridge|refrigerator|dishwasher|microwave|light|intercom)\b/.test(
    t
  );
}

function issueIsRequestClausePattern_(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (
    /(^|\b)(need|have|send|get|schedule|dispatch|let|can|could|please)\b/.test(t) &&
    /(someone|maintenance|team|you|it)\b/.test(t)
  )
    return true;
  if (
    /\b(need\s+someone|need\s+maintenance|need\s+someone\s+to\s+(check|look|inspect|fix|repair)|have\s+someone|have\s+maintenance|can\s+someone|could\s+someone|please\s+have|send\s+someone|let\s+me\s+know|come\s+out|check\s+it|look\s+at\s+it)\b/.test(
      t
    )
  )
    return true;
  return false;
}

function issueClassifyClauseType_(c) {
  const t = String(c || "").toLowerCase().trim();
  if (!t) return "other";
  if (looksLikeGreetingOnly_(t)) return "greeting";
  if (looksLikeAckOnly_(t)) return "ack";
  if (isScheduleWindowLike_(t)) return "schedule";
  if (/\?$/.test(t)) return "question";
  if (/^\s*(when|what|how|why|can you|could you|is there|any chance|do you|will you)\b/.test(t))
    return "question";
  if (
    /\b(even after|maintenance came|tried adjusting|like they told|has been going on|going on for|getting frustrated|honestly getting|freezing at night|living room is freezing|over a month|over a week)\b/.test(
      t
    )
  )
    return "context";
  if (isAttemptedFixClause_(t)) return "attempt";
  if (/^\s*(i tried|i've tried|i have tried)\b/i.test(t)) return "attempt";
  if (/\b(drain cleaner|plunged|plunging|reset|restarted|adjusted|turned the thermostat)\b/.test(t))
    return "attempt";
  if (isScheduleIntentOnly_(t)) return "request";
  if (issueIsRequestClausePattern_(t)) return "request";
  if (t.length < 25 && !issueHasIssueNounKeyword_(t)) return "other";
  if (looksActionableIssue_(t)) return "problem";
  if (/\b(again|second|2nd|third|3rd|another|still|same issue|happened before|last time)\b/.test(t))
    return "context";
  if (isResolvedOrDismissedClause_(t)) return "other";
  return "other";
}

function issueScoreClause_(c, type) {
  const t = String(c || "").toLowerCase().trim();
  if (!t) return -999;
  if (type === "greeting" || type === "ack") return -500;
  if (type === "schedule") return -50;
  if (type === "request") return -50;
  if (type === "question") return -50;
  if (type === "attempt") return -250;
  if (isResolvedOrDismissedClause_(t)) return -300;
  let score = 0;
  if (
    /(not working|doesn'?t work|broken|won'?t|wont|stopped|leak|clog|smell|noise|sparks|tripping|overflow|backup|no heat|no hot|not heating|not cooling)/.test(
      t
    )
  )
    score += 60;
  if (
    /(sink|toilet|shower|tub|faucet|drain|pipe|stove|oven|range|burner|knob|washer|dryer|fridge|refrigerator|dishwasher|microwave|door|lock|window|outlet|light|breaker|thermostat|\bac\b|a\/c|heater|\bheat\b|intercom)/.test(
      t
    )
  )
    score += 35;
  if (/(gas|smoke|fire|sparks|arcing|carbon monoxide|co alarm|flooding|sewage|backing up)/.test(t))
    score += 80;
  if (type === "context") score += 10;
  if (t.length >= 20) score += 10;
  if (t.length >= 40) score += 10;
  if (
    /(time frame|when can|what time|availability|available|come by|stop by|tomorrow|today|morning|afternoon|evening)/.test(
      t
    )
  )
    score -= 25;
  return score;
}

function issueScoreClauseWithPos_(c, type, idx, total) {
  let score = issueScoreClause_(c, type);
  if (isResolvedOrDismissedClause_(c)) score -= 200;
  if (isAttemptedFixClause_(c)) score -= 180;
  if (total >= 6) {
    const frac = total <= 1 ? 0 : idx / (total - 1);
    score += Math.round(frac * 18);
  }
  return score;
}

function issueNormalizeTitle_(clause) {
  let t = String(clause || "").trim();
  if (!t) return "";
  t = t.replace(/^\s*(also|and|but|so)\b[\s,.:;]*/i, "");
  t = t.replace(/^\s*(just\s+)?(wanted to|want to|need to)\s+/i, "");
  t = t.replace(/^\s*(is there|any chance|can you|could you|would you)\b[\s,.-:]*/i, "");
  t = t.replace(/^\s*(this is|it'?s)\s+(the\s+)?(2nd|second|3rd|third)\b[\s,.-:]*/i, "");
  t = normalizeIssueText_(t);
  t = t.replace(/\b(is there a time frame|any time frame|when can you|what time frame)\b[\s\S]*$/i, "").trim();
  t = t.replace(/[,.;:]+$/g, "").trim();
  return t;
}

function issueEnsureParenQualifier_(title, q) {
  const tt = String(title || "").trim();
  const qual = String(q || "").trim();
  if (!tt || !qual) return tt;
  if (/\)\s*$/.test(tt)) return tt;
  return tt + " (" + qual + ")";
}

function issueFinalizeTitlePolish_(title, fullCleaned) {
  let t = String(title || "").trim();
  if (!t) return "";
  const lowerFull = String(fullCleaned || "").toLowerCase();
  let qual = "";
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

function issueBuildDetails_(clauses, coreIdx) {
  if (!clauses || !clauses.length) return "";
  const out = [];
  for (let i = 0; i < clauses.length; i++) {
    if (i === coreIdx) continue;
    const c = clauses[i] || {};
    if (!c.text) continue;
    if (c.type === "greeting" || c.type === "ack") continue;
    if (c.type === "schedule") continue;
    if (c.type === "context" || c.type === "request") continue;
    let text = String(c.text || "").trim();
    if (!text) continue;
    if (text.length > 220) text = text.slice(0, 220);
    out.push(text);
  }
  let joined = out.join(" | ").trim();
  if (joined.length > 450) joined = joined.slice(0, 450);
  return joined;
}

function issueDetectSubcategory_(title, details) {
  const t = (String(title || "") + " " + String(details || "")).toLowerCase();
  if (!t.trim()) return "";
  if (/\bstove\b|\boven\b|\brange\b/.test(t) && /\bknob\b/.test(t)) return "Stove knob";
  if (/\bclog\b|\bclogged\b|\bdrain\b/.test(t)) return "Clog";
  if (/\bleak\b|\bleaking\b|\bdrip\b/.test(t)) return "Leak";
  if (/\bno heat\b|\bheat\b/.test(t)) return "No heat";
  if (/\block\b|\bkey\b|\blocked out\b/.test(t)) return "Lock/Key";
  return "";
}

function issueDetectUrgency_(title, details) {
  const t = (String(title || "") + " " + String(details || "")).toLowerCase();
  const detectorMaint =
    /\b(battery|batteries|beeping|beep|chirping|chirp|replacement|replace|low battery|new battery)\b/.test(
      t
    ) && /\b(detector|alarm|smoke alarm|co alarm)\b/.test(t);
  const activeDanger =
    /\b(smell smoke|smoke coming from|see smoke|flames|on fire|burning|gas smell|smell gas)\b/.test(t) ||
    /\bco alarm\s+(going off|alarming)\b/.test(t);
  if (detectorMaint && !activeDanger) return "normal";
  if (/(gas smell|smell gas|carbon monoxide|co alarm|smoke|fire|sparks|arcing|electrical arc)/.test(t))
    return "urgent";
  if (/(flooding|flood|sewage|backing up|overflowing)/.test(t)) return "urgent";
  if (/(no heat|heat not working|no hot water|hot water not working)/.test(t)) return "high";
  if (/(no power|power out|lost power)/.test(t)) return "high";
  if (/(leak|leaking|water leak)/.test(t)) return "high";
  return "normal";
}

function extractIssuePayload_(s) {
  let t = String(s || "").trim();
  if (!t) return "";
  t = t.replace(/^\s*(hi|hey|hello|good (morning|afternoon|evening))\b[\s,.-:]*/i, "");
  t = t.replace(
    /^\s*(i\s+)?(called|call(ed)?|reach(ed)?|left a message|no answer|did not get anyone)\b[\s\S]{0,80}\b(my|the)\b/i,
    "$3 "
  );
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function issueStripPreamble_(s) {
  let t = String(s || "").trim();
  if (!t) return "";
  t = t.replace(/^\s*(hi|hey|hello|good (morning|afternoon|evening))\b[\s,.-:]*/i, "");
  t = t.replace(/^\s*[a-z]{2,}\s*,\s*/i, "");
  t = t.replace(/^\s*(this is|it'?s)\b[\s\S]{0,40}?\b(at|in|from)?\s*/i, "");
  t = t.replace(/^\s*(apt|apartment|unit|rm|room|suite|ste|#)\s*[\w-]{1,6}\b[\s,.-:]*?/i, "");
  t = t.replace(/^\s*\d{1,5}\s+[a-z]{2,}\b[\s,.-:]*?/i, "");
  t = extractIssuePayload_(t);
  t = t.replace(
    /^\s*(?:i'?m\s+)?[a-z]{2,}(?:\s+[a-z]{1,}){0,4}\s+(?:from|in)\s+(?:apt|apartment|unit|rm|room|suite|ste|#)\s*[\w-]{1,6}(?:\s+at\s+[a-z0-9\s'-]{1,30})?\b[\s,.-:;]*/i,
    ""
  );
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function issueSplitClauses_(s) {
  let t = String(s || "").trim();
  if (!t) return [];
  t = t.replace(/\s+/g, " ").trim();
  const parts = t.split(
    /(?:\.\s+|\?\s+|!\s+|;\s+|,\s+|\s+\-\s+|\s+also\s+|\s+but\s+|\s+however\s+|\s+plus\s+)/i
  );
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = String(parts[i] || "").trim();
    if (!p) continue;
    if (p.length < 3) continue;
    out.push(p);
  }
  return out;
}

function issueMaybeSplitProblemClause_(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  if (!/\band\b/i.test(t)) return [t];
  const nounAlt =
    "sink|toilet|shower|tub|faucet|drain|pipe|stove|oven|range|burner|washer|dryer|fridge|refrigerator|freezer|dishwasher|microwave|light|hallway|corridor|intercom|door|lock|window|thermostat|ac|a\\/c|heater|outlet|breaker|ice\\s*maker|icemaker";
  try {
    const rxSplit = new RegExp(
      "\\s+and\\s+(?=(?:the\\s+)?(?:" + nounAlt + ")\\b)",
      "i"
    );
    let parts = t
      .split(rxSplit)
      .map((x) => String(x || "").trim())
      .filter((x) => x.length >= 4);
    if (parts.length < 2) return [t];
    const nounRe = new RegExp("\\b(?:" + nounAlt + ")\\b", "i");
    const n0 = nounRe.test(parts[0]);
    const n1 = nounRe.test(parts[1]);
    if (!n0 || !n1) return [t];
    return parts;
  } catch (_) {
    /* ignore */
  }
  return [t];
}

/**
 * @param {string} rawText
 * @param {object} [opts]
 * @returns {{
 *   title: string,
 *   details: string,
 *   category: string,
 *   subcategory: string,
 *   urgency: string,
 *   clauses: Array<{ text: string, title: string, type: string, score: number }>,
 *   problemSpanCount: number,
 *   bestClauseText: string,
 *   debug: string
 * }}
 */
function parseIssueDeterministic(rawText, opts) {
  void opts;
  const raw = String(rawText || "").trim();
  if (!raw) {
    return {
      title: "",
      details: "",
      category: "",
      subcategory: "",
      urgency: "normal",
      clauses: [],
      problemSpanCount: 0,
      bestClauseText: "",
      debug: "",
    };
  }

  const cleaned = issueStripPreamble_(raw);
  const clausesRaw = issueSplitClauses_(cleaned);
  const clauses = [];

  for (let i = 0; i < clausesRaw.length; i++) {
    const c = String(clausesRaw[i] || "").trim();
    if (!c) continue;

    if (isScheduleWindowLike_(c)) {
      clauses.push({ text: c, title: "", type: "schedule", score: -999 });
      continue;
    }

    const baseType = issueClassifyClauseType_(c);
    const partsToProcess = baseType === "problem" ? issueMaybeSplitProblemClause_(c) : [c];
    const toProc = partsToProcess && partsToProcess.length ? partsToProcess : [c];

    for (let pIdx = 0; pIdx < toProc.length; pIdx++) {
      const part = String(toProc[pIdx] || "").trim();
      if (!part) continue;

      if (isScheduleWindowLike_(part)) {
        clauses.push({ text: part, title: "", type: "schedule", score: -999 });
        continue;
      }

      const type = issueClassifyClauseType_(part);
      const score = issueScoreClauseWithPos_(part, type, i + pIdx * 0.1, clausesRaw.length);
      let title = "";
      if (type === "problem") title = issueNormalizeTitle_(part);
      clauses.push({ text: part, title, type, score });
    }
  }

  let bestIdx = -1;
  let bestScore = -999999;
  for (let j = 0; j < clauses.length; j++) {
    const it = clauses[j];
    if (!it || it.type !== "problem") continue;
    if (it.score > bestScore) {
      bestScore = it.score;
      bestIdx = j;
    }
  }
  const core = bestIdx >= 0 ? clauses[bestIdx] : null;

  let titleOut = core && core.title ? core.title : "";
  if (titleOut) {
    titleOut = normalizeIssueText_(titleOut);
  }
  titleOut = issueFinalizeTitlePolish_(titleOut, cleaned);
  const detailsOut = issueBuildDetails_(clauses, bestIdx);

  let cat = "";
  try {
    cat =
      localCategoryFromText((titleOut + " " + detailsOut).trim()) ||
      localCategoryFromText(titleOut) ||
      "";
  } catch (_) {
    /* ignore */
  }
  const subcat = issueDetectSubcategory_(titleOut, detailsOut);
  const urgency = issueDetectUrgency_(titleOut, detailsOut);

  const outClauses = [];
  const seen = {};
  for (let m = 0; m < clauses.length; m++) {
    const c3 = clauses[m];
    if (!c3 || c3.type !== "problem") continue;
    const tt = c3.title ? String(c3.title).toLowerCase().trim() : "";
    if (!tt || seen[tt]) continue;
    seen[tt] = 1;
    outClauses.push({
      text: c3.text,
      title: c3.title,
      type: c3.type,
      score: c3.score,
    });
  }

  let problemSpanCount = 0;
  for (let psc = 0; psc < clauses.length; psc++) {
    if (clauses[psc] && clauses[psc].type === "problem") problemSpanCount++;
  }

  return {
    title: titleOut,
    details: detailsOut,
    category: cat || "",
    subcategory: subcat || "",
    urgency: urgency || "normal",
    clauses: outClauses,
    problemSpanCount,
    bestClauseText: core && core.text ? String(core.text).trim() : "",
    debug: "picked=" + bestIdx + " score=" + bestScore + " nClauses=" + clauses.length,
  };
}

module.exports = {
  parseIssueDeterministic,
  normalizeIssueForCompare,
  /** @internal tests / tools */
  _issueParseTestExports: {
    issueClassifyClauseType_,
    looksActionableIssue_,
    looksLikeGreetingOnly_,
    isScheduleWindowLike_,
    normalizeIssueText_,
  },
};
