/**
 * CANONICAL_INTAKE_ENGINE.gs — Propera Canonical Intake & Draft Upsert
 *
 * OWNS:
 *   - Utilities (dbg, locks, dir), deterministic issue parsing/classification helpers, canonical intake sheet
 *   - Issue atoms, split preview, merge commit, attach classification, draftUpsertFromTurn_
 *
 * DOES NOT OWN:
 *   - PROPERA MAIN.gs shell: props, Twilio constants, commWebhookSecret_, onOpen, LOG_SHEET_ID, COL, dev flags
 *   - recomputeDraftExpected_, finalize, portal PM, ops domain router -> TICKET_FINALIZE_ENGINE.gs
 *   - Session/ctx DAL -> DIRECTORY_SESSION_DAL.gs
 *
 * ENTRY POINTS:
 *   - draftUpsertFromTurn_(), properaCanonicalIntakeMergeCommit_(), etc.
 *
 * DEPENDENCIES:
 *   - Globals from PROPERA MAIN.gs shell: props, TWILIO_*, LOG_SHEET_ID, SHEET_NAME, DIR_COL, dal*, session*, etc.
 *
 * FUTURE MIGRATION NOTE:
 *   - Canonical intake state service; sheet I/O becomes repository APIs
 *
 * SECTIONS IN THIS FILE:
 *   1. Core utilities (dbg, locks, dir)
 *   2. Issue parsing & canonical intake DAL
 *   3. Draft upsert from turn
 */
function dbg_() {
  try {
    Logger.log([].slice.call(arguments).join(" "));
  } catch (_) {}
}

function withWriteLock_(label, fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } catch (err) {
    try { logDevSms_("(system)", "", "WRITELOCK_ERR " + label + " " + String(err && err.stack ? err.stack : err)); } catch (_) {}
    throw err;
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// =========================
// Propera Compass: Directory write helper (LOCKED)
// =========================
function dirSet_(dir, dirRow, obj) {
  if (!dirRow) return;
  dalWithLock_("DIR_SET", function () {
    if (obj.propertyCode !== undefined || obj.propertyName !== undefined) dalSetPendingPropertyNoLock_(dir, dirRow, { code: obj.propertyCode, name: obj.propertyName });
    if (obj.pendingIssue !== undefined) {
      var issueCandidate = String(obj.pendingIssue || "").trim();
      if (issueCandidate) {
        dalSetPendingIssueNoLock_(dir, dirRow, issueCandidate);
        try { logDevSms_("", "", "ISSUE_WRITE site=[dirSet_] val=[" + issueCandidate.slice(0, 40) + "]"); } catch (_) {}
      }
    }
    if (obj.pendingUnit  !== undefined) dalSetPendingUnitNoLock_(dir, dirRow, obj.pendingUnit);
    if (obj.pendingRow   !== undefined) dalSetPendingRowNoLock_(dir, dirRow, obj.pendingRow);
    if (obj.pendingStage !== undefined) dalSetPendingStageNoLock_(dir, dirRow, obj.pendingStage);
    dalSetLastUpdatedNoLock_(dir, dirRow);
    try { logDevSms_("", "", "DAL_WRITE DIR_SET row=" + dirRow); } catch (_) {}
  });
}

// C3 extracted: parser primitives now live in ISSUE_CLASSIFICATION_ENGINE.gs.

// ============================================================
// DETERMINISTIC ISSUE PARSER (AI-feel, no AI)
// Output: { title, details, category, subcategory, urgency, clauses, debug }
// clauses: [{ text, title, type, score }]
// ============================================================

// Multi-issue hygiene helper:
// For a single "problem" clause containing multiple fixtures joined by "and the <fixture>",
// split into subclauses so parseIssueDeterministic_ can produce multiple problem clauses.
function maybeSplitProblemClauseIntoMultiSubclauses_(text) { return issueMaybeSplitProblemClause_(text); }

function parseIssueDeterministic_(rawText, opts) { return issueParseDeterministic_(rawText, opts); }


// ------------------------------------------------------------
// Clause splitting
// ------------------------------------------------------------
function splitIssueClauses_(s) { return issueSplitClauses_(s); }

/** Feature flag: schema-based issue extraction for long messages. Default OFF. */
function isSchemaExtractEnabled_() {
  return issueSchemaExtractEnabled_();
}

/** Gate: true when message should use schema extract (slow lane). Returns { use, reason }. */
function shouldUseSchemaExtract_(t) {
  return issueShouldUseSchemaExtract_(t);
}

/** Deterministic digest when Twilio SID is missing (SIM/tests/internal). Prevents retries bypassing dedupe. */
function _nosidDigest_(fromDed, bodyTrim) {
  var raw = String(fromDed || "") + "|" + String(bodyTrim || "");
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw, Utilities.Charset.UTF_8);
  return digest.map(function(b){ return ("0" + ((b + 256) % 256).toString(16)).slice(-2); }).join("").slice(0, 24);
}

// C1+C2 extracted: OpenAI transport + media signal/attachment runtime live in AI_MEDIA_TRANSPORT.gs.

// =============================================================================
// Propera Compass — Image Signal Adapter (Phase 1)
// Shared media/image adapter for tenant SMS/WhatsApp, staff # screenshot, synthetic body.
// Channel-neutral inbound media: canonical JSON in e.parameter._mediaJson (preferred),
// with legacy Twilio NumMedia / MediaUrl* as fallback (normalized once via ensureCanonicalMediaJsonOnParameters_).
// =============================================================================

// Phase-1 manual test scenarios (no harness):
// TEST 1 — tenant real photo + text: Body "which one do I switch...", image breaker panel → mediaType real_world_photo, category hint electrical, merged body to compileTurn_, no crash.
// TEST 2 — tenant attachment-only: Body empty, NumMedia=1, thermostat image → syntheticBody if possible, hasMediaOnly false when synthetic strong, issue can append.
// TEST 3 — staff # + screenshot chat: Body "#", image of tenant saying smoke detectors beeping → staff capture flow, merged payload from extracted text, compileTurn_ gets usable text.
// TEST 4 — staff # + note + screenshot: Body "# apt 305 penn", screenshot → merged text includes complaint context.
// TEST 5 — non-image media → adapter no-ops safely.
// TEST 6 — AI failure/timeout → fallback, no break.

/** Validator: schema object must have issues array with at least 1 item and summary strings. */
function isValidSchemaIssues_(obj) {
  return issueIsValidSchemaIssues_(obj);
}

/** Schema-based issue extraction (LLM JSON) for long messages. Returns null on failure. */
function extractIssuesSchema_(rawText, lang, phone) {
  return issueExtractSchema_(rawText, lang, phone);
}

/** Apply schema extraction results to draft (PendingIssue, IssueBuffer) and access notes. Call inside dalWithLock_. */
function applySchemaIssuesToDraft_(dir, dirRow, schema, phone) {
  return issueApplySchemaToDraft_(dir, dirRow, schema, phone);
}


// ------------------------------------------------------------
// Preamble stripping (greeting + identity + property/unit/location)
// Keep deterministic and conservative (don't eat real issue).
// ------------------------------------------------------------
function stripIssuePreamble_(s) { return issueStripPreamble_(s); }

var PROBLEM_THRESHOLD = (typeof ISSUE_PROBLEM_THRESHOLD_ !== "undefined") ? ISSUE_PROBLEM_THRESHOLD_ : 30;

function hasIssueNounKeyword_(text) { return issueHasIssueNounKeyword_(text); }

function isRequestClausePattern_(text) { return issueIsRequestClausePattern_(text); }


// ------------------------------------------------------------
// Clause type classification
// ------------------------------------------------------------
// Phase A contract (taxonomy → legacy labels used in this file):
// - problem: symptom/defect/hazard maintenance should fix (→ type "problem")
// - context: scene-setting / temporal narrative without defect as primary (→ "context")
// - schedule: availability / time windows (→ "schedule" when strict window; else often "other")
// - request: dispatch / visit / meta-request without new defect (→ "request"; schedule-intent-only → "request")
// - filler/other: greeting / ack / chit / resolved (→ "greeting"|"ack"|"other")
// - question / attempt: subtypes that must not win as primary issue (→ "question"|"attempt")
// Admission to issue buffer / multi-issue lists: only classify === "problem" (see isProblemClauseForAdmission_,
// parseIssueDeterministic_ outClauses, appendIssueBufferItem_).
function classifyIssueClauseType_(c) { return issueClassifyClauseType_(c); }

/** True only when clause is classified as a maintenance problem (buffer / mixed-property split admission). */
function isProblemClauseForAdmission_(text) { return issueIsProblemClauseForAdmission_(text); }


// ------------------------------------------------------------
// Scoring
// ------------------------------------------------------------
function scoreIssueClauseWithPos_(c, type, idx, total) { return issueScoreClauseWithPos_(c, type, idx, total); }

function scoreIssueClause_(c, type) { return issueScoreClause_(c, type); }


// ------------------------------------------------------------
// Title normalization (more aggressive than normalizeIssueText_ but safe)
// ------------------------------------------------------------
function normalizeIssueTitle_(clause) { return issueNormalizeTitle_(clause); }


// ------------------------------------------------------------
// Final polish: add qualifiers like "(second time)" or "(second knob)"
// ------------------------------------------------------------
function finalizeIssueTitlePolish_(title, fullCleaned) { return issueFinalizeTitlePolish_(title, fullCleaned); }

function ensureParenQualifier_(title, q) { return issueEnsureParenQualifier_(title, q); }

/** Build one deterministic summary from multiple problem clauses (order preserved, semicolon-separated). Used for staff capture multi-issue title only. */
function buildCombinedIssueTitleFromClauses_(clauses) { return issueBuildCombinedTitleFromClauses_(clauses); }


// ------------------------------------------------------------
// Details builder: keep only useful non-schedule, non-ack content
// ------------------------------------------------------------
function buildIssueDetails_(clauses, coreIdx) { return issueBuildDetails_(clauses, coreIdx); }


// ------------------------------------------------------------
// Subcategory (optional)
// ------------------------------------------------------------
function detectSubcategory_(title, details) { return issueDetectSubcategory_(title, details); }


// ------------------------------------------------------------
// Urgency (deterministic)
// ------------------------------------------------------------
function detectUrgency_(title, details) { return issueDetectUrgency_(title, details); }

// ============================================================
// CANONICAL INTAKE MEMORY (authoritative pre-ticket state)
// AI/extraction proposes values; system validators decide commits.
// ============================================================
var INTAKE_MEMORY_SHEET = "IntakeMemory";
var INTAKE_MEMORY_COLS = {
  PHONE: 1,
  CONVERSATION_KEY: 2,
  ACTIVE: 3,
  STATUS: 4,
  PROPERTY_CODE: 5,
  PROPERTY_NAME: 6,
  UNIT: 7,
  PRIMARY_ISSUE: 8,
  ISSUE_BUF_JSON: 9,
  ISSUE_META_JSON: 10,
  SCHEDULE_RAW: 11,
  PREFERRED_WINDOW: 12,
  EXPECTED_NEXT: 13,
  CURRENT_STAGE: 14,
  REVISION: 15,
  LAST_WRITER: 16,
  TENTATIVE_JSON: 17,
  UPDATED_AT_ISO: 18
};

function ensureCanonicalIntakeSheet_() {
  var sh = getActiveSheetByNameCached_(INTAKE_MEMORY_SHEET);
  if (sh) return sh;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  sh = ss.getSheetByName(INTAKE_MEMORY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(INTAKE_MEMORY_SHEET);
    sh.getRange(1, 1, 1, 18).setValues([[
      "PhoneE164", "ConversationKey", "ActiveIntake", "Status", "PropertyCode", "PropertyName", "Unit",
      "PrimaryIssue", "IssueBufJson", "IssueMetaJson", "ScheduleRaw", "PreferredWindow",
      "ExpectedNext", "CurrentStage", "Revision", "LastWriter", "TentativeJson", "UpdatedAtIso"
    ]]);
  }
  return sh;
}

function canonicalIntakeLoadNoLock_(sh, phone) {
  var p = actorKey_(phone);
  if (!p) return null;
  var r = findRowByValue_(sh, "PhoneE164", p);
  if (!r) {
    return {
      row: 0,
      phoneE164: p,
      conversationKey: "",
      activeIntake: false,
      status: "",
      propertyCode: "",
      propertyName: "",
      unit: "",
      primaryIssue: "",
      issueBuf: [],
      issueMeta: null,
      scheduleRaw: "",
      preferredWindow: "",
      expectedNext: "",
      currentStage: "",
      revision: 0,
      lastWriter: "",
      tentative: {},
      askCounts: { property: 0, unit: 0, issue: 0, schedule: 0 },
      updatedAtIso: ""
    };
  }
  var vals = sh.getRange(r, 1, 1, 18).getValues()[0];
  var issueBuf = [];
  var issueMeta = null;
  var tentative = {};
  try { issueBuf = JSON.parse(String(vals[INTAKE_MEMORY_COLS.ISSUE_BUF_JSON - 1] || "[]")); } catch (_) { issueBuf = []; }
  try { issueMeta = JSON.parse(String(vals[INTAKE_MEMORY_COLS.ISSUE_META_JSON - 1] || "null")); } catch (_) { issueMeta = null; }
  try { tentative = JSON.parse(String(vals[INTAKE_MEMORY_COLS.TENTATIVE_JSON - 1] || "{}")); } catch (_) { tentative = {}; }
  if (!Array.isArray(issueBuf)) issueBuf = [];
  if (!tentative || typeof tentative !== "object") tentative = {};
  var askCounts = { property: 0, unit: 0, issue: 0, schedule: 0 };
  try {
    if (tentative && tentative.askCounts && typeof tentative.askCounts === "object") {
      askCounts.property = Number(tentative.askCounts.property) || 0;
      askCounts.unit = Number(tentative.askCounts.unit) || 0;
      askCounts.issue = Number(tentative.askCounts.issue) || 0;
      askCounts.schedule = Number(tentative.askCounts.schedule) || 0;
    }
  } catch (_) {}
  return {
    row: r,
    phoneE164: p,
    conversationKey: String(vals[INTAKE_MEMORY_COLS.CONVERSATION_KEY - 1] || ""),
    activeIntake: String(vals[INTAKE_MEMORY_COLS.ACTIVE - 1] || "").toUpperCase() === "TRUE",
    status: String(vals[INTAKE_MEMORY_COLS.STATUS - 1] || ""),
    propertyCode: String(vals[INTAKE_MEMORY_COLS.PROPERTY_CODE - 1] || ""),
    propertyName: String(vals[INTAKE_MEMORY_COLS.PROPERTY_NAME - 1] || ""),
    unit: String(vals[INTAKE_MEMORY_COLS.UNIT - 1] || ""),
    primaryIssue: String(vals[INTAKE_MEMORY_COLS.PRIMARY_ISSUE - 1] || ""),
    issueBuf: issueBuf,
    issueMeta: issueMeta,
    scheduleRaw: String(vals[INTAKE_MEMORY_COLS.SCHEDULE_RAW - 1] || ""),
    preferredWindow: String(vals[INTAKE_MEMORY_COLS.PREFERRED_WINDOW - 1] || ""),
    expectedNext: String(vals[INTAKE_MEMORY_COLS.EXPECTED_NEXT - 1] || ""),
    currentStage: String(vals[INTAKE_MEMORY_COLS.CURRENT_STAGE - 1] || ""),
    revision: Number(vals[INTAKE_MEMORY_COLS.REVISION - 1] || 0) || 0,
    lastWriter: String(vals[INTAKE_MEMORY_COLS.LAST_WRITER - 1] || ""),
    tentative: tentative,
    askCounts: askCounts,
    updatedAtIso: String(vals[INTAKE_MEMORY_COLS.UPDATED_AT_ISO - 1] || "")
  };
}

function canonicalIntakeSaveNoLock_(sh, rec, writerTag) {
  var nowIso = new Date().toISOString();
  var issueBufJson = "[]";
  var issueMetaJson = "";
  var tentativeJson = "{}";
  try { issueBufJson = JSON.stringify(Array.isArray(rec.issueBuf) ? rec.issueBuf : []); } catch (_) {}
  try { issueMetaJson = rec.issueMeta ? JSON.stringify(rec.issueMeta) : ""; } catch (_) {}
  if (rec.askCounts) {
    rec.tentative = rec.tentative || {};
    rec.tentative.askCounts = rec.askCounts;
  }
  try { tentativeJson = JSON.stringify(rec.tentative || {}); } catch (_) {}
  var rowValues = [[
    String(rec.phoneE164 || ""),
    String(rec.conversationKey || ""),
    rec.activeIntake ? true : false,
    String(rec.status || ""),
    String(rec.propertyCode || ""),
    String(rec.propertyName || ""),
    String(rec.unit || ""),
    String(rec.primaryIssue || ""),
    issueBufJson,
    issueMetaJson,
    String(rec.scheduleRaw || ""),
    String(rec.preferredWindow || ""),
    String(rec.expectedNext || ""),
    String(rec.currentStage || ""),
    Number(rec.revision || 0),
    String(writerTag || rec.lastWriter || ""),
    tentativeJson,
    nowIso
  ]];
  if (rec.row && rec.row >= 2) {
    sh.getRange(rec.row, 1, 1, 18).setValues(rowValues);
  } else {
    sh.appendRow(rowValues[0]);
    rec.row = sh.getLastRow();
  }
  rec.updatedAtIso = nowIso;
}

function askCountBumpAndGet_(phone, slot) {
  var count = 1;
  try {
    var sh = ensureCanonicalIntakeSheet_();
    var rec = canonicalIntakeLoadNoLock_(sh, phone);
    if (!rec) return count;
    rec.askCounts = rec.askCounts || { property: 0, unit: 0, issue: 0, schedule: 0 };
    var sl = String(slot || "").toLowerCase();
    if (rec.askCounts.hasOwnProperty(sl)) {
      rec.askCounts[sl] = (Number(rec.askCounts[sl]) || 0) + 1;
      count = rec.askCounts[sl];
    }
    rec.tentative = rec.tentative || {};
    rec.tentative.askCounts = rec.askCounts;
    canonicalIntakeSaveNoLock_(sh, rec, "ASK_BUMP_" + sl.toUpperCase());
    try { logDevSms_(phone, "", "ASK_COUNT_BUMP slot=[" + sl + "] count=[" + count + "]"); } catch (_) {}
  } catch (_) {}
  return count;
}

function askCountResetSlot_(rec, slot) {
  if (!rec) return;
  rec.askCounts = rec.askCounts || { property: 0, unit: 0, issue: 0, schedule: 0 };
  var sl = String(slot || "").toLowerCase();
  if (rec.askCounts.hasOwnProperty(sl)) rec.askCounts[sl] = 0;
}

function buildSlotAskContext_(rec, slot, lang) {
  var known = {
    property: String((rec && (rec.propertyName || rec.propertyCode)) || "").trim(),
    unit: String((rec && rec.unit) || "").trim(),
    issue: String((rec && rec.primaryIssue) || "").trim(),
    scheduleLabel: String((rec && (rec.preferredWindow || rec.scheduleRaw)) || "").trim()
  };
  var askAttempt = 1;
  try {
    var ac = (rec && rec.askCounts) || {};
    var sl = String(slot || "").toLowerCase();
    askAttempt = Number(ac[sl]) || 1;
  } catch (_) {}
  return {
    slot: String(slot || "").toLowerCase(),
    askAttempt: askAttempt,
    lang: String(lang || "en").toLowerCase(),
    known: known,
    renderContext: {
      isClarification: askAttempt > 1,
      showIssueProof: !!known.issue,
      allowInlineOptions: askAttempt <= 2,
      avoidGenericAck: true
    }
  };
}

function canonicalIssueKey_(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ============================================================
// Multi-issue split (issue-atoms → ticket-group preview)
// Canonical split preview is written into IntakeMemory.tentative.
// ============================================================

function inferRoomLocationKey_(text) {
  var t = String(text || "").toLowerCase();
  if (!t.trim()) return "";
  if (/\b(hallway|corridor)\b/.test(t)) return "hallway";
  if (/\b(bedroom)\b/.test(t)) return "bedroom";
  if (/\b(kitchen)\b/.test(t)) return "kitchen";
  if (/\b(bathroom)\b/.test(t)) return "bathroom";
  if (/\b(living room|livingroom|den)\b/.test(t)) return "living_room";
  if (/\b(garage)\b/.test(t)) return "garage";
  if (/\b(basement)\b/.test(t)) return "basement";
  return "";
}

function inferFixtureBaseKey_(text) {
  var t = String(text || "").toLowerCase();
  if (!t.trim()) return "";
  if (/\bsink\b/.test(t)) return "sink";
  if (/\btoilet\b/.test(t)) return "toilet";
  if (/\bshower\b/.test(t)) return "shower";
  if (/\btub\b/.test(t) || /\bbathtub\b/.test(t)) return "tub";
  if (/\bfaucet\b/.test(t)) return "faucet";
  if (/\bdrain\b/.test(t) || /\bbacked up\b/.test(t)) return "drain";
  if (/\bpipe\b/.test(t)) return "pipe";
  if (/\bstove\b/.test(t) || /\boven\b/.test(t) || /\brange\b/.test(t) || /\bburner\b/.test(t)) return "stove";
  if (/\bwasher\b/.test(t) || /\bwasher\/dryer\b/.test(t) || /\bdryer\b/.test(t)) return "laundry";
  if (/\bfridge\b|\brefrigerator\b|\bfreezer\b/.test(t)) return "refrigerator";
  if (/\bdishwasher\b/.test(t)) return "dishwasher";
  if (/\bmicrowave\b/.test(t)) return "microwave";
  if (/\blight\b|\blights\b|\bbulb\b|\blamp\b|\bfixture\b/.test(t)) return "light";
  if (/\bintercom\b/.test(t)) return "intercom";
  if (/\bdoor\b/.test(t) || /\bentry\b/.test(t)) return "door";
  if (/\block\b|\blocked\b|\blocked out\b|\bkey\b|\bdeadbolt\b|\bdoor won'?t open\b/.test(t)) return "lock";
  if (/\bwindow\b/.test(t)) return "window";
  if (/\bthermostat\b/.test(t)) return "thermostat";
  if (/\bac\b|\bair conditioner\b|\ba\/c\b/.test(t)) return "ac";
  if (/\bheater\b|\bboiler\b|\bradiator\b|\bfurnace\b/.test(t)) return "heater";
  if (/\boutlet\b|\bgfci\b|\breceptacle\b/.test(t)) return "outlet";
  if (/\bbreaker\b|\bpanel\b/.test(t)) return "breaker";
  return "";
}

function inferFixtureKey_(text) {
  var base = inferFixtureBaseKey_(text);
  if (!base) return "";
  var room = inferRoomLocationKey_(text);
  // Room-sensitive keys for objects that commonly differ by location.
  if (room && (base === "light" || base === "door" || base === "outlet" || base === "lock" || base === "window")) {
    return room + "|" + base;
  }
  return base;
}

function safeInferLocationTypeAndInUnit_(rawText) {
  var out = { locationType: "UNIT", inUnit: true };
  try {
    if (typeof inferLocationTypeDeterministic_ === "function") {
      var loc = inferLocationTypeDeterministic_(rawText);
      var lt = String((loc && loc.locationType) || "UNIT").toUpperCase();
      if (lt === "COMMON_AREA") {
        out.locationType = "COMMON_AREA";
        out.inUnit = false;
      } else {
        out.locationType = "UNIT";
        out.inUnit = true;
      }
    }
  } catch (_) {}
  return out;
}

function issueAtomFromProblemText_(rawText, sourceStage) {
  var rt = String(rawText || "").trim();
  if (rt.length < 3) return null;
  var atomTitle = rt;
  var category = String((typeof localCategoryFromText_ === "function") ? localCategoryFromText_(rt) : "").trim();
  if (!category) category = "General";
  var subcategory = "";
  try { subcategory = (typeof detectSubcategory_ === "function") ? String(detectSubcategory_(atomTitle, rt) || "").trim() : ""; } catch (_) {}
  var faultFamilyKey = subcategory || ((typeof issueTextStableKey_ === "function") ? issueTextStableKey_(atomTitle) : issueTextKey_(atomTitle)) || category;
  var urgency = "Normal";
  try {
    if (typeof detectUrgency_ === "function") {
      var urg = String(detectUrgency_(atomTitle, rt) || "").toLowerCase();
      if (urg === "urgent" || urg === "high") urgency = "Urgent";
    }
  } catch (_) {}
  var fixtureKey = inferFixtureKey_(rt);
  if (!fixtureKey) fixtureKey = "unknown_fixture";
  var loc = safeInferLocationTypeAndInUnit_(rt);

  var dedupeKey = [
    String(category || "").trim(),
    String(faultFamilyKey || "").trim(),
    String(fixtureKey || "").trim(),
    String((typeof issueTextStableKey_ === "function") ? issueTextStableKey_(atomTitle) : issueTextKey_(atomTitle) || "").trim()
  ].join("|");

  try {
    logDevSms_("", "", "ISSUE_ATOM_CREATED cat=[" + category + "] fixture=[" + fixtureKey + "] fault=[" + faultFamilyKey + "] stage=[" + String(sourceStage || "") + "]");
  } catch (_) {}

  return {
    rawText: rt.slice(0, 500),
    normalizedTitle: atomTitle.slice(0, 500),
    category: category,
    subcategory: subcategory,
    faultFamilyKey: faultFamilyKey,
    fixtureKey: fixtureKey,
    roomLocationKey: inferRoomLocationKey_(rt),
    locationType: loc.locationType,
    inUnit: loc.inUnit,
    urgency: urgency,
    confidence: 0.5,
    sourceStage: String(sourceStage || ""),
    dedupeKey: dedupeKey
  };
}

function issueAtomFromSchemaIssue_(issueObj, sourceStage) {
  var sum = String(issueObj && issueObj.summary ? issueObj.summary : "").trim();
  if (sum.length < 3) return null;
  var trade = String(issueObj && issueObj.trade ? issueObj.trade : "").trim().toLowerCase();
  var category = "";
  if (trade === "plumbing") category = "Plumbing";
  else if (trade === "electrical") category = "Electrical";
  else if (trade === "hvac") category = "HVAC";
  else if (trade === "appliance") category = "Appliance";
  else if (trade === "general" || trade === "other") category = "General";
  else category = String((typeof localCategoryFromText_ === "function") ? localCategoryFromText_(sum) : "").trim() || "General";

  var subcategory = String(issueObj && issueObj.category ? issueObj.category : "").trim();
  if (!subcategory) {
    try { subcategory = (typeof detectSubcategory_ === "function") ? String(detectSubcategory_(sum, sum) || "").trim() : ""; } catch (_) {}
  }
  var faultFamilyKey = subcategory || ((typeof issueTextStableKey_ === "function") ? issueTextStableKey_(sum) : issueTextKey_(sum)) || category;

  var urgency = "Normal";
  var u = String(issueObj && issueObj.urgency ? issueObj.urgency : "").trim().toLowerCase();
  if (u === "urgent") urgency = "Urgent";

  var locSrc = String(issueObj && issueObj.tenant_description ? issueObj.tenant_description : sum);
  var loc = safeInferLocationTypeAndInUnit_(locSrc);

  var fixtureKey = inferFixtureKey_(locSrc);
  if (!fixtureKey) fixtureKey = inferFixtureKey_(sum) || "unknown_fixture";

  var dedupeKey = [
    String(category || "").trim(),
    String(faultFamilyKey || "").trim(),
    String(fixtureKey || "").trim(),
    String((typeof issueTextStableKey_ === "function") ? issueTextStableKey_(sum) : issueTextKey_(sum) || "").trim()
  ].join("|");

  try {
    logDevSms_("", "", "ISSUE_ATOM_CREATED cat=[" + category + "] fixture=[" + fixtureKey + "] fault=[" + faultFamilyKey + "] stage=[" + String(sourceStage || "") + "]");
  } catch (_) {}

  return {
    rawText: sum.slice(0, 500),
    normalizedTitle: sum.slice(0, 500),
    category: category,
    subcategory: subcategory,
    faultFamilyKey: faultFamilyKey,
    fixtureKey: fixtureKey,
    roomLocationKey: inferRoomLocationKey_(locSrc),
    locationType: loc.locationType,
    inUnit: loc.inUnit,
    urgency: urgency,
    confidence: 0.7,
    sourceStage: String(sourceStage || ""),
    dedupeKey: dedupeKey
  };
}

function dedupeIssueAtomsByDedupeKey_(atoms) {
  var seen = {};
  var out = [];
  for (var i = 0; i < (atoms || []).length; i++) {
    var a = atoms[i];
    if (!a || !a.dedupeKey) continue;
    if (seen[a.dedupeKey]) {
      try { logDevSms_("", "", "ISSUE_ATOM_DEDUPED key=[" + String(a.dedupeKey).slice(0, 20) + "]"); } catch (_) {}
      continue;
    }
    seen[a.dedupeKey] = 1;
    out.push(a);
  }
  return out;
}

function groupIssueAtomsIntoTicketGroups_(issueAtoms, policy) {
  policy = policy || {};
  var atoms = Array.isArray(issueAtoms) ? issueAtoms : [];
  var map = {};
  var orderedKeys = [];
  for (var i = 0; i < atoms.length; i++) {
    var a = atoms[i];
    if (!a) continue;
    var gk = [
      String(a.category || "").trim() || "General",
      String(a.fixtureKey || "").trim() || "unknown_fixture",
      String(a.faultFamilyKey || "").trim() || "unknown_fault"
    ].join("|");
    if (!map[gk]) {
      map[gk] = {
        groupKey: gk,
        trade: String(a.category || "").trim() || "General",
        fixtureKey: String(a.fixtureKey || "").trim() || "unknown_fixture",
        faultFamilyKey: String(a.faultFamilyKey || "").trim() || "unknown_fault",
        atoms: [],
        locationType: String(a.locationType || "UNIT").toUpperCase(),
        inUnit: !!a.inUnit,
        urgency: String(a.urgency || "Normal").toLowerCase() === "urgent" ? "Urgent" : "Normal"
      };
      orderedKeys.push(gk);
    }
    // Upgrade group location if any clause is common area.
    if (String(a.locationType || "").toUpperCase() === "COMMON_AREA") {
      map[gk].locationType = "COMMON_AREA";
      map[gk].inUnit = false;
    }
    // Upgrade urgency.
    if (String(a.urgency || "").toLowerCase() === "urgent") map[gk].urgency = "Urgent";
    map[gk].atoms.push(a);
  }

  var groups = [];
  for (var oi = 0; oi < orderedKeys.length; oi++) {
    var g0 = map[orderedKeys[oi]];
    if (!g0 || !g0.atoms || !g0.atoms.length) continue;
    var issueTexts = g0.atoms.map(function (x) { return String(x.normalizedTitle || x.rawText || "").trim(); }).filter(Boolean);
    var groupMessageRaw = issueTexts.join(" | ");
    var groupTitle = issueTexts[0] || g0.groupKey;

    try { logDevSms_("", "", "TICKET_GROUP_PREVIEW groupKey=[" + String(g0.groupKey).slice(0, 32) + "] nIssues=" + String(g0.atoms.length)); } catch (_) {}

    groups.push({
      groupKey: g0.groupKey,
      groupTitle: groupTitle,
      groupMessageRaw: groupMessageRaw.slice(0, 900),
      trade: g0.trade,
      fixtureKey: g0.fixtureKey,
      faultFamilyKey: g0.faultFamilyKey,
      locationType: g0.locationType === "COMMON_AREA" ? "COMMON_AREA" : "UNIT",
      inUnit: g0.locationType === "COMMON_AREA" ? false : true,
      urgency: g0.urgency,
      issues: g0.atoms.map(function (x) { return String(x.normalizedTitle || x.rawText || "").trim(); }).filter(Boolean)
    });
  }
  return groups;
}

function properaCanonicalSplitPreviewUpsert_(phone, newIssueAtoms, splitPreviewSource, writerTag) {
  phone = String(phone || "").trim();
  if (!phone) return { ok: false, reason: "no_phone" };
  var sh = ensureCanonicalIntakeSheet_();
  var rec = canonicalIntakeLoadNoLock_(sh, phone);
  if (!rec || !rec.row) return { ok: false, reason: "no_canonical_row" };

  return withWriteLock_("CANONICAL_SPLIT_PREVIEW_UPSERT", function () {
    rec = canonicalIntakeLoadNoLock_(sh, phone);
    if (!rec || !rec.row) return { ok: false, reason: "no_row_after_relock" };
    rec.tentative = rec.tentative && typeof rec.tentative === "object" ? rec.tentative : {};

    var intakeGroupKey = String(rec.tentative.intakeGroupKey || "").trim();
    if (!intakeGroupKey) {
      try { intakeGroupKey = (typeof Utilities !== "undefined" && Utilities.getUuid) ? Utilities.getUuid() : ("IGK:" + String(Date.now())); } catch (_) {}
      if (!intakeGroupKey) intakeGroupKey = "IGK:" + String(Date.now());
    }
    rec.tentative.intakeGroupKey = intakeGroupKey;
    rec.tentative.splitPreviewSource = String(splitPreviewSource || "canonical_groups");

    var existingAtoms = Array.isArray(rec.tentative.issueAtoms) ? rec.tentative.issueAtoms : [];
    var mergedAtoms = existingAtoms.concat(Array.isArray(newIssueAtoms) ? newIssueAtoms : []).filter(Boolean);
    mergedAtoms = dedupeIssueAtomsByDedupeKey_(mergedAtoms);
    rec.tentative.issueAtoms = mergedAtoms.slice(0, 80);

    var groups = groupIssueAtomsIntoTicketGroups_(rec.tentative.issueAtoms, {});
    rec.tentative.ticketGroupsPreview = groups;
    rec.tentative.splitNeeded = groups.length >= 2;
    rec.tentative.splitStable = true;
    rec.tentative.splitGroupCount = groups.length;

    // Clear any previously cached durable row identity if preview changes.
    rec.tentative.splitBundleRows = [];
    rec.tentative.splitBundleIntakeGroupKey = intakeGroupKey;
    rec.tentative.splitPreviewUpdatedAtIso = new Date().toISOString();

    try { logDevSms_(phone, "", "SPLIT_DECISION groupCount=" + String(groups.length) + " source=[" + String(splitPreviewSource || "canonical_groups") + "]"); } catch (_) {}
    try { logDevSms_(phone, "", "SPLIT_DECISION_SOURCE source=[" + String(splitPreviewSource || "canonical_groups") + "]"); } catch (_) {}

    canonicalIntakeSaveNoLock_(sh, rec, String(writerTag || "CANONICAL_SPLIT_PREVIEW"));
    return { ok: true, ticketGroupsPreview: groups, intakeGroupKey: intakeGroupKey };
  });
}

function canonicalSplitPreviewLoad_(phone) {
  phone = String(phone || "").trim();
  if (!phone) return { ok: false, reason: "no_phone" };
  var sh = ensureCanonicalIntakeSheet_();
  var rec = canonicalIntakeLoadNoLock_(sh, phone);
  if (!rec || !rec.row) return { ok: false, reason: "no_row" };
  var t = rec.tentative && typeof rec.tentative === "object" ? rec.tentative : {};
  var groups = Array.isArray(t.ticketGroupsPreview) ? t.ticketGroupsPreview : [];
  return {
    ok: true,
    intakeGroupKey: String(t.intakeGroupKey || "").trim(),
    ticketGroupsPreview: groups,
    splitNeeded: !!t.splitNeeded,
    splitGroupCount: groups.length,
    splitPreviewSource: String(t.splitPreviewSource || "")
  };
}

function canonicalSplitPreviewClear_(phone, writerTag) {
  phone = String(phone || "").trim();
  if (!phone) return { ok: false, reason: "no_phone" };
  var sh = ensureCanonicalIntakeSheet_();
  return withWriteLock_("CANONICAL_SPLIT_PREVIEW_CLEAR", function () {
    var rec = canonicalIntakeLoadNoLock_(sh, phone);
    if (!rec || !rec.row) return { ok: false, reason: "no_row" };
    rec.tentative = rec.tentative && typeof rec.tentative === "object" ? rec.tentative : {};
    rec.tentative.issueAtoms = [];
    rec.tentative.ticketGroupsPreview = [];
    rec.tentative.splitNeeded = false;
    rec.tentative.splitStable = true;
    rec.tentative.splitGroupCount = 0;
    rec.tentative.splitBundleRows = [];
    rec.tentative.splitBundleIntakeGroupKey = "";
    canonicalIntakeSaveNoLock_(sh, rec, String(writerTag || "CANONICAL_SPLIT_CLEAR"));
    return { ok: true };
  });
}

/**
 * Finalize-time ticket groups: merge canonical tentative.issueAtoms, durable issue buffer,
 * committed package issues, and pipe-separated merged draft text — then dedupe + regroup.
 * Prevents stale ticketGroupsPreview (e.g. only the last appended clause) from skipping split
 * or picking the wrong MSG while ISSUEBUF_COUNT / confirmation still reflect multiple issues.
 */
function reconcileTicketGroupsForFinalize_(phone, buf, splitPack, mergedIssueText) {
  phone = String(phone || "").trim();
  var atoms = [];
  try {
    var sh = ensureCanonicalIntakeSheet_();
    var rec = canonicalIntakeLoadNoLock_(sh, phone);
    if (rec && rec.tentative && Array.isArray(rec.tentative.issueAtoms)) {
      for (var ia = 0; ia < rec.tentative.issueAtoms.length; ia++) {
        if (rec.tentative.issueAtoms[ia]) atoms.push(rec.tentative.issueAtoms[ia]);
      }
    }
  } catch (_) {}

  if (buf && buf.length) {
    for (var ib = 0; ib < buf.length; ib++) {
      var rt = String((buf[ib] && buf[ib].rawText) || "").trim();
      if (!rt || canonicalInboundLooksScheduleOnly_(rt)) continue;
      var ab = issueAtomFromProblemText_(rt, "finalize_buf");
      if (ab) atoms.push(ab);
    }
  }

  if (splitPack && Array.isArray(splitPack.issues) && splitPack.issues.length) {
    for (var ik = 0; ik < splitPack.issues.length; ik++) {
      var tx = String((splitPack.issues[ik] && (splitPack.issues[ik].normalizedTitle || splitPack.issues[ik].rawText)) || "").trim();
      if (!tx) continue;
      var ak = issueAtomFromProblemText_(tx, "finalize_splitPack");
      if (ak) atoms.push(ak);
    }
  }

  var mergedIssue = String(mergedIssueText || "").trim();
  if (mergedIssue.indexOf("|") >= 0) {
    var segs = mergedIssue.split(/\s*\|\s*/);
    for (var is = 0; is < segs.length; is++) {
      var seg = String(segs[is] || "").trim();
      if (seg.length < 4) continue;
      if (canonicalInboundLooksScheduleOnly_(seg)) continue;
      var as = issueAtomFromProblemText_(seg, "finalize_pipe");
      if (as) atoms.push(as);
    }
  }

  // Last resort: one ticket from merged draft when no atoms were derivable (stale buf / preview only).
  if (!atoms.length && mergedIssue.length >= 4 && !canonicalInboundLooksScheduleOnly_(mergedIssue)) {
    var af = issueAtomFromProblemText_(mergedIssue, "finalize_fallback_whole");
    if (af) atoms.push(af);
  }

  // Expand any atom that accidentally contains multiple issues joined with '|'.
  // Without this, a combined atom can get classified into (say) Plumbing because
  // it contains sink/clog keywords, causing the Plumbing split ticket to inherit
  // the unrelated bedroom-door clause text.
  var expandedAtoms = [];
  for (var ea = 0; ea < (atoms || []).length; ea++) {
    var a = atoms[ea];
    if (!a) continue;
    var t = String(a.normalizedTitle != null ? a.normalizedTitle : a.rawText || "").trim();
    if (t && t.indexOf("|") >= 0) {
      var segs = t.split(/\s*\|\s*/);
      for (var ss = 0; ss < segs.length; ss++) {
        var seg = String(segs[ss] || "").trim();
        if (seg.length < 4) continue;
        if (canonicalInboundLooksScheduleOnly_(seg)) continue;
        var na = issueAtomFromProblemText_(seg, "finalize_atom_split");
        if (na) expandedAtoms.push(na);
      }
    } else {
      expandedAtoms.push(a);
    }
  }
  atoms = expandedAtoms;

  atoms = dedupeIssueAtomsByDedupeKey_(atoms);
  var groups = groupIssueAtomsIntoTicketGroups_(atoms, {});
  try {
    logDevSms_(phone, "", "FINALIZE_TICKET_GROUPS_RECONCILE atomCount=" + String(atoms.length) + " groupCount=" + String(groups.length) + " bufLen=" + String(buf && buf.length ? buf.length : 0));
  } catch (_) {}
  return {
    ticketGroupsPreview: groups,
    splitDecisionSource: "finalize_reconciled",
    atomCount: atoms.length
  };
}

function buildSplitIssuesFromTicketGroupsPreview_(ticketGroups) {
  var out = [];
  for (var i = 0; i < (ticketGroups || []).length; i++) {
    var g = ticketGroups[i];
    if (!g) continue;
    var msg = String(g.groupMessageRaw || g.groupTitle || "").trim();
    if (!msg) continue;
    out.push({
      normalizedTitle: msg,
      rawText: msg,
      inUnit: !!g.inUnit,
      locationType: String(g.locationType || (g.inUnit ? "UNIT" : "COMMON_AREA")).toUpperCase(),
      category: String(g.trade || "General").trim(),
      urgency: String(g.urgency || "normal").toLowerCase()
    });
  }
  return out;
}

/**
 * True when inbound text is schedule/window-like, not an actionable maintenance symptom.
 * Used to prevent SCHEDULE_PRETICKET turns from committing window text as issue (canonical + finalize buffer).
 */
function canonicalInboundLooksScheduleOnly_(text) {
  var t = String(text || "").trim();
  if (!t) return false;
  try {
    if (typeof isScheduleWindowLike_ === "function" && isScheduleWindowLike_(t)) return true;
  } catch (_) {}
  try {
    if (typeof isScheduleLike_ === "function" && isScheduleLike_(t)) return true;
  } catch (_) {}
  if (t.length > 160) return false;
  return /\b(today|tomorrow|tonight|morning|afternoon|evening|noon|am\b|pm\b|after\s+\d|before\s+\d|between|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*-\s*\d{1,2})\b/i.test(t);
}

function canonicalExpectedFromRecord_(rec) {
  var hasIssue = !!String(rec.primaryIssue || "").trim() || (Array.isArray(rec.issueBuf) && rec.issueBuf.length > 0);
  var hasProp = !!String(rec.propertyCode || "").trim();
  var hasUnit = !!String(rec.unit || "").trim();
  var hasSched = !!String(rec.scheduleRaw || "").trim() || !!String(rec.preferredWindow || "").trim();
  if (!hasIssue) return "ISSUE";
  if (!hasProp && !hasUnit) return "PROPERTY_AND_UNIT";
  if (!hasProp) return "PROPERTY";
  if (!hasUnit) return "UNIT";
  if (!hasSched) return "SCHEDULE_PRETICKET";
  return "FINALIZE_DRAFT";
}

function validateProposedProperty_(proposal, rec) {
  var out = { decision: "reject", value: null, reason: "empty" };
  if (!proposal || !proposal.code) return out;
  var code = String(proposal.code || "").trim().toUpperCase();
  var name = String(proposal.name || "").trim();
  var known = null;
  try { if (typeof getPropertyByCode_ === "function") known = getPropertyByCode_(code); } catch (_) {}
  if (!known) return { decision: "tentative", value: { code: code, name: name }, reason: "unknown_code" };
  var canonicalName = String((known && known.name) || name || "").trim();
  if (!rec.propertyCode) return { decision: "accept", value: { code: code, name: canonicalName }, reason: "empty_property" };
  if (rec.propertyCode === code) return { decision: "accept", value: { code: code, name: canonicalName }, reason: "same_property" };
  return { decision: "tentative", value: { code: code, name: canonicalName }, reason: "conflict_existing_property" };
}

function validateProposedUnit_(proposal, rec) {
  var out = { decision: "reject", value: "", reason: "empty" };
  var u = String(proposal || "").trim();
  if (!u) return out;
  try { if (typeof normalizeUnit_ === "function") u = normalizeUnit_(u) || u; } catch (_) {}
  if (!/^[A-Za-z0-9#\-]{1,16}$/.test(u)) return { decision: "tentative", value: u, reason: "format_weak" };
  if (!rec.unit) return { decision: "accept", value: u, reason: "empty_unit" };
  if (String(rec.unit || "").trim().toUpperCase() === u.toUpperCase()) return { decision: "accept", value: u, reason: "same_unit" };
  return { decision: "tentative", value: u, reason: "conflict_existing_unit" };
}

function applyCanonicalMirrorWritesNoLock_(dir, dirRow, phone, rec) {
  if (!dir || !dirRow || dirRow < 2) return;
  if (rec.propertyCode) {
    var p0 = dalGetPendingProperty_(dir, dirRow) || {};
    if (!String(p0.code || "").trim()) dalSetPendingPropertyNoLock_(dir, dirRow, { code: rec.propertyCode, name: rec.propertyName || "" });
  }
  if (rec.unit) {
    var u0 = String(dalGetPendingUnit_(dir, dirRow) || "").trim();
    if (!u0) dalSetPendingUnitNoLock_(dir, dirRow, rec.unit);
  }
  if (rec.primaryIssue) {
    var i0 = String(dalGetPendingIssue_(dir, dirRow) || "").trim();
    if (!i0) dalSetPendingIssueNoLock_(dir, dirRow, rec.primaryIssue);
  }
  dalSetPendingStageNoLock_(dir, dirRow, rec.expectedNext || "");
  dalSetLastUpdatedNoLock_(dir, dirRow);
  try {
    if (typeof sessionUpsertNoLock_ === "function") {
      sessionUpsertNoLock_(phone, {
        stage: rec.expectedNext || "",
        expected: rec.expectedNext || "",
        draftProperty: rec.propertyCode || "",
        draftUnit: rec.unit || "",
        draftIssue: rec.primaryIssue || "",
        draftScheduleRaw: rec.scheduleRaw || "",
        issueBufJson: JSON.stringify(Array.isArray(rec.issueBuf) ? rec.issueBuf : []),
        expiresAtIso: new Date(Date.now() + ((rec.expectedNext === "SCHEDULE" || rec.expectedNext === "SCHEDULE_PRETICKET") ? 30 : 10) * 60 * 1000).toISOString()
      }, "CANONICAL_INTAKE_MIRROR");
    }
  } catch (_) {}
}

function properaCanonicalIntakeMergeCommit_(opts) {
  opts = opts || {};
  var phone = String(opts.phone || "").trim();
  if (!phone) return { ok: false, reason: "no_phone" };
  var tf = opts.turnFacts || {};
  var writerTag = String(opts.writerTag || "CANONICAL_MERGE").trim();
  var attachDecision = opts.attachDecision || null;
  return withWriteLock_("CANONICAL_INTAKE_MERGE", function () {
    var sh = ensureCanonicalIntakeSheet_();
    var rec = canonicalIntakeLoadNoLock_(sh, phone);
    try { logDevSms_(phone, "", "CANONICAL_INTAKE_LOAD rev=" + String(rec.revision || 0)); } catch (_) {}

    if (attachDecision && attachDecision.attachmentDecision === "clarify_attach_vs_new") {
      var __reqClarifyResolved = (typeof globalThis !== "undefined" && String(globalThis.__attachClarifyResolvedThisTurn || "") === "1");
      if (__reqClarifyResolved) {
        var __forcedOutcome = String(globalThis.__attachClarifyResolvedOutcome || "").trim().toLowerCase();
        attachDecision.attachmentDecision = (__forcedOutcome === "start_new") ? "start_new_intake" : "attach_to_active_intake";
        try { logDevSms_(phone, "", "ATTACH_CLARIFY_REENTRY_SUPPRESSED reason=[canonical_merge_override_with_request_guard] forcedOutcome=[" + String(__forcedOutcome) + "]"); } catch (_) {}
      } else {
        try { logDevSms_(phone, "", "CANONICAL_MERGE_CLARIFY_BLOCK reason=[clarify_attach_vs_new]"); } catch (_) {}
        return { ok: false, reason: "clarify_blocked", record: rec };
      }
    }

    if (attachDecision && attachDecision.attachmentDecision === "start_new_intake") {
      try { logDevSms_(phone, "", "CANONICAL_START_NEW reason=[attach_classifier] role=[" + String(attachDecision.messageRole || "") + "]"); } catch (_) {}
      rec.issueBuf = [];
      rec.primaryIssue = "";
      rec.issueMeta = null;
      rec.propertyCode = "";
      rec.propertyName = "";
      rec.unit = "";
      rec.scheduleRaw = "";
      rec.preferredWindow = "";
      rec.tentative = {};
      try { logDevSms_(phone, "", "CANONICAL_ATTACH_EXISTING cleared=1 for=[start_new_intake]"); } catch (_) {}
    } else {
      try { logDevSms_(phone, "", "CANONICAL_ATTACH_EXISTING"); } catch (_) {}
    }

    var prGhost = 0;
    try {
      if (opts.dir && opts.dirRow >= 2 && typeof dalGetPendingRow_ === "function") prGhost = Number(dalGetPendingRow_(opts.dir, opts.dirRow) || 0) || 0;
    } catch (_) { prGhost = 0; }
    // Package missingSlots alone must not override slots we already hold in canonical intake or
    // Directory draft (same contract as properaPackageAfterDurableMerge_ in PROPERA_INTAKE_PACKAGE.gs).
    var msGhost = {};
    try {
      msGhost = tf.missingSlots ? Object.assign({}, tf.missingSlots) : {};
    } catch (_) {
      msGhost = {};
    }
    if (String(rec.propertyCode || "").trim()) msGhost.propertyMissing = false;
    if (String(rec.unit || "").trim()) msGhost.unitMissing = false;
    try {
      if (opts.dir && opts.dirRow >= 2) {
        if (typeof dalGetPendingProperty_ === "function") {
          var _dalPc = dalGetPendingProperty_(opts.dir, opts.dirRow) || {};
          if (String(_dalPc.code || "").trim()) msGhost.propertyMissing = false;
        }
        if (typeof dalGetPendingUnit_ === "function") {
          var _dalPu = String(dalGetPendingUnit_(opts.dir, opts.dirRow) || "").trim();
          if (_dalPu) msGhost.unitMissing = false;
        }
        if (typeof dalGetUnit_ === "function") {
          var _dalCu = String(dalGetUnit_(opts.dir, opts.dirRow) || "").trim();
          if (_dalCu) msGhost.unitMissing = false;
        }
      }
    } catch (_) {}
    var hasIncomingProp = !!(tf.property && String(tf.property.code || "").trim());
    var inboundGhostProbe = String(opts.inboundBodyTrim || tf.originalText || tf.semanticTextEnglish || "").trim();
    var hasCanonPropUnit = !!(String(rec.propertyCode || "").trim() && String(rec.unit || "").trim());
    var scheduleOnlyInbound = inboundGhostProbe && canonicalInboundLooksScheduleOnly_(inboundGhostProbe);
    if (prGhost < 2 && msGhost.propertyMissing && !msGhost.issueMissing && (String(rec.propertyCode || "").trim() || String(rec.unit || "").trim() || String(rec.scheduleRaw || "").trim() || String(rec.preferredWindow || "").trim()) && !hasIncomingProp) {
      if (scheduleOnlyInbound && hasCanonPropUnit) {
        try { logDevSms_(phone, "", "CANONICAL_RECONCILE_STALE_ACTIVE_SKIP reason=[schedule_only_preserve_prop_unit]"); } catch (_) {}
      } else {
        try { logDevSms_(phone, "", "CANONICAL_RECONCILE_STALE_ACTIVE reason=[package_prop_missing_ghost_slots]"); } catch (_) {}
        rec.propertyCode = "";
        rec.propertyName = "";
        rec.unit = "";
        rec.scheduleRaw = "";
        rec.preferredWindow = "";
      }
    }

    var continStage = String(opts.collectStage || "").trim().toUpperCase();
    if (!continStage) continStage = String(rec.expectedNext || "").trim().toUpperCase();

    var proposed = {
      property: (tf && tf.property && tf.property.code) ? { code: String(tf.property.code || "").trim(), name: String(tf.property.name || "").trim() } : null,
      unit: String((tf && tf.unit) || "").trim(),
      issue: String((tf && (tf.issue || tf.issueHint)) || "").trim(),
      issueMeta: (tf && tf.issueMeta) ? tf.issueMeta : null,
      scheduleRaw: String((tf && tf.schedule && tf.schedule.raw) || "").trim(),
      safety: !!(tf && tf.safety && tf.safety.isEmergency)
    };

    // SCHEDULE turns: never commit window text as issue (fixes bogus second ticket / buffer pollution).
    if (continStage === "SCHEDULE" || continStage === "SCHEDULE_PRETICKET") {
      if (!proposed.scheduleRaw && proposed.issue && canonicalInboundLooksScheduleOnly_(proposed.issue)) {
        proposed.scheduleRaw = proposed.issue;
        proposed.issue = "";
        proposed.issueMeta = null;
        try { logDevSms_(phone, "", "SLOT_ROUTED slot=[issue→schedule] reason=[schedule_stage_window_text]"); } catch (_) {}
      }
    }

    try {
      logDevSms_(phone, "", "SLOT_PROPOSED slot=[property] value=[" + String((proposed.property && proposed.property.code) || "") + "] conf=[model]");
      logDevSms_(phone, "", "SLOT_PROPOSED slot=[unit] value=[" + proposed.unit + "] conf=[model]");
      logDevSms_(phone, "", "SLOT_PROPOSED slot=[issue] value=[" + proposed.issue.slice(0, 80) + "] conf=[model]");
      logDevSms_(phone, "", "SLOT_PROPOSED slot=[schedule] value=[" + proposed.scheduleRaw.slice(0, 80) + "] conf=[model]");
    } catch (_) {}

    var pCheck = validateProposedProperty_(proposed.property, rec);
    try { logDevSms_(phone, "", "SLOT_VALIDATED slot=[property] decision=[" + pCheck.decision + "] reason=[" + pCheck.reason + "]"); } catch (_) {}
    if (pCheck.decision === "accept" && pCheck.value) {
      rec.propertyCode = pCheck.value.code;
      rec.propertyName = pCheck.value.name;
    } else if (pCheck.decision === "tentative") {
      rec.tentative = rec.tentative || {};
      rec.tentative.property = pCheck.value;
      try { logDevSms_(phone, "", "SLOT_CONFLICT slot=[property] old=[" + String(rec.propertyCode || "") + "] new=[" + String((pCheck.value && pCheck.value.code) || "") + "]"); } catch (_) {}
    }

    var uCheck = validateProposedUnit_(proposed.unit, rec);
    try { logDevSms_(phone, "", "SLOT_VALIDATED slot=[unit] decision=[" + uCheck.decision + "] reason=[" + uCheck.reason + "]"); } catch (_) {}
    if (uCheck.decision === "accept" && uCheck.value) {
      rec.unit = uCheck.value;
    } else if (uCheck.decision === "tentative") {
      rec.tentative = rec.tentative || {};
      rec.tentative.unit = uCheck.value;
      try { logDevSms_(phone, "", "SLOT_CONFLICT slot=[unit] old=[" + String(rec.unit || "") + "] new=[" + String(uCheck.value || "") + "]"); } catch (_) {}
    }

    if (proposed.issue && proposed.issue.length >= 4) {
      var k = canonicalIssueKey_(proposed.issue);
      var seen = {};
      var i;
      for (i = 0; i < rec.issueBuf.length; i++) seen[canonicalIssueKey_(rec.issueBuf[i].rawText)] = 1;
      if (!seen[k]) rec.issueBuf.push({ rawText: proposed.issue.slice(0, 500), createdAt: new Date().toISOString(), sourceStage: String(rec.expectedNext || "") });
      if (!rec.primaryIssue) rec.primaryIssue = proposed.issue.slice(0, 500);
      if (proposed.issueMeta && !rec.issueMeta) rec.issueMeta = proposed.issueMeta;
      try { logDevSms_(phone, "", "SLOT_VALIDATED slot=[issue] decision=[accept] reason=[append_safe]"); } catch (_) {}
    } else {
      try { logDevSms_(phone, "", "SLOT_VALIDATED slot=[issue] decision=[reject] reason=[empty_or_short]"); } catch (_) {}
    }

    if (proposed.scheduleRaw) {
      rec.scheduleRaw = proposed.scheduleRaw.slice(0, 500);
      try {
        if (typeof parsePreferredWindowShared_ === "function") {
          var pw = parsePreferredWindowShared_(rec.scheduleRaw, null);
          if (pw && pw.label) rec.preferredWindow = String(pw.label || "").trim();
        }
      } catch (_) {}
      try { logDevSms_(phone, "", "SLOT_VALIDATED slot=[schedule] decision=[accept] reason=[raw_or_parsed]"); } catch (_) {}
    } else {
      try { logDevSms_(phone, "", "SLOT_VALIDATED slot=[schedule] decision=[reject] reason=[empty]"); } catch (_) {}
    }

    if (proposed.safety) {
      rec.status = "EMERGENCY";
      try { logDevSms_(phone, "", "SLOT_VALIDATED slot=[safety] decision=[accept] reason=[conservative_escalation]"); } catch (_) {}
    }
    rec.askCounts = rec.askCounts || { property: 0, unit: 0, issue: 0, schedule: 0 };
    if (pCheck.decision === "accept" && pCheck.value) askCountResetSlot_(rec, "property");
    if (uCheck.decision === "accept" && uCheck.value) askCountResetSlot_(rec, "unit");
    if (proposed.issue && proposed.issue.length >= 4) askCountResetSlot_(rec, "issue");
    if (proposed.scheduleRaw) askCountResetSlot_(rec, "schedule");

    rec.activeIntake = true;
    rec.status = rec.status || "ACTIVE";
    rec.conversationKey = rec.conversationKey || ("INTAKE:" + actorKey_(phone));
    rec.expectedNext = canonicalExpectedFromRecord_(rec);
    rec.currentStage = rec.expectedNext;
    rec.revision = Number(rec.revision || 0) + 1;
    rec.lastWriter = writerTag;

    try { logDevSms_(phone, "", "CANONICAL_EXPECTED_NEXT value=[" + String(rec.expectedNext || "") + "]"); } catch (_) {}
    try { logDevSms_(phone, "", "ASK_COUNTS prop=[" + rec.askCounts.property + "] unit=[" + rec.askCounts.unit + "] issue=[" + rec.askCounts.issue + "] sched=[" + rec.askCounts.schedule + "]"); } catch (_) {}
    canonicalIntakeSaveNoLock_(sh, rec, writerTag);
    try { logDevSms_(phone, "", "CANONICAL_INTAKE_SAVE rev=" + String(rec.revision || 0)); } catch (_) {}
    try { logDevSms_(phone, "", "CANONICAL_INTAKE_MERGE expected=[" + String(rec.expectedNext || "") + "]"); } catch (_) {}

    if (opts.dir && opts.dirRow >= 2 && opts.mirrorWrites !== false) {
      applyCanonicalMirrorWritesNoLock_(opts.dir, opts.dirRow, phone, rec);
    }
    return { ok: true, expectedNext: rec.expectedNext, record: rec };
  });
}

function properaCanonicalIntakeHydrateCtx_(phone, ctx) {
  try {
    var p = actorKey_(phone);
    if (!p) return ctx;
    var sh = ensureCanonicalIntakeSheet_();
    var rec = canonicalIntakeLoadNoLock_(sh, p);
    if (!rec || !rec.activeIntake || !String(rec.expectedNext || "").trim()) {
      try { logDevSms_(phone, "", "CONTINUATION_SOURCE=[ctx_or_session_only] reason=[no_active_canonical]"); } catch (_) {}
      return ctx;
    }
    var existing = String((ctx && ctx.pendingExpected) || "").trim().toUpperCase();
    var next = String(rec.expectedNext || "").trim().toUpperCase();
    if (existing && existing !== next) {
      try { logDevSms_(phone, "", "MIRROR_MISMATCH mirror=[" + existing + "] canonical=[" + next + "]"); } catch (_) {}
      try { logDevSms_(phone, "", "MIRROR_IGNORED_CANONICAL_WINS mirror=[" + existing + "] canonical=[" + next + "]"); } catch (_) {}
    }
    if (!ctx) ctx = {};
    // Clarification latch must not be overwritten by canonical hydration.
    if (existing === "ATTACH_CLARIFY") {
      try { logDevSms_(phone, "", "CANONICAL_HYDRATE_SKIP reason=[attach_clarify_latch]"); } catch (_) {}
      return ctx;
    }
    ctx.pendingExpected = next;
    if (typeof ctxUpsert_ === "function") {
      ctxUpsert_(phone, { pendingExpected: next, pendingExpiresAt: new Date(Date.now() + ((next === "SCHEDULE" || next === "SCHEDULE_PRETICKET") ? 30 : 10) * 60 * 1000).toISOString() }, "CANONICAL_CTX_HYDRATE");
    }
    try { logDevSms_(phone, "", "CANONICAL_STAGE_USED expected=[" + next + "] source=[canonical_intake]"); } catch (_) {}
    try { logDevSms_(phone, "", "CONTINUATION_SOURCE=[canonical]"); } catch (_) {}
    return ctx;
  } catch (_) {
    try { logDevSms_(phone, "", "CONTINUATION_SOURCE=[mirror]"); } catch (_) {}
    return ctx;
  }
}

function properaCanonicalIntakeIsActive_(phone) {
  try {
    var sh = ensureCanonicalIntakeSheet_();
    var rec = canonicalIntakeLoadNoLock_(sh, phone);
    if (!rec || !rec.activeIntake) return false;
    var next = String(rec.expectedNext || "").trim().toUpperCase();
    return !!next;
  } catch (_) {
    return false;
  }
}

// -------------------------------------------------------------------
// Pre-merge intake attachment / message-role classifier (deterministic
// first, bounded OpenAI assist). AI does not write canonical memory;
// system applies validated overlays to turnFacts before merge only.
// -------------------------------------------------------------------

function properaShallowCloneTurnFacts_(tf) {
  tf = tf || {};
  var o = Object.assign({}, tf);
  if (tf.property && typeof tf.property === "object") o.property = { code: String(tf.property.code || "").trim(), name: String(tf.property.name || "").trim() };
  if (tf.schedule && typeof tf.schedule === "object") o.schedule = Object.assign({}, tf.schedule);
  if (tf.safety && typeof tf.safety === "object") o.safety = Object.assign({}, tf.safety);
  if (tf.missingSlots && typeof tf.missingSlots === "object") o.missingSlots = Object.assign({}, tf.missingSlots);
  if (tf.meta && typeof tf.meta === "object") o.meta = Object.assign({}, tf.meta);
  if (tf.issueMeta != null) {
    try { o.issueMeta = JSON.parse(JSON.stringify(tf.issueMeta)); } catch (_) { o.issueMeta = tf.issueMeta; }
  }
  return o;
}

function intakeMaintenanceSymptomHeuristic_(text) {
  var t = String(text || "").toLowerCase();
  if (!t) return false;
  return /\b(broken|break|leak|leaking|clog(?:ged)?|stuck|drain|draining|off\s*track|loose|wobbly|won'?t\s+work|not\s+working|doesn'?t\s+work|smell|mold|mould|spark|smoke|flood|flooding|backed\s+up|back\s+up|handle|hinge|creak|squeak|damage|crack|cracked|missing|ripped|torn|infest|pest|no\s+hot\s+water|no\s+water|not\s+flushing)\b/.test(t);
}

function intakeExplicitNewTicketMarkers_(text) {
  var t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (/\b(another\s+issue|new\s+issue|separate\s+problem|different\s+(apartment|unit|building|place)|other\s+unit|another\s+unit|unrelated\s+issue)\b/.test(t)) return true;
  if (/\b(also|another|new)\s+(have|got|need)\b[\s\S]{0,120}\b(in\s+apartment|apartment)\s+\d{2,4}\b/.test(t)) return true;
  return false;
}

function intakeContinuationMarkers_(text) {
  return /\b(also|and\s+then|,\s*and\b|\band\b\s+(the|my|our|a|an)\b|plus|oh\s+i\s+(?:just\s+)?remembered|actually|as\s+well|additionally)\b/i.test(String(text || ""));
}

function intakeDeterministicSplitSlotAndResidual_(body) {
  var b = String(body || "").trim();
  if (!b) return { slotPart: "", residualPart: "", marker: "" };
  var m = b.match(/^([\s\S]{1,220}?)[\.\!\?]\s+(also|and\s+then|and|plus|oh\s+i\s+(?:just\s+)?remembered|actually)\b[\s,:-]+([\s\S]+)$/i);
  if (m && m[3] && String(m[3]).trim().length >= 4) return { slotPart: String(m[1]).trim(), residualPart: String(m[3]).trim(), marker: String(m[2] || "").trim() };
  m = b.match(/^(.{1,48}?)\s+(also|and|plus)\s+(.+)$/i);
  if (m && String(m[3]).trim().length >= 6 && String(m[1]).trim().length <= 44) return { slotPart: String(m[1]).trim(), residualPart: String(m[3]).trim(), marker: String(m[2] || "").trim() };
  return { slotPart: "", residualPart: "", marker: "" };
}

function intakeLooksPurePropertyUnitAnswer_(body, expectedStage) {
  var exp = String(expectedStage || "").trim().toUpperCase();
  if (!(exp === "PROPERTY" || exp === "PROPERTY_AND_UNIT" || exp === "UNIT")) return false;
  var b = String(body || "").trim();
  if (!b || b.length > 56) return false;
  if (intakeMaintenanceSymptomHeuristic_(b)) return false;
  if (intakeExplicitNewTicketMarkers_(b)) return false;
  if (canonicalInboundLooksScheduleOnly_(b)) return false;
  var u = (typeof extractUnit_ === "function") ? String(extractUnit_(b) || "").trim() : "";
  if (!u) return false;
  var propHit = null;
  try {
    if (typeof resolvePropertyExplicitOnly_ === "function") propHit = resolvePropertyExplicitOnly_(b);
  } catch (_) {}
  if (!propHit) {
    try {
      if (typeof resolvePropertyFromText_ === "function") propHit = resolvePropertyFromText_(b, { strict: true });
    } catch (_) {}
  }
  if (propHit && propHit.code) return true;
  var compact = b.replace(/\s+/g, " ").trim();
  if (/^[\w\.\-]{2,24}\s+#?\d{2,5}$/i.test(compact)) return true;
  return false;
}

function intakeResolvePropertyToken_(token) {
  var t = String(token || "").trim();
  if (!t) return null;
  try {
    if (typeof resolvePropertyExplicitOnly_ === "function") {
      var p = resolvePropertyExplicitOnly_(t);
      if (p && p.code) return { code: String(p.code || "").trim().toUpperCase(), name: String(p.name || "").trim() };
    }
  } catch (_) {}
  try {
    if (typeof resolvePropertyFromText_ === "function") {
      var p2 = resolvePropertyFromText_(t, { strict: true });
      if (p2 && p2.code) return { code: String(p2.code || "").trim().toUpperCase(), name: String(p2.name || "").trim() };
    }
  } catch (_) {}
  return null;
}

function intakeAttachClassifyAi_(phone, bodyTrim, context) {
  var apiKey = "";
  try { apiKey = String(PropertiesService.getScriptProperties().getProperty("OPENAI_API_KEY") || "").trim(); } catch (_) {}
  if (!apiKey) return null;
  if (typeof isOpenAICooldown_ === "function" && isOpenAICooldown_()) return null;
  var system =
    "You classify tenant messages during an INCOMPLETE maintenance intake. Output JSON only. You advise; the system decides.\n" +
    "Schema keys:\n" +
    "- attachToActiveIntake: boolean\n" +
    "- role: slot_fill_only | slot_fill_plus_append | append_only | correction | explicit_new_ticket | schedule_fill_only | unknown\n" +
    "- proposedNewIssueClauses: string[] (short maintenance symptom phrases only; empty if none)\n" +
    "- proposedSlotFills: { propertyToken: string, unit: string, scheduleHint: string }\n" +
    "- signals: { continuation: number, newTicket: number } (0-1 range, optional but recommended)\n" +
    "- confidence: number (0-1 optional)\n" +
    "- reasonTags: string[]\n" +
    "Guidance:\n" +
    "- Property+unit replies like 'Penn 502' with no new symptom => slot_fill_only, empty proposedNewIssueClauses.\n" +
    "- Schedule-only windows without symptoms => schedule_fill_only.\n" +
    "- Separate problem in another unit/building or clearly distinct ticket => explicit_new_ticket and attachToActiveIntake false.\n" +
    "- 'Also X is broken' => append or slot_fill_plus_append if first clause is location.\n" +
    "Keep clauses in English; max 5 clauses; each clause max 200 chars.";
  var user = "CONTEXT_JSON:\n" + JSON.stringify(context).slice(0, 3800);
  var r = (typeof openaiChatJson_ === "function")
    ? openaiChatJson_({ apiKey: apiKey, model: "gpt-4.1-mini", system: system, user: user, timeoutMs: 12000, phone: String(phone || "").trim(), logLabel: "ATTACH_CLASSIFY_AI", maxRetries: 1 })
    : { ok: false };
  if (!r || !r.ok || !r.json) return null;
  return r.json;
}

/**
 * Classify attachment + message role before canonical merge. Returns a decision object;
 * use properaApplyAttachDecisionToTurnFacts_ to derive merge-safe turnFacts.
 */
function properaIntakeAttachClassify_(opts) {
  opts = opts || {};
  var phone = String(opts.phone || "").trim();
  var bodyTrim = String(opts.bodyTrim || "").trim();
  var tf = opts.turnFacts || {};
  var exp = String(opts.collectStage || "").trim().toUpperCase();
  var reasonTags = [];
  var decisionSource = "deterministic";
  var attachmentDecision = "attach_to_active_intake";
  var messageRole = "unknown";
  var suppressRawIssueForMerge = false;
  var overlayIssueText = "";
  var overlayIssueAppends = [];
  var overlayScheduleRaw = "";
  var resolvedProperty = null;
  var resolvedUnit = "";
  // Request-scoped guard: if the global router already resolved ATTACH_CLARIFY in this inbound turn,
  // do not allow re-entrant clarify classification/side effects later in the same execution.
  var __clarifyResolvedReq = (typeof globalThis !== "undefined" && String(globalThis.__attachClarifyResolvedThisTurn || "") === "1");
  var __clarifyResolvedOutcome = (typeof globalThis !== "undefined" && globalThis.__attachClarifyResolvedOutcome != null)
    ? String(globalThis.__attachClarifyResolvedOutcome || "").trim().toLowerCase()
    : "";

  try { logDevSms_(phone, bodyTrim.slice(0, 72), "ATTACH_CLASSIFY_START exp=[" + exp + "]"); } catch (_) {}

  var rec = null;
  try {
    var sh0 = ensureCanonicalIntakeSheet_();
    rec = canonicalIntakeLoadNoLock_(sh0, phone);
  } catch (_) { rec = null; }

  var activeIncomplete = !!(rec && rec.activeIntake && String(rec.expectedNext || "").trim());

  if (!activeIncomplete) {
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RESULT attach=[attach_to_active_intake] role=[na_inactive] source=[deterministic] tags=[no_active_incomplete]"); } catch (_) {}
    return {
      attachmentDecision: "attach_to_active_intake",
      messageRole: "unknown",
      suppressRawIssueForMerge: false,
      overlayIssueText: "",
      overlayIssueAppends: [],
      overlayScheduleRaw: "",
      resolvedProperty: null,
      resolvedUnit: "",
      decisionSource: "deterministic",
      reasonTags: ["no_active_incomplete_canonical"]
    };
  }

  // Clarification natural-language resolution (hard attach vs start_new for this cycle).
  // If we strip the leading marker and there is no residual content, we short-circuit.
  var __clarifyOutcomeLocked = "";
  var __bodyWork = bodyTrim;
  var __lcWork = String(__bodyWork || "").toLowerCase();
  var __mSame = __lcWork.match(/^\s*(same request|same one|this one|this request)\b[\s,.\-:]*/i);
  if (__mSame) {
    __clarifyOutcomeLocked = "attach";
    attachmentDecision = "attach_to_active_intake";
    messageRole = "unknown";
    var __cutSame = __mSame[0] ? __mSame[0].length : 0;
    __bodyWork = String(bodyTrim || "").slice(__cutSame).trim();
    bodyTrim = __bodyWork;
    suppressRawIssueForMerge = !bodyTrim || bodyTrim.length < 4;
    reasonTags.push("clarify_resolved_same_request");
    try { logDevSms_(phone, "", "ATTACH_CLARIFY_RESOLUTION_LOCKED outcome=[attach]"); } catch (_) {}
    if (suppressRawIssueForMerge) {
      try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RESULT attach=[" + attachmentDecision + "] role=[clarify_resolved] source=[clarify_phrase]"); } catch (_) {}
      return {
        attachmentDecision: attachmentDecision,
        messageRole: messageRole,
        suppressRawIssueForMerge: true,
        overlayIssueText: "",
        overlayIssueAppends: [],
        overlayScheduleRaw: "",
        resolvedProperty: null,
        resolvedUnit: "",
        decisionSource: "clarify_resolution",
        reasonTags: reasonTags
      };
    }
  }
  var __mNew = (!__clarifyOutcomeLocked) ? __lcWork.match(/^\s*(new one|another|different apartment|different unit|other apartment|other unit)\b[\s,.\-:]*/i) : null;
  if (__mNew) {
    __clarifyOutcomeLocked = "start_new";
    attachmentDecision = "start_new_intake";
    messageRole = "explicit_new_ticket";
    var __cutNew = __mNew[0] ? __mNew[0].length : 0;
    __bodyWork = String(bodyTrim || "").slice(__cutNew).trim();
    bodyTrim = __bodyWork;
    suppressRawIssueForMerge = !bodyTrim || bodyTrim.length < 4;
    reasonTags.push("clarify_resolved_start_new");
    try { logDevSms_(phone, "", "ATTACH_CLARIFY_RESOLUTION_LOCKED outcome=[start_new]"); } catch (_) {}
    if (suppressRawIssueForMerge) {
      try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RESULT attach=[" + attachmentDecision + "] role=[clarify_resolved] source=[clarify_phrase]"); } catch (_) {}
      return {
        attachmentDecision: attachmentDecision,
        messageRole: messageRole,
        suppressRawIssueForMerge: true,
        overlayIssueText: "",
        overlayIssueAppends: [],
        overlayScheduleRaw: "",
        resolvedProperty: null,
        resolvedUnit: "",
        decisionSource: "clarify_resolution",
        reasonTags: reasonTags
      };
    }
  }

  // Clarification choice digits (from our own clarification prompt).
  if (/^\s*[12]\s*$/.test(bodyTrim)) {
    var choice = String(bodyTrim).trim();
    if (choice === "1") {
      attachmentDecision = "attach_to_active_intake";
      messageRole = "unknown";
      suppressRawIssueForMerge = true; // digit choice adds no issue content
      reasonTags.push("clarify_choice_digit_same");
      try { logDevSms_(phone, "", "ATTACH_CLARIFY_RESOLUTION_LOCKED outcome=[attach]"); } catch (_) {}
    } else {
      attachmentDecision = "start_new_intake";
      messageRole = "explicit_new_ticket";
      suppressRawIssueForMerge = true; // digit choice adds no issue content
      reasonTags.push("clarify_choice_digit_new");
      try { logDevSms_(phone, "", "ATTACH_CLARIFY_RESOLUTION_LOCKED outcome=[start_new]"); } catch (_) {}
    }
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RESULT attach=[" + attachmentDecision + "] role=[" + messageRole + "] source=[clarify_digit]"); } catch (_) {}
    return {
      attachmentDecision: attachmentDecision,
      messageRole: messageRole,
      suppressRawIssueForMerge: suppressRawIssueForMerge,
      overlayIssueText: "",
      overlayIssueAppends: [],
      overlayScheduleRaw: "",
      resolvedProperty: null,
      resolvedUnit: "",
      decisionSource: "deterministic",
      reasonTags: reasonTags
    };
  }

  var explicitNew = intakeExplicitNewTicketMarkers_(bodyTrim);
  var contMarker = intakeContinuationMarkers_(bodyTrim);

  // Ambiguity: explicit new-ticket + continuation marker (e.g. "Also another issue upstairs").
  if (!__clarifyOutcomeLocked && explicitNew && contMarker) {
    if (__clarifyResolvedReq) {
      attachmentDecision = (__clarifyResolvedOutcome === "start_new") ? "start_new_intake" : "attach_to_active_intake";
      try { logDevSms_(phone, "", "ATTACH_CLARIFY_REENTRY_SUPPRESSED reason=[explicit_new_and_continuation_resolved_by_request_guard]"); } catch (_) {}
    } else {
      attachmentDecision = "clarify_attach_vs_new";
    }
    messageRole = "unknown";
    suppressRawIssueForMerge = false;
    reasonTags.push("explicit_new_and_continuation_ambiguous");
    if (!__clarifyResolvedReq) {
      try { logDevSms_(phone, "", "ATTACH_CLASSIFY_AMBIGUOUS reason=[explicit_new_and_continuation]"); } catch (_) {}
    }
    return {
      attachmentDecision: attachmentDecision,
      messageRole: messageRole,
      suppressRawIssueForMerge: suppressRawIssueForMerge,
      overlayIssueText: "",
      overlayIssueAppends: [],
      overlayScheduleRaw: "",
      resolvedProperty: null,
      resolvedUnit: "",
      decisionSource: "deterministic",
      reasonTags: reasonTags
    };
  }

  if (!__clarifyOutcomeLocked && explicitNew) {
    reasonTags.push("explicit_new_ticket_marker");
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RULE_HIT rule=[explicit_new_ticket]"); } catch (_) {}
    try { logDevSms_(phone, "", "NEW_TICKET_DETECTED source=[deterministic]"); } catch (_) {}
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RESULT attach=[start_new_intake] role=[explicit_new_ticket] source=[deterministic]"); } catch (_) {}
    return {
      attachmentDecision: "start_new_intake",
      messageRole: "explicit_new_ticket",
      suppressRawIssueForMerge: false,
      overlayIssueText: "",
      overlayIssueAppends: [],
      overlayScheduleRaw: "",
      resolvedProperty: null,
      resolvedUnit: "",
      decisionSource: "deterministic",
      reasonTags: reasonTags
    };
  }

  // Unit conflict without explicit new markers is ambiguous: never silently attach a different unit.
  try {
    var recUnitNow = rec ? String(rec.unit || "").trim().toUpperCase() : "";
    var uCandNow = (typeof extractUnit_ === "function") ? String(extractUnit_(bodyTrim) || "").trim().toUpperCase() : "";
    if (recUnitNow && uCandNow && uCandNow !== recUnitNow && !explicitNew && !__clarifyOutcomeLocked) {
      if (__clarifyResolvedReq) {
        attachmentDecision = (__clarifyResolvedOutcome === "start_new") ? "start_new_intake" : "attach_to_active_intake";
        try { logDevSms_(phone, "", "ATTACH_CLARIFY_REENTRY_SUPPRESSED reason=[unit_mismatch_without_explicit_new_ticket_resolved]"); } catch (_) {}
      } else {
        attachmentDecision = "clarify_attach_vs_new";
      }
      messageRole = "unknown";
      suppressRawIssueForMerge = false;
      reasonTags.push("unit_mismatch_without_explicit_new_ticket");
      if (!__clarifyResolvedReq) {
        try { logDevSms_(phone, "", "ATTACH_CLASSIFY_AMBIGUOUS reason=[unit_mismatch_without_explicit_new_ticket] expectedUnit=[" + recUnitNow + "] got=[" + uCandNow + "]"); } catch (_) {}
      }
      return {
        attachmentDecision: attachmentDecision,
        messageRole: messageRole,
        suppressRawIssueForMerge: suppressRawIssueForMerge,
        overlayIssueText: "",
        overlayIssueAppends: [],
        overlayScheduleRaw: "",
        resolvedProperty: null,
        resolvedUnit: "",
        decisionSource: "deterministic",
        reasonTags: reasonTags
      };
    }
  } catch (_) {}

  if ((exp === "SCHEDULE" || exp === "SCHEDULE_PRETICKET" || exp === "FINALIZE_DRAFT") && canonicalInboundLooksScheduleOnly_(bodyTrim) && !intakeMaintenanceSymptomHeuristic_(bodyTrim) && !intakeContinuationMarkers_(bodyTrim)) {
    messageRole = "schedule_fill_only";
    suppressRawIssueForMerge = true;
    overlayScheduleRaw = bodyTrim;
    reasonTags.push("schedule_window_only");
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RULE_HIT rule=[schedule_fill_only]"); } catch (_) {}
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RESULT attach=[attach_to_active_intake] role=[schedule_fill_only] source=[deterministic]"); } catch (_) {}
    try { logDevSms_(phone, "", "SLOT_FILL_ACCEPTED kind=[schedule]"); } catch (_) {}
    return {
      attachmentDecision: attachmentDecision,
      messageRole: messageRole,
      suppressRawIssueForMerge: suppressRawIssueForMerge,
      overlayIssueText: overlayIssueText,
      overlayIssueAppends: overlayIssueAppends,
      overlayScheduleRaw: overlayScheduleRaw,
      resolvedProperty: resolvedProperty,
      resolvedUnit: resolvedUnit,
      decisionSource: decisionSource,
      reasonTags: reasonTags
    };
  }

  var split = intakeDeterministicSplitSlotAndResidual_(bodyTrim);
  if (split.residualPart && (intakeContinuationMarkers_(bodyTrim) || split.marker) && intakeMaintenanceSymptomHeuristic_(split.residualPart)) {
    messageRole = "slot_fill_plus_append";
    suppressRawIssueForMerge = true;
    overlayIssueText = split.residualPart;
    reasonTags.push("split_slot_residual", "continuation_marker");
    if (split.slotPart) {
      var uSp = (typeof extractUnit_ === "function") ? String(extractUnit_(split.slotPart) || "").trim() : "";
      if (uSp) resolvedUnit = uSp;
      var rp = intakeResolvePropertyToken_(split.slotPart.replace(/\s+\d{1,5}\b.*$/, "").trim()) || intakeResolvePropertyToken_(split.slotPart);
      if (rp) resolvedProperty = rp;
    }
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RULE_HIT rule=[slot_fill_plus_append_split]"); } catch (_) {}
    try { logDevSms_(phone, overlayIssueText.slice(0, 80), "ISSUE_APPEND_ACCEPTED reason=[slot_fill_plus_append]"); } catch (_) {}
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RESULT attach=[attach_to_active_intake] role=[slot_fill_plus_append] source=[deterministic]"); } catch (_) {}
    return {
      attachmentDecision: attachmentDecision,
      messageRole: messageRole,
      suppressRawIssueForMerge: suppressRawIssueForMerge,
      overlayIssueText: overlayIssueText,
      overlayIssueAppends: overlayIssueAppends,
      overlayScheduleRaw: overlayScheduleRaw,
      resolvedProperty: resolvedProperty,
      resolvedUnit: resolvedUnit,
      decisionSource: decisionSource,
      reasonTags: reasonTags
    };
  }

  if ((exp === "PROPERTY" || exp === "PROPERTY_AND_UNIT" || exp === "UNIT") && intakeLooksPurePropertyUnitAnswer_(bodyTrim, exp)) {
    // If the user provided a conflicting unit for the active intake without explicit new-ticket markers,
    // the same-message may actually be a new ticket seed. Require clarification.
    try {
      var _recUnit = rec ? String(rec.unit || "").trim().toUpperCase() : "";
      var _uIn = (typeof extractUnit_ === "function") ? String(extractUnit_(bodyTrim) || "").trim().toUpperCase() : "";
      if (_recUnit && _uIn && _uIn !== _recUnit && !__clarifyOutcomeLocked && !__clarifyResolvedReq) {
        attachmentDecision = "clarify_attach_vs_new";
        messageRole = "unknown";
        suppressRawIssueForMerge = false;
        reasonTags.push("slot_answer_unit_mismatch");
        try { logDevSms_(phone, "", "ATTACH_CLASSIFY_AMBIGUOUS reason=[slot_answer_unit_mismatch] expectedUnit=[" + _recUnit + "] got=[" + _uIn + "]"); } catch (_) {}
        return {
          attachmentDecision: attachmentDecision,
          messageRole: messageRole,
          suppressRawIssueForMerge: suppressRawIssueForMerge,
          overlayIssueText: "",
          overlayIssueAppends: [],
          overlayScheduleRaw: "",
          resolvedProperty: null,
          resolvedUnit: "",
          decisionSource: "deterministic",
          reasonTags: reasonTags
        };
      }
    } catch (_) {}

    messageRole = "slot_fill_only";
    suppressRawIssueForMerge = true;
    reasonTags.push("pure_property_unit_answer");
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RULE_HIT rule=[slot_fill_only_property_unit]"); } catch (_) {}
    try { logDevSms_(phone, "", "ISSUE_APPEND_REJECTED reason=[slot_text_only]"); } catch (_) {}
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RESULT attach=[attach_to_active_intake] role=[slot_fill_only] source=[deterministic]"); } catch (_) {}
    try { logDevSms_(phone, "", "SLOT_FILL_ACCEPTED kind=[property_unit]"); } catch (_) {}
    return {
      attachmentDecision: attachmentDecision,
      messageRole: messageRole,
      suppressRawIssueForMerge: suppressRawIssueForMerge,
      overlayIssueText: overlayIssueText,
      overlayIssueAppends: overlayIssueAppends,
      overlayScheduleRaw: overlayScheduleRaw,
      resolvedProperty: resolvedProperty,
      resolvedUnit: resolvedUnit,
      decisionSource: decisionSource,
      reasonTags: reasonTags
    };
  }

  if (/^(also|and|plus|oh\b|actually)\b/i.test(bodyTrim) && intakeMaintenanceSymptomHeuristic_(bodyTrim) && bodyTrim.length >= 8) {
    messageRole = "append_only";
    reasonTags.push("leading_continuation_token");
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RULE_HIT rule=[append_only]"); } catch (_) {}
    try { logDevSms_(phone, bodyTrim.slice(0, 80), "ISSUE_APPEND_ACCEPTED reason=[append_only]"); } catch (_) {}
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RESULT attach=[attach_to_active_intake] role=[append_only] source=[deterministic]"); } catch (_) {}
    return {
      attachmentDecision: attachmentDecision,
      messageRole: messageRole,
      suppressRawIssueForMerge: false,
      overlayIssueText: overlayIssueText,
      overlayIssueAppends: overlayIssueAppends,
      overlayScheduleRaw: overlayScheduleRaw,
      resolvedProperty: resolvedProperty,
      resolvedUnit: resolvedUnit,
      decisionSource: decisionSource,
      reasonTags: reasonTags
    };
  }

  var needsAi = bodyTrim.length >= 6 && activeIncomplete;
  if (needsAi) {
    var ctx = {
      expectedStage: exp,
      body: bodyTrim.slice(0, 900),
      canonicalSummary: {
        expectedNext: rec ? String(rec.expectedNext || "") : "",
        hasProperty: !!(rec && String(rec.propertyCode || "").trim()),
        hasUnit: !!(rec && String(rec.unit || "").trim()),
        hasIssue: !!(rec && (String(rec.primaryIssue || "").trim() || (rec.issueBuf && rec.issueBuf.length)))
      },
      packageSummary: {
        issue: String(tf.issue || "").slice(0, 200),
        unit: String(tf.unit || ""),
        propCode: tf.property && tf.property.code ? String(tf.property.code) : ""
      }
    };
    var j = intakeAttachClassifyAi_(phone, bodyTrim, ctx);
    if (j) {
      decisionSource = "deterministic_plus_ai";
      try { logDevSms_(phone, "", "ATTACH_CLASSIFY_AI_USED"); } catch (_) {}
      var roleAi = String(j.role || "unknown").trim().toLowerCase();
      var allowed = { slot_fill_only: 1, slot_fill_plus_append: 1, append_only: 1, correction: 1, explicit_new_ticket: 1, schedule_fill_only: 1, unknown: 1 };
      if (allowed[roleAi]) messageRole = roleAi;
      var aiSignals = (j.signals && typeof j.signals === "object") ? j.signals : {};
      var aiCont = Number(aiSignals.continuation != null ? aiSignals.continuation : NaN);
      var aiNew = Number(aiSignals.newTicket != null ? aiSignals.newTicket : NaN);
      if (!isFinite(aiCont)) aiCont = 0;
      if (!isFinite(aiNew)) aiNew = 0;
      var aiDelta = Math.abs(aiCont - aiNew);
      var aiMax = Math.max(aiCont, aiNew);
      var aiConf = Number(j.confidence != null ? j.confidence : (j.confidenceScore != null ? j.confidenceScore : NaN));
      if (!isFinite(aiConf)) aiConf = 0;
      var aiUncertain = (roleAi === "unknown") || (aiMax < 0.6) || (aiDelta < 0.15) || (aiConf > 0 && aiConf < 0.55);
      if (aiUncertain) {
        if (__clarifyResolvedReq) {
          attachmentDecision = (__clarifyResolvedOutcome === "start_new") ? "start_new_intake" : "attach_to_active_intake";
          messageRole = "unknown";
          reasonTags.push("ai_uncertain_reentry_suppressed");
          try { logDevSms_(phone, "", "ATTACH_CLARIFY_REENTRY_SUPPRESSED reason=[ai_uncertain_resolved_guard] contSig=[" + String(aiCont) + "] newSig=[" + String(aiNew) + "] conf=[" + String(aiConf) + "]"); } catch (_) {}
        } else if (__clarifyOutcomeLocked) {
          attachmentDecision = (__clarifyOutcomeLocked === "attach") ? "attach_to_active_intake" : "start_new_intake";
          messageRole = "unknown";
          reasonTags.push("ai_uncertain_but_clarify_locked");
          try { logDevSms_(phone, "", "ATTACH_CLASSIFY_AMBIGUOUS reason=[ai_uncertain_but_locked] outcomeLocked=[" + String(__clarifyOutcomeLocked) + "] contSig=[" + String(aiCont) + "] newSig=[" + String(aiNew) + "] conf=[" + String(aiConf) + "] role=[" + String(roleAi || "") + "]"); } catch (_) {}
        } else {
          attachmentDecision = "clarify_attach_vs_new";
          messageRole = "unknown";
          reasonTags.push("ai_uncertain_clarify");
          try { logDevSms_(phone, "", "ATTACH_CLASSIFY_AMBIGUOUS reason=[ai_uncertain_clarify] contSig=[" + String(aiCont) + "] newSig=[" + String(aiNew) + "] conf=[" + String(aiConf) + "] role=[" + String(roleAi || "") + "]"); } catch (_) {}
        }
      } else {
        if (j.attachToActiveIntake === false) {
          attachmentDecision = "start_new_intake";
          reasonTags.push("ai_attach_false");
        } else {
          attachmentDecision = "attach_to_active_intake";
        }
        if (messageRole === "explicit_new_ticket") {
          attachmentDecision = "start_new_intake";
          reasonTags.push("ai_role_explicit_new_ticket");
        }
      }
      if (messageRole === "slot_fill_only" || messageRole === "schedule_fill_only") {
        suppressRawIssueForMerge = true;
        try { logDevSms_(phone, "", "ISSUE_APPEND_REJECTED reason=[ai_slot_or_schedule_fill]"); } catch (_) {}
      }
      if (Array.isArray(j.proposedNewIssueClauses)) {
        overlayIssueAppends = j.proposedNewIssueClauses.map(function (x) { return String(x || "").trim(); }).filter(Boolean).slice(0, 5);
        for (var ci = 0; ci < overlayIssueAppends.length; ci++) {
          if (overlayIssueAppends[ci].length > 280) overlayIssueAppends[ci] = overlayIssueAppends[ci].slice(0, 280);
        }
      }
      if (messageRole === "slot_fill_plus_append" && overlayIssueAppends.length) {
        suppressRawIssueForMerge = true;
        overlayIssueText = overlayIssueAppends.join(" | ");
      }
      if (j.proposedSlotFills && typeof j.proposedSlotFills === "object") {
        var pt = String(j.proposedSlotFills.propertyToken || "").trim();
        var ut = String(j.proposedSlotFills.unit || "").trim();
        var sch = String(j.proposedSlotFills.scheduleHint || "").trim();
        if (ut && (typeof normalizeUnit_ === "function")) {
          try { ut = normalizeUnit_(ut) || ut; } catch (_) {}
        }
        if (pt) {
          var rp2 = intakeResolvePropertyToken_(pt);
          if (rp2) resolvedProperty = rp2;
        }
        if (ut && /^[A-Za-z0-9#\-]{1,16}$/.test(ut)) resolvedUnit = ut;
        if (sch && sch.length <= 500) overlayScheduleRaw = sch;
      }
      if (attachmentDecision === "start_new_intake") {
        suppressRawIssueForMerge = false;
        overlayIssueText = "";
      }
      if (messageRole === "append_only" && overlayIssueAppends.length) {
        suppressRawIssueForMerge = true;
        overlayIssueText = overlayIssueAppends.join(" | ");
      }
    }
  }

  try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RESULT attach=[" + attachmentDecision + "] role=[" + messageRole + "] source=[" + decisionSource + "] tags=[" + reasonTags.join(",") + "]"); } catch (_) {}
  if (attachmentDecision === "clarify_attach_vs_new") {
    try { logDevSms_(phone, "", "ATTACH_CLASSIFY_RESULT attach=[clarify_attach_vs_new] role=[clarify_needed] source=[" + decisionSource + "]"); } catch (_) {}
    return {
      attachmentDecision: attachmentDecision,
      messageRole: messageRole,
      suppressRawIssueForMerge: suppressRawIssueForMerge,
      overlayIssueText: overlayIssueText,
      overlayIssueAppends: overlayIssueAppends,
      overlayScheduleRaw: overlayScheduleRaw,
      resolvedProperty: resolvedProperty,
      resolvedUnit: resolvedUnit,
      decisionSource: decisionSource,
      reasonTags: reasonTags
    };
  }
  if (messageRole === "unknown" && !suppressRawIssueForMerge && String(tf.issue || "").trim()) {
    var issueLine = String(tf.issue || tf.issueHint || "").trim();
    if (issueLine && !intakeMaintenanceSymptomHeuristic_(issueLine) && intakeLooksPurePropertyUnitAnswer_(issueLine, exp)) {
      suppressRawIssueForMerge = true;
      messageRole = "slot_fill_only";
      reasonTags.push("fallback_issue_matches_slot_shape");
      try { logDevSms_(phone, "", "ISSUE_APPEND_REJECTED reason=[no_symptom_language_slot_shape]"); } catch (_) {}
    }
  }

  return {
    attachmentDecision: attachmentDecision,
    messageRole: messageRole,
    suppressRawIssueForMerge: suppressRawIssueForMerge,
    overlayIssueText: overlayIssueText,
    overlayIssueAppends: overlayIssueAppends,
    overlayScheduleRaw: overlayScheduleRaw,
    resolvedProperty: resolvedProperty,
    resolvedUnit: resolvedUnit,
    decisionSource: decisionSource,
    reasonTags: reasonTags
  };
}

function properaApplyAttachDecisionToTurnFacts_(tf, ad) {
  if (!ad) return tf || {};
  var o = properaShallowCloneTurnFacts_(tf);
  if (ad.attachmentDecision === "start_new_intake") return o;
  var roleUp = String(ad.messageRole || "").trim().toLowerCase();
  var hasOverlayAppends = !!(ad.overlayIssueAppends && ad.overlayIssueAppends.length);
  o.attachMessageRole = roleUp;
  if ((roleUp === "slot_fill_only" || roleUp === "schedule_fill_only") && !hasOverlayAppends) {
    o.slotFillOnly = true;
  }
  if (ad.suppressRawIssueForMerge) {
    o.issue = "";
    o.issueHint = "";
    o.issueMeta = null;
  }
  if (ad.overlayIssueText && String(ad.overlayIssueText).trim()) {
    o.issue = String(ad.overlayIssueText).trim();
  }
  if (ad.overlayIssueAppends && ad.overlayIssueAppends.length && !o.issue) {
    o.issue = ad.overlayIssueAppends.filter(Boolean).join(" | ");
  }
  if (ad.overlayScheduleRaw && String(ad.overlayScheduleRaw).trim()) {
    o.schedule = o.schedule || {};
    o.schedule.raw = String(ad.overlayScheduleRaw).trim();
  }
  if (o.slotFillOnly && o.structuredSignal && typeof o.structuredSignal === "object") {
    // Slot-fill replies must not be reinterpreted as issue commits during finalize.
    o.structuredSignal.issues = [];
    if (String(o.structuredSignal.intentType || "").trim()) {
      o.structuredSignal.intentType = "PENDING_SLOT_FILL";
    }
  }
  if (ad.resolvedProperty && ad.resolvedProperty.code && (!o.property || !String(o.property.code || "").trim())) {
    o.property = { code: ad.resolvedProperty.code, name: ad.resolvedProperty.name || "" };
  }
  if (ad.resolvedUnit && !String(o.unit || "").trim()) o.unit = ad.resolvedUnit;
  return o;
}


// ===================================================================
// ===== M5 — DRAFT ACCUMULATOR =======================================
// @MODULE:M5
// Responsibilities:
// - Merge turn facts into draft/session/directory
// - Stage expectation recompute
//
// Required:
// - LockService discipline
// ===================================================================
// DRAFT ACCUMULATOR (Propera Compass — Draft-First)
// Write-if-empty: property, unit, issue.
// Issue: append-only with min-length guard (no drip noise).
// Exception: if session/directory still holds a *different* substantive issue (no stable-token
// overlap with this turn), replace — avoids piping stale text into a false multi-ticket split.
// ============================================================

/** @returns {boolean} true if stable-key token bags for a and b share at least one word */
function issueDraftStableTokensOverlap_(a, b) {
  var ka = (typeof issueTextStableKey_ === "function") ? String(issueTextStableKey_(a) || "").trim() : "";
  var kb = (typeof issueTextStableKey_ === "function") ? String(issueTextStableKey_(b) || "").trim() : "";
  if (!ka || !kb) return true;
  var ta = ka.split(/\s+/).filter(Boolean);
  var tb = kb.split(/\s+/).filter(Boolean);
  if (!ta.length || !tb.length) return true;
  var set = {};
  for (var i = 0; i < tb.length; i++) set[tb[i]] = 1;
  for (var j = 0; j < ta.length; j++) {
    if (set[ta[j]]) return true;
  }
  return false;
}

function draftUpsertFromTurn_(dir, dirRow, turnFacts, bodyTrim, phone, sessionOpt) {
  if (!dirRow || dirRow < 2) return false;
  var _canonStage = "";
  try {
    if (sessionOpt && sessionOpt.expected) _canonStage = String(sessionOpt.expected || "").trim().toUpperCase();
    else if (sessionOpt && sessionOpt.stage) _canonStage = String(sessionOpt.stage || "").trim().toUpperCase();
  } catch (_) {}
  if (!_canonStage && dir && dirRow >= 2) {
    try {
      var _psCol = (typeof DIR_COL !== "undefined" && DIR_COL.PENDING_STAGE) ? DIR_COL.PENDING_STAGE : 8;
      _canonStage = String(dir.getRange(dirRow, _psCol).getValue() || "").trim().toUpperCase();
    } catch (_) {}
  }
  var _attachDec = null;
  var _tfForCanon = turnFacts || {};
  try {
    if (typeof properaIntakeAttachClassify_ === "function" && typeof properaApplyAttachDecisionToTurnFacts_ === "function") {
      _attachDec = properaIntakeAttachClassify_({
        phone: phone,
        bodyTrim: String(bodyTrim || ""),
        turnFacts: turnFacts || {},
        collectStage: _canonStage,
        dir: dir,
        dirRow: dirRow
      });
      try {
        var _mr = String((_attachDec && _attachDec.messageRole) || "").trim().toLowerCase();
        var _slotOnly = (_mr === "slot_fill_only" || _mr === "schedule_fill_only") && !((_attachDec && _attachDec.overlayIssueAppends) && _attachDec.overlayIssueAppends.length);
        if (turnFacts && typeof turnFacts === "object") {
          turnFacts.attachMessageRole = _mr;
          turnFacts.slotFillOnly = !!_slotOnly;
        }
      } catch (_) {}
      _tfForCanon = properaApplyAttachDecisionToTurnFacts_(turnFacts || {}, _attachDec);
      turnFacts = _tfForCanon;
    }
  } catch (_) {}

  if (_attachDec && _attachDec.attachmentDecision === "clarify_attach_vs_new") {
    var __reqClarifyResolved = (typeof globalThis !== "undefined" && String(globalThis.__attachClarifyResolvedThisTurn || "") === "1");
    if (__reqClarifyResolved) {
      var __forcedOutcomeDraft = String(globalThis.__attachClarifyResolvedOutcome || "").trim().toLowerCase();
      _attachDec.attachmentDecision = (__forcedOutcomeDraft === "start_new") ? "start_new_intake" : "attach_to_active_intake";
      try { logDevSms_(phone, "", "ATTACH_CLARIFY_REENTRY_SUPPRESSED reason=[draft_upsert_override_request_guard] forcedOutcome=[" + String(__forcedOutcomeDraft) + "]"); } catch (_) {}
    } else {
      try { logDevSms_(phone, "", "ATTACH_CLARIFY_REQUIRED blocked_merge reason=[clarify_attach_vs_new]"); } catch (_) {}
      try {
        if (typeof ctxUpsert_ === "function") {
          var _clarMs = Date.now() + 3 * 60 * 1000; // bounded TTL
          ctxUpsert_(phone, { pendingExpected: "ATTACH_CLARIFY", pendingExpiresAt: new Date(_clarMs).toISOString(), lastIntent: "ATTACH_CLARIFY" }, "ATTACH_CLARIFY_REQUIRED");
        }
      } catch (_) {}
      return false;
    }
  }
  try {
    properaCanonicalIntakeMergeCommit_({
      phone: phone,
      dir: dir,
      dirRow: dirRow,
      turnFacts: _tfForCanon,
      writerTag: "DRAFT_UPSERT_CANONICAL",
      mirrorWrites: true,
      collectStage: _canonStage,
      attachDecision: _attachDec,
      inboundBodyTrim: String(bodyTrim || "")
    });
  } catch (_) {}

  var didWriteIssue = false;
  // Canonical split preview inputs (issue-atoms). Filled during this draft upsert cycle.
  var previewAtomsFromThisTurn = [];
  var previewAtomsSourceTag = "canonical_groups";
  var schemaObjPre = null;
  var schemaGateUsed = false;
  var schemaAlreadyAttempted = false;
  // Apply schema in its own lock (fetch done above, no lock during network call)
  if (schemaObjPre && (typeof isValidSchemaIssues_ === "function") && isValidSchemaIssues_(schemaObjPre) && typeof applySchemaIssuesToDraft_ === "function") {
    try {
      withWriteLock_("SCHEMA_APPLY", function () { applySchemaIssuesToDraft_(dir, dirRow, schemaObjPre, phone); });
      didWriteIssue = true;
      try { logDevSms_(phone, "", "SCHEMA_EXTRACT ok=1 n=" + (schemaObjPre.issues ? schemaObjPre.issues.length : 0)); } catch (_) {}

      // Build canonical issue-atoms directly from schema extraction.
      try {
        if (schemaObjPre && Array.isArray(schemaObjPre.issues) && schemaObjPre.issues.length) {
          previewAtomsFromThisTurn = (schemaObjPre.issues || [])
            .map(function (it) { return issueAtomFromSchemaIssue_(it, "SCHEMA"); })
            .filter(Boolean);
          previewAtomsSourceTag = "canonical_groups";
        }
      } catch (_) {}
    } catch (_) {}
  } else if (schemaGateUsed && !(schemaObjPre && (typeof isValidSchemaIssues_ === "function") && isValidSchemaIssues_(schemaObjPre))) {
    try { logDevSms_(phone, "", "SCHEMA_EXTRACT ok=0 fallback=deterministic"); } catch (_) {}
  }
  try {
    const now = new Date();

    dalWithLock_("DRAFT_UPSERT", function () {

      // 1) Property (B + C) — compiler turnFacts only
      var existingPropCode = String(dir.getRange(dirRow, 2).getValue() || "").trim();
      if (!existingPropCode && turnFacts && turnFacts.property && turnFacts.property.code) {
        dalSetPendingPropertyNoLock_(dir, dirRow, { code: String(turnFacts.property.code || "").trim(), name: String(turnFacts.property.name || "").trim() });
        try { logDevSms_(phone, bodyTrim, "DRAFT_UPSERT prop=[" + turnFacts.property.code + "]"); } catch (_) {}
      }

      // 2) Unit (F) — opener/compiler facts only (no raw-text reinterpret)
      var existingUnit = String(dir.getRange(dirRow, 6).getValue() || "").trim();
      if (!existingUnit) {
        var unitCandidate = (turnFacts && turnFacts.unit) ? normalizeUnit_(turnFacts.unit) : "";
        if (unitCandidate) {
          dalSetPendingUnitNoLock_(dir, dirRow, unitCandidate);
          try { logDevSms_(phone, bodyTrim, "DRAFT_UPSERT unit=[" + unitCandidate + "]"); } catch (_) {}
        }
      }

      // 3) Issue (E) — append-only, min 4 chars. Skip only for content-based reasons (ack/greet, schedule-like, property).
      // Being in UNIT or SCHEDULE stage does NOT block issue capture; cross-field capture allowed.
      // Structured intake (portal/PM form): property + unit + message come from dedicated fields; do not run conversational property gates.
      var structuredIntake = !!(sessionOpt && sessionOpt.structuredIntake);
      if (bodyTrim) {
        const st = String(dir.getRange(dirRow, 8).getValue() || "").trim().toUpperCase();
        let skipIssueAppend = false;
        var schemaApplied = false;

        // Slot-collect turns: never treat inbound body as issue text (package + durable slots own truth).
        var sessionExpectedUp = "";
        try {
          if (sessionOpt && sessionOpt.expected) sessionExpectedUp = String(sessionOpt.expected || "").toUpperCase().trim();
        } catch (_) {}
        var effectiveSlotStage = String(st || sessionExpectedUp || "").toUpperCase();
        var _slotHasIssueSignal = false;
        try {
          _slotHasIssueSignal = !!String((turnFacts && turnFacts.issue) || "").trim();
          if (!_slotHasIssueSignal && turnFacts && turnFacts.issueMeta && Array.isArray(turnFacts.issueMeta.clauses)) {
            for (var _ci = 0; _ci < turnFacts.issueMeta.clauses.length; _ci++) {
              var _c0 = turnFacts.issueMeta.clauses[_ci];
              if (!_c0) continue;
              var _ct0 = (typeof classifyIssueClauseType_ === "function") ? classifyIssueClauseType_(String(_c0.text || _c0.title || "")) : "problem";
              if (_ct0 === "problem") { _slotHasIssueSignal = true; break; }
            }
          }
        } catch (_) {}
        if (!structuredIntake &&
            (effectiveSlotStage === "PROPERTY" || effectiveSlotStage === "PROPERTY_AND_UNIT" || effectiveSlotStage === "UNIT" ||
              effectiveSlotStage === "SCHEDULE" || effectiveSlotStage === "SCHEDULE_PRETICKET")) {
          // Cross-slot capture: in slot stages, still accept issue text when present.
          skipIssueAppend = !_slotHasIssueSignal;
          try {
            if (skipIssueAppend) logDevSms_(phone, "", "ISSUE_APPEND_SKIP reason=[slot_collect_only] stage=[" + effectiveSlotStage + "]");
            else logDevSms_(phone, "", "ISSUE_APPEND_ALLOW reason=[slot_collect_with_issue] stage=[" + effectiveSlotStage + "]");
          } catch (_) {}
        }

        // D) Schema applied above (outside lock); skip deterministic path when schema succeeded
        schemaApplied = !!(schemaObjPre && (typeof isValidSchemaIssues_ === "function") && isValidSchemaIssues_(schemaObjPre));
        if (schemaApplied) {
          try { logDevSms_(phone, "", "SCHEMA_SHORTCIRCUIT issue_parse=1"); } catch (_) {}
        }

        const meta = (turnFacts && turnFacts.meta) ? turnFacts.meta : {};
        if (meta && meta.hasMediaOnly === true) {
          skipIssueAppend = true;
          try { logDevSms_(phone, (bodyTrim || "").slice(0, 20), "ISSUE_APPEND_SKIP reason=[media_only]"); } catch (_) {}
        }
        // Staff-capture may synthesize a strong issue from payload when parser output is weak.
        // Preserve that issue; do not let property-answer heuristics suppress it.
        var staffSynthIssue = !!(
          sessionOpt && sessionOpt.staffCapture &&
          meta && meta.staffSynthIssue === true &&
          turnFacts && turnFacts.issue &&
          String(turnFacts.issue || "").trim().length >= 8
        );
        if (staffSynthIssue) {
          skipIssueAppend = false;
        }
        var issueCandidate = ""; // set by mixed property+issue split; do not mutate bodyTrim
        var hasActionable = !!String((turnFacts && turnFacts.issue) || "").trim();
        var hasInterpretedSchedule = !!(turnFacts && turnFacts.schedule && String(turnFacts.schedule.raw || "").trim());
        if (hasInterpretedSchedule) {
          if (!hasActionable) {
            skipIssueAppend = true;
            try { logDevSms_(phone, (bodyTrim || "").slice(0, 20), "ISSUE_APPEND_SKIP reason=[schedule_like]"); } catch (_) {}
          } else {
            try { logDevSms_(phone, (bodyTrim || "").slice(0, 20), "ISSUE_SCHED_MIXED allow_issue=1"); } catch (_) {}
          }
        }
        // Only suppress issue when message is a property answer, not when property appears embedded in a long report.
        // Skip this gate for structured intake (portal/PM form): message is the dedicated issue field.
        var propertyAnswerLike = !!(
          turnFacts &&
          turnFacts.missingSlots &&
          turnFacts.missingSlots.propertyMissing === false &&
          !String((turnFacts && turnFacts.issue) || "").trim()
        );
        if (!structuredIntake && !staffSynthIssue && turnFacts && turnFacts.property && turnFacts.property.code && propertyAnswerLike) {
          skipIssueAppend = true;
          try { logDevSms_(phone, (bodyTrim || "").slice(0, 20), "ISSUE_APPEND_SKIP reason=[property_detected]"); } catch (_) {}
        }
        if (st === "PROPERTY" && !structuredIntake && !staffSynthIssue) {
          if (!skipIssueAppend) {
            try {
              var openerClauses = [];
              if (turnFacts && turnFacts.issueMeta && Array.isArray(turnFacts.issueMeta.problemClauses)) {
                openerClauses = turnFacts.issueMeta.problemClauses.map(function (x) { return String(x || "").trim(); }).filter(Boolean);
              }
              if (openerClauses && openerClauses.length) {
                skipIssueAppend = false;
                issueCandidate = openerClauses[0];
                try { logDevSms_(phone, issueCandidate, "ISSUE_FROM_OPENER_CLAUSE"); } catch (_) {}
                for (var ii = 1; ii < openerClauses.length; ii++) {
                  var issuePart = openerClauses[ii];
                  if (typeof classifyIssueClauseType_ === "function" && classifyIssueClauseType_(issuePart) !== "problem") continue;
                  if (typeof appendIssueBufferItem_ === "function") {
                    try { appendIssueBufferItem_(dir, dirRow, issuePart, st); } catch (_) {}
                  }
                }
              }
            } catch (_) {}
          }
        }

        const isAck     = (typeof looksLikeAckOnly_ === "function")     && looksLikeAckOnly_(bodyTrim.toLowerCase());
        const isGreet   = (typeof looksLikeGreetingOnly_ === "function") && looksLikeGreetingOnly_(bodyTrim.toLowerCase());
        var issueText = issueCandidate || bodyTrim;
        var parsedIssue = null;
        var effectiveIssueTitle = "";
        var isActionable = false;
        if (staffSynthIssue) {
          issueText = String(turnFacts.issue || "").trim();
          isActionable = true;
        }
        if (structuredIntake && (turnFacts && turnFacts.issue ? String(turnFacts.issue).trim() : bodyTrim).length >= 4) {
          issueText = (turnFacts && turnFacts.issue) ? String(turnFacts.issue).trim() : bodyTrim;
          isActionable = true;
        }
        if (!schemaApplied && !structuredIntake) {
          issueText = (typeof extractIssuePayload_ === "function") ? extractIssuePayload_(issueText) : issueText;

          // ── Deterministic parse first (prefer compileTurn_ output) ──
          parsedIssue = (turnFacts && turnFacts.issueMeta) ? turnFacts.issueMeta : null;
          // Actionable check on selected clause/title, not full body (avoids "fixed itself" in preamble killing real issue)
          var actionableText = (parsedIssue && (parsedIssue.bestClauseText || parsedIssue.title))
            ? (parsedIssue.bestClauseText || parsedIssue.title)
            : issueText;
          var parsedActionable = !!String(actionableText || "").trim();
          // Staff-capture synth issue: already vetted (length + !weak); do not let parse/heuristic clear it (fixes Missing: issue after MEDIA_SYNTH).
          isActionable = parsedActionable || !!staffSynthIssue;

          // Effective issue title: for staff capture with multiple actionable clauses, combine all (order preserved); else single winner
          effectiveIssueTitle = (parsedIssue && (parsedIssue.title || parsedIssue.bestClauseText)) ? String(parsedIssue.title || parsedIssue.bestClauseText).trim() : "";
          var isStaffCaptureMultiIssue = sessionOpt && sessionOpt.staffCapture && parsedIssue && parsedIssue.clauses && parsedIssue.clauses.length > 1;
          if (isStaffCaptureMultiIssue && typeof buildCombinedIssueTitleFromClauses_ === "function") {
            effectiveIssueTitle = buildCombinedIssueTitleFromClauses_(parsedIssue.clauses);
            try {
              logDevSms_(phone, "", "STAFF_MULTI_ISSUE_COMBINED count=" + parsedIssue.clauses.length + " summary=[" + String(effectiveIssueTitle || "").slice(0, 120) + "]");
            } catch (_) {}
          } else if (parsedIssue && parsedIssue.title) {
            try {
              logDevSms_(phone, parsedIssue.title.slice(0, 80), "ISSUE_PICK_WIN dbg=[" + (parsedIssue.debug || "") + "]");
            } catch (_) {}
          }

          try {
            if (parsedIssue && effectiveIssueTitle) {
              logDevSms_(phone, (bodyTrim || "").slice(0, 60),
                "ISSUE_PARSE title=[" + String(effectiveIssueTitle || "").slice(0, 60) + "]" +
                " cat=[" + String(parsedIssue.category || "") + "]" +
                " urg=[" + String(parsedIssue.urgency || "") + "]" +
                " n=" + (parsedIssue.clauses ? parsedIssue.clauses.length : 0) +
                " dbg=[" + String(parsedIssue.debug || "") + "]"
              );
            }
          } catch (_) {}
        }

        if (!skipIssueAppend && !schemaApplied && !isAck && !isGreet && isActionable) {
          // Draft/ticket title: use effectiveIssueTitle when we have it (single winner or staff-capture combined), else turnFacts/session
          const newDetail =
            (parsedIssue && effectiveIssueTitle) ? effectiveIssueTitle :
            (parsedIssue && (parsedIssue.title || parsedIssue.bestClauseText)) ? String(parsedIssue.title || parsedIssue.bestClauseText).trim() :
            (turnFacts && turnFacts.issue)     ? String(turnFacts.issue).trim() :
                                                String(issueText || "").trim();

          // Canonical issue-atoms for this intake cycle (deterministic, clause-level).
          try {
            var atomsForPreviewThisTurn = [];
            if (parsedIssue && parsedIssue.clauses && Array.isArray(parsedIssue.clauses) && parsedIssue.clauses.length) {
              for (var ai = 0; ai < parsedIssue.clauses.length; ai++) {
                var c = parsedIssue.clauses[ai];
                if (!c) continue;
                var raw = String(c.title || c.text || "").trim();
                if (!raw) continue;
                // Ensure we only admit problem clauses into the atom set.
                if (typeof classifyIssueClauseType_ === "function") {
                  var ct = classifyIssueClauseType_(String(c.text || c.title || ""));
                  if (ct !== "problem") continue;
                }
                var atom = issueAtomFromProblemText_(raw, st);
                if (atom) atomsForPreviewThisTurn.push(atom);
              }
            }
            if (!atomsForPreviewThisTurn.length) {
              var singleAtom = issueAtomFromProblemText_(newDetail, st);
              if (singleAtom) atomsForPreviewThisTurn.push(singleAtom);
            }
            if (atomsForPreviewThisTurn.length) {
              previewAtomsFromThisTurn = (previewAtomsFromThisTurn || []).concat(atomsForPreviewThisTurn).filter(Boolean);
              previewAtomsSourceTag = "canonical_groups";
            }
          } catch (_) {}

          const pendingRow = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0;
          var existingIssue = String(dir.getRange(dirRow, 5).getValue() || "").trim();
          if (pendingRow <= 0) {
            var _sess = sessionOpt && (sessionOpt.draftIssue !== undefined) ? sessionOpt : (typeof sessionGet_ === "function" ? sessionGet_(phone) : null);
            if (_sess && _sess.draftIssue) existingIssue = String(_sess.draftIssue || "").trim();
          }

          if (newDetail) {
            let merged = existingIssue;
            var replacedUnrelatedDraft = false;

            if (!merged) {
              merged = newDetail;
            } else if (pendingRow <= 0 && (typeof isWeakIssue_ === "function") && (typeof looksSpecificIssue_ === "function") && isWeakIssue_(existingIssue) && looksSpecificIssue_(newDetail)) {
              merged = newDetail;
            } else if (
              pendingRow <= 0 &&
              String(newDetail || "").trim().length >= 8 &&
              (typeof looksSpecificIssue_ === "function") && looksSpecificIssue_(newDetail) &&
              (typeof looksSpecificIssue_ === "function") && looksSpecificIssue_(merged) &&
              (typeof issueDraftStableTokensOverlap_ === "function") && !issueDraftStableTokensOverlap_(merged, newDetail)
            ) {
              merged = newDetail;
              replacedUnrelatedDraft = true;
              try { logDevSms_(phone, "", "ISSUE_DRAFT_REPLACE reason=[unrelated_stable_tokens]"); } catch (_) {}
            } else if (
              newDetail.length >= 4 &&
              merged.toLowerCase().indexOf(newDetail.toLowerCase()) === -1
            ) {
              merged = merged + " | " + newDetail;
            }

            if (merged.length > 500) merged = merged.slice(0, 500);

            if (typeof normalizeIssueText_ === "function") {
              try { merged = normalizeIssueText_(merged); } catch (_) {}
            }
            if (merged !== existingIssue) {
              if (pendingRow <= 0 && typeof sessionUpsertNoLock_ === "function" && String(phone || "").indexOf("PORTAL_PM:") !== 0) {
                var sessBuf = (sessionOpt && sessionOpt.issueBuf) ? sessionOpt.issueBuf : ((typeof sessionGet_ === "function") ? (sessionGet_(phone) || {}).issueBuf : []);
                if (!Array.isArray(sessBuf)) sessBuf = [];
                if (replacedUnrelatedDraft) sessBuf = [];
                var firstItem = { rawText: newDetail.slice(0, 500), createdAt: now.toISOString(), sourceStage: st };
                if (parsedIssue && parsedIssue.details) firstItem.details = String(parsedIssue.details || "").trim().slice(0, 450);
                sessBuf.push(firstItem);
                if (parsedIssue && parsedIssue.clauses && parsedIssue.clauses.length >= 2) {
                  var mainTitle = String((parsedIssue && parsedIssue.title) ? parsedIssue.title : "").trim();
                  var seenTitles = {};
                  var primaryKey = issueTextKey_(newDetail);
                  if (primaryKey) seenTitles[primaryKey] = 1;
                  for (var mi = 0; mi < parsedIssue.clauses.length; mi++) {
                    var c = parsedIssue.clauses[mi];
                    if (!c || !c.title) continue;
                    var t2 = String(c.title || "").trim();
                    if (!t2) continue;
                    if (mainTitle && t2 === mainTitle) continue;
                    if (typeof isScheduleWindowLike_ === "function" && isScheduleWindowLike_(t2)) continue;
                    // Only append as separate item when type=problem (filter context/troubleshooting/emotion)
                    var ct = (typeof classifyIssueClauseType_ === "function") ? classifyIssueClauseType_(c.text || t2) : "";
                    if (ct !== "problem") continue;
                    var t2Key = issueTextKey_(t2);
                    if (!t2Key || seenTitles[t2Key]) continue;
                    seenTitles[t2Key] = 1;
                    sessBuf.push({ rawText: t2.slice(0, 500), createdAt: now.toISOString(), sourceStage: st });
                  }
                }
                if (sessBuf.length > 50) sessBuf = sessBuf.slice(-50);
                sessionUpsertNoLock_(phone, { draftIssue: merged, issueBufJson: JSON.stringify(sessBuf) }, "draftUpsertFromTurn_issue");
                didWriteIssue = true;
                try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[draftUpsertFromTurn_] val=[" + merged.slice(0, 40) + "] session=1"); } catch (_) {}
                try { logDevSms_(phone, bodyTrim, "DRAFT_UPSERT issue=[" + merged.slice(0, 60) + "] session=1"); } catch (_) {}
                // If we are still in DRAFT (no PendingRow yet), mirror issue into Directory.PendingIssue
                try {
                  var pr = dalGetPendingRow_(dir, dirRow);
                  if (pr < 2) {
                    dalSetPendingIssueNoLock_(dir, dirRow, merged);
                    dalSetLastUpdatedNoLock_(dir, dirRow);
                    try { logDevSms_(phone, (merged || "").slice(0, 40), "DIR_SET_ISSUE_FROM_DRAFT"); } catch (_) {}
                  }
                } catch (_) {}
              } else {
                dalSetPendingIssueNoLock_(dir, dirRow, merged);
                didWriteIssue = true;
                try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[draftUpsertFromTurn_] val=[" + merged.slice(0, 40) + "]"); } catch (_) {}
                try { logDevSms_(phone, bodyTrim, "DRAFT_UPSERT issue=[" + merged.slice(0, 60) + "]"); } catch (_) {}
              }
            }
            if (newDetail && (typeof appendIssueBufferItem_ === "function") && pendingRow > 0) {

              try {
                appendIssueBufferItem_(dir, dirRow, newDetail, st);
                if (parsedIssue && typeof getIssueBuffer_ === "function" && typeof setIssueBuffer_ === "function") {
                  var buf0 = getIssueBuffer_(dir, dirRow);
                  if (buf0 && buf0.length) {
                    var last = buf0[buf0.length - 1];
                    if (last && !last.details && parsedIssue.details) last.details = String(parsedIssue.details || "").trim();
                    if (last && !last.category && parsedIssue.category) last.category = String(parsedIssue.category || "").trim();
                    if (last && !last.subcategory && parsedIssue.subcategory) last.subcategory = String(parsedIssue.subcategory || "").trim();
                    if (last && !last.urgency && parsedIssue.urgency) last.urgency = String(parsedIssue.urgency || "").trim();
                    setIssueBuffer_(dir, dirRow, buf0);
                  }
                }
              } catch (_) {}

              if (parsedIssue && parsedIssue.clauses && parsedIssue.clauses.length >= 2) {
                var mainTitle = String((parsedIssue && parsedIssue.title) ? parsedIssue.title : "").trim();
                var seenTitles = {};
                var newDetailKey = issueTextKey_(newDetail);
                if (newDetailKey) seenTitles[newDetailKey] = 1;
                for (var mi = 0; mi < parsedIssue.clauses.length; mi++) {
                  var c = parsedIssue.clauses[mi];
                  if (!c || !c.title) continue;
                  var t2 = String(c.title || "").trim();
                  if (!t2) continue;
                  if (mainTitle && t2 === mainTitle) continue;
                  if (typeof isScheduleWindowLike_ === "function" && isScheduleWindowLike_(t2)) continue;
                  // Only append as separate item when type=problem (filter context/troubleshooting/emotion)
                  var ct = (typeof classifyIssueClauseType_ === "function") ? classifyIssueClauseType_(c.text || t2) : "";
                  if (ct !== "problem") continue;
                  var t2Key = issueTextKey_(t2);
                  if (!t2Key || seenTitles[t2Key]) continue;
                  seenTitles[t2Key] = 1;
                  try { appendIssueBufferItem_(dir, dirRow, t2, st); } catch (_) {}
                }
              }

            }
          }
        }
      }

      // 4) Schedule (ticket PREF_WINDOW) — write-if-empty when we have a ticket pointer
      // Phase 1: never persist full inbound messages into PreferredWindow/DRAFT_SCHEDULE_RAW.
      // Persist a normalized schedule label/phrase instead.
      var scheduleCandidateInput = "";
      var scheduleInputFromBody = false;
      if (
        turnFacts &&
        turnFacts.schedule &&
        turnFacts.schedule.raw &&
        (typeof isScheduleWindowLike_ === "function") &&
        isScheduleWindowLike_(turnFacts.schedule.raw)
      ) {
        scheduleCandidateInput = String(turnFacts.schedule.raw || "").trim();
      }

      var scheduleCandidateRaw = "";
      var scheduleParseSource = "";
      if (scheduleCandidateInput) {
        if (typeof parsePreferredWindowShared_ === "function") {
          try {
            var _schedParsedPre = parsePreferredWindowShared_(scheduleCandidateInput, null);
            if (_schedParsedPre && _schedParsedPre.label) {
              scheduleCandidateRaw = String(_schedParsedPre.label || "").trim();
              scheduleParseSource = "parsed_label";
            }
          } catch (_) {}
        }

        // If parsing failed on a full inbound message, do NOT persist the whole message.
        if (!scheduleCandidateRaw && !scheduleInputFromBody) {
          scheduleCandidateRaw = scheduleCandidateInput;
          scheduleParseSource = "raw_schedule_phrase";
        }
      }

      if (scheduleCandidateRaw) {
        const pendingRowSched = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0;
        if (pendingRowSched >= 2 && typeof COL !== "undefined") {
          try {
            const sheetSched = getLogSheet_();
            if (sheetSched && pendingRowSched <= sheetSched.getLastRow()) {
              const existingWindow = String(sheetSched.getRange(pendingRowSched, COL.PREF_WINDOW).getValue() || "").trim();
              if (!existingWindow) {
                withWriteLock_("DRAFT_UPSERT_SCHEDULE", () => {
                  sheetSched.getRange(pendingRowSched, COL.PREF_WINDOW).setValue(scheduleCandidateRaw);
                  sheetSched.getRange(pendingRowSched, COL.LAST_UPDATE).setValue(now);
                });
                try {
                  logDevSms_(
                    phone,
                    scheduleCandidateRaw,
                    "PREFERRED_WINDOW_WRITE source=[" + String(scheduleParseSource || "").trim() + "] label=[" + String(scheduleCandidateRaw || "").slice(0, 80) + "]"
                  );
                } catch (_) {}
              }
            }
          } catch (_) {}
        } else if (pendingRowSched < 2 && typeof DIR_COL !== "undefined") {
          try {
            const draftCol = DIR_COL.DRAFT_SCHEDULE_RAW;
            const existingDraft = String(dir.getRange(dirRow, draftCol).getValue() || "").trim();
            if (!existingDraft) {
              dir.getRange(dirRow, draftCol).setValue(scheduleCandidateRaw);
              try {
                logDevSms_(
                  phone,
                  scheduleCandidateRaw,
                  "PREFERRED_WINDOW_WRITE source=[" + String(scheduleParseSource || "").trim() + "] label=[" + String(scheduleCandidateRaw || "").slice(0, 80) + "]"
                );
              } catch (_) {}
            }
          } catch (_) {}
        } else {
          try { logDevSms_(phone, bodyTrim, "DRAFT_UPSERT schedule_ignored_no_ptr raw=[" + scheduleCandidateRaw.slice(0, 40) + "]"); } catch (_) {}
        }
      }

      try {
        if (typeof logDevSms_ === "function") {
          var _capUnit = String((turnFacts && turnFacts.unit) || "").trim();
          var _capSched = String((turnFacts && turnFacts.schedule && turnFacts.schedule.raw) || "").trim();
          var _capIssue = !!String((turnFacts && turnFacts.issue) || "").trim();
          if (_capUnit || _capSched || _capIssue) {
            logDevSms_(
              phone,
              "",
              "CROSS_SLOT_CAPTURE stage=[" + String(st || "").trim().toUpperCase() + "] unit=[" + _capUnit + "] sched=[" + _capSched.slice(0, 60) + "] issueAdded=[" + (_capIssue ? "1" : "0") + "]"
            );
          }
        }
      } catch (_) {}

      dalSetLastUpdatedNoLock_(dir, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE DRAFT_UPSERT row=" + dirRow); } catch (_) {}

      // Persist emergency facts to ctx so resolver/recompute can skip SCHEDULE
      if (turnFacts && turnFacts.safety && turnFacts.safety.isEmergency) {
        try {
          if (typeof ctxUpsert_ === "function") {
            ctxUpsert_(phone, {
              flowMode: "EMERGENCY",
              emergencyKind: String(turnFacts.safety.emergencyType || "EMERGENCY").trim(),
              pendingExpected: (typeof ctxGet_ === "function" && ctxGet_(phone)) ? ctxGet_(phone).pendingExpected : "",
              pendingExpiresAt: (typeof ctxGet_ === "function" && ctxGet_(phone)) ? ctxGet_(phone).pendingExpiresAt : ""
            }, "DRAFT_EMERGENCY_UPSERT");
          }
          try { logDevSms_(phone, "", "DRAFT_EMERGENCY_UPSERT emergency=1 type=[" + String(turnFacts.safety.emergencyType || "").trim() + "]"); } catch (_) {}
        } catch (_) {}
      }
    });

    // Persist canonical split preview durably (issue-atoms → ticket-group preview).
    try {
      if (Array.isArray(previewAtomsFromThisTurn) && previewAtomsFromThisTurn.length) {
        properaCanonicalSplitPreviewUpsert_(phone, previewAtomsFromThisTurn, previewAtomsSourceTag, "DRAFT_UPSERT_SPLIT_PREVIEW");
      }
    } catch (_) {}

    return didWriteIssue;
  } catch (err) {
    try { logDevSms_(phone, bodyTrim, "DRAFT_UPSERT_ERR " + String(err && err.message ? err.message : err)); } catch (_) {}
    return false;
  }
}

