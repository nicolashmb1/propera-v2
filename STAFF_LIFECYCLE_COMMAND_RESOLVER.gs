/**
 * STAFF_LIFECYCLE_COMMAND_RESOLVER.gs — Propera Compass
 * Staff lifecycle command parsing and resolution (non-# staff SMS).
 *
 * Responsibilities:
 * - staff identity resolution from phone
 * - open work item listing for staff
 * - target work item resolution from text
 * - outcome normalization from raw staff text
 * - clarification vs resolved behavior (including outbound intents)
 *
 * Lifecycle engine (`LIFECYCLE_ENGINE.gs`) remains responsible only for:
 * - canonical lifecycle signal intake (`handleLifecycleSignal_`)
 * - policy evaluation (`evaluateLifecyclePolicy_`)
 * - state transitions (`wiEnterState_`)
 * - timer writes/cancels
 * - lifecycle logging (`lifecycleLog_`)
 */

// ─────────────────────────────────────────────────────────────────────────────
// STAFF DIRECTORY HELPERS — identity + open work items
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if phone belongs to staff (canonical: Staff + Contacts). Only contacts linked via Staff.ContactId.
 */
function isStaffSender_(phone) {
  if (!phone) return false;
  var normalized = typeof normalizePhone_ === "function" ? normalizePhone_(String(phone).trim()) : String(phone).trim();
  if (!normalized) return false;
  var dig = function (s) { return String(s || "").replace(/\D/g, "").slice(-10); };
  try {
    var staffSh = typeof getActiveSheetByNameCached_ === "function" ? getActiveSheetByNameCached_("Staff") : SpreadsheetApp.getActive().getSheetByName("Staff");
    var contactsSh = typeof getActiveSheetByNameCached_ === "function" ? getActiveSheetByNameCached_("Contacts") : SpreadsheetApp.getActive().getSheetByName("Contacts");
    var sLast = staffSh.getLastRow();
    var cLast = contactsSh.getLastRow();
    if (!staffSh || !contactsSh || sLast < 2 || cLast < 2) return false;
    var sMap = typeof getHeaderMap_ === "function" ? getHeaderMap_(staffSh) : {};
    var cMap = typeof getHeaderMap_ === "function" ? getHeaderMap_(contactsSh) : {};
    var staffContactIdCol = (sMap["ContactId"] || sMap["ContactID"] || 2) - 1;
    var contactIdCol = (cMap["ContactID"] || cMap["ContactId"] || 1) - 1;
    var phoneCol = (cMap["PhoneE164"] || 2) - 1;
    var staffIds = {};
    var sNumRows = sLast - 1;
    if (sNumRows < 1) return false;
    var sData = staffSh.getRange(2, 1, sNumRows, staffSh.getLastColumn()).getValues();
    for (var s = 0; s < sData.length; s++) {
      var cid = String(sData[s][staffContactIdCol] || "").trim();
      if (cid) staffIds[cid] = true;
    }
    var cNumRows = cLast - 1;
    if (cNumRows < 1) return false;
    var cData = contactsSh.getRange(2, 1, cNumRows, contactsSh.getLastColumn()).getValues();
    for (var i = 0; i < cData.length; i++) {
      if (!staffIds[String(cData[i][contactIdCol] || "").trim()]) continue;
      var p = String(cData[i][phoneCol] != null ? cData[i][phoneCol] : "").trim();
      if (!p) continue;
      if (p === normalized || dig(p) === dig(normalized)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function lifecycleResolveStaffIdByPhone_(phone) {
  if (!phone) return null;
  var normalized = typeof normalizePhone_ === "function" ? normalizePhone_(String(phone).trim()) : String(phone).trim();
  var dig = function (s) { return String(s || "").replace(/\D/g, "").slice(-10); };
  try {
    var staffSh = typeof getActiveSheetByNameCached_ === "function" ? getActiveSheetByNameCached_("Staff") : SpreadsheetApp.getActive().getSheetByName("Staff");
    var contactsSh = typeof getActiveSheetByNameCached_ === "function" ? getActiveSheetByNameCached_("Contacts") : SpreadsheetApp.getActive().getSheetByName("Contacts");
    var cLast = contactsSh.getLastRow();
    var sLast = staffSh.getLastRow();
    if (!staffSh || !contactsSh || cLast < 2 || sLast < 2) return null;
    var cMap = typeof getHeaderMap_ === "function" ? getHeaderMap_(contactsSh) : {};
    var contactIdCol = (cMap["ContactID"] || cMap["ContactId"] || 1) - 1;
    var phoneCol = (cMap["PhoneE164"] || 2) - 1;
    var cNumRows = cLast - 1;
    if (cNumRows < 1) return null;
    var cData = contactsSh.getRange(2, 1, cNumRows, contactsSh.getLastColumn()).getValues();
    var contactId = null;
    for (var i = 0; i < cData.length; i++) {
      var p = String(cData[i][phoneCol] != null ? cData[i][phoneCol] : "").trim();
      if (p === normalized || dig(p) === dig(normalized)) { contactId = String(cData[i][contactIdCol] || "").trim(); break; }
    }
    if (!contactId) return null;
    var sMap = typeof getHeaderMap_ === "function" ? getHeaderMap_(staffSh) : {};
    var staffIdCol = (sMap["StaffId"] || 1) - 1;
    var sContactCol = (sMap["ContactId"] || sMap["ContactID"] || 2) - 1;
    var sNumRows = sLast - 1;
    if (sNumRows < 1) return null;
    var sData = staffSh.getRange(2, 1, sNumRows, staffSh.getLastColumn()).getValues();
    for (var j = 0; j < sData.length; j++) {
      if (String(sData[j][sContactCol] || "").trim() === contactId) return String(sData[j][staffIdCol] || "").trim();
    }
  } catch (_) {}
  return null;
}

function lifecycleListOpenWisForOwner_(ownerId) {
  var out = [];
  try {
    var sh = typeof getActiveSheetByNameCached_ === "function" ? getActiveSheetByNameCached_("WorkItems") : null;
    var lastRow = sh ? sh.getLastRow() : 0;
    var numRows = lastRow - 1;
    if (!sh || numRows < 1) return out;
    var map = typeof getHeaderMap_ === "function" ? getHeaderMap_(sh) : {};
    var colId = (map["WorkItemId"] || 1) - 1;
    var colStatus = (map["Status"] || 3) - 1;
    var colOwner = (map["OwnerId"] || 16) - 1;
    var colUnit = (map["UnitId"] || 8) - 1;
    var colProp = (map["PropertyId"] || map["PropertyCode"] || 0) - 1;
    var data = sh.getRange(2, 1, numRows, sh.getLastColumn()).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][colStatus] || "").toUpperCase() === "COMPLETED") continue;
      if (String(data[i][colOwner] || "").trim() !== String(ownerId || "").trim()) continue;
      var wiId = String(data[i][colId] || "").trim();
      var unitId = String(data[i][colUnit] || "").trim();
      var propertyId = (colProp >= 0 && data[i][colProp] != null) ? String(data[i][colProp] || "").trim().toUpperCase() : "";
      out.push({ workItemId: wiId, unitId: unitId, propertyId: propertyId });
    }
  } catch (_) {}
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT EXTRACTORS — unit, property, work item id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract unit from body. Supports: leading unit ("403 done", "403 refrigerator done", "403 penn done"),
 * "unit 403", "apt 403", "#403", trailing "403", and alphanumeric units (e.g. 403a).
 */
function lifecycleExtractUnitFromBody_(body) {
  var t = String(body || "").trim();
  var m = t.match(/^([0-9]+[a-z]?)\b/i) ||
          t.match(/\b(?:unit|apt|#|no\.?)\s*[:\s]*([a-z0-9\-]+)/i) ||
          t.match(/\b([0-9]+[a-z]?)\s+(?:[a-z]{2,5}\s+)?/i) ||
          t.match(/\b([0-9]+[a-z]?)\s+/i) ||
          t.match(/\b([0-9]+[a-z]?)\s*$/i);
  return m ? String(m[1] || "").trim() : "";
}

/**
 * Known property codes (from getActiveProperties_ when available). Used so we never treat "done", "sink", "fridge" as property.
 */
function lifecycleKnownPropertyCodes_() {
  if (typeof getActiveProperties_ === "function") {
    try {
      var list = getActiveProperties_() || [];
      var set = {};
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (p && (p.code || p.propertyCode)) set[String(p.code || p.propertyCode).trim().toUpperCase()] = true;
        if (p && p.propertyId) set[String(p.propertyId).trim().toUpperCase()] = true;
        if (p && p.shortName) set[String(p.shortName).trim().toUpperCase()] = true;
        if (p && p.name) {
          var nameWords = String(p.name).trim().split(/\s+/);
          for (var w = 0; w < nameWords.length; w++) {
            var word = String(nameWords[w] || "").replace(/\W/g, "").toUpperCase();
            if (word.length >= 2) set[word] = true;
          }
        }
      }
      return set;
    } catch (_) {}
  }
  return {};
}

/**
 * Resolve a hint (e.g. "Morris", "PENN") to the canonical PropertyCode for filtering WorkItems.
 * Uses getActiveProperties_: matches code, shortName, ticketPrefix, or significant name words.
 */
function lifecyclePropertyCodeFromHint_(hint) {
  if (!hint || typeof getActiveProperties_ !== "function") return "";
  var h = String(hint).trim().toUpperCase();
  if (!h) return "";
  try {
    var list = getActiveProperties_() || [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      var code = String(p.code || p.propertyCode || "").trim().toUpperCase();
      if (code && h === code) return code;
      if (p.shortName && h === String(p.shortName).trim().toUpperCase()) return code;
      if (p.ticketPrefix && h === String(p.ticketPrefix).trim().toUpperCase()) return code;
      if (p.name) {
        var nameWords = String(p.name).trim().split(/\s+/);
        for (var w = 0; w < nameWords.length; w++) {
          var word = String(nameWords[w] || "").replace(/\W/g, "").toUpperCase();
          if (word.length >= 2 && h === word) return code;
        }
      }
    }
  } catch (_) {}
  return "";
}

/**
 * Extract property code hint from body only when it matches a known property (code, shortName, or name word).
 * Supports: "PENN 403 done", "403 penn done", "411 Morris done" (unit + shortName/code).
 * Uses 2–10 letter tokens so "Morris", "Murray", "Westfield" match. Returns canonical PropertyCode.
 */
function lifecycleExtractPropertyHintFromBody_(body) {
  var t = String(body || "").trim();
  var known = lifecycleKnownPropertyCodes_();
  var code, m, re;
  // Pattern: word before digit (e.g. "Morris 411" or "PENN 403")
  re = /\b([A-Za-z]{2,10})\s+[0-9]/g;
  while ((m = re.exec(t)) !== null) {
    code = String(m[1] || "").trim().toUpperCase();
    if (known[code]) return lifecyclePropertyCodeFromHint_(code) || code;
  }
  // Pattern: digit then word (e.g. "411 Morris done", "403 penn done")
  re = /\b([0-9]+[a-z]?)\s+([A-Za-z]{2,10})\b/gi;
  while ((m = re.exec(t)) !== null) {
    code = String(m[2] || "").trim().toUpperCase();
    if (known[code]) return lifecyclePropertyCodeFromHint_(code) || code;
  }
  // Pattern: any known property token as standalone word
  re = /\b([A-Za-z]{2,10})\b/g;
  while ((m = re.exec(t)) !== null) {
    code = String(m[1] || "").trim().toUpperCase();
    if (known[code]) return lifecyclePropertyCodeFromHint_(code) || code;
  }
  return "";
}

/**
 * Extract WorkItemId hint from body so staff can disambiguate (e.g. "b18e2759 done", "WI_b18e2759 done").
 * Returns the matched segment (WI_xxx or 8+ alphanumeric) or "".
 */
function lifecycleExtractWorkItemIdHintFromBody_(body) {
  var t = String(body || "").trim();
  var wiPrefix = t.match(/\b(WI_[a-zA-Z0-9]+)\b/i);
  if (wiPrefix) return String(wiPrefix[1] || "").trim();
  var suffix = t.match(/\b([a-zA-Z0-9]{8,})\b/);
  return suffix ? String(suffix[1] || "").trim() : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// TARGET WORK ITEM RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/** Default score threshold above which we auto-pick a candidate using issue hints. */
var STAFF_RESOLVER_SCORE_THRESHOLD_ = 0.3;
/** Minimum margin between best and second-best score to auto-pick. */
var STAFF_RESOLVER_SCORE_MARGIN_ = 0.2;

/**
 * Get a short issue label for a work item (for scoring and suggested prompts).
 * Uses WorkItem.metadataJson if present; otherwise returns empty string.
 */
function staffGetIssueLabelForWi_(wiId) {
  if (!wiId || typeof workItemGetById_ !== "function") return "";
  var wi = workItemGetById_(wiId);
  if (!wi || !wi.metadataJson) return "";
  try {
    var meta = JSON.parse(String(wi.metadataJson || "{}"));
    var s = String(meta.issueSummary || meta.issue || meta.title || meta.summary || "").trim();
    return s.slice(0, 80).toLowerCase();
  } catch (_) {}
  return "";
}

/**
 * Score candidates by overlap of issue hints (fixtures/modifiers) with WI issue label.
 * Returns { best, bestScore, secondScore } or { tie: true, candidates } when no clear winner.
 */
function scoreCandidatesByIssueHints_(candidates, bodyTrim) {
  var hints = extractIssueHintsForStaff_(bodyTrim);
  var fixtures = hints.fixtures || [];
  var modifiers = hints.modifiers || [];
  if (fixtures.length === 0 && modifiers.length === 0) {
    return { tie: true, candidates: candidates };
  }
  var scored = [];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    var label = staffGetIssueLabelForWi_(c.workItemId);
    var score = 0;
    for (var f = 0; f < fixtures.length; f++) {
      if (label.indexOf(String(fixtures[f]).toLowerCase()) >= 0) score += 0.4;
    }
    for (var m = 0; m < modifiers.length; m++) {
      if (label.indexOf(String(modifiers[m]).toLowerCase()) >= 0) score += 0.3;
    }
    scored.push({ candidate: c, score: score });
  }
  scored.sort(function (a, b) { return (b.score - a.score); });
  var best = scored[0];
  var second = scored.length > 1 ? scored[1] : { score: 0 };
  if (best.score >= STAFF_RESOLVER_SCORE_THRESHOLD_ && (best.score - second.score) >= STAFF_RESOLVER_SCORE_MARGIN_) {
    return { best: best.candidate, bestScore: best.score, secondScore: second.score };
  }
  return { tie: true, candidates: candidates };
}

/** Max suggested prompts to include in clarification (avoid overwhelming staff). */
var STAFF_RESOLVER_MAX_SUGGESTED_PROMPTS_ = 5;

/**
 * Build suggested reply prompts for clarification (e.g. "403 sink done", "403 refrigerator done", or "403 done" when no issue label).
 * Dedupes by prompt text so multiple candidates with same label don't produce "'403 done' or '403 done'".
 */
function buildSuggestedPromptsForCandidates_(candidates) {
  var out = [];
  var seen = {};
  var limit = Math.min(candidates.length, STAFF_RESOLVER_MAX_SUGGESTED_PROMPTS_);
  for (var i = 0; i < limit; i++) {
    var c = candidates[i];
    var unit = String(c.unitId || "").trim() || "unit";
    var label = staffGetIssueLabelForWi_(c.workItemId);
    var prompt;
    if (label && label.length > 0) {
      var short = label.split(/\s+/).slice(0, 2).join(" ");
      prompt = unit + " " + short + " done";
    } else {
      prompt = unit + " done";
    }
    var key = String(prompt).toLowerCase().trim();
    if (key && !seen[key]) {
      seen[key] = 1;
      out.push(prompt);
    }
  }
  return out;
}

/**
 * Extract simple issue hints from staff text for clarification labels.
 * Returns { fixtures: string[], modifiers: string[] } with normalized tokens.
 */
function extractIssueHintsForStaff_(bodyTrim) {
  var t = String(bodyTrim || "").toLowerCase();
  var fixtures = [];
  var modifiers = [];

  function addOnce(arr, val) {
    if (!val) return;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] === val) return;
    }
    arr.push(val);
  }

  // Fixtures / locations
  if (/\bsink\b/.test(t)) addOnce(fixtures, "SINK");
  if (/\b(fridge|refrigerator)\b/.test(t)) addOnce(fixtures, "REFRIGERATOR");
  if (/\btoilet\b/.test(t)) addOnce(fixtures, "TOILET");
  if (/\b(tub|bathtub)\b/.test(t)) addOnce(fixtures, "BATHTUB");
  if (/\bshower\b/.test(t)) addOnce(fixtures, "SHOWER");
  if (/\boutlet\b/.test(t)) addOnce(fixtures, "OUTLET");
  if (/\bwasher\b/.test(t)) addOnce(fixtures, "WASHER");
  if (/\bdryer\b/.test(t)) addOnce(fixtures, "DRYER");
  if (/\bstove|oven\b/.test(t)) addOnce(fixtures, "STOVE");

  // Modifiers / problem words
  if (/\bclogged\b/.test(t)) addOnce(modifiers, "CLOGGED");
  if (/\bleak(s|ing)?\b/.test(t)) addOnce(modifiers, "LEAKING");
  if (/\bnot working\b/.test(t)) addOnce(modifiers, "NOT_WORKING");
  if (/\bno (hot )?water\b/.test(t)) addOnce(modifiers, "NO_WATER");
  if (/\b(no heat|heat(ing)? isn'?t working)\b/.test(t)) addOnce(modifiers, "NO_HEAT");

  return { fixtures: fixtures, modifiers: modifiers };
}

/**
 * Resolve target WorkItem for staff inbound.
 * Order (Phase 3 baseline):
 *   1) WI-id hint (strongest — explicit ticket reference)
 *   2) Property+unit-bounded candidate set
 *   3) Clarify when multiple candidates remain
 *   4) Fallback to ctx only when no bounded candidate can be found
 *
 * Returns { wiId: string, reason: string } or { wiId: "", reason: "CLARIFICATION*" }.
 */
function lifecycleResolveTargetWiForStaff_(phone, bodyTrim) {
  var body = String(bodyTrim || "").trim();
  var staffId = lifecycleResolveStaffIdByPhone_(phone);
  if (!staffId) return { wiId: "", reason: "CLARIFICATION" };

  var openWis = lifecycleListOpenWisForOwner_(staffId);
  if (openWis.length === 0) return { wiId: "", reason: "CLARIFICATION" };
  if (openWis.length === 1) return { wiId: openWis[0].workItemId, reason: "OWNER_MATCH" };

  // 1) WI-id hint first (strongest): explicit ticket fragment beats fuzzy text
  var wiIdHint = lifecycleExtractWorkItemIdHintFromBody_(body);
  if (wiIdHint) {
    var hintUpper = String(wiIdHint).toUpperCase();
    var byId = openWis.filter(function (w) {
      var id = String(w.workItemId || "").toUpperCase();
      return id === hintUpper || id.indexOf(hintUpper) >= 0 || id.lastIndexOf(hintUpper) === id.length - hintUpper.length;
    });
    if (byId.length === 1) return { wiId: byId[0].workItemId, reason: "WI_ID_MATCH" };
  }

  // 2) Property+unit bounding: derive a bounded candidate set before using ctx.
  // 2a) Extract unit (e.g. "403 done", "403 refrigerator done")
  var unitFromBody = lifecycleExtractUnitFromBody_(body);
  // 2b) Extract explicit property hint when it matches a known code (e.g. "penn 403 done")
  var propertyHint = lifecycleExtractPropertyHintFromBody_(body);

  var candidates = openWis;

  // If we have a property hint, scope first by property, then by unit inside that property.
  if (propertyHint) {
    candidates = candidates.filter(function (w) {
      return String(w.propertyId || "").toUpperCase() === propertyHint;
    });
  }

  // Apply unit filter within whatever property scope we have now.
  if (unitFromBody) {
    var unitNorm = String(unitFromBody).toLowerCase().replace(/\s/g, "");
    candidates = candidates.filter(function (w) {
      return String(w.unitId || "").toLowerCase().replace(/\s/g, "") === unitNorm;
    });
  }

  // If we have a bounded set, prefer decisions inside it.
  if (candidates.length === 1) {
    return { wiId: candidates[0].workItemId, reason: propertyHint ? "PROPERTY_UNIT_MATCH" : "UNIT_MATCH" };
  }
  if (candidates.length > 1) {
    // Phase 3: try issue-hint scoring to pick one; else clarify with suggested prompts.
    var scored = scoreCandidatesByIssueHints_(candidates, body);
    if (scored.best) {
      return { wiId: scored.best.workItemId, reason: "ISSUE_HINT_MATCH" };
    }
    var prompts = buildSuggestedPromptsForCandidates_(candidates);
    // If all candidates collapse to one prompt (e.g. same unit, no issue labels), auto-pick first to avoid clarification loop.
    if (prompts.length === 1) {
      return { wiId: candidates[0].workItemId, reason: "SINGLE_PROMPT_AUTO_PICK" };
    }
    return {
      wiId: "",
      reason: "CLARIFICATION_MULTI_MATCH",
      suggestedPrompts: prompts
    };
  }

  // 3) If property+unit could not produce any candidate, fall back to only unit across staff's scope.
  if (unitFromBody && !propertyHint) {
    var unitOnly = openWis.filter(function (w) {
      return String(w.unitId || "").toLowerCase().replace(/\s/g, "") === String(unitFromBody).toLowerCase().replace(/\s/g, "");
    });
    if (unitOnly.length === 1) return { wiId: unitOnly[0].workItemId, reason: "UNIT_MATCH_UNSCOPED_PROPERTY" };
    if (unitOnly.length > 1) {
      var unitPrompts = buildSuggestedPromptsForCandidates_(unitOnly);
      if (unitPrompts.length === 1) {
        return { wiId: unitOnly[0].workItemId, reason: "SINGLE_PROMPT_AUTO_PICK" };
      }
      return {
        wiId: "",
        reason: "CLARIFICATION_MULTI_PROPERTY",
        suggestedPrompts: unitPrompts
      };
    }
  }

  // 4) Fallback: ctx (kept for backward-compatibility, but only after bounded attempts above).
  var ctx = typeof ctxGet_ === "function" ? ctxGet_(phone) : null;
  var wiId = ctx ? (String(ctx.pendingWorkItemId || "").trim() || String(ctx.activeWorkItemId || "").trim()) : "";
  if (wiId && typeof workItemGetById_ === "function") {
    var wi = workItemGetById_(wiId);
    if (wi && String(wi.status || "").toUpperCase() !== "COMPLETED") return { wiId: wiId, reason: "CTX" };
  }
  return { wiId: "", reason: "CLARIFICATION" };
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTCOME NORMALIZATION — from raw staff text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse optional parts ETA from message text. Returns { partsEtaAt: Date|null, partsEtaText: string }.
 * Minimal patterns: tomorrow, next week, in N days, M/D, M/D/YY, month name day, "eta ...", "expected ...", "by ...".
 */
function lifecycleParsePartsEta_(bodyTrim) {
  var out = { partsEtaAt: null, partsEtaText: "" };
  var t = String(bodyTrim || "").trim();
  if (!t) return out;
  var lower = t.toLowerCase();
  var now = new Date();
  var year = now.getFullYear();

  if (/\btomorrow\b/.test(lower)) {
    var d1 = new Date(now); d1.setDate(d1.getDate() + 1); out.partsEtaAt = d1; out.partsEtaText = "tomorrow"; return out;
  }
  if (/\bnext week\b/.test(lower)) {
    var d2 = new Date(now); d2.setDate(d2.getDate() + 7); out.partsEtaAt = d2; out.partsEtaText = "next week"; return out;
  }
  var inDays = t.match(/\bin\s+(\d+)\s+days?\b/i);
  if (inDays && inDays[1]) {
    var n = parseInt(inDays[1], 10); if (isFinite(n) && n >= 0 && n <= 365) {
      var d3 = new Date(now); d3.setDate(d3.getDate() + n); out.partsEtaAt = d3; out.partsEtaText = "in " + n + " days"; return out;
    }
  }
  var md = t.match(/\b(?:eta|expected|by|on|delivery)\s*[:\s]*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i) || t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (md) {
    var m = parseInt(md[1], 10); var day = parseInt(md[2], 10); var y = md[3] ? parseInt(md[3], 10) : year;
    if (md[3] && md[3].length <= 2) y = 2000 + (y % 100);
    var d4 = new Date(y, m - 1, day);
    if (isFinite(d4.getTime()) && d4.getMonth() === m - 1) { out.partsEtaAt = d4; out.partsEtaText = md[0].slice(0, 30); return out; }
  }
  var monthNames = "january|february|march|april|may|june|july|august|september|october|november|december";
  var mon = new RegExp("\\b(" + monthNames + ")\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?\\b", "i").exec(t);
  if (mon) {
    var midx = monthNames.split("|").indexOf(mon[1].toLowerCase());
    var day2 = parseInt(mon[2], 10); var y2 = mon[3] ? parseInt(mon[3], 10) : year;
    var d5 = new Date(y2, midx, day2);
    if (isFinite(d5.getTime())) { out.partsEtaAt = d5; out.partsEtaText = mon[0].slice(0, 30); return out; }
  }
  return out;
}

/**
 * Normalize staff message to outcome: COMPLETED | IN_PROGRESS | WAITING_PARTS | NEEDS_VENDOR | DELAYED | ACCESS_ISSUE | UNRESOLVED.
 * For WAITING_PARTS, returns { outcome: "WAITING_PARTS", partsEtaAt?: Date, partsEtaText?: string }; otherwise returns string.
 * Do not call before WI is resolved.
 */
function lifecycleNormalizeStaffOutcome_(bodyTrim) {
  var t = String(bodyTrim || "").toLowerCase().trim();
  if (!t) return "UNRESOLVED";
  if (/\b(done|complete|completed|finished|fixed|resolved)\b/.test(t)) return "COMPLETED";
  if (/\b(in progress|working on it|started|on it|in progress)\b/.test(t)) return "IN_PROGRESS";
  if (/\b(waiting on parts|parts ordered|waiting for parts|backorder)\b/.test(t)) {
    var eta = lifecycleParsePartsEta_(bodyTrim);
    return { outcome: "WAITING_PARTS", partsEtaAt: eta.partsEtaAt, partsEtaText: eta.partsEtaText };
  }
  if (/\b(vendor|contractor|need to send|dispatch)\b/.test(t)) return "NEEDS_VENDOR";
  if (/\b(delayed|running late|reschedule|tomorrow|next week)\b/.test(t)) return "DELAYED";
  if (/\b(access|key|entry|no access|couldn't get in)\b/.test(t)) return "ACCESS_ISSUE";
  return "UNRESOLVED";
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE SET — staff natural commands (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

function staffEscapeRe_(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip the {property + unit} targeting prefix from a staff message.
 * This isolates the "schedule remainder" so the shared parser doesn't treat
 * unit numbers (e.g. 403) as schedule time.
 */
function staffExtractScheduleRemainderFromTarget_(bodyTrim, unitFromBody, propertyHint) {
  var remainder = String(bodyTrim || "").trim();
  if (!remainder) return "";

  // 1) If message starts with property, remove it first.
  if (propertyHint) {
    var reP0 = new RegExp("^\\s*" + staffEscapeRe_(propertyHint) + "\\b\\s*", "i");
    remainder = remainder.replace(reP0, "");
  }

  // 2) If message now starts with unit (with optional prefixes), remove it.
  if (unitFromBody) {
    var u = staffEscapeRe_(unitFromBody);
    remainder = remainder.replace(new RegExp("^\\s*(?:unit|apt)\\s*[:\\s]*" + u + "\\b\\s*", "i"), "");
    remainder = remainder.replace(new RegExp("^\\s*#\\s*" + u + "\\b\\s*", "i"), "");
    remainder = remainder.replace(new RegExp("^\\s*no\\.?\\s*" + u + "\\b\\s*", "i"), "");
    remainder = remainder.replace(new RegExp("^\\s*" + u + "\\b\\s*", "i"), "");
  }

  // 3) If message now starts with property again (unit → property order), remove it.
  if (propertyHint) {
    var reP1 = new RegExp("^\\s*" + staffEscapeRe_(propertyHint) + "\\b\\s*", "i");
    remainder = remainder.replace(reP1, "");
  }

  // 4) Strip leading punctuation/separators.
  remainder = remainder.replace(/^[\\s,:;\\-]+/, "").trim();
  return remainder;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRYPOINT — staffHandleLifecycleCommand_
// ─────────────────────────────────────────────────────────────────────────────

/**
 * staffHandleLifecycleCommand_(phone, rawText)
 *
 * Entry point for non-# staff lifecycle commands.
 * Mirrors previous `routeStaffInbound_` behavior:
 * - resolve staff identity
 * - resolve target WI
 * - normalize outcome
 * - call handleLifecycleSignal_(signal) on success
 * - dispatch same outbound intents as before (ACK / clarification)
 *
 * Returns true when the message was handled; false only if not handled.
 */
function staffHandleLifecycleCommand_(phone, rawText) {
  if (!phone) return false;
  var body = String(rawText || "").trim();
  var staffId = lifecycleResolveStaffIdByPhone_(phone);

  var resolved = lifecycleResolveTargetWiForStaff_(phone, body);
  var wiId = resolved.wiId;
  if (!wiId) {
    lifecycleLog_("STAFF_TARGET_UNRESOLVED", "GLOBAL", "", { reason: resolved.reason || "CLARIFICATION", rawText: body.slice(0, 500), actorType: "STAFF", actorId: phone });
    var clarifyVars = {};
    if (resolved.suggestedPrompts && resolved.suggestedPrompts.length > 0) {
      clarifyVars.options = resolved.suggestedPrompts;
      clarifyVars.suggestedPrompts = resolved.suggestedPrompts;
    }
    if (typeof dispatchOutboundIntent_ === "function") {
      dispatchOutboundIntent_(lifecycleOutboundIntent_(staffId, phone, "STAFF_CLARIFICATION", "STAFF_CLARIFICATION", clarifyVars, "REPLY_SAME_CHANNEL", resolved.reason || "STAFF_TARGET_UNRESOLVED"));
    }
    return true;
  }

  // Phase 3 — schedule intent for UNSCHEDULED tickets.
  // Only the resolver does natural-language extraction; lifecycle applies the canonical schedule payload.
  var wiForSchedule = typeof workItemGetById_ === "function" ? workItemGetById_(wiId) : null;
  var wiState = wiForSchedule ? String(wiForSchedule.state || "").trim().toUpperCase() : "";
  if (wiState === "UNSCHEDULED" && typeof parsePreferredWindowShared_ === "function") {
    // Avoid overriding explicit staff outcomes.
    var lower = body.toLowerCase();
    var hasDoneOrStatus =
      /\b(done|complete|completed|finished|fixed|resolved)\b/.test(lower) ||
      /\b(in progress|working on it|started|on it)\b/.test(lower) ||
      /\b(waiting on parts|parts ordered|waiting for parts|backorder)\b/.test(lower) ||
      /\b(vendor|contractor|need to send|dispatch)\b/.test(lower) ||
      /\b(access|key|entry|no access|couldn't get in)\b/.test(lower);

    if (!hasDoneOrStatus) {
      var unitFromBody = lifecycleExtractUnitFromBody_(body);
      var propertyHint = lifecycleExtractPropertyHintFromBody_(body);
      var scheduleRemainder = staffExtractScheduleRemainderFromTarget_(body, unitFromBody, propertyHint);

      if (scheduleRemainder && scheduleRemainder.length >= 2) {
        var scheduleParsed = null;
        try {
          // stageDay intentionally null: staff schedule replies should include an explicit day/time.
          scheduleParsed = parsePreferredWindowShared_(scheduleRemainder, null);
        } catch (_) {}

        if (scheduleParsed && scheduleParsed.end instanceof Date && isFinite(scheduleParsed.end.getTime())) {
          var propertyIdForSchedule = wiForSchedule ? String(wiForSchedule.propertyId || "").trim().toUpperCase() : "GLOBAL";
          var scheduleSignal = {
            eventType: "SCHEDULE_SET",
            wiId: wiId,
            propertyId: propertyIdForSchedule,
            scheduledEndAt: scheduleParsed.end,
            scheduleLabel: scheduleParsed.label,
            scheduleKind: scheduleParsed.kind,
            phone: phone,
            actorType: "STAFF",
            actorId: phone,
            reasonCode: "STAFF_SCHEDULE_SET",
            rawText: body.slice(0, 500),
            scheduleText: scheduleRemainder
          };

          var resultSchedule = handleLifecycleSignal_(scheduleSignal);
          if (typeof dispatchOutboundIntent_ === "function") {
            if (resultSchedule === "OK") {
              // Schedule application is a different semantic event than generic work-progress updates.
              // Use schedule-specific ACK wording instead of reusing STAFF_UPDATE_ACK.
              dispatchOutboundIntent_(
                lifecycleOutboundIntent_(
                  staffId,
                  phone,
                  "STAFF_SCHEDULE_ACK",
                  "STAFF_SCHEDULE_ACK",
                  { scheduleLabel: String(scheduleSignal && scheduleSignal.scheduleLabel ? scheduleSignal.scheduleLabel : "").trim() },
                  "REPLY_SAME_CHANNEL",
                  "STAFF_SCHEDULE_SET"
                )
              );
            } else {
              var clarifyVarsReject2 = { reasonCode: resultSchedule };
              if (resultSchedule === "REJECTED") clarifyVarsReject2.transitionRejected = true;
              dispatchOutboundIntent_(lifecycleOutboundIntent_(staffId, phone, "STAFF_CLARIFICATION", "STAFF_CLARIFICATION", clarifyVarsReject2, "REPLY_SAME_CHANNEL", resultSchedule === "REJECTED" ? "STAFF_TRANSITION_REJECTED" : "STAFF_HOLD_OR_REJECT"));
            }
          }
          return true;
        }
      }
    }
  }

  var normalized = lifecycleNormalizeStaffOutcome_(body);
  var outcome = (typeof normalized === "object" && normalized && normalized.outcome) ? normalized.outcome : normalized;
  if (outcome !== "UNRESOLVED") {
    var wi = typeof workItemGetById_ === "function" ? workItemGetById_(wiId) : null;
    var propertyId = wi ? String(wi.propertyId || "").trim().toUpperCase() : "GLOBAL";
    var signalPayload = {
      eventType: "STAFF_UPDATE",
      wiId: wiId,
      propertyId: propertyId,
      outcome: outcome,
      phone: phone,
      actorType: "STAFF",
      actorId: phone,
      reasonCode: "STAFF_UPDATE",
      rawText: body.slice(0, 500)
    };
    if (typeof normalized === "object" && normalized && (normalized.partsEtaAt != null || normalized.partsEtaText)) {
      if (normalized.partsEtaAt instanceof Date) signalPayload.partsEtaAt = normalized.partsEtaAt;
      if (normalized.partsEtaText != null) signalPayload.partsEtaText = String(normalized.partsEtaText).trim();
    }
    var result = handleLifecycleSignal_(signalPayload);
    if (typeof dispatchOutboundIntent_ === "function") {
      if (result === "OK") {
        dispatchOutboundIntent_(lifecycleOutboundIntent_(staffId, phone, "STAFF_UPDATE_ACK", "STAFF_UPDATE_ACK", { outcome: outcome }, "REPLY_SAME_CHANNEL", "STAFF_UPDATE"));
      } else {
        var clarifyVarsReject = { reasonCode: result };
        if (result === "REJECTED") clarifyVarsReject.transitionRejected = true;
        dispatchOutboundIntent_(lifecycleOutboundIntent_(staffId, phone, "STAFF_CLARIFICATION", "STAFF_CLARIFICATION", clarifyVarsReject, "REPLY_SAME_CHANNEL", result === "REJECTED" ? "STAFF_TRANSITION_REJECTED" : "STAFF_HOLD_OR_REJECT"));
      }
    }
    return true;
  }
  lifecycleLog_("STAFF_UPDATE_UNRESOLVED", "", wiId, { rawText: body.slice(0, 500), actorType: "STAFF", actorId: phone });
  if (typeof dispatchOutboundIntent_ === "function") {
    dispatchOutboundIntent_(lifecycleOutboundIntent_(staffId, phone, "STAFF_CLARIFICATION", "STAFF_CLARIFICATION", {}, "REPLY_SAME_CHANNEL", "STAFF_CLARIFY"));
  }
  return true;
}

