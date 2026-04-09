/**
 * MESSAGING_ENGINE.gs — Propera Layer 10 (Messaging + Emergency signals)
 *
 * OWNS:
 *   - DevSms buffer (logDevSms_, flushDevSmsLogs_), SIM_MODE helpers, chaos timeline writers
 *   - Rule-based emergency evaluation (hardEmergency_, evaluateEmergencySignal_)
 *   - Urgent (non-emergency) signals, local category hints, LLM classify_
 *   - M8 template rendering (renderTenantKey_, tenantMsgSafe_, compliance/welcome)
 *   - Global reply helpers and Twilio SMS/WhatsApp send (sendSms_, sendWhatsApp_)
 *   - Twilio voice placeCall_ (on-call / emergency audio)
 *   - detectEmergencyKind_ — shared keyword detector for emergency typing
 *
 * DOES NOT OWN (never add these here):
 *   - Lifecycle authority, resolver routing, or ticket creation policy
 *
 * ENTRY POINTS:
 *   - renderTenantKey_(key, lang, vars, opts) — tenant-visible template body
 *   - sendSms_ / sendWhatsApp_ — transport send with opt-out enforcement
 *   - evaluateEmergencySignal_(text, opts) — deterministic emergency structure
 *   - logDevSms_ / flushDevSmsLogs_ — observability (sheet-backed dev log)
 *
 * DEPENDENCIES (reads from):
 *   - DIRECTORY_SESSION_DAL.gs — tenantMsg_, withWelcome_
 *   - PROPERA MAIN.gs — phoneKey_, isDevSendMode_, COL, DEV_MODE, LOG_SHEET_ID, isSmsOptedOut_, etc.
 *   - AI_MEDIA_TRANSPORT — openaiChatJson_ for classify_
 *
 * FUTURE MIGRATION NOTE:
 *   - Notification service + emergency classifier service; templates remain data-driven
 *
 * SECTIONS IN THIS FILE:
 *   0. Dev observability (DevSms buffer, SIM, chaos timeline) + emergency voice call
 *   1. Emergency rules + evaluation + classification
 *   2. M8 template rendering and reply builders
 *   3. Twilio SMS / WhatsApp
 *   4. detectEmergencyKind_ (keyword detector)
 */

  // ─────────────────────────────────────────────────────────────────
  // DEV OBSERVABILITY — DevSms buffer, SIM gates, chaos timeline, voice call
  // ─────────────────────────────────────────────────────────────────

  // ---- DEV LOG BUFFER ----
  var DEVLOG_BUF_ = [];
  var DEVLOG_MAX_ = 500; // safety cap per execution
  var SIM_PHONE_SCOPE_ = "";

  // ---- Chaos Timeline (execution-scoped) ----
  if (typeof globalThis.__chaos === "undefined") {
    globalThis.__chaos = {
      enabled: false,
      verbose: false,
      view: "CORE",
      runId: "",
      testId: "",
      step: 0,
      phone: "",
      sid: "",
      started: false
    };
  }
  /** Request-scoped outbox for DEV_MODE: doPost sets to [], sendSms_ pushes; doPost returns last as TwiML <Message>. */
  var TWIML_OUTBOX_ = null;
  /** Set by doPost for the request; sendSms_ calls when DEV_MODE to mirror outbound message into TwiML. */
  var DEV_EMIT_TWIML_ = null;

  function logDevSms_(to, msg, status, extra) {
    try {
      // When chaos is on and not verbose, suppress most logs but ALWAYS keep entry/deny/crash so we're not blind
      if (globalThis.__chaos && globalThis.__chaos.enabled && !globalThis.__chaos.verbose) {
        var s = String(status || "");
        var critical = s.indexOf("DOPOST_HIT") === 0 || s.indexOf("WEBHOOK_") === 0 || s.indexOf("ROUTER_CRASH") === 0 || s.indexOf("DEVLOG_FLUSH") === 0;
        if (!critical) return;
      }
      if (DEVLOG_BUF_.length >= DEVLOG_MAX_) return;

      DEVLOG_BUF_.push([
        new Date(),
        String(to || ""),
        String(msg || ""),
        String(status || ""),
        String(extra || "")
      ]);
    } catch (_) {}
  }

  function logTurnSummary_(phone, eid, lane, mode, stateType, effectiveStage, pendingRow, pendingExpected, replyKey) {
    try {
      logDevSms_(phone, "", "TURN_SUMMARY eid=[" + eid + "] lane=[" + lane + "] mode=[" + mode + "] state=[" + stateType + "] stage=[" + effectiveStage + "] pendingRow=[" + pendingRow + "] expected=[" + pendingExpected + "] replyKey=[" + replyKey + "]");
    } catch (_) {}
  }

  function logStageDecision_(phone, eid, prevStage, nextStage, reason) {
    try {
      if (!prevStage) prevStage = "";
      if (!nextStage) nextStage = "";
      if (String(prevStage).toUpperCase() === String(nextStage).toUpperCase()) return;
      logDevSms_(phone, "", "STAGE_DECISION eid=[" + eid + "] prev=[" + prevStage + "] next=[" + nextStage + "] reason=[" + (reason || "") + "]");
    } catch (_) {}
  }

  function logInvariantFail_(phone, eid, invId, detail) {
    try {
      logDevSms_(phone, "", "INVARIANT_FAIL eid=[" + eid + "] inv=[" + invId + "] detail=[" + (detail || "") + "]");
    } catch (_) {}
  }

  function safeTrunc_(s, n) {
    try { var t = String(s != null ? s : ""); if (n == null || n <= 0) return t; return t.length <= n ? t : t.slice(0, n); } catch (_) { return ""; }
  }

  function getChaosTimelineSheet_() {
    try {
      var props = PropertiesService.getScriptProperties();
      var id = String(props.getProperty("LOG_SHEET_ID") || "").trim();

      // Fallback: allow existing global if you already set it somewhere
      if (!id && typeof LOG_SHEET_ID !== "undefined") id = String(LOG_SHEET_ID || "").trim();
      if (!id) return null;

      var ss = SpreadsheetApp.openById(id);
      var sh = ss.getSheetByName("ChaosTimeline");
      if (!sh) sh = ss.insertSheet("ChaosTimeline");

      if (sh.getLastRow() < 1) {
        sh.getRange(1, 1, 1, 14).setValues([[
          "ts","runId","testId","step","phase","phone","sid","lane","effectiveStage",
          "replyKey","tag","msg","kv","json"
        ]]);
      }
      return sh;
    } catch (err) {
      return null;
    }
  }

  var CHAOS_PHASES_IO_ = ["TEST_START", "IN", "OUT", "SNAP", "TEST_END", "ERROR"];
  var CHAOS_PHASES_CORE_ = CHAOS_PHASES_IO_.concat(["LANE", "TURN", "DRAFT", "STATE", "HANDLER", "SOP_SHADOW"]);
  var CHAOS_PHASES_FULL_ = CHAOS_PHASES_CORE_.concat(["SNAP_DIR", "SNAP_CTX", "SNAP_DRAFT", "SNAP_WI"]);

  function writeTimeline_(phase, kvObj, jsonObj) {
    try {
      var c = globalThis.__chaos;
      if (!c || !c.enabled) return;
      var view = String(c.view || "CORE").toUpperCase();
      var allowed = view === "IO" ? CHAOS_PHASES_IO_ : (view === "FULL" ? CHAOS_PHASES_FULL_ : CHAOS_PHASES_CORE_);
      if (allowed.indexOf(phase) === -1) return;
      c.step = (c.step || 0) + 1;
      var kvParts = [];
      if (kvObj && typeof kvObj === "object") { for (var k in kvObj) { if (kvObj[k] == null || kvObj[k] === "") continue; kvParts.push(k + "=" + safeTrunc_(kvObj[k], 120)); } }
      var kvStr = safeTrunc_(kvParts.join(" "), 600);
      var jsonStr = ""; if (jsonObj != null) try { jsonStr = safeTrunc_(JSON.stringify(jsonObj), 1500); } catch (_) {}
      var lane = (kvObj && kvObj.lane != null) ? String(kvObj.lane) : "";
      var effectiveStage = (kvObj && kvObj.effectiveStage != null) ? String(kvObj.effectiveStage) : "";
      var replyKey = (kvObj && kvObj.replyKey != null) ? String(kvObj.replyKey) : "";
      var tag = (kvObj && kvObj.tag != null) ? String(kvObj.tag) : "";
      var msg = (kvObj && kvObj.msg != null) ? safeTrunc_(kvObj.msg, 300) : "";
      var sh = getChaosTimelineSheet_();
      if (!sh) return;
      sh.appendRow([new Date().toISOString(), c.runId || "", c.testId || "", c.step || 0, phase, c.phone || "", c.sid || "", lane, effectiveStage, replyKey, tag, msg, kvStr, jsonStr]);
    } catch (_) {}
  }

  function chaosInit_(e, phone, sid) {
    try {
      var p = (e && e.parameter) ? e.parameter : {};
      var chaosMode = String(p.CHAOS_MODE || "").trim();
      var chaosVerbose = String(p.CHAOS_VERBOSE || "").trim();
      var chaosView = String(p.CHAOS_VIEW || "").trim().toUpperCase();
      var runId = String(p.runId || "").trim();
      var testId = String(p.testId || "").trim();
      if (!globalThis.__chaos) globalThis.__chaos = { enabled: false, verbose: false, view: "CORE", runId: "", testId: "", step: 0, phone: "", sid: "", started: false };
      var c = globalThis.__chaos;
      c.enabled = (chaosMode === "1") || (runId !== "" || testId !== "");
      c.verbose = (chaosVerbose === "1");
      c.view = (chaosView === "IO" || chaosView === "FULL") ? chaosView : "CORE";
      if (!runId) runId = "RUN_" + new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 15);
      if (!testId) testId = "T00";
      c.runId = runId; c.testId = testId; c.phone = String(phone || "").trim(); c.sid = String(sid || "").trim(); c.step = 0;
      if (c.enabled && !c.started) { c.started = true; writeTimeline_("TEST_START", { msg: "", result: "" }, { meta: { runId: c.runId, testId: c.testId } }); }
    } catch (_) {}
  }

  function snapDir_(dir, dirRow) {
    try {
      if (!dir || !dirRow || dirRow < 2) return {};
      var pendingRow = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0;
      var pendingStage = String(dir.getRange(dirRow, 8).getValue() || "").trim();
      var out = { dirRow: dirRow, pendingRow: pendingRow, pendingStage: pendingStage };
      if (pendingRow >= 2 && typeof COL !== "undefined" && typeof getLogSheet_ === "function") {
        try { var sheet = getLogSheet_(); if (sheet && pendingRow <= sheet.getLastRow()) out.activeTicketId = String(sheet.getRange(pendingRow, COL.TICKET_ID).getValue() || "").trim(); } catch (_) {}
      }
      return out;
    } catch (_) { return {}; }
  }

  function snapCtx_(ctx) {
    try {
      if (!ctx) return {};
      return { pendingExpected: String(ctx.pendingExpected || "").trim(), pendingExpiresAt: ctx.pendingExpiresAt != null ? String(ctx.pendingExpiresAt) : "", lang: String(ctx.lang || "en").trim(), activeWorkItemId: String(ctx.activeWorkItemId || "").trim() };
    } catch (_) { return {}; }
  }

  function snapDraft_(dir, dirRow) {
    try {
      if (!dir || !dirRow || dirRow < 2) return {};
      var issue = String(dir.getRange(dirRow, 5).getValue() || "").trim();
      var property = String(dir.getRange(dirRow, 2).getValue() || "").trim();
      var unit = String(dir.getRange(dirRow, 6).getValue() || "").trim();
      var pendingRow = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0;
      var hasSchedule = false, schedule = "";
      if (pendingRow >= 2 && typeof getLogSheet_ === "function" && typeof COL !== "undefined") {
        try { var sheet = getLogSheet_(); if (sheet && pendingRow <= sheet.getLastRow()) { schedule = String(sheet.getRange(pendingRow, COL.PREF_WINDOW).getValue() || "").trim(); hasSchedule = schedule.length > 0; } } catch (_) {}
      }
      var issueCount = 0; if (typeof getIssueBuffer_ === "function") try { issueCount = (getIssueBuffer_(dir, dirRow) || []).length; } catch (_) {}
      return { draftId: dirRow, issueCount: issueCount, hasIssue: issue.length > 0, property: property, unit: unit, hasSchedule: hasSchedule, schedule: safeTrunc_(schedule, 80) };
    } catch (_) { return {}; }
  }

  function snapWi_(wi) {
    try {
      if (!wi || typeof wi !== "object") return {};
      return { workItemId: String(wi.workItemId || wi.id || "").trim(), type: String(wi.type || "").trim(), status: String(wi.status || "").trim(), state: String(wi.state || wi.stage || wi.substate || "").trim(), assignedTo: String(wi.assignedTo || "").trim() };
    } catch (_) { return {}; }
  }

  function simEnabled_() {
    try {
      const v = PropertiesService.getScriptProperties().getProperty("SIM_MODE");
      return (v === "true" || v === "1" || String(v || "").toLowerCase() === "true");
    } catch (_) { return false; }
  }

  function simKilled_() {
    try {
      const v = String(PropertiesService.getScriptProperties().getProperty("SIM_KILL") || "").trim().toLowerCase();
      return (v === "true" || v === "1");
    } catch (_) { return false; }
  }

  function isSimAllowedPhone_(from) {
    try {
      const raw = String(PropertiesService.getScriptProperties().getProperty("SIM_ALLOW_PHONES") || "").trim();
      if (!raw || !from) return false;
      const list = raw.split(/[\s,]+/).map(function (s) { return (typeof phoneKey_ === "function") ? phoneKey_(s.trim()) : s.trim(); }).filter(Boolean);
      const fromKey = (typeof phoneKey_ === "function") ? phoneKey_(from) : String(from || "").trim();
      for (var i = 0; i < list.length; i++) {
        if (list[i] === fromKey) return true;
      }
      return false;
    } catch (_) { return false; }
  }

  function simReadLastOutboundFromLog_(phone) {
    try {
      const tabName = simEnabled_() ? "DevSmsLog_SIM" : "DevSmsLog";
      const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
      const sh = ss.getSheetByName(tabName);
      if (!sh || sh.getLastRow() < 2) return { found: false };

      const lastRow = sh.getLastRow();
      const startRow = Math.max(2, lastRow - 399);
      const rows = sh.getRange(startRow, 1, lastRow, 5).getValues();
      const phoneNorm = (typeof phoneKey_ === "function") ? phoneKey_(phone) : String(phone || "").trim();

      for (let i = rows.length - 1; i >= 0; i--) {
        const toCol = String(rows[i][1] || "").trim();
        const toNorm = (typeof phoneKey_ === "function") ? phoneKey_(toCol) : toCol;
        if (toNorm !== phoneNorm) continue;

        const status = String(rows[i][3] || "").trim();
        const isOutbound = (status.indexOf("OUT_SMS") >= 0 || status === "LIVE_ATTEMPT" || status === "DEV_MODE");
        if (!isOutbound) continue;

        const ts = rows[i][0];
        const iso = (ts instanceof Date) ? ts.toISOString() : String(ts || "");
        return {
          found: true,
          ts: iso,
          message: String(rows[i][2] || "").trim(),
          status: status,
          extra: String(rows[i][4] || "").trim()
        };
      }
      return { found: false };
    } catch (_) {
      return { found: false };
    }
  }

  // Flush once per webhook
  function flushDevSmsLogs_() {
    try {
      if (!DEVLOG_BUF_ || !DEVLOG_BUF_.length) return;

      const rows = DEVLOG_BUF_; // keep until successful write
      const tabName = simEnabled_() ? "DevSmsLog_SIM" : "DevSmsLog";
      try { Logger.log("DEVLOG_FLUSH_ENTER len=" + rows.length + " tab=" + tabName + " simEnabled=" + simEnabled_()); } catch (_) {}

      // 1) use LOG_SHEET_ID if set
      // 2) else fall back to active spreadsheet (emulator / missing config)
      let ss = null;
      const id = String(typeof LOG_SHEET_ID !== "undefined" ? LOG_SHEET_ID : "").trim();
      if (id) {
        try { ss = SpreadsheetApp.openById(id); } catch (openErr) {
          try { Logger.log("DEVLOG_FLUSH_ERR openById: " + (openErr && openErr.message ? openErr.message : openErr)); } catch (_) {}
        }
      }
      if (!ss) {
        if (!id) try { Logger.log("DEVLOG_FLUSH: LOG_SHEET_ID is empty; using getActiveSpreadsheet()"); } catch (_) {}
        try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (_) {}
      }
      if (!ss) {
        try { Logger.log("DEVLOG_FLUSH_ERR: no spreadsheet available. Buffer retained len=" + rows.length); } catch (_) {}
        return;
      }
      try { Logger.log("DEVLOG_FLUSH_TARGET ssId=" + ss.getId() + " tab=" + tabName); } catch (_) {}
      let sh = ss.getSheetByName(tabName);
      if (!sh) {
        sh = ss.insertSheet(tabName);
        sh.appendRow(["TS", "To", "Message", "Status", "Extra"]);
      }
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
      DEVLOG_BUF_ = []; // clear only after successful write
      try { Logger.log("DEVLOG_FLUSH_OK wrote=" + rows.length + " tab=" + tabName); } catch (_) {}
    } catch (err) {
      try { Logger.log("DEVLOG_FLUSH_ERR: " + (err && err.stack ? err.stack : err)); } catch (_) {}
    }
  }

  /****************************
  * Twilio VOICE CALL (Emergency)
  ****************************/
  function placeCall_(sid, token, fromNumber, toNumber, messageToSay) {
    if (DEV_MODE) {
      Logger.log("DEV MODE CALL -> " + toNumber + ": " + messageToSay);
      return;
    }

    if (!sid || !token || !fromNumber) {
      throw new Error("Missing Twilio credentials in Script Properties.");
    }
    if (!toNumber) return;

    // Twimlets "message" reads a spoken message when you answer
    const twimlUrl =
      "https://twimlets.com/message?Message%5B0%5D=" +
      encodeURIComponent(String(messageToSay || "").slice(0, 800));

    const url = "https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Calls.json";
    const payload = {
      From: fromNumber,
      To: toNumber,
      Url: twimlUrl
    };

    const options = {
      method: "post",
      payload,
      headers: { Authorization: "Basic " + Utilities.base64Encode(sid + ":" + token) },
      muteHttpExceptions: true
    };

    const res = UrlFetchApp.fetch(url, options);
    Logger.log("Call API status: " + res.getResponseCode());
  }

  /****************************
  * Emergency rules (rules beat AI) — Compass-aligned
  * NOTE:
  * - No tenant-facing copy here. Only structured signals.
  * - Any tenant messages should be produced by buildTenantReply_/templates.
  ****************************/
  function hardEmergency_(message) {
    const t = String(message || "").toLowerCase();

    // -----------------------------
    // 0) DETECTOR/ALARM MAINTENANCE FALSE-POSITIVE GUARD
    // Battery/chirping/beeping/replacement without active danger => not emergency
    // -----------------------------
    const detectorMaintenanceContext =
      /\b(battery|chirping|beeping|replacement|needs replacement|replace battery|low battery|dead battery|battery (low|dead|replacement))\b/.test(t) &&
      /\b(detector|alarm)\b/.test(t);

    const activeDanger =
      /\b(smell(s|ing)?\s*smoke|smoke\s+(coming|in the|everywhere|full of)|apartment\s+(full of\s+)?smoke|active\s+smoke|flames?|on fire|burning|gas\s+smell|smell(s|ing)?\s+gas|carbon\s+monoxide\s+leak|smoke\s+coming\s+from)\b/.test(t) ||
      /\b(going\s+off|alarm\s+going\s+off)\b.*\b(smoke|dizzy|sick|symptoms|feel\s+(dizzy|sick|ill)|faint)\b/.test(t) ||
      /\b(smoke|dizzy|sick|symptoms)\b.*\b(going\s+off|alarm\s+going\s+off)\b/.test(t);

    if (detectorMaintenanceContext && !activeDanger) {
      return { emergency: false, reason: "detector_maintenance_guard" };
    }

    // -----------------------------
    // 1) GAS / CO / FIRE / SMOKE (active danger or non-maintenance context)
    // -----------------------------
    const hasCO =
      /\bcarbon monoxide\b/.test(t) ||
      /\bco alarm\b/.test(t) ||
      /\bco detector\b/.test(t) ||
      /\bcarbon monoxide alarm\b/.test(t);

    const hasGasSmellOrLeak =
      /\bsmell(s|ing)?\s+gas\b/.test(t) ||
      /\bgas smell\b/.test(t) ||
      /\bgas leak\b/.test(t) ||
      /\bleaking gas\b/.test(t);

    const hasSmokeOrFire =
      /\bsmoke\b/.test(t) ||
      /\bsmoke alarm\b/.test(t) ||
      /\bsmoke detector\b/.test(t) ||
      /\bfire\b/.test(t) ||
      /\bon fire\b/.test(t) ||
      /\boven\s*(is\s*)?on fire\b/.test(t) ||
      /\bflames?\b/.test(t) ||
      /\bsmolder(ing)?\b/.test(t);

    if (hasCO || hasGasSmellOrLeak || hasSmokeOrFire) {
      return {
        emergency: true,
        category: "Safety",
        emergencyType: "Gas / CO / Smoke / Fire",
        confidence: 95,
        safetyNoteKey: "SAFETY_GAS_CO_FIRE",
        nextQuestionsKeys: ["Q_SAFE_NOW", "Q_ANYONE_INJURED", "Q_UNIT_NUMBER"]
      };
    }

    // -----------------------------
    // 2) PLUMBING FLOODING / CEILING LEAK
    // -----------------------------
    const floodingEmergency =
      // Strong signals
      /\bflood(ing)?\b/.test(t) ||
      /\bwater (everywhere|all over)\b/.test(t) ||
      /\b(rain(ing)?|waterfall)\b.*\binside\b/.test(t) ||
      /\bwater coming in\b/.test(t) ||
      /\bwater\s*pouring\b|\bpouring\s*water\b/.test(t) ||
      (/\bwater intrusion\b/.test(t) && /\b(ceiling|wall|walls|window|roof)\b/.test(t)) ||

      // Burst pipe (either order)
      /\bpipe\s*burst\b|\bburst\s*pipe\b/.test(t) ||
      /\bwater\s*pipe\s*burst\b|\bburst\s*(pipe|line|hose)\b/.test(t) ||
      /\bburst\b.*\b(pipe|line|hose)?\b/.test(t) ||
      /\b(gushing|pouring|spraying|shooting)\b/.test(t) ||

      // Ceiling leak patterns
      /\bceiling\b.*\b(leak(ing)?|drip(ping)?|water)\b/.test(t) ||
      /\bwater\b.*\b(through|from)\b.*\bceiling\b/.test(t) ||

      // “major/severe/active leak”
      (
        /\b(leak|leaking)\b/.test(t) &&
        (
          /\b(major|severe|serious|heavy|bad)\b/.test(t) ||
          /\bactive\b/.test(t) ||
          (/\bwater\b.*\b(leak|leaking)\b/.test(t) && /\b(major|severe|serious|heavy|bad)\b/.test(t))
        )
      ) ||

      // “water is running” / “won’t stop”
      (
        /\bwater\b/.test(t) &&
        (
          /\b(running|won't stop|wont stop|nonstop|can't stop|cant stop)\b/.test(t) ||
          /\b(overflow(ing)?|backing up)\b/.test(t)
        )
      );

    if (floodingEmergency) {
      return {
        emergency: true,
        category: "Plumbing",
        emergencyType: "Active Flooding / Ceiling Leak",
        confidence: 95,
        safetyNoteKey: "SAFETY_FLOODING",
        nextQuestionsKeys: ["Q_WATER_RUNNING", "Q_SOURCE_LOCATION", "Q_CAN_SHUTOFF_WATER"]
      };
    }

    // -----------------------------
    // 3) ELECTRICAL HAZARD
    // -----------------------------
    const electricalDanger =
      /\bsparks?\b/.test(t) ||
      /\boutlet\b.*\b(smok(e|ing)|on fire|burn(ing)?)\b/.test(t) ||
      /\b(outlet|switch|breaker|panel|wiring)\b.*\b(burning smell|electrical smell)\b/.test(t) ||
      /\b(outlet|switch)\b.*\b(smoking|sparking)\b/.test(t);

    if (electricalDanger) {
      return {
        emergency: true,
        category: "Electrical",
        emergencyType: "Electrical Hazard",
        confidence: 95,
        safetyNoteKey: "SAFETY_ELECTRICAL",
        nextQuestionsKeys: ["Q_SMOKE_OR_SPARKS", "Q_CAN_SHUTOFF_BREAKER", "Q_UNIT_NUMBER"]
      };
    }

    // -----------------------------
    // 4) SEWAGE BACKUP
    // -----------------------------
    const sewageEmergency =
      /\bsewage\b/.test(t) ||
      /\bsewer\b/.test(t) ||
      /\bwaste\s*water\b/.test(t) ||
      (/\bback(ing)?\s*up\b/.test(t) && /\b(toilet|drain|tub|shower|sink)\b/.test(t)) ||
      /\btoilet overflow(ing)?\b/.test(t);

    if (sewageEmergency) {
      return {
        emergency: true,
        category: "Plumbing",
        emergencyType: "Sewage Backup",
        confidence: 95,
        safetyNoteKey: "SAFETY_SEWAGE",
        nextQuestionsKeys: ["Q_WASTEWATER_OVERFLOWING", "Q_WHICH_FIXTURE", "Q_UNIT_NUMBER"]
      };
    }

    return { emergency: false };
  }

  /**
  * Shared safety evaluation (SMS + Portal). Rule-based only.
  * Returns deterministic object for compileTurn_/resolver/finalize.
  * Logs: EMERGENCY_EVAL, EMERGENCY_EVAL_HIT, EMERGENCY_EVAL_NONE.
  */
  function evaluateEmergencySignal_(text, opts) {
    opts = opts || {};
    var t = String(text || "").trim();
    try { logDevSms_(opts.phone || "", t.slice(0, 60), "EMERGENCY_EVAL text=[" + t.slice(0, 80) + "]"); } catch (_) {}
    var hard = hardEmergency_(t);

    if (hard && hard.reason === "detector_maintenance_guard") {
      try { logDevSms_(opts.phone || "", "", "EMERGENCY_FALSE_POSITIVE_GUARD hit=[detector_maintenance]"); } catch (_) {}
      return {
        isEmergency: false,
        emergencyType: "",
        category: "",
        urgency: "",
        requiresImmediateInstructions: false,
        skipScheduling: false,
        reason: "detector_maintenance_guard"
      };
    }

    if (hard && hard.emergency) {
      var hadDetectorContext = /\b(detector|alarm)\b/.test(t.toLowerCase());
      if (hadDetectorContext) {
        try { logDevSms_(opts.phone || "", "", "EMERGENCY_ACTIVE_DANGER_OVERRIDE"); } catch (_) {}
      }
      var emType = (detectEmergencyKind_(t) || (hard.emergencyType || "").split("/")[0] || "SAFETY").trim().toUpperCase().replace(/\s+/g, "_").slice(0, 20);
      if (!emType) emType = "EMERGENCY";
      try { logDevSms_(opts.phone || "", "", "EMERGENCY_EVAL_HIT type=[" + emType + "] reason=[" + (hard.safetyNoteKey || "hard") + "]"); } catch (_) {}
      return {
        isEmergency: true,
        emergencyType: emType,
        category: String(hard.category || "").trim(),
        urgency: "emergency",
        requiresImmediateInstructions: true,
        skipScheduling: true,
        reason: hard.safetyNoteKey || "hard_emergency"
      };
    }

    var kind = detectEmergencyKind_(t);
    if (kind) {
      var detectorMaint = /\b(battery|chirping|beeping|replacement|needs replacement|replace battery|low battery)\b/.test(t.toLowerCase()) && /\b(detector|alarm)\b/.test(t.toLowerCase());
      if (detectorMaint) {
        try { logDevSms_(opts.phone || "", "", "EMERGENCY_FALSE_POSITIVE_GUARD hit=[detector_maintenance] detectKind_suppressed"); } catch (_) {}
        return {
          isEmergency: false,
          emergencyType: "",
          category: "",
          urgency: "",
          requiresImmediateInstructions: false,
          skipScheduling: false,
          reason: "detector_maintenance_guard"
        };
      }
      try { logDevSms_(opts.phone || "", "", "EMERGENCY_EVAL_HIT type=[" + kind + "] reason=detectKind"); } catch (_) {}
      return {
        isEmergency: true,
        emergencyType: String(kind).trim().toUpperCase(),
        category: "Safety",
        urgency: "emergency",
        requiresImmediateInstructions: true,
        skipScheduling: true,
        reason: "detectEmergencyKind"
      };
    }
    try { logDevSms_(opts.phone || "", "", "EMERGENCY_EVAL_NONE"); } catch (_) {}
    return {
      isEmergency: false,
      emergencyType: "",
      category: "",
      urgency: "",
      requiresImmediateInstructions: false,
      skipScheduling: false,
      reason: ""
    };
  }

  /**
  * Urgent (not necessarily emergency) signals.
  * Structured only; buildTenantReply_ decides what to say.
  */
  function urgentSignals_(message) {
    const t = String(message || "").toLowerCase();

    const patterns = [
      { re: /\bleak(ing)?\b|\bdrip(ping)?\b|\bwater under\b|\bwater coming from\b/, reason: "Active leak / water intrusion" },
      { re: /\btoilet\b.*\b(clog|blocked|won't flush|overflow|back up|backing up)\b/, reason: "Toilet not working / possible backup" },
      { re: /\bno heat\b|\bheater( is)? not\b|\bfurnace\b.*\bnot\b|\bheat not working\b/, reason: "No heat" },
      { re: /\bno hot water\b|\bhot water\b.*\bnot\b/, reason: "No hot water" },
      { re: /\bpower\b.*\bout\b|\bno power\b|\bwhole apartment\b.*\b(no power|out)\b/, reason: "Power outage" },
      { re: /\bbreaker\b.*\btrip(ped)?\b|\boutlet\b.*\bnot working\b/, reason: "Electrical issue affecting service" },
      { re: /\bdoor\b.*\b(won't lock|doesn't lock|can't lock)\b|\block\b.*\b(broken|jammed)\b/, reason: "Security concern (door/lock)" },
      { re: /\b(major|bad|severe)\b.*\bmold\b|\bmold\b.*\bspreading\b/, reason: "Potential mold escalation" },
      { re: /\bfridge\b.*\b(not working|warm)\b|\bfreezer\b.*\b(not working|warm)\b/, reason: "Food safety (refrigeration down)" }
    ];

    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].re.test(t)) {
        return { urgent: true, reason: patterns[i].reason, confidence: 80 };
      }
    }

    if (t.includes("asap") || t.includes("urgent") || t.includes("immediately")) {
      return { urgent: true, reason: "Tenant requested ASAP", confidence: 60 };
    }

    return { urgent: false, reason: "", confidence: 0 };
  }



  /****************************
  * Classification (OpenAI)
  ****************************/

  function localCategoryFromText_(message) {
    const t = String(message || "").toLowerCase();

    // SAFETY / EMERGENCY-ish keywords
    if (/(gas smell|smell gas|carbon monoxide|co alarm|smoke|fire|sparks|arcing|electrical arc|flooding|sewage|backing up|overflowing)/.test(t)) {
      return "Safety";
    }

    // ELECTRICAL (your exact complaint)
    if (/(outlet|outlets|no power|power out|lost power|breaker|tripped|panel|electric|electrical|gfci|reset button|flicker|flickering|short|burning smell|switch not working|lights? (out|not working)|receptacle)/.test(t)) {
      return "Electrical";
    }

    // Lighting (add before Electrical/HVAC or right after Electrical)
    if (/(light|lights|lamp|fixture|bulb|ballast|sconce|cover)/.test(t)) {
      return "Electrical";
    }

    // PLUMBING
    if (/(leak|leaking|pipe|faucet|toilet|clog|clogged|drain|sewer|water pressure|no water|hot water|cold water|sink|tub|shower|backed up)/.test(t)) {
      return "Plumbing";
    }

    // APPLIANCE (check before HVAC to avoid "cooling" false-positives in refrigerator/freezer complaints)
    if (/(washing machine|wash machine|washer|dryer|laundry|dishwasher|fridge|refrigerator|freezer|oven|stove|range|microwave|garbage disposal|disposal)/.test(t)) {
      return "Appliance";
    }

    // HVAC: vent/temperature signals (avoid generic "cooling" which is ambiguous)
    if (/(heat|heating|no heat|\bac\b|a\/c|air conditioner|air conditioning|no ac|thermostat|boiler|radiator|furnace|\bvent\b|hvac)/.test(t)) {
      return "HVAC";
    }

    // LOCK / KEY
    if (/(locked out|lockout|lost key|lost keys|key fob|fob|deadbolt|lock broken|lock not working|can.?t get in|cannot get in|door won.?t open)/.test(t)) {
      return "Lock/Key";
    }

    // PEST
    if (/(roach|roaches|mouse|mice|rat|rats|bed bug|bedbug|ant|ants|spider|spiders|wasp|bees|pest)/.test(t)) {
      return "Pest";
    }

    // CLEANING
    if (/(trash|garbage|dirty|cleanup|clean up|cleaning|spill|odor|smell(?! gas)|stain|mold|mildew)/.test(t)) {
      return "Cleaning";
    }

    // PAINT / REPAIR (walls/doors/trim/holes)
    if (/(paint|painting|patch|hole in wall|drywall|crack|repair wall|baseboard|trim|cabinet|drawer|hinge|door frame|tile|grout|caulk|blind|curtain|shelf|closet)/.test(t)) {
      return "Paint/Repair";
    }

    // GENERAL (fallback catch)
    if (/(maintenance|repair|fix|broken|not working|issue|problem)/.test(t)) {
      return "General";
    }

    return "";
  }


  /** Gate: skip LLM classify when deterministic parser already has confident category. */
  function shouldRunLLMClassify_(parsedIssue) {
    if (!parsedIssue) return true;

    var cat = String(parsedIssue.category || "").trim();
    var urg = String(parsedIssue.urgency || "").trim();

    // deterministic parser already confident
    if (cat && cat !== "General" && cat !== "Unknown") {
      return false;
    }

    return true;
  }

  function classify_(apiKey, message, unit, afterHours) {
    const hard = hardEmergency_(message);
    if (hard && hard.emergency) return hard;

    if (!apiKey) throw new Error("Missing OPENAI_API_KEY in Script Properties.");

    const system =
      "You are a property maintenance triage assistant.\n" +
      "Return JSON only with keys: category, emergency, emergencyType, confidence (0-100), nextQuestions (array), safetyNote.\n" +
      "Category must be one of: Appliance, Cleaning, Electrical, General, HVAC, Lock/Key, Plumbing, Paint/Repair, Pest, Safety, Other.\n" +
      "IMPORTANT: Do NOT tell the tenant to call 911 or any emergency services.\n" +
      "If there is gas smell, fire/smoke, sparks/arcing, active flooding, sewage backing up, carbon monoxide alarm => emergency=true and category=Safety.\n" +
      "If lockout / keys / cannot access unit => category=Lock/Key.\n" +
      "If outlets, breaker, power, lights flickering => category=Electrical.\n" +
      "If washer/dryer/fridge/oven/dishwasher/microwave => category=Appliance.\n";

    const user =
      'Tenant message: "' + String(message || "") + '"\n' +
      'Known unit (if any): "' + String(unit || "") + '"\n' +
      "After hours: " + (afterHours ? "Yes" : "No");

    var r = (typeof openaiChatJson_ === "function")
      ? openaiChatJson_({
          apiKey: apiKey,
          model: "gpt-4.1-mini",
          system: system,
          user: user,
          timeoutMs: 20000,
          phone: "",
          logLabel: "CLASSIFY",
          maxRetries: 2
        })
      : { ok: false };

    if (!r.ok) {
      try { logDevSms_("", "", "CLASSIFY_FALLBACK code=" + (r.code || 0)); } catch (_) {}
      if (hard && hard.emergency) return hard;
      var urgFallback = (typeof urgentSignals_ === "function") ? urgentSignals_(message) : { urgent: false, reason: "" };
      var fallbackCat = (typeof localCategoryFromText_ === "function") ? localCategoryFromText_(message) : "";
      return {
        category: fallbackCat || "General",
        emergency: false,
        emergencyType: "",
        confidence: 0,
        nextQuestions: [],
        safetyNote: "",
        urgency: urgFallback.urgent ? "Urgent" : "Normal",
        urgencyReason: urgFallback.reason || ""
      };
    }

    var out = r.json || {};

    // -----------------------------
    // Normalize + keyword override
    // -----------------------------
    const allowed = {
      "appliance": "Appliance",
      "cleaning": "Cleaning",
      "electrical": "Electrical",
      "general": "General",
      "hvac": "HVAC",
      "lock/key": "Lock/Key",
      "lock": "Lock/Key",
      "key": "Lock/Key",
      "plumbing": "Plumbing",
      "paint/repair": "Paint/Repair",
      "paint": "Paint/Repair",
      "repair": "Paint/Repair",
      "pest": "Pest",
      "safety": "Safety",
      "other": "Other"
    };

    let aiCatRaw = String(out.category || "").trim();
    let aiKey = aiCatRaw.toLowerCase();
    if (aiKey.endsWith("s")) aiKey = aiKey.slice(0, -1); // appliances -> appliance
    let aiCat = allowed[aiKey] || "Other";

    const localCat = localCategoryFromText_(message);

    const aiConf = (typeof out.confidence === "number") ? out.confidence : 0;

    // Strong override: if localCat is clear, trust it when AI is weak/Other/blank
    if (localCat) {
      const aiBad = (!aiCatRaw || aiCat === "Other" || aiConf < 55);
      if (aiBad) aiCat = localCat;
    }
    // HVAC false-positive guard: LLM often returns HVAC for non-HVAC text (e.g. ceiling cracks, light bulb, smoke detector)
    const msgLower = String(message || "").toLowerCase();
    const hasHvacKeywords = /(no heat|heat not working|heater|boiler|radiator|ac|a\/c|air conditioner|air conditioning|cooling|no ac|thermostat|furnace|\bvent\b|hvac)/.test(msgLower);
    if (localCat && aiCat === "HVAC" && !hasHvacKeywords) {
      aiCat = localCat;
    }

    // Urgent-but-not-emergency detection (your existing rules)
    const urg = urgentSignals_(message);
    const urgency = urg.urgent ? "Urgent" : "Normal";
    const urgencyReason = urg.reason || "";

    return {
      category: aiCat,
      emergency: !!out.emergency,
      emergencyType: String(out.emergencyType || "").trim(),
      confidence: aiConf,
      nextQuestions: Array.isArray(out.nextQuestions) ? out.nextQuestions.slice(0, 4) : [],
      safetyNote: String(out.safetyNote || ""),
      urgency: urgency,
      urgencyReason: urgencyReason
    };
  }


  /****************************
  * Tenant reply
  ****************************/

  function tenantMsgSafe_(key, lang, vars, fallbackKey) {
    const k = String(key || "").trim();
    const L = String(lang || "en").trim().toLowerCase();
    const fb = String(fallbackKey || "").trim();

    const msg = tenantMsg_(k, L, vars); // returns "" if missing
    if (msg && String(msg).trim()) return msg;

    // Deterministic sheet log (not just Logger)
    try { logDevSms_("", "TEMPLATE_EMPTY key=[" + k + "] lang=[" + L + "]", "ERR_TEMPLATE"); } catch (_) {}

    if (fb) {
      const msg2 = tenantMsg_(fb, L, vars);
      if (msg2 && String(msg2).trim()) return msg2;

      try { logDevSms_("", "TEMPLATE_EMPTY fallbackKey=[" + fb + "] lang=[" + L + "]", "ERR_TEMPLATE"); } catch (_) {}
    }

    // Fail closed: no tenant-visible garbage
    return "";
  }



  // ===================================================================
  // ===== M8 — MESSAGING (Template Rendering ONLY) =====================
  // @MODULE:M8
  // Responsibilities:
  // - template lookup
  // - placeholder rendering
  // - compliance footer
  //
  // Forbidden:
  // - business logic
  // - sheet writes
  // ===================================================================

  function sanitizeTenantText_(s) {
    let t = String(s || "");
    t = t.replace(/""/g, '"');
    t = t.replace(/\u2013|\u2014/g, "-");
    t = t.replace(/\u2018|\u2019/g, "'");
    t = t.replace(/\u201C|\u201D/g, '"');
    t = t.replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }

  function shouldAppendCompliance_(key) {
    const k = String(key || "").toUpperCase().trim();
    const ALLOW = {
      "WELCOME": true,
      "SMS_START_CONFIRM": true,
      "SMS_STOP_CONFIRM": true,
      "SMS_HELP": true,
      "CONF_WINDOW_SET": true,
      "TICKET_CREATED_CONFIRM": true,
      "TICKET_CREATED_COMMON_AREA": true,
      "CLEANING_WORKITEM_ACK": true,
      "EMERGENCY_ACK_RECEIVED": true,
      "VISIT_CONFIRM_MULTI": true
    };
    return !!ALLOW[k];
  }

  function shouldPrependWelcome_(key) {
    const k = String(key || "").toUpperCase().trim();
    const ALLOW = {
      "WELCOME": true
    };
    return !!ALLOW[k];
  }

  function renderTenantKey_(key, lang, vars, opts) {
    const L = String(lang || "en").toLowerCase();
    const V = vars || {};
    const ch = opts && opts.channel ? String(opts.channel).toUpperCase() : "";
    const channel = (ch === "WA" || ch === "TELEGRAM") ? "WA" : "SMS";
    const deliveryPolicy = (opts && opts.deliveryPolicy && String(opts.deliveryPolicy).trim() === "NO_HEADER") ? "NO_HEADER" : "DIRECT_SEND";

    let body = tenantMsgSafe_(key, L, V, "ERR_GENERIC_TRY_AGAIN");
    body = sanitizeTenantText_(body);

    if (deliveryPolicy !== "NO_HEADER" && shouldPrependWelcome_(key)) {
      const wl = sanitizeTenantText_(String((V && V.__welcomeLine) || ""));
      if (wl) {
        if (!body.startsWith(wl)) {
          body = wl + "\n\n" + body;
        }
      }
    }

    if (channel === "SMS" && shouldAppendCompliance_(key)) {
      const footer = sanitizeTenantText_(tenantMsgSafe_("COMPLIANCE_FOOTER", L, V, ""));
      if (footer) body = String(body).trim() + "\n\n" + footer;
    }

    return sanitizeTenantText_(body);
  }





  function replyGlobal_(toPhone, welcomeLine, text) {
    try {
      const msg = withWelcome_(welcomeLine || "", text);
      if (!msg) return;
      const ref = (typeof phoneKey_ === "function") ? phoneKey_(toPhone) : String(toPhone || "").trim();
      var _ogRg = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({
        intentType: "CORE_TEXT_REPLY",
        recipientType: "TENANT",
        recipientRef: ref,
        lang: "en",
        deliveryPolicy: "DIRECT_SEND",
        preRenderedBody: msg,
        vars: {},
        meta: { source: "replyGlobal_", stage: "GLOBAL", flow: "LEGACY" }
      }) : { ok: false };
      if (!(_ogRg && _ogRg.ok)) {
        var _chRg = (typeof tenantPreferredChannelFallback_ === "function") ? tenantPreferredChannelFallback_(ref) : "SMS";
        if (_chRg !== "TELEGRAM" && typeof sendRouterSms_ === "function") sendRouterSms_(ref, msg, "REPLY_GLOBAL", _chRg);
      }
    } catch (err) {
      try { logDevSms_(String(toPhone || ""), String(text || ""), "REPLY_GLOBAL_CRASH " + String(err && err.stack ? err.stack : err)); } catch (_) {}
    }
  }

  function replyNoHeaderGlobal_(toPhone, text) {
    try {
      const msg = String(text || "").trim();
      if (!msg) return;
      const ref = (typeof phoneKey_ === "function") ? phoneKey_(toPhone) : String(toPhone || "").trim();
      var _ogRnh = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({
        intentType: "CORE_TEXT_REPLY_NO_HEADER",
        recipientType: "TENANT",
        recipientRef: ref,
        lang: "en",
        deliveryPolicy: "NO_HEADER",
        preRenderedBody: msg,
        vars: {},
        meta: { source: "replyNoHeaderGlobal_", stage: "GLOBAL", flow: "LEGACY" }
      }) : { ok: false };
      if (!(_ogRnh && _ogRnh.ok)) {
        var _chRnh = (typeof tenantPreferredChannelFallback_ === "function") ? tenantPreferredChannelFallback_(ref) : "SMS";
        if (_chRnh !== "TELEGRAM" && typeof sendRouterSms_ === "function") sendRouterSms_(ref, msg, "REPLY_NOHEADER_GLOBAL", _chRnh);
      }
    } catch (err) {
      try { logDevSms_(String(toPhone || ""), String(text || ""), "REPLY_NOHEADER_GLOBAL_CRASH " + String(err && err.stack ? err.stack : err)); } catch (_) {}
    }
  }



  function buildTenantReply_(c, unit, propertyName, lang, vars) {
    const L = String(lang || "en").toLowerCase();
    const V = vars || {};

    // ---------- helpers ----------
    function safeLine_(s) {
      const t = String(s || "").trim();
      return t ? (t + "\n") : "";
    }

    function renderSafety_(c) {
      // New world: key-based
      if (c && c.safetyNoteKey) {
        const s = tenantMsg_(String(c.safetyNoteKey), L, V);
        return safeLine_(strip911_(s));
      }
      // Old world: raw text
      if (c && c.safetyNote) return safeLine_(strip911_(c.safetyNote));
      return "";
    }

    function renderQuestions_(c) {
      // NEWEST world: array of template keys
      if (c && Array.isArray(c.nextQuestionsKeys) && c.nextQuestionsKeys.length) {
        const arr = c.nextQuestionsKeys
          .map(k => tenantMsg_(String(k), L, V))
          .map(s => String(s || "").trim())
          .filter(Boolean);

        if (arr.length) {
          return tenantMsg_("REPLY_QUICK_QUESTIONS_HEADER", L, V) + "\n- " + arr.join("\n- ");
        }
        return tenantMsg_("REPLY_FALLBACK_QUESTIONS", L, V);
      }

      // New world: single bundle key that returns "q1 | q2 | q3"
      if (c && c.nextQuestionsKey) {
        const raw = tenantMsg_(String(c.nextQuestionsKey), L, V);
        const arr = String(raw || "")
          .split("|")
          .map(s => String(s).trim())
          .filter(Boolean);

        if (arr.length) {
          return tenantMsg_("REPLY_QUICK_QUESTIONS_HEADER", L, V) + "\n- " + arr.join("\n- ");
        }
        return tenantMsg_("REPLY_FALLBACK_QUESTIONS", L, V);
      }

      // Old world: array of raw questions
      if (c && c.nextQuestions && c.nextQuestions.length) {
        const arr = c.nextQuestions.map(q => String(q).trim()).filter(Boolean);
        if (arr.length) {
          return tenantMsg_("REPLY_QUICK_QUESTIONS_HEADER", L, V) + "\n- " + arr.join("\n- ");
        }
      }

      return tenantMsg_("REPLY_FALLBACK_QUESTIONS", L, V);
    }

    // ---------- build lines ----------
    const urgencyLine =
      (c && c.urgency === "Urgent" && !c.emergency)
        ? (tenantMsg_("REPLY_URGENT_PREFIX", L, {
            ...V,
            reason: (c.urgencyReason || tenantMsg_("REPLY_URGENT_REASON_DEFAULT", L, V))
          }) + "\n\n")
        : "";


    const propLine = propertyName
      ? tenantMsg_("REPLY_PROP_LINE", L, { ...V, propertyName: propertyName }) + "\n"
      : "";

    const unitLine = unit
      ? tenantMsg_("REPLY_UNIT_LINE", L, { ...V, unit: unit }) + "\n"
      : (tenantMsg_("REPLY_ASK_UNIT", L, V) + "\n");

    const safetyBlock = renderSafety_(c);
    const questionsBlock = renderQuestions_(c);

    // ---------- emergency ----------
    if (c && c.emergency) {
      const header = tenantMsg_("REPLY_EMERG_HEADER", L, V);
      return (
        header + "\n" +
        (safetyBlock ? (safetyBlock + "\n") : "") +
        propLine +
        unitLine +
        questionsBlock
      );
    }

    // ---------- normal ----------
    const header = tenantMsg_("REPLY_NORMAL_HEADER", L, V);
    const categoryLine = tenantMsg_("REPLY_CATEGORY_LINE", L, {
      ...V,
      category: (c && c.category ? c.category : tenantMsg_("CATEGORY_OTHER_LABEL", L, V))
    });

    const footer = tenantMsg_("REPLY_FOOTER", L, V);

    return (
      urgencyLine +
      header + "\n" +
      propLine +
      unitLine +
      categoryLine + "\n\n" +
      questionsBlock + "\n\n" +
      footer
    );
  }



  /****************************
  * Twilio SMS send
  ****************************/
  function sendSms_(sid, token, fromNumber, toNumber, message, tagOpt, tidOpt) {
    // Log outbound so you can see the reply the tenant would receive (system reply line).
    // Skip OUT_SMS when To is WhatsApp (sendWhatsApp_ already logs OUT_WA).
    try {
      var toStr = String(toNumber || "").trim();
      if (toStr.toLowerCase().indexOf("whatsapp:") !== 0) {
        var outTag = (tagOpt != null && tagOpt !== "") ? String(tagOpt) : "";
        var outLen = (message != null && message !== "") ? String(message).length : 0;
        var outTid = (tidOpt != null && tidOpt !== "") ? " tid=" + String(tidOpt) : "";
        logDevSms_(toNumber, String(message || ""), "OUT_SMS tag=[" + outTag + "] len=" + outLen + outTid);
      }
    } catch (e) {
      Logger.log("logDevSms_ failed: " + e);
    }

    // -----------------------------
    // GLOBAL OPT-OUT ENFORCEMENT (Twilio compliance)
    // - Blocks ALL outbound SMS to opted-out numbers
    // - Use normalized phone (strip whatsapp:) so opt-out matches Directory/key store
    // -----------------------------
    try {
      const toKey = phoneKey_(String(toNumber || "").replace(/^whatsapp:/i, "").trim());
      if (toKey && isSmsOptedOut_(toKey) && !(typeof isOptOutBypassActive_ === "function" && isOptOutBypassActive_(toKey))) {
        try {
          logDevSms_(toKey, String(message || ""), "SEND_BLOCKED_OPTOUT", "COMPLIANCE");
        } catch (_) {}
        return; // do not send
      }
    } catch (e) {
      // Never let compliance check crash sending
      Logger.log("opt-out check failed: " + e);
    }

    if (isDevSendMode_()) {
      try { if (typeof DEV_EMIT_TWIML_ === "function") DEV_EMIT_TWIML_(message); } catch (_) {}
      return;
    }

    try {
      if (!sid || !token || !fromNumber) {
        try { logDevSms_(toNumber, message, "TWILIO_CONFIG_ERROR", "Missing credentials"); } catch (_) {}
        return;
      }
      if (!toNumber) {
        try { logDevSms_("(missing)", message, "TWILIO_CONFIG_ERROR", "Missing destination phone"); } catch (_) {}
        return;
      }
      if (!message) return;

      const url = "https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json";
      const payload = { From: fromNumber, To: toNumber, Body: message };

      const options = {
        method: "post",
        payload: payload,
        headers: { Authorization: "Basic " + Utilities.base64Encode(sid + ":" + token) },
        muteHttpExceptions: true
      };

      const resp = UrlFetchApp.fetch(url, options);
      const code = resp.getResponseCode();
      const body = resp.getContentText();

      try { logDevSms_(toNumber, message, "TWILIO_RESP " + code, body); } catch (_) {}

      // No throwing here (avoid Twilio webhook retries)
      if (code < 200 || code >= 300) {
        try { logDevSms_(toNumber, message, "TWILIO_ERROR", body); } catch (_) {}
      }
    } catch (err) {
      // Never crash the webhook
      try { logDevSms_(toNumber, message, "SENDSMS_CRASH", String(err)); } catch (_) {}
      Logger.log("sendSms_ crash: " + err);
    }
  }

  /****************************
  * Twilio WhatsApp send (Sandbox/API)
  ****************************/
  function sendWhatsApp_(sid, token, fromWa, toPhone, message, tagOpt, tidOpt) {
    // Normalize destination phone to E.164 without channel prefix
    var toNorm = String(toPhone || "").trim().replace(/^whatsapp:/i, "");
    var toWa = "whatsapp:" + toNorm;

    // Log outbound WhatsApp
    try {
      var outTag = (tagOpt != null && tagOpt !== "") ? String(tagOpt) : "";
      var outLen = (message != null && message !== "") ? String(message).length : 0;
      var outTid = (tidOpt != null && tidOpt !== "") ? " tid=" + String(tidOpt) : "";
      logDevSms_(toNorm, String(message || ""), "OUT_WA tag=[" + outTag + "] len=" + outLen + outTid);
    } catch (_) {}

    // Reuse existing sender (opt-out, DEV_EMIT_TWIML_, Twilio POST). Pass To/From in WhatsApp format.
    sendSms_(sid, token, String(fromWa || "").trim(), toWa, message, tagOpt, tidOpt);
  }
  function detectEmergencyKind_(text) {
    const s = String(text || "").toLowerCase();

    // keep these specific to avoid false positives
    if (/\b(oven\s*(is\s*)?on fire|on fire|fire|flames)\b/.test(s)) return "FIRE";
    if (/\b(smoke|smoky)\b/.test(s)) return "SMOKE";
    if (/\b(gas leak|smell gas|gas smell)\b/.test(s)) return "GAS";
    if (/\b(carbon monoxide|co alarm|co detector)\b/.test(s)) return "CO";
    if (/\b(sparks|arcing|electrical fire|outlet sparks|burning outlet)\b/.test(s)) return "ELECTRICAL";
    if (/\b(pipe\s*burst|burst\s*pipe|water\s*pipe\s*burst|flood(ing)?|water\s*pouring|sewage|sewer\s*back)\b/.test(s)) return "FLOOD";

    return "";
  }


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (post-split restore)
// sendRouterSms_ + emergency + channel fallback
// ─────────────────────────────────────────────────────────────────


  function sendRouterSms_(to, text, tag, channelOverride, meta) {
    const msg = String(text || "").trim();
    const metaObj = (meta && typeof meta === "object") ? meta : {};

    dbg_("ROUTER_SMS_ENTER", { from: to, bodyRaw: msg, note: "sendRouterSms_ called", tag: tag || "" });

    if (!to || !msg) {
      dbg_("ROUTER_SMS_ABORT_EMPTY", { from: to, note: "missing to or msg" });
      return;
    }

    try {
      if (
        !metaObj.fromOutgate &&
        typeof cigRendererEnabled_ === "function" &&
        cigRendererEnabled_() &&
        typeof properaLegacyTextReplyEnvelope_ === "function" &&
        typeof properaRenderReply_ === "function"
      ) {
        var legacyEnvelope = properaLegacyTextReplyEnvelope_(
          String(to || "").trim(),
          msg,
          "en",
          String(channelOverride || "SMS").trim().toUpperCase(),
          "DIRECT_SEND",
          String(tag || "DIRECT_SEND")
        );
        if (legacyEnvelope) {
          var renderRes = properaRenderReply_(legacyEnvelope, legacyEnvelope.replyLang, legacyEnvelope.channel, legacyEnvelope.recipientRef);
          if (renderRes && renderRes.ok) {
            dbg_("ROUTER_SMS_REDIRECTED_TO_RENDERER", { from: to, tag: tag || "" });
            return;
          }
        }
      }
    } catch (_) {}

    // Outbound is logged once in sendSms_/sendWhatsApp_ to avoid duplicate OUT_SMS lines

    // ✅ allow compliance / router messages to bypass opt-out suppression
    try { allowOptOutBypass_(to, 10); }
    catch (err) { dbg_("ROUTER_SMS_BYPASS_ERR", { from: to, note: String(err) }); }

    const sid     = TWILIO_SID;
    const token   = TWILIO_TOKEN;
    const fromNum = TWILIO_NUMBER;

    dbg_("ROUTER_SMS_CFG", { from: to, note: `sid=${!!sid} token=${!!token} fromNum=${fromNum}` });

    if (!sid || !token || !fromNum) {
      dbg_("ROUTER_SMS_CFG_MISSING", { from: to, note: "missing Twilio config in Script Properties" });
      return;
    }

    try {
      var ch = String(channelOverride || "SMS").trim().toUpperCase();
      if (ch !== "WA" && ch !== "TELEGRAM") ch = "SMS";
      if (ch === "TELEGRAM") {
        try { dbg_("ROUTER_SMS_SKIP_TELEGRAM", { from: to, note: "sendRouterSms_ does not deliver TELEGRAM; use Outgate" }); } catch (_) {}
        return;
      }
      if (ch === "WA") {
        sendWhatsApp_(sid, token, TWILIO_WA_FROM, to, msg, tag);
      } else {
        sendSms_(sid, token, fromNum, to, msg, tag);
      }
      dbg_("ROUTER_SMS_SENT_OK", { from: to, note: (ch === "WA" ? "sendWhatsApp_ success" : "sendSms_ success") });
    } catch (e) {
      try { dbg_("ROUTER_SMS_ERR", { err: String(e && e.message || e), tag: tag || "" }); } catch (_) {}
    }
  }



  function finishEmergencyIfReady_(sheet, dir, dirRow, row, lang) {
    const hasProp = String(sheet.getRange(row, COL.PROPERTY).getValue() || "").trim();
    const hasUnit = String(sheet.getRange(row, COL.UNIT).getValue() || "").trim();
    const hasMsg  = String(sheet.getRange(row, COL.MSG).getValue() || "").trim();

    if (hasProp && hasUnit && hasMsg) {
      const tid = ticketIdFromRow_(sheet, row);
      var finishPhone = String(sheet.getRange(row, COL.PHONE).getValue() || "").trim();
      try { dalSetPendingStage_(dir, dirRow, "", finishPhone, "finishEmergencyIfReady_"); } catch (_) {}
      setStatus_(sheet, row, "In Progress");

      var _ogEChannel = "SMS";
      try {
        _ogEChannel = String(typeof _channel !== "undefined" ? _channel : "SMS").trim().toUpperCase();
        if (_ogEChannel !== "WA" && _ogEChannel !== "TELEGRAM") _ogEChannel = "SMS";
      } catch (_) { _ogEChannel = "SMS"; }

      if (tid) {
        var _ogE = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED_WITH_TICKET", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _ogEChannel, deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, { ticketId: tid }), meta: { source: "finishEmergencyIfReady_", stage: "EMERGENCY_DONE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogE && _ogE.ok)) reply_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED_WITH_TID", lang, { ...baseVars, ticketId: tid }));
      } else {
        var _ogE2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _ogEChannel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "finishEmergencyIfReady_", stage: "EMERGENCY_DONE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogE2 && _ogE2.ok)) reply_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED", lang, baseVars));
      }
      return true;
    }
    return false;
  }




  function latchEmergency_(sheet, row, phone, kind) {
    const now = new Date();
    const k = String(kind || "EMERGENCY").trim() || "EMERGENCY";

    // Ticket latch (authoritative + visible)
    if (row && row > 1) {
      withWriteLock_("LATCH_EMERGENCY_TICKET", () => {
        sheet.getRange(row, COL.EMER).setValue("Yes");
        sheet.getRange(row, COL.EMER_TYPE).setValue(k);
        sheet.getRange(row, COL.LAST_UPDATE).setValue(now);
      });
    }

    // Context latch (fast routing)
    try {
      ctxUpsert_(phone, {
        flowMode: "EMERGENCY",
        emergencyKind: k,
        // critical: emergency cannot be waiting on schedule/detail
        pendingExpected: "",
        pendingExpiresAt: ""
      }, "EMERGENCY_LATCH");
    } catch (_) {}
  }





  function isEmergencyContext_(sheet, row) {
    if (isEmergencyRow_(sheet, row)) return true;
    const msg = String(sheet.getRange(row, COL.MSG).getValue() || "");
    return looksLikeEmergencyText_(msg);
  }



  function isEmergencyContinuation_(dir, dirRow, ctx, phone) {
    if (!dir || !dirRow || dirRow < 2) return { isEmergency: false, source: "" };
    var pendingStage = String((typeof dalGetPendingStage_ === "function" ? dalGetPendingStage_(dir, dirRow) : "") || "").toUpperCase();
    if (pendingStage === "EMERGENCY_DONE") {
      try { if (phone) logDevSms_(phone, "", "EMERGENCY_RESOLVE_FROM_DIRECTORY"); } catch (_) {}
      return { isEmergency: true, source: "DIRECTORY" };
    }
    var pr = (typeof dalGetPendingRow_ === "function") ? dalGetPendingRow_(dir, dirRow) : 0;
    if (pr >= 2 && typeof getLogSheet_ === "function" && typeof COL !== "undefined") {
      try {
        var sheet = getLogSheet_();
        if (sheet && pr <= sheet.getLastRow() && isEmergencyRow_(sheet, pr)) {
          try { if (phone) logDevSms_(phone, "", "EMERGENCY_RESOLVE_FROM_TICKET row=" + pr); } catch (_) {}
          return { isEmergency: true, source: "TICKET" };
        }
      } catch (_) {}
    }
    var wiId = ctx && (ctx.activeWorkItemId || ctx.pendingWorkItemId);
    if (wiId && typeof workItemGetById_ === "function") {
      try {
        var wi = workItemGetById_(wiId);
        if (wi && String(wi.substate || "").toUpperCase() === "EMERGENCY") {
          try { if (phone) logDevSms_(phone, "", "EMERGENCY_RESOLVE_FROM_WORKITEM wi=" + wiId); } catch (_) {}
          return { isEmergency: true, source: "WORKITEM" };
        }
      } catch (_) {}
    }
    if (ctx && String(ctx.flowMode || "").toUpperCase() === "EMERGENCY") {
      try { if (phone) logDevSms_(phone, "", "EMERGENCY_RESOLVE_FROM_CTX"); } catch (_) {}
      return { isEmergency: true, source: "CTX" };
    }
    return { isEmergency: false, source: "" };
  }




  function getWelcomeLineOnce_(dirSheet, dirRow, lang) {
    if (!dirSheet || !dirRow) return "";

    const cell = dirSheet.getRange(dirRow, DIR_COL.WELCOME_SENT); // J
    const already = String(cell.getValue() || "").trim().toLowerCase() === "yes";
    if (already) return "";

    cell.setValue("Yes");
    return tenantMsg_("WELCOME", lang);
  }





  function strip911_(s) {
    let t = String(s || "");

    // remove explicit 911/dial/call emergency phrases
    t = t.replace(/\b(call|dial|contact)\s*(911|9-1-1)\b[^.!\n]*[.!\n]?/ig, "");
    t = t.replace(/\b(call|contact)\s*(the\s*)?(police|fire\s*department|emergency\s*services)\b[^.!\n]*[.!\n]?/ig, "");

    // remove any leftover standalone 911 mentions
    t = t.replace(/\b(911|9-1-1)\b/ig, "");

    return t.trim();
  }



  function tenantPreferredChannelFallback_(phoneRaw) {
    var to = (typeof normalizePhone_ === "function") ? normalizePhone_(phoneRaw) : String(phoneRaw || "").trim();
    var ch = "SMS";
    if (!to) return ch;
    try {
      var cx = (typeof ctxGet_ === "function") ? ctxGet_(to) : null;
      var p = String(cx && cx.preferredChannel || "").trim().toUpperCase();
      if (p === "WA") ch = "WA";
      else if (p === "TELEGRAM") {
        var tg = cx && cx.telegramChatId != null ? String(cx.telegramChatId || "").trim() : "";
        if (tg) ch = "TELEGRAM";
      }
    } catch (_) {}
    return ch;
  }
