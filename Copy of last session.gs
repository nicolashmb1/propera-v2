  // ===================================================================
  // PROPERA COMPASS ARCHITECTURE
  // Canonical Flow:
  // Gateway → Router → Core Pipeline → Compiler → Draft → Resolver → Workflow → Messaging
  //
  // Patch Law:
  // - Every patch MUST target a single module.
  // - No cross-module side effects.
  // ===================================================================

  /************************************
  * PROPERA — GLOBAL CONFIG
  ************************************/

  const props = PropertiesService.getScriptProperties();

  // ---- Twilio (SMS ingress / egress)
  const TWILIO_SID = props.getProperty("TWILIO_SID");
  const TWILIO_TOKEN = props.getProperty("TWILIO_TOKEN");
  const TWILIO_NUMBER = props.getProperty("TWILIO_NUMBER");
  // WhatsApp Sandbox sender (Twilio sandbox). Later: make this per-tenant config (Directory/Settings).
  var TWILIO_WA_FROM = "whatsapp:+14155238886";
  const ONCALL_NUMBER = props.getProperty("ONCALL_NUMBER");
  const TWILIO_WEBHOOK_SECRET = props.getProperty("TWILIO_WEBHOOK_SECRET");

  // ---- Internal webhooks (AppSheet / Comm Engine)
  const COMM_WEBHOOK_SECRET = props.getProperty("COMM_WEBHOOK_SECRET");

  function commWebhookSecret_() {
    try {
      return String(PropertiesService.getScriptProperties().getProperty("COMM_WEBHOOK_SECRET") || "");
    } catch (_) {
      return "";
    }
  }

  /************************************
  * PROPERA — SHEETS UI (sidebar emulator)
  ************************************/
  function onOpen() {
    SpreadsheetApp.getUi()
      .createMenu("Propera")
      .addItem("Open Message Emulator", "showMessageEmulator_")
      .addToUi();
  }

  function showMessageEmulator_() {
    var html = HtmlService.createHtmlOutputFromFile("MessageEmulator")
      .setTitle("Message Emulator")
      .setWidth(360);
    SpreadsheetApp.getUi().showSidebar(html);
  }

  /************************************
  * PROPERA — CORE UTILITIES
  ************************************/

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

    // Strip "take a look at / check / look at"
    t = t.replace(/\b(take\s+a\s+look\s+at|look\s+at|check|inspect)\b\s*/i, "");

    // Normalize possessive-ish noise
    t = t.replace(/\bmyu\b/ig, "my"); // observed typo

    // Collapse whitespace and trailing punctuation
    t = t.replace(/\s+/g, " ").trim();
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

    // Split into clauses (keep order) — no \s+and\s+ to keep "washer not draining and leaves water" intact
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
      if ((typeof looksActionableIssue_ === "function") && !looksActionableIssue_(t)) continue;
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

  // ============================================================
  // DETERMINISTIC ISSUE PARSER (AI-feel, no AI)
  // Output: { title, details, category, subcategory, urgency, clauses, debug }
  // clauses: [{ text, title, type, score }]
  // ============================================================

  function parseIssueDeterministic_(rawText, opts) {
    opts = opts || {};
    var raw = String(rawText || "").trim();
    if (!raw) return { title: "", details: "", category: "", subcategory: "", urgency: "normal", clauses: [], debug: "" };

    // 1) Normalize preamble / identity / location noise
    var cleaned = stripIssuePreamble_(raw);

    // 2) Split into clauses (keep order)
    var clausesRaw = splitIssueClauses_(cleaned);

    // 3) Classify + score clauses
    var clauses = [];
    for (var i = 0; i < clausesRaw.length; i++) {
      var c = String(clausesRaw[i] || "").trim();
      if (!c) continue;

      // Avoid schedule-like clauses being treated as issues
      if (typeof isScheduleWindowLike_ === "function" && isScheduleWindowLike_(c)) {
        clauses.push({ text: c, title: "", type: "schedule", score: -999 });
        continue;
      }

      var type = classifyIssueClauseType_(c);
      var score = scoreIssueClauseWithPos_(c, type, i, clausesRaw.length);

      // title candidate
      var title = "";
      if (type === "problem" || type === "context") {
        title = normalizeIssueTitle_(c);
      }

      clauses.push({ text: c, title: title, type: type, score: score });
    }

    // 4) Pick best core problem clause
    var bestIdx = -1;
    var bestScore = -999999;
    for (var j = 0; j < clauses.length; j++) {
      var it = clauses[j];
      if (!it) continue;
      if (it.type !== "problem") continue;
      if (it.score > bestScore) { bestScore = it.score; bestIdx = j; }
    }

    // If no explicit "problem", allow a strong "context" clause to become problem-like (rare)
    if (bestIdx < 0) {
      for (var k = 0; k < clauses.length; k++) {
        var it2 = clauses[k];
        if (!it2) continue;
        if (it2.type !== "context") continue;
        if (it2.score > bestScore) { bestScore = it2.score; bestIdx = k; }
      }
    }

    var core = (bestIdx >= 0) ? clauses[bestIdx] : null;

    // Debug: log when an attempted-fix clause was deprioritized (not chosen as title)
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

    // 5) Title
    var titleOut = core && core.title ? core.title : "";
    if (titleOut && typeof normalizeIssueText_ === "function") {
      try { titleOut = normalizeIssueText_(titleOut); } catch (_) {}
    }
    titleOut = finalizeIssueTitlePolish_(titleOut, cleaned);

    // 6) Details (everything except the title clause, plus qualifying context)
    var detailsOut = buildIssueDetails_(clauses, bestIdx);

    // 7) Category/subcategory (deterministic)
    var cat = "";
    try {
      if (typeof localCategoryFromText_ === "function") {
        cat = localCategoryFromText_((titleOut + " " + detailsOut).trim()) || localCategoryFromText_(titleOut) || "";
      }
    } catch (_) {}
    var subcat = detectSubcategory_(titleOut, detailsOut);

    // 8) Urgency
    var urgency = detectUrgency_(titleOut, detailsOut);

    // 9) Multi-issue: return all problem clauses (dedup by normalized title)
    var problemTitles = [];
    var outClauses = [];
    var seen = {};
    for (var m = 0; m < clauses.length; m++) {
      var c3 = clauses[m];
      if (!c3 || c3.type !== "problem") continue;
      var tt = c3.title ? String(c3.title).toLowerCase().trim() : "";
      if (!tt) continue;
      if (seen[tt]) continue;
      seen[tt] = 1;
      outClauses.push({ text: c3.text, title: c3.title, type: c3.type, score: c3.score });
    }

    return {
      title: titleOut,
      details: detailsOut,
      category: cat || "",
      subcategory: subcat || "",
      urgency: urgency || "normal",
      clauses: outClauses,
      bestClauseText: (core && core.text) ? String(core.text).trim() : "",
      debug: "picked=" + bestIdx + " score=" + bestScore + " nClauses=" + clauses.length
    };
  }


  // ------------------------------------------------------------
  // Clause splitting
  // ------------------------------------------------------------
  function splitIssueClauses_(s) {
    var t = String(s || "").trim();
    if (!t) return [];
    // Normalize whitespace
    t = t.replace(/\s+/g, " ").trim();

    // Split on sentence punctuation and common joiners (no \s+and\s+ — keeps "washer isn't draining and leaves water" intact)
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

  /** Feature flag: schema-based issue extraction for long messages. Default OFF. */
  function isSchemaExtractEnabled_() {
    try {
      var sp = PropertiesService.getScriptProperties();
      return String(sp.getProperty("ENABLE_SCHEMA_EXTRACT") || "").trim() === "1";
    } catch (_) { return false; }
  }

  /** Gate: true when message should use schema extract (slow lane). Returns { use, reason }. */
  function shouldUseSchemaExtract_(t) {
    var s = String(t || "").trim();
    if (!s) return { use: false, reason: "" };
    if (s.length >= 220) return { use: true, reason: "len" };
    var clauses = (typeof splitIssueClauses_ === "function") ? splitIssueClauses_(s) : [];
    if (clauses && clauses.length >= 6) return { use: true, reason: "clauses" };
    if (/\b(also|another|plus|in addition)\b/i.test(s)) return { use: true, reason: "also" };
    if ((typeof isScheduleWindowLike_ === "function") && isScheduleWindowLike_(s) &&
        (typeof looksActionableIssue_ === "function") && looksActionableIssue_(s)) {
      return { use: true, reason: "schedmix" };
    }
    return { use: false, reason: "" };
  }

  /** Deterministic digest when Twilio SID is missing (SIM/tests/internal). Prevents retries bypassing dedupe. */
  function _nosidDigest_(fromDed, bodyTrim) {
    var raw = String(fromDed || "") + "|" + String(bodyTrim || "");
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw, Utilities.Charset.UTF_8);
    return digest.map(function(b){ return ("0" + ((b + 256) % 256).toString(16)).slice(-2); }).join("").slice(0, 24);
  }

  /** Cooldown key for OpenAI rate-limit backoff (CacheService). */
  function openaiCooldownKey_(label) {
    return "OAI_CD_" + String(label || "GEN").toUpperCase();
  }

  /** Returns true if cooldown is active for label. */
  function openaiCooldownActive_(label) {
    try { return CacheService.getScriptCache().get(openaiCooldownKey_(label)) === "1"; } catch (_) { return false; }
  }

  /** Set cooldown for label (seconds). */
  function openaiSetCooldown_(label, seconds) {
    try { CacheService.getScriptCache().put(openaiCooldownKey_(label), "1", seconds || 120); } catch (_) {}
  }

  /** ScriptProperties-based global OpenAI cooldown (ms epoch). Key: OPENAI_COOLDOWN_UNTIL_MS */
  function getOpenAICooldownUntilMs_() {
    try {
      var s = String(PropertiesService.getScriptProperties().getProperty("OPENAI_COOLDOWN_UNTIL_MS") || "").trim();
      if (!s) return 0;
      var n = parseInt(s, 10);
      return isFinite(n) ? n : 0;
    } catch (_) { return 0; }
  }

  /** Set global OpenAI cooldown: msFromNow = milliseconds from now until cooldown ends. */
  function setOpenAICooldownMs_(msFromNow) {
    try {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(200)) return;
      try {
        var until = new Date().getTime() + (msFromNow || 0);
        PropertiesService.getScriptProperties().setProperty("OPENAI_COOLDOWN_UNTIL_MS", String(until));
      } finally {
        lock.releaseLock();
      }
    } catch (_) {}
  }

  /** Returns true if global OpenAI cooldown is active. */
  function isOpenAICooldown_() {
    var until = getOpenAICooldownUntilMs_();
    if (!until) return false;
    return new Date().getTime() < until;
  }

  /** Short hash for cache keys (SHA-256 truncated to 16 hex chars). */
  function hashText_(s) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s || ""), Utilities.Charset.UTF_8);
    return bytes.map(function (b) { b = (b < 0 ? b + 256 : b); return ("0" + b.toString(16)).slice(-2); }).join("").slice(0, 16);
  }

  /** Shared OpenAI chat completions JSON helper. Returns { ok, code, json?, err? }.
  * opts: { apiKey, model, system, user, timeoutMs, phone, logLabel, maxRetries }
  */
  function openaiChatJson_(opts) {
    opts = opts || {};
    var apiKey = String(opts.apiKey || "").trim();
    var logLabel = String(opts.logLabel || "OPENAI").trim();
    var phone = String(opts.phone || "").trim();
    var maxRetries = (typeof opts.maxRetries === "number") ? opts.maxRetries : 2;

    if (!apiKey) {
      return { ok: false, code: 0, err: "no_key" };
    }

    if (typeof isOpenAICooldown_ === "function" && isOpenAICooldown_()) {
      var untilMs = (typeof getOpenAICooldownUntilMs_ === "function") ? getOpenAICooldownUntilMs_() : 0;
      try { logDevSms_(phone, "", logLabel + "_COOLDOWN until=" + untilMs); } catch (_) {}
      return { ok: false, code: 429, err: "cooldown" };
    }

    var model = String(opts.model || "gpt-4.1-mini").trim();
    var system = String(opts.system || "").trim();
    var user = String(opts.user || "").trim();
    var timeoutMs = (typeof opts.timeoutMs === "number") ? opts.timeoutMs : 20000;

    var payload = {
      model: model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    };

    function doFetch() {
      return UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + apiKey },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
        timeout: timeoutMs
      });
    }

    var res = null;
    var code = 0;

    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        res = doFetch();
        code = res.getResponseCode();
      } catch (_) {
        return { ok: false, code: 0, err: "fetch_err" };
      }

      if (code >= 200 && code < 300) {
        var content = "{}";
        try {
          var parsed = JSON.parse(res.getContentText());
          content = (parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content)
            ? parsed.choices[0].message.content
            : "{}";
        } catch (_) {
          return { ok: false, code: code, err: "parse" };
        }
        var out = {};
        try { out = JSON.parse(content || "{}"); } catch (_) {}
        return { ok: true, code: code, json: out };
      }

      var retryable = (code === 429 || code === 503 || code === 500 || code === 408);
      try { logDevSms_(phone, "", logLabel + "_HTTP code=" + code); } catch (_) {}

      if (retryable && attempt < maxRetries) {
        var sleepMs = (500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 251);
        try { logDevSms_(phone, "", logLabel + "_RETRY attempt=" + (attempt + 1) + " sleepMs=" + sleepMs); } catch (_) {}
        Utilities.sleep(sleepMs);
      } else {
        if (retryable && typeof setOpenAICooldownMs_ === "function") {
          setOpenAICooldownMs_(90000);
        }
        return { ok: false, code: code, err: "retry_exhausted" };
      }
    }

    return { ok: false, code: code, err: "retry_exhausted" };
  }

  // =============================================================================
  // Propera Compass — Image Signal Adapter (Phase 1)
  // Shared media/image adapter for tenant SMS/WhatsApp, staff # screenshot, synthetic body.
  // =============================================================================

  /** Read first media item from event params; return normalized facts (no AI). */
  function extractInboundMediaFacts_(e) {
    var out = { hasMedia: false, mediaCount: 0, firstUrl: "", firstType: "", isImage: false };
    try {
      var p = (e && e.parameter) ? e.parameter : {};
      var n = parseInt(String(p.NumMedia || "0"), 10) || 0;
      if (n < 1) return out;
      var url = String(p.MediaUrl0 || p["MediaUrl0"] || "").trim();
      var typ = String(p.MediaContentType0 || p["MediaContentType0"] || "").trim().toLowerCase();
      out.mediaCount = n;
      out.firstUrl = url;
      out.firstType = typ;
      if (!url) return out;
      out.hasMedia = true;
      var imageTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"];
      out.isImage = imageTypes.some(function (t) { return typ.indexOf(t) === 0 || typ === t; });
    } catch (_) {}
    return out;
  }

  /** Build system + user prompt for OpenAI vision extraction (JSON-only, conservative). */
  function buildMediaSignalPrompt_(bodyText) {
    var body = String(bodyText || "").trim();
    var system = "You are a maintenance intake assistant. Analyze the image and optional text. " +
      "Return ONLY valid JSON with these exact top-level keys: mediaType, detectedObjects (array of strings), extractedText (string), " +
      "propertyHint (string), unitHint (string), tenantNameHint (string), " +
      "issueHints (object with category, subcategory, issueSummary, symptoms array, attemptedFixes array, locationsInUnit array, safetySensitive boolean), " +
      "syntheticBody (string), confidence (0-1 number). " +
      "mediaType must be one of: real_world_photo, screenshot_chat, screenshot_error_screen, unknown. " +
      "When reading screenshot headers and message body, extract only operational identifiers. " +
      "propertyHint: extract visible building/property name from header OR message body. unitHint: extract visible unit/apartment number from header OR message body. " +
      "If screenshot text contains a building/property name together with a unit/apartment pattern (e.g. '<property> apt 219', '<property> unit 219', '<property> 219'), extract both propertyHint and unitHint from that phrase. " +
      "Property and unit hints may appear in the header/title area or in the message body; check both. Do not invent property or unit; only extract what is clearly visible. " +
      "tenantNameHint: extract only if it appears to be a real personal name AND is also supported by the message body text; otherwise leave empty. " +
      "Ignore nicknames, descriptive labels, jokes, emojis, or subjective/freeform contact labels. Do not include freeform contact-label text in syntheticBody unless it is clearly corroborated by the message body. " +
      "Header contact labels (e.g. 'The Grand Services') should not be used as propertyHint unless the same property name appears in a clear operational context; do not assume property from label alone. " +
      "For screenshot_chat, syntheticBody should preserve: property hint if clearly visible, unit if clearly visible, issue text, room/location, attempted checks/fixes, and schedule timing if clearly visible (e.g. 'after 3:30 pm'). " +
      "If schedule timing is present in screenshot text, include it in extractedText and syntheticBody; do not invent a normalized schedule beyond what is visible. " +
      "CRITICAL: In syntheticBody place the primary symptom or problem FIRST; put attempted checks/fixes AFTER. Example: 'Living room lights are out; breaker was checked.' NOT 'Checked the breaker; living room lights are out.' " +
      "issueSummary must represent the primary problem/symptom only. attemptedFixes array must list actions like checked breaker, replaced battery, reset outlet, etc. " +
      "syntheticBody must avoid including questionable header-only names or nicknames. Keep syntheticBody concise and operational. " +
      "For screenshots: read visible text into extractedText; for chat screenshots set syntheticBody to one short normalized issue sentence. " +
      "If the issue mentions a room or location in the unit, or attempted checks/fixes, include those in syntheticBody with problem first, then attempted action. " +
      "For real-world photos: list objects from: breaker_panel, thermostat_screen, smoke_detector, appliance_display, leak_or_water, sink_pipe, toilet, outlet_or_gfci, chat_message. " +
      "Never invent property, unit, tenant name, or schedule. Never over-diagnose. If unreadable or low confidence use unknown and low confidence. " +
      "syntheticBody only when you can state a concise maintenance-relevant sentence; otherwise empty string.";
    var user = "Optional message from sender: " + (body || "(none)") + "\n\nAnalyze the image and return the JSON.";
    return { system: system, user: user };
  }

  /** Download Twilio media with Basic auth; return data URL for inline vision input, or "" on failure. */
  function fetchTwilioMediaAsDataUrl_(mediaUrl) {
    var url = String(mediaUrl || "").trim();
    if (!url) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_FAIL reason=no_url"); } catch (_) {}
      return "";
    }
    var sid = "";
    var token = "";
    try {
      var sp = PropertiesService.getScriptProperties();
      sid = String(sp.getProperty("TWILIO_SID") || "").trim();
      token = String(sp.getProperty("TWILIO_TOKEN") || "").trim();
    } catch (_) {}
    if (!sid || !token) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_FAIL reason=no_twilio_creds"); } catch (_) {}
      return "";
    }
    var res = null;
    try {
      res = UrlFetchApp.fetch(url, {
        method: "get",
        headers: { Authorization: "Basic " + Utilities.base64Encode(sid + ":" + token) },
        muteHttpExceptions: true
      });
    } catch (e) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_FAIL reason=fetch_err"); } catch (_) {}
      return "";
    }
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_FAIL code=" + code); } catch (_) {}
      return "";
    }
    var blob = res.getBlob();
    var mime = (blob && blob.getContentType()) ? String(blob.getContentType()).trim().toLowerCase().split(";")[0] : "";
    if (!mime) mime = "image/jpeg";
    var allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"];
    if (allowed.indexOf(mime) === -1) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_FAIL reason=unsupported_type type=" + mime); } catch (_) {}
      return "";
    }
    var base64 = "";
    try {
      base64 = Utilities.base64Encode(blob.getBytes());
    } catch (_) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_FAIL reason=base64_err"); } catch (_) {}
      return "";
    }
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_OK type=" + mime); } catch (_) {}
    return "data:" + mime + ";base64," + base64;
  }

  /** OpenAI multimodal chat completion (vision); returns { ok, code, json?, err? }. Uses imageDataUrl (inline) or imageUrl. */
  function openaiVisionJson_(opts) {
    opts = opts || {};
    var apiKey = String(opts.apiKey || "").trim();
    var logLabel = String(opts.logLabel || "OPENAI_VISION").trim();
    var phone = String(opts.phone || "").trim();
    var maxRetries = (typeof opts.maxRetries === "number") ? opts.maxRetries : 2;
    if (!apiKey) return { ok: false, code: 0, err: "no_key" };
    if (typeof isOpenAICooldown_ === "function" && isOpenAICooldown_()) {
      try { if (typeof logDevSms_ === "function") logDevSms_(phone, "", logLabel + "_COOLDOWN"); } catch (_) {}
      return { ok: false, code: 429, err: "cooldown" };
    }
    var model = String(opts.model || "gpt-4o-mini").trim();
    try {
      var sp = PropertiesService.getScriptProperties();
      var visionModel = sp.getProperty("OPENAI_MODEL_VISION");
      if (visionModel && String(visionModel).trim()) model = String(visionModel).trim();
    } catch (_) {}
    var system = String(opts.system || "").trim();
    var userText = String(opts.userText || "").trim();
    var imageDataUrl = String(opts.imageDataUrl || "").trim();
    var imageUrl = String(opts.imageUrl || "").trim();
    var imageForApi = imageDataUrl || imageUrl;
    if (!imageForApi) return { ok: false, code: 0, err: "no_image_url" };
    var timeoutMs = (typeof opts.timeoutMs === "number") ? opts.timeoutMs : 20000;
    var userContent = [];
    if (userText) userContent.push({ type: "text", text: userText });
    userContent.push({ type: "image_url", image_url: { url: imageForApi } });
    var payload = {
      model: model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent }
      ]
    };
    function doFetch() {
      return UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + apiKey },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
        timeout: timeoutMs
      });
    }
    var res = null, code = 0;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try { res = doFetch(); code = res.getResponseCode(); } catch (_) {
        try { if (typeof logDevSms_ === "function") logDevSms_(phone, "", "MEDIA_SIGNAL_FAIL reason=fetch_err"); } catch (_) {}
        return { ok: false, code: 0, err: "fetch_err" };
      }
      if (code >= 200 && code < 300) {
        var content = "{}";
        try {
          var parsed = JSON.parse(res.getContentText());
          content = (parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content)
            ? parsed.choices[0].message.content : "{}";
        } catch (_) { return { ok: false, code: code, err: "parse" }; }
        var out = {};
        try { out = JSON.parse(content || "{}"); } catch (_) {}
        return { ok: true, code: code, json: out };
      }
      var retryable = (code === 429 || code === 503 || code === 500 || code === 408);
      var bodySnippet = "";
      try {
        if (code < 200 || code >= 300) {
          var raw = res.getContentText();
          if (raw != null && typeof raw === "string") bodySnippet = raw.replace(/\s+/g, " ").trim().slice(0, 180);
        }
      } catch (_) {}
      try { if (typeof logDevSms_ === "function") logDevSms_(phone, "", "MEDIA_SIGNAL_HTTP code=" + code + " body=" + (bodySnippet || "")); } catch (_) {}
      if (retryable && attempt < maxRetries) {
        Utilities.sleep((500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 251));
      } else {
        try { if (typeof logDevSms_ === "function") logDevSms_(phone, "", "MEDIA_SIGNAL_FAIL reason=retry_exhausted"); } catch (_) {}
        return { ok: false, code: code, err: "retry_exhausted" };
      }
    }
    return { ok: false, code: code, err: "retry_exhausted" };
  }

  /** Main shared adapter: run when media exists; one AI pass; return normalized media facts or safe fallback. */
  function imageSignalAdapter_(e, bodyText, phone) {
    var empty = {
      hasMedia: false, mediaCount: 0, mediaType: "", detectedObjects: [], extractedText: "",
      propertyHint: "", unitHint: "", tenantNameHint: "",
      issueHints: { category: "", subcategory: "", issueSummary: "", symptoms: [], attemptedFixes: [], locationsInUnit: [], safetySensitive: false },
      syntheticBody: "", confidence: 0, firstUrl: "", firstType: ""
    };
    var facts = extractInboundMediaFacts_(e);
    if (!facts.hasMedia || !facts.isImage || !facts.firstUrl) return empty;
    try {
      if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "MEDIA_SIGNAL_START type=image"); } catch (_) {}
    var imageDataUrl = (typeof fetchTwilioMediaAsDataUrl_ === "function") ? fetchTwilioMediaAsDataUrl_(facts.firstUrl) : "";
    if (!imageDataUrl) {
      try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "MEDIA_SIGNAL_FAIL reason=media_fetch_failed"); } catch (_) {}
      return { hasMedia: true, mediaCount: facts.mediaCount, mediaType: "unknown", detectedObjects: [], extractedText: "", propertyHint: "", unitHint: "", tenantNameHint: "", issueHints: empty.issueHints, syntheticBody: "", confidence: 0, firstUrl: facts.firstUrl, firstType: facts.firstType };
    }
    try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "MEDIA_SIGNAL_TRANSPORT inline_data_url"); } catch (_) {}
    var prompt = buildMediaSignalPrompt_(bodyText);
    var apiKey = "";
    try { apiKey = String(PropertiesService.getScriptProperties().getProperty("OPENAI_API_KEY") || "").trim(); } catch (_) {}
    if (!apiKey) {
      try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "MEDIA_SIGNAL_FAIL reason=no_key"); } catch (_) {}
      return { hasMedia: true, mediaCount: facts.mediaCount, mediaType: "unknown", detectedObjects: [], extractedText: "", propertyHint: "", unitHint: "", tenantNameHint: "", issueHints: empty.issueHints, syntheticBody: "", confidence: 0, firstUrl: facts.firstUrl, firstType: facts.firstType };
    }
    var result = openaiVisionJson_({
      apiKey: apiKey, imageDataUrl: imageDataUrl, imageUrl: facts.firstUrl, system: prompt.system, userText: prompt.user,
      phone: phone, timeoutMs: 20000, maxRetries: 2, logLabel: "MEDIA_SIGNAL"
    });
    if (!result.ok || !result.json) {
      try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "MEDIA_SIGNAL_FAIL reason=" + String(result.err || "no_json")); } catch (_) {}
      return { hasMedia: true, mediaCount: facts.mediaCount, mediaType: "unknown", detectedObjects: [], extractedText: "", propertyHint: "", unitHint: "", tenantNameHint: "", issueHints: empty.issueHints, syntheticBody: "", confidence: 0, firstUrl: facts.firstUrl, firstType: facts.firstType };
    }
    var j = result.json;
    var mediaType = String(j.mediaType || "unknown").trim().toLowerCase();
    if (["real_world_photo", "screenshot_chat", "screenshot_error_screen", "unknown"].indexOf(mediaType) === -1) mediaType = "unknown";
    var det = j.detectedObjects;
    if (!Array.isArray(det)) det = [];
    var issueHints = j.issueHints && typeof j.issueHints === "object" ? j.issueHints : {};
    var hints = {
      category: String(issueHints.category || "").trim(),
      subcategory: String(issueHints.subcategory || "").trim(),
      issueSummary: String(issueHints.issueSummary || "").trim(),
      symptoms: Array.isArray(issueHints.symptoms) ? issueHints.symptoms : [],
      attemptedFixes: Array.isArray(issueHints.attemptedFixes) ? issueHints.attemptedFixes : [],
      locationsInUnit: Array.isArray(issueHints.locationsInUnit) ? issueHints.locationsInUnit : [],
      safetySensitive: !!(issueHints.safetySensitive)
    };
    var syntheticBody = String(j.syntheticBody || "").trim();
    var confidence = typeof j.confidence === "number" ? Math.max(0, Math.min(1, j.confidence)) : 0;
    var propertyHint = String(j.propertyHint || "").trim();
    var unitHint = String(j.unitHint || "").trim();
    var tenantNameHint = String(j.tenantNameHint || "").trim();
    try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "MEDIA_SIGNAL_OK mediaType=" + mediaType + " conf=" + confidence); } catch (_) {}
    return {
      hasMedia: true, mediaCount: facts.mediaCount, mediaType: mediaType, detectedObjects: det, extractedText: String(j.extractedText || "").trim(),
      propertyHint: propertyHint, unitHint: unitHint, tenantNameHint: tenantNameHint,
      issueHints: hints, syntheticBody: syntheticBody, confidence: confidence, firstUrl: facts.firstUrl, firstType: facts.firstType
    };
  }

  /** Decide merged body for downstream: prefer existing body; use synthetic when body weak/empty. */
  function mergeMediaIntoBody_(bodyTrim, mediaFacts) {
    var body = String(bodyTrim || "").trim();
    var syn = (mediaFacts && mediaFacts.syntheticBody) ? String(mediaFacts.syntheticBody).trim() : "";
    if (typeof sanitizeSyntheticBodyFromMedia_ === "function" && mediaFacts) syn = sanitizeSyntheticBodyFromMedia_(syn, mediaFacts);
    var bodyWeak = !body || body.length <= 2 || (typeof isWeakIssue_ === "function" && isWeakIssue_(body));
    if (bodyWeak && syn) return syn;
    if (body && syn && !bodyWeak) {
      var lower = body.toLowerCase();
      if (syn.toLowerCase().indexOf(lower) !== -1 || lower.indexOf(syn.toLowerCase()) !== -1) return body;
      if (syn.length > 20 && body.length < 80) return body + " " + syn;
    }
    return body;
  }

  /** Conservative: is tenantNameHint from media trustworthy for metadata-only use (not for official ticket fields). */
  function isTrustworthyMediaTenantName_(nameHint, extractedText) {
    var name = String(nameHint || "").trim();
    if (!name) return false;
    if (name.length < 2 || name.length > 40) return false;
    var punctCount = (name.match(/[!@#$%^&*()_+=\[\]{}|;:'",.<>?~\-\\\/]/g) || []).length;
    if (punctCount > 2) return false;
    var labelWords = ["lady", "guy", "girl", "dude", "plumber", "maintenance", "boss", "new number"];
    var nameLower = name.toLowerCase();
    for (var i = 0; i < labelWords.length; i++) {
      if (nameLower.indexOf(labelWords[i]) !== -1) return false;
    }
    var ext = String(extractedText || "").trim();
    if (!ext) return false;
    if (ext.toLowerCase().indexOf(nameLower) === -1) return false;
    return true;
  }

  /** Optional: strip leading header-only name from syntheticBody when tenantNameHint is not trusted. */
  function sanitizeSyntheticBodyFromMedia_(syntheticBody, mediaFacts) {
    if (!syntheticBody || typeof syntheticBody !== "string") return syntheticBody || "";
    var syn = String(syntheticBody).trim();
    if (!syn) return "";
    var hint = (mediaFacts && mediaFacts.tenantNameHint) ? String(mediaFacts.tenantNameHint).trim() : "";
    if (!hint) return syn;
    var ext = (mediaFacts && mediaFacts.extractedText) ? String(mediaFacts.extractedText || "").trim() : "";
    if (typeof isTrustworthyMediaTenantName_ !== "function" || isTrustworthyMediaTenantName_(hint, ext)) return syn;
    var hintLower = hint.toLowerCase();
    var synLower = syn.toLowerCase();
    if (synLower.indexOf(hintLower) !== 0) return syn;
    var rest = syn.slice(hint.length);
    var fromApt = /^\s+from\s+(apt\.?|unit|apartment)\s*\d*\s*/i;
    var reports = /^\s+reports?\s+/i;
    if (fromApt.test(rest)) { var cleaned = rest.replace(fromApt, " ").trim(); return cleaned || syn; }
    if (reports.test(rest)) { var cleaned2 = rest.replace(reports, " ").trim(); return cleaned2 || syn; }
    return syn;
  }

  /** Attach normalized media info to turnFacts.meta for downstream. */
  function maybeAttachMediaFactsToTurn_(turnFacts, mediaFacts) {
    if (!turnFacts) return;
    turnFacts.meta = turnFacts.meta || {};
    if (!mediaFacts || !mediaFacts.hasMedia) return;
    turnFacts.meta.hasMedia = true;
    turnFacts.meta.mediaType = String(mediaFacts.mediaType || "").trim();
    if (turnFacts.meta.mediaUrls == null && mediaFacts.firstUrl) turnFacts.meta.mediaUrls = [mediaFacts.firstUrl];
    turnFacts.meta.mediaFirstType = String(mediaFacts.firstType || "").trim();
    turnFacts.meta.mediaExtractedText = String(mediaFacts.extractedText || "").trim();
    turnFacts.meta.mediaSyntheticBody = String(mediaFacts.syntheticBody || "").trim();
    turnFacts.meta.mediaConfidence = typeof mediaFacts.confidence === "number" ? mediaFacts.confidence : 0;
    turnFacts.meta.mediaDetectedObjects = Array.isArray(mediaFacts.detectedObjects) ? mediaFacts.detectedObjects.slice(0, 20) : [];
    turnFacts.meta.mediaCategoryHint = String((mediaFacts.issueHints && mediaFacts.issueHints.category) || "").trim();
    turnFacts.meta.mediaSubcategoryHint = String((mediaFacts.issueHints && mediaFacts.issueHints.subcategory) || "").trim();
    turnFacts.meta.mediaSafetySensitive = !!(mediaFacts.issueHints && mediaFacts.issueHints.safetySensitive);
    turnFacts.meta.mediaPropertyHint = String(mediaFacts.propertyHint || "").trim();
    turnFacts.meta.mediaUnitHint = String(mediaFacts.unitHint || "").trim();
    turnFacts.meta.mediaTenantNameHint = String(mediaFacts.tenantNameHint || "").trim();
    var trusted = (typeof isTrustworthyMediaTenantName_ === "function") && isTrustworthyMediaTenantName_(mediaFacts.tenantNameHint, mediaFacts.extractedText);
    turnFacts.meta.mediaTenantNameTrusted = !!trusted;
    try {
      if (turnFacts.meta.mediaTenantNameHint) logDevSms_("", "", trusted ? "MEDIA_NAME_HINT_TRUSTED name=[" + (turnFacts.meta.mediaTenantNameHint || "").slice(0, 30) + "]" : "MEDIA_NAME_HINT_REJECTED name=[" + (turnFacts.meta.mediaTenantNameHint || "").slice(0, 30) + "]");
    } catch (_) {}
  }

  /** Return payload for ticket attachment write (phase 1: first URL only). Caller wires into finalize/processTicket if desired. */
  function extractTicketMediaWritePayload_(turnFacts) {
    var urls = (turnFacts && turnFacts.meta && turnFacts.meta.mediaUrls) ? turnFacts.meta.mediaUrls : [];
    var first = Array.isArray(urls) && urls.length ? String(urls[0] || "").trim() : "";
    return { firstMediaUrl: first };
  }

  /**
  * Resolve / create the Drive folder used for Propera attachments.
  * Prefers explicit PROPERA_ATTACHMENTS_FOLDER_ID; otherwise falls back to root folder by name.
  * Optional Year/Month subfolders keep things tidy but are not required for correctness.
  *
  * Returns: Folder or null on failure (never throws). Logs ATTACH_FOLDER_OK / ATTACH_FOLDER_FAIL.
  */
  function getProperaAttachmentsFolder_() {
    var sp = null;
    try {
      sp = PropertiesService.getScriptProperties();
    } catch (_) {}

    var rootName = "Propera_Attachments";
    if (sp) {
      try {
        var nameProp = String(sp.getProperty("PROPERA_ATTACHMENTS_ROOT_NAME") || "").trim();
        if (nameProp) rootName = nameProp;
      } catch (_) {}
    }

    // 1) Explicit folder id wins when present and valid
    if (sp) {
      var folderId = "";
      try {
        folderId = String(sp.getProperty("PROPERA_ATTACHMENTS_FOLDER_ID") || "").trim();
      } catch (_) {}
      if (folderId) {
        try {
          var folderById = DriveApp.getFolderById(folderId);
          if (folderById) {
            try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FOLDER_OK id=[" + folderById.getId() + "]"); } catch (_) {}
            return folderById;
          }
        } catch (e) {
          try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FOLDER_FAIL reason=[invalid_id]"); } catch (_) {}
        }
      }
    }

    // 2) Fallback root folder by name at Drive root
    var rootFolder = null;
    try {
      var it = DriveApp.getFoldersByName(rootName);
      rootFolder = it.hasNext() ? it.next() : DriveApp.createFolder(rootName);
    } catch (e2) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FOLDER_FAIL reason=[root_create_err]"); } catch (_) {}
      return null;
    }

    // Optional: YYYY/MM subfolders for organization; fall back to rootFolder on any error
    var targetFolder = rootFolder;
    try {
      var now = new Date();
      var yearName = String(now.getFullYear());
      var month = now.getMonth() + 1;
      var monthName = (month < 10 ? "0" : "") + month;

      var yearFolders = targetFolder.getFoldersByName(yearName);
      targetFolder = yearFolders.hasNext() ? yearFolders.next() : targetFolder.createFolder(yearName);

      var monthFolders = targetFolder.getFoldersByName(monthName);
      targetFolder = monthFolders.hasNext() ? monthFolders.next() : targetFolder.createFolder(monthName);
    } catch (_) {
      targetFolder = targetFolder || rootFolder;
    }

    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FOLDER_OK id=[" + targetFolder.getId() + "]"); } catch (_) {}
    return targetFolder;
  }

  /**
  * Map media facts from Image Signal into a compact attachment kind label.
  * Keeps label stable so filenames are easy to scan.
  */
  function guessAttachmentKindFromMediaFacts_(mediaFacts) {
    var mf = mediaFacts || {};
    var mt = String(mf.mediaType || "").trim().toLowerCase();

    if (mt === "screenshot_chat") return "SCREENSHOT_CHAT";
    if (mt === "screenshot_error_screen") return "SCREENSHOT_ERROR";
    if (mt === "real_world_photo") {
      var cat = "";
      try {
        cat = String(mf.issueHints && mf.issueHints.category ? mf.issueHints.category : "").trim();
      } catch (_) {}
      return cat ? "PHOTO_ISSUE" : "PHOTO_UNKNOWN";
    }
    return "PHOTO_UNKNOWN";
  }

  /** Map MIME type to file extension for attachment filenames. */
  function guessAttachmentExtFromMime_(mime) {
    var m = String(mime || "").trim().toLowerCase();
    if (!m) return "bin";
    if (m === "image/jpeg" || m === "image/jpg") return "jpg";
    if (m === "image/png") return "png";
    if (m === "image/webp") return "webp";
    if (m === "image/heic") return "heic";
    if (m === "image/heif") return "heif";
    return "bin";
  }

  /**
  * Normalize a string for safe filename segments.
  * - Normalize whitespace to underscore
  * - Remove unsafe characters
  * - Collapse repeated underscores
  * - Cap length to ~40 characters
  */
  function sanitizeAttachmentNamePart_(s) {
    if (s == null) return "";
    var v = String(s).trim();
    if (!v) return "";
    // Normalize whitespace to underscore
    v = v.replace(/\s+/g, "_");
    // Remove characters that are unsafe or noisy in filenames
    v = v.replace(/[^A-Za-z0-9_\-]/g, "_");
    // Collapse repeated underscores
    v = v.replace(/_+/g, "_");
    // Trim leading/trailing underscores
    v = v.replace(/^_+|_+$/g, "");
    if (!v) return "";
    if (v.length > 40) v = v.slice(0, 40);
    return v;
  }

  /**
  * Build a human-readable attachment filename:
  *   {ticketId}__{attachmentKind}__{unitOrContext}.{ext}
  *
  * ticketId: required when present; fallback "UNFILED" otherwise.
  * Third segment prefers unit, else compact context hint (category/room), else omitted.
  */
  function buildReadableAttachmentFilename_(ticketId, mediaFacts, opts) {
    opts = opts || {};
    var rawTicketId = String(ticketId || "").trim();
    var idPart = rawTicketId || "UNFILED";

    var kind = guessAttachmentKindFromMediaFacts_(mediaFacts);
    var kindPart = sanitizeAttachmentNamePart_(kind || "ATTACHMENT");

    // Prefer explicit unit; otherwise derive a compact context hint from category/subcategory/room
    var unitRaw = String(opts.unit || "").trim();
    var contextHint = "";
    if (unitRaw) {
      contextHint = unitRaw;
    } else if (opts.contextHint) {
      contextHint = String(opts.contextHint || "").trim();
    } else if (mediaFacts && mediaFacts.issueHints) {
      var cat = String(mediaFacts.issueHints.category || "").trim();
      var sub = String(mediaFacts.issueHints.subcategory || "").trim();
      contextHint = cat || sub || "";
    }
    var thirdPart = sanitizeAttachmentNamePart_(contextHint);

    var ext = guessAttachmentExtFromMime_(opts.mime || (mediaFacts && mediaFacts.firstType));
    if (!ext) ext = "bin";

    var name = idPart + "__" + kindPart;
    if (thirdPart) name += "__" + thirdPart;
    name += "." + ext;
    return name;
  }

  /**
  * Fetch Twilio media as a raw blob using the same credentials as fetchTwilioMediaAsDataUrl_.
  *
  * Returns:
  *   { ok:true, blob:Blob, mime:"image/png" }
  *   { ok:false, err:"..." }
  *
  * Logs ATTACH_FETCH_OK / ATTACH_FETCH_FAIL.
  */
  function fetchTwilioMediaBlob_(mediaUrl) {
    var url = String(mediaUrl || "").trim();
    if (!url) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_FAIL reason=[no_url]"); } catch (_) {}
      return { ok: false, err: "no_url" };
    }

    var sid = "";
    var token = "";
    try {
      var sp = PropertiesService.getScriptProperties();
      sid = String(sp.getProperty("TWILIO_SID") || "").trim();
      token = String(sp.getProperty("TWILIO_TOKEN") || "").trim();
    } catch (_) {}

    if (!sid || !token) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_FAIL reason=[no_twilio_creds]"); } catch (_) {}
      return { ok: false, err: "no_twilio_creds" };
    }

    var res;
    try {
      res = UrlFetchApp.fetch(url, {
        method: "get",
        headers: { Authorization: "Basic " + Utilities.base64Encode(sid + ":" + token) },
        muteHttpExceptions: true
      });
    } catch (e) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_FAIL reason=[fetch_err]"); } catch (_) {}
      return { ok: false, err: "fetch_err" };
    }

    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_FAIL reason=[http_" + code + "]"); } catch (_) {}
      return { ok: false, err: "http_" + code };
    }

    var blob = null;
    var mime = "";
    try {
      blob = res.getBlob();
      mime = (blob && blob.getContentType()) ? String(blob.getContentType()).trim().toLowerCase().split(";")[0] : "";
    } catch (_) {}
    if (!mime) mime = "image/jpeg";

    var allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"];
    if (allowed.indexOf(mime) === -1) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_FAIL reason=[unsupported_type] type=" + mime); } catch (_) {}
      return { ok: false, err: "unsupported_type" };
    }

    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_OK type=[" + mime + "]"); } catch (_) {}
    return { ok: true, blob: blob, mime: mime };
  }

  /**
  * Build lightweight display metadata for an attachment for future use in logs or metadata fields.
  * For phase 1 this is only used in logs.
  */
  function extractAttachmentDisplayMeta_(mediaFacts, opts) {
    opts = opts || {};
    var mf = mediaFacts || {};
    var kind = guessAttachmentKindFromMediaFacts_(mf);
    var mediaType = String(mf.mediaType || "").trim();
    var unit = String(opts.unit || mf.unitHint || "").trim();
    var context = "";
    if (!unit) {
      try {
        if (mf.issueHints) {
          context = String(mf.issueHints.category || mf.issueHints.subcategory || "").trim();
        }
      } catch (_) {}
    }
    var readableName = buildReadableAttachmentFilename_(opts.ticketId || "UNFILED", mf, {
      unit: unit,
      contextHint: context || opts.contextHint || "",
      mime: opts.mime || mf.firstType
    });
    return {
      attachmentKind: kind,
      mediaType: mediaType,
      readableName: readableName
    };
  }

  /**
  * Save inbound Twilio media to Drive with a structured filename and return Drive metadata.
  *
  * Inputs:
  *   mediaUrl: Twilio media URL
  *   mediaFacts: compact facts (mediaType, issueHints.category/subcategory, unitHint)
  *   opts: { ticketId, unit, contextHint }
  *
  * Returns:
  *   {
  *     ok: true,
  *     fileId: "...",
  *     fileName: "...",
  *     webUrl: "...",
  *     downloadUrl: "...",
  *     mime: "...",
  *     attachmentKind: "..."
  *   }
  *   or { ok:false, err:"..." } on failure (never throws).
  *
  * Logs ATTACH_SAVE_OK / ATTACH_SAVE_FAIL.
  */
  function saveInboundAttachmentToDrive_(mediaUrl, mediaFacts, opts) {
    opts = opts || {};
    var folder = getProperaAttachmentsFolder_();
    if (!folder) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_SAVE_FAIL reason=[no_folder]"); } catch (_) {}
      return { ok: false, err: "no_folder" };
    }

    var fetchRes = fetchTwilioMediaBlob_(mediaUrl);
    if (!fetchRes || !fetchRes.ok) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_SAVE_FAIL reason=[fetch_fail]"); } catch (_) {}
      return { ok: false, err: "fetch_fail" };
    }

    var blob = fetchRes.blob;
    var mime = fetchRes.mime;

    var ticketId = String(opts.ticketId || "").trim() || "UNFILED";
    var filename = buildReadableAttachmentFilename_(ticketId, mediaFacts, {
      unit: opts.unit || "",
      contextHint: opts.contextHint || "",
      mime: mime
    });

    try {
      blob.setName(filename);
    } catch (_) {}

    var file;
    try {
      file = folder.createFile(blob);
    } catch (e) {
      try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_SAVE_FAIL reason=[create_err]"); } catch (_) {}
      return { ok: false, err: "create_err" };
    }

    var id = "";
    var webViewUrl = "";
    var downloadUrl = "";
    try {
      id = file.getId();
      // Use direct view/download URLs so the portal can open them directly.
      webViewUrl = "https://drive.google.com/uc?export=view&id=" + id;
      downloadUrl = "https://drive.google.com/uc?export=download&id=" + id;
    } catch (_) {}

    var kind = guessAttachmentKindFromMediaFacts_(mediaFacts);
    try {
      if (typeof logDevSms_ === "function") {
        var meta = extractAttachmentDisplayMeta_(mediaFacts, { ticketId: ticketId, unit: opts.unit || "", contextHint: opts.contextHint || "", mime: mime });
        logDevSms_("", "", "ATTACH_SAVE_OK id=[" + id + "] kind=[" + kind + "] name=[" + (meta && meta.readableName ? meta.readableName : filename) + "]");
      }
    } catch (_) {}

    return {
      ok: true,
      fileId: id,
      fileName: filename,
      webUrl: webViewUrl || file.getUrl(),
      downloadUrl: downloadUrl || "",
      mime: mime,
      attachmentKind: kind
    };
  }

  // Phase-1 manual test scenarios (no harness):
  // TEST 1 — tenant real photo + text: Body "which one do I switch...", image breaker panel → mediaType real_world_photo, category hint electrical, merged body to compileTurn_, no crash.
  // TEST 2 — tenant attachment-only: Body empty, NumMedia=1, thermostat image → syntheticBody if possible, hasMediaOnly false when synthetic strong, issue can append.
  // TEST 3 — staff # + screenshot chat: Body "#", image of tenant saying smoke detectors beeping → staff capture flow, merged payload from extracted text, compileTurn_ gets usable text.
  // TEST 4 — staff # + note + screenshot: Body "# apt 305 penn", screenshot → merged text includes complaint context.
  // TEST 5 — non-image media → adapter no-ops safely.
  // TEST 6 — AI failure/timeout → fallback, no break.

  /** Validator: schema object must have issues array with at least 1 item and summary strings. */
  function isValidSchemaIssues_(obj) {
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

  /** Schema-based issue extraction (LLM JSON) for long messages. Returns null on failure. */
  function extractIssuesSchema_(rawText, lang, phone) {
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
      "- Put availability/schedule in access_notes only.";

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
    if (!(typeof isValidSchemaIssues_ === "function") || !isValidSchemaIssues_(out)) return null;
    out.issue_count = (out.issues && out.issues.length) || 0;
    return out;
  }

  /** Apply schema extraction results to draft (PendingIssue, IssueBuffer) and access notes. Call inside dalWithLock_. */
  function applySchemaIssuesToDraft_(dir, dirRow, schema, phone) {
    if (!dir || !dirRow || dirRow < 2 || !schema || !isValidSchemaIssues_(schema)) return;
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

    // Append issues to IssueBuffer: when >=2, add primary first so buf.length=2 triggers multi-defer
    if (typeof appendIssueBufferItem_ === "function") {
      if (issues.length >= 2) {
        appendIssueBufferItem_(dir, dirRow, primary, "SCHEMA");
      }
      for (var k = 1; k < issues.length; k++) {
        var txt = String((issues[k] && issues[k].summary) || "").trim();
        if (txt) appendIssueBufferItem_(dir, dirRow, txt, "SCHEMA");
      }
    }

    // Access notes: draft-only (session + Directory). No ticket-sheet writes.
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


  // ------------------------------------------------------------
  // Preamble stripping (greeting + identity + property/unit/location)
  // Keep deterministic and conservative (don't eat real issue).
  // ------------------------------------------------------------
  function stripIssuePreamble_(s) {
    var t = String(s || "").trim();
    if (!t) return "";

    // greetings
    t = t.replace(/^\s*(hi|hey|hello|good (morning|afternoon|evening))\b[\s\,\.\-:]*/i, "");

    // "hey Nicholas," / "hi team," etc. (name up to 20 chars)
    t = t.replace(/^\s*[a-z]{2,}\s*,\s*/i, ""); // "Nicholas," at start

    // "this is ..." / "it's ..." prefix (short window)
    t = t.replace(/^\s*(this is|it'?s)\b[\s\S]{0,40}?\b(at|in|from)?\s*/i, "");

    // remove leading property/unit-like patterns:
    // "314 penn", "penn 314", "apt 314", "unit 314", "#314"
    t = t.replace(/^\s*(apt|apartment|unit|rm|room|suite|ste|#)\s*[\w\-]{1,6}\b[\s\,\.\-:]*?/i, "");
    t = t.replace(/^\s*\d{1,5}\s+[a-z]{2,}\b[\s\,\.\-:]*?/i, ""); // "314 penn"

    // contact-attempt (reuse existing behavior)
    if (typeof extractIssuePayload_ === "function") {
      try { t = extractIssuePayload_(t); } catch (_) {}
    }

    // collapse whitespace
    t = t.replace(/\s+/g, " ").trim();
    return t;
  }

  var PROBLEM_THRESHOLD = 30;

  function hasIssueNounKeyword_(text) {
    var t = String(text || "").toLowerCase();
    return /\b(ac|a\/c|heat|heater|sink|toilet|leak|water|breaker|outlet|door|lock|window|thermostat|shower|tub|faucet|drain|pipe|stove|oven|range|burner|washer|dryer|fridge|refrigerator|dishwasher|microwave|light|intercom)\b/.test(t);
  }

  function isRequestClausePattern_(text) {
    var t = String(text || "").toLowerCase().trim();
    if (!t) return false;
    if (/(^|\b)(have|send|get|schedule|dispatch|let|can|could|please)\b/.test(t)
        && /(someone|maintenance|team|you|it)\b/.test(t)) return true;
    if (/\b(have\s+someone|have\s+maintenance|can\s+someone|could\s+someone|please\s+have|send\s+someone|let\s+me\s+know|come\s+out|check\s+it|look\s+at\s+it)\b/.test(t)) return true;
    return false;
  }


  // ------------------------------------------------------------
  // Clause type classification
  // ------------------------------------------------------------
  function classifyIssueClauseType_(c) {
    var t = String(c || "").toLowerCase().trim();
    if (!t) return "other";

    if (typeof looksLikeGreetingOnly_ === "function" && looksLikeGreetingOnly_(t)) return "greeting";
    if (typeof looksLikeAckOnly_ === "function" && looksLikeAckOnly_(t)) return "ack";

    if (/\?$/.test(t)) return "question";
    if (/^\s*(when|what|how|why|can you|could you|is there|any chance|do you|will you)\b/.test(t)) return "question";

    // Supporting context (temporal, troubleshooting, emotion) — before actionable fallback so they don't become separate IssueBuffer items
    if (/\b(even after|maintenance came|tried adjusting|like they told|has been going on|going on for|getting frustrated|honestly getting|freezing at night|living room is freezing|over a month|over a week)\b/.test(t)) return "context";

    // attempt: troubleshooting / attempted check or fix — never wins as core issue
    if (typeof isAttemptedFixClause_ === "function" && isAttemptedFixClause_(t)) return "attempt";
    if (/^\s*(i tried|i've tried|i have tried)\b/i.test(t)) return "attempt";
    if (/\b(drain cleaner|plunged|plunging|reset|restarted|adjusted|turned the thermostat)\b/.test(t)) return "attempt";

    // schedule-intent only (e.g. "please have maintenance schedule to check it") — do not treat as second problem
    if (typeof isScheduleIntentOnly_ === "function" && isScheduleIntentOnly_(t)) return "other";

    // explicit request/action phrases should never be treated as separate problems
    if (isRequestClausePattern_(t)) return "request";

    // Short text with no fixture/system nouns is not a problem clause.
    if (t.length < 25 && !hasIssueNounKeyword_(t)) return "other";

    // problem: actionable clause wins even if it contains "still/again"
    if ((typeof looksActionableIssue_ === "function") && looksActionableIssue_(t)) return "problem";

    if (/\b(again|second|2nd|third|3rd|another|still|same issue|happened before|last time)\b/.test(t)) return "context";

    if (isResolvedOrDismissedClause_(t)) return "other";

    return "other";
  }


  // ------------------------------------------------------------
  // Scoring
  // ------------------------------------------------------------
  function scoreIssueClauseWithPos_(c, type, idx, total) {
    var score = 0;
    try { score = scoreIssueClause_(c, type); } catch (_) { score = 0; }

    // HARD NEGATIVE: explicitly resolved/dismissed clauses should never win
    if (isResolvedOrDismissedClause_(c)) score -= 200;

    // Deprioritize attempted-check/fix clauses so symptom/problem wins as title
    if (typeof isAttemptedFixClause_ === "function" && isAttemptedFixClause_(c)) score -= 180;

    // Soft preference for later clauses in long "bible" messages (real ask often appears later)
    if (total >= 6) {
      var frac = (total <= 1) ? 0 : (idx / (total - 1));
      score += Math.round(frac * 18);
    }

    return score;
  }

  function scoreIssueClause_(c, type) {
    var t = String(c || "").toLowerCase().trim();
    if (!t) return -999;

    // hard negatives
    if (type === "greeting" || type === "ack") return -500;
    if (type === "request") return -50;
    if (type === "question") return -50;
    if (type === "attempt") return -250;

    // Resolved/dismissed clauses should never win
    if (isResolvedOrDismissedClause_(t)) return -300;

    var score = 0;

    // problem verbs / failure phrases
    if (/(not working|doesn'?t work|broken|won'?t|wont|stopped|leak|clog|smell|noise|sparks|tripping|overflow|backup|no heat|no hot|not heating|not cooling)/.test(t)) score += 60;

    // nouns (appliance/fixture)
    if (/(sink|toilet|shower|tub|faucet|drain|pipe|stove|oven|range|burner|knob|washer|dryer|fridge|refrigerator|dishwasher|microwave|door|lock|window|outlet|light|breaker|thermostat|ac|a\/c|heater|heat|intercom)/.test(t)) score += 35;

    // safety indicators
    if (/(gas|smoke|fire|sparks|arcing|carbon monoxide|co alarm|flooding|sewage|backing up)/.test(t)) score += 80;

    // context adds small bonus (but shouldn't beat core problem)
    if (type === "context") score += 10;

    // length bonus (but capped)
    if (t.length >= 20) score += 10;
    if (t.length >= 40) score += 10;

    // penalty if mostly "time frame / availability"
    if (/(time frame|when can|what time|availability|available|come by|stop by|tomorrow|today|morning|afternoon|evening)/.test(t)) score -= 25;

    return score;
  }


  // ------------------------------------------------------------
  // Title normalization (more aggressive than normalizeIssueText_ but safe)
  // ------------------------------------------------------------
  function normalizeIssueTitle_(clause) {
    var t = String(clause || "").trim();
    if (!t) return "";

    // Strip wrappers/questions at start
    t = t.replace(/^\s*(just\s+)?(wanted to|want to|need to)\s+/i, "");
    t = t.replace(/^\s*(is there|any chance|can you|could you|would you)\b[\s\,\.\-:]*/i, "");

    // Remove "this is the 2nd one" from beginning; we'll re-add as qualifier later
    t = t.replace(/^\s*(this is|it'?s)\s+(the\s+)?(2nd|second|3rd|third)\b[\s\,\.\-:]*/i, "");

    // Prefer your existing normalizer
    if (typeof normalizeIssueText_ === "function") {
      try { t = normalizeIssueText_(t); } catch (_) {}
    }

    // Collapse trailing question fragments
    t = t.replace(/\b(is there a time frame|any time frame|when can you|what time frame)\b[\s\S]*$/i, "").trim();

    // Trim punctuation
    t = t.replace(/[\,\.\;\:\-]+$/g, "").trim();

    return t;
  }


  // ------------------------------------------------------------
  // Final polish: add qualifiers like "(second time)" or "(second knob)"
  // ------------------------------------------------------------
  function finalizeIssueTitlePolish_(title, fullCleaned) {
    var t = String(title || "").trim();
    if (!t) return "";

    var lowerFull = String(fullCleaned || "").toLowerCase();

    // Qualifiers
    var qual = "";
    if (/\b(second|2nd)\b/.test(lowerFull)) qual = "second";
    else if (/\b(third|3rd)\b/.test(lowerFull)) qual = "third";
    else if (/\bagain\b|\bstill\b|\bsame issue\b/.test(lowerFull)) qual = "repeat";

    // Specific stove knob nuance
    if (/\bstove\b/.test(lowerFull) && /\bknob\b/.test(lowerFull) && /\b(second|2nd)\b/.test(lowerFull)) {
      return ensureParenQualifier_(t, "second knob");
    }

    if (qual === "second") return ensureParenQualifier_(t, "second time");
    if (qual === "third") return ensureParenQualifier_(t, "third time");
    if (qual === "repeat") return ensureParenQualifier_(t, "repeat");

    return t;
  }

  function ensureParenQualifier_(title, q) {
    var t = String(title || "").trim();
    var qual = String(q || "").trim();
    if (!t || !qual) return t;
    if (/\)\s*$/.test(t)) return t; // already has qualifier
    return t + " (" + qual + ")";
  }

  /** Build one deterministic summary from multiple problem clauses (order preserved, semicolon-separated). Used for staff capture multi-issue title only. */
  function buildCombinedIssueTitleFromClauses_(clauses) {
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


  // ------------------------------------------------------------
  // Details builder: keep only useful non-schedule, non-ack content
  // ------------------------------------------------------------
  function buildIssueDetails_(clauses, coreIdx) {
    if (!clauses || !clauses.length) return "";
    var out = [];
    for (var i = 0; i < clauses.length; i++) {
      if (i === coreIdx) continue;
      var c = clauses[i] || {};
      if (!c.text) continue;
      if (c.type === "greeting" || c.type === "ack") continue;
      if (c.type === "schedule") continue;

      var text = String(c.text || "").trim();
      if (!text) continue;

      // Keep questions as details (helpful), but short
      if (text.length > 220) text = text.slice(0, 220);
      out.push(text);
    }
    var joined = out.join(" | ").trim();
    if (joined.length > 450) joined = joined.slice(0, 450);
    return joined;
  }


  // ------------------------------------------------------------
  // Subcategory (optional)
  // ------------------------------------------------------------
  function detectSubcategory_(title, details) {
    var t = (String(title || "") + " " + String(details || "")).toLowerCase();
    if (!t.trim()) return "";

    if (/\bstove\b|\boven\b|\brange\b/.test(t) && /\bknob\b/.test(t)) return "Stove knob";
    if (/\bclog\b|\bclogged\b|\bdrain\b/.test(t)) return "Clog";
    if (/\bleak\b|\bleaking\b|\bdrip\b/.test(t)) return "Leak";
    if (/\bno heat\b|\bheat\b/.test(t)) return "No heat";
    if (/\block\b|\bkey\b|\blocked out\b/.test(t)) return "Lock/Key";

    return "";
  }


  // ------------------------------------------------------------
  // Urgency (deterministic)
  // ------------------------------------------------------------
  function detectUrgency_(title, details) {
    var t = (String(title || "") + " " + String(details || "")).toLowerCase();

    // Detector/alarm maintenance false-positive: battery, beeping, chirping → normal (not urgent)
    var detectorMaint = /\b(battery|batteries|beeping|beep|chirping|chirp|replacement|replace|low battery|new battery)\b/.test(t) && /\b(detector|alarm|smoke alarm|co alarm)\b/.test(t);
    var activeDanger = /\b(smell smoke|smoke coming from|see smoke|flames|on fire|burning|gas smell|smell gas)\b/.test(t) || /\bco alarm\s+(going off|alarming)\b/.test(t);
    if (detectorMaint && !activeDanger) return "normal";

    // Emergency / safety
    if (/(gas smell|smell gas|carbon monoxide|co alarm|smoke|fire|sparks|arcing|electrical arc)/.test(t)) return "urgent";
    if (/(flooding|flood|sewage|backing up|overflowing)/.test(t)) return "urgent";

    // High priority comfort outages
    if (/(no heat|heat not working|no hot water|hot water not working)/.test(t)) return "high";
    if (/(no power|power out|lost power)/.test(t)) return "high";
    if (/(leak|leaking|water leak)/.test(t)) return "high";

    return "normal";
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
  // NEVER overwrites existing values.
  // ============================================================
  function draftUpsertFromTurn_(dir, dirRow, turnFacts, bodyTrim, phone, sessionOpt) {
    if (!dirRow || dirRow < 2) return false;

    var didWriteIssue = false;
    var schemaObjPre = null;
    var schemaGateUsed = false;
    if (bodyTrim && (typeof isSchemaExtractEnabled_ === "function") && isSchemaExtractEnabled_()) {
      var gatePre = (typeof shouldUseSchemaExtract_ === "function") ? shouldUseSchemaExtract_(bodyTrim) : { use: false, reason: "" };
      schemaGateUsed = gatePre.use;
      if (gatePre.use) {
        if ((typeof isOpenAICooldown_ === "function") && isOpenAICooldown_()) {
          try { logDevSms_(phone, (bodyTrim || "").slice(0, 40), "SCHEMA_GATE skip=1 reason=[cooldown]"); } catch (_) {}
          schemaGateUsed = false;
        } else if (typeof extractIssuesSchema_ === "function") {
          var langPre = (turnFacts && turnFacts.lang) ? String(turnFacts.lang || "en").toLowerCase() : "en";
          try { schemaObjPre = extractIssuesSchema_(bodyTrim, langPre, phone); } catch (_) {}
          try { logDevSms_(phone, (bodyTrim || "").slice(0, 40), "SCHEMA_GATE use=1 reason=[" + (gatePre.reason || "") + "]"); } catch (_) {}
        } else {
          try { logDevSms_(phone, (bodyTrim || "").slice(0, 40), "SCHEMA_GATE use=0 reason=[" + (gatePre.reason || "") + "]"); } catch (_) {}
        }
      }
    }
    // Apply schema in its own lock (fetch done above, no lock during network call)
    if (schemaObjPre && (typeof isValidSchemaIssues_ === "function") && isValidSchemaIssues_(schemaObjPre) && typeof applySchemaIssuesToDraft_ === "function") {
      try {
        withWriteLock_("SCHEMA_APPLY", function () { applySchemaIssuesToDraft_(dir, dirRow, schemaObjPre, phone); });
        didWriteIssue = true;
        try { logDevSms_(phone, "", "SCHEMA_EXTRACT ok=1 n=" + (schemaObjPre.issues ? schemaObjPre.issues.length : 0)); } catch (_) {}
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

        // 2) Unit (F) — compiler first, then extractUnit_ fallback
        var existingUnit = String(dir.getRange(dirRow, 6).getValue() || "").trim();
        if (!existingUnit) {
          var unitCandidate = (turnFacts && turnFacts.unit) ? normalizeUnit_(turnFacts.unit) : "";
          if (!unitCandidate) {
            var raw = extractUnit_(bodyTrim);
            if (raw) unitCandidate = normalizeUnit_(raw);
          }
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
          var issueCandidate = ""; // set by mixed property+issue split; do not mutate bodyTrim
          var hasActionable = (typeof looksActionableIssue_ === "function") && looksActionableIssue_(bodyTrim);
          if ((typeof isScheduleWindowLike_ === "function") && isScheduleWindowLike_(bodyTrim)) {
            if (!hasActionable) {
              skipIssueAppend = true;
              try { logDevSms_(phone, (bodyTrim || "").slice(0, 20), "ISSUE_APPEND_SKIP reason=[schedule_like]"); } catch (_) {}
            } else {
              try { logDevSms_(phone, (bodyTrim || "").slice(0, 20), "ISSUE_SCHED_MIXED allow_issue=1"); } catch (_) {}
            }
          }
          // Only suppress issue when message is a property answer, not when property appears embedded in a long report.
          // Skip this gate for structured intake (portal/PM form): message is the dedicated issue field.
          var propertyAnswerLike = (typeof looksLikePropertyAnswer_ === "function" && looksLikePropertyAnswer_(bodyTrim)) ||
            (String(bodyTrim || "").trim().length <= 18 && turnFacts && turnFacts.property && turnFacts.property.code);
          if (!structuredIntake && turnFacts && turnFacts.property && turnFacts.property.code && propertyAnswerLike) {
            skipIssueAppend = true;
            try { logDevSms_(phone, (bodyTrim || "").slice(0, 20), "ISSUE_APPEND_SKIP reason=[property_detected]"); } catch (_) {}
          }
          if (st === "PROPERTY" && !structuredIntake) {
            const lower = String(bodyTrim || "").toLowerCase().trim();
            if (/^\s*[1-9]\s*$/.test(lower)) { skipIssueAppend = true; try { logDevSms_(phone, (bodyTrim || "").slice(0, 20), "ISSUE_APPEND_SKIP reason=[property_menu_digit]"); } catch (_) {} }
            else if (/grand/i.test(lower)) {
              const looksPureProp = (lower.length <= 24) && (lower.indexOf("fix") === -1) && (lower.indexOf("also") === -1);
              if (looksPureProp) { skipIssueAppend = true; try { logDevSms_(phone, (bodyTrim || "").slice(0, 40), "ISSUE_APPEND_SKIP reason=[property_grand_pure]"); } catch (_) {} }
              try { logDevSms_(phone, (bodyTrim || "").slice(0, 40), "ISSUE_SKIP_GRAND pure=[" + (looksPureProp ? 1 : 0) + "]"); } catch (_) {}
            }
            if (!skipIssueAppend) {
              try {
                const propsList = (typeof getActiveProperties_ === "function") ? getActiveProperties_() : [];
                if (propsList && propsList.length) {
                  for (let i = 0; i < propsList.length; i++) {
                    const p = propsList[i];
                    const name = String(p.name || "").toLowerCase();
                    const code = String(p.code || "").toLowerCase();
                    if ((name && lower.indexOf(name) >= 0) || (code && lower.indexOf(code) >= 0)) {

                      // Mixed: property + multiple issues in one message.
                      // Extract ALL issue clauses deterministically; never drop content.
                      var propTokLower = (name && lower.indexOf(name) >= 0) ? name : code;
                      var issues = extractMixedIssuesAfterProperty_(lower, propTokLower);

                      if (issues && issues.length) {
                        skipIssueAppend = false;
                        issueCandidate = issues[0];
                        try { logDevSms_(phone, issues[0], "ISSUE_MIXED_SPLIT ok"); } catch (_) {}
                        // Remaining issues go into IssueBuf only if type=problem (no context/troubleshooting as separate items)
                        for (var ii = 1; ii < issues.length; ii++) {
                          var issuePart = issues[ii];
                          if (typeof classifyIssueClauseType_ === "function" && classifyIssueClauseType_(issuePart) !== "problem") continue;
                          if (typeof appendIssueBufferItem_ === "function") {
                            try { appendIssueBufferItem_(dir, dirRow, issuePart, st); } catch (_) {}
                          }
                        }
                      } else {
                        skipIssueAppend = true;
                        try { logDevSms_(phone, (bodyTrim || "").slice(0, 20), "ISSUE_APPEND_SKIP reason=[property_match]"); } catch (_) {}
                      }
                      break;
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
          if (structuredIntake && (turnFacts && turnFacts.issue ? String(turnFacts.issue).trim() : bodyTrim).length >= 4) {
            issueText = (turnFacts && turnFacts.issue) ? String(turnFacts.issue).trim() : bodyTrim;
            isActionable = true;
          }
          if (!schemaApplied && !structuredIntake) {
            issueText = (typeof extractIssuePayload_ === "function") ? extractIssuePayload_(issueText) : issueText;

            // ── Deterministic parse first (prefer compileTurn_ output) ──
            parsedIssue = (turnFacts && turnFacts.issueMeta) ? turnFacts.issueMeta : null;
            if (!parsedIssue && typeof parseIssueDeterministic_ === "function") {
              try { parsedIssue = parseIssueDeterministic_(issueText, {}); } catch (_) {}
            }
            // Actionable check on selected clause/title, not full body (avoids "fixed itself" in preamble killing real issue)
            var actionableText = (parsedIssue && (parsedIssue.bestClauseText || parsedIssue.title))
              ? (parsedIssue.bestClauseText || parsedIssue.title)
              : issueText;
            isActionable = (typeof looksActionableIssue_ === "function") && looksActionableIssue_(actionableText);

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

            const pendingRow = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0;
            var existingIssue = String(dir.getRange(dirRow, 5).getValue() || "").trim();
            if (pendingRow <= 0) {
              var _sess = sessionOpt && (sessionOpt.draftIssue !== undefined) ? sessionOpt : (typeof sessionGet_ === "function" ? sessionGet_(phone) : null);
              if (_sess && _sess.draftIssue) existingIssue = String(_sess.draftIssue || "").trim();
            }

            if (newDetail) {
              let merged = existingIssue;

              if (!merged) {
                merged = newDetail;
              } else if (pendingRow <= 0 && (typeof isWeakIssue_ === "function") && (typeof looksSpecificIssue_ === "function") && isWeakIssue_(existingIssue) && looksSpecificIssue_(newDetail)) {
                merged = newDetail;
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
        var scheduleCandidateRaw = "";
        if (turnFacts && turnFacts.schedule && turnFacts.schedule.raw && (typeof isScheduleWindowLike_ === "function") && isScheduleWindowLike_(turnFacts.schedule.raw)) scheduleCandidateRaw = String(turnFacts.schedule.raw || "").trim();
        else if (typeof isScheduleWindowLike_ === "function" && isScheduleWindowLike_(bodyTrim)) scheduleCandidateRaw = String(bodyTrim || "").trim();
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
                  try { logDevSms_(phone, bodyTrim, "DRAFT_UPSERT schedule=[" + scheduleCandidateRaw.slice(0, 60) + "]"); } catch (_) {}
                }
              }
            } catch (_) {}
          } else if (pendingRowSched < 2 && typeof DIR_COL !== "undefined") {
            try {
              const draftCol = DIR_COL.DRAFT_SCHEDULE_RAW;
              const existingDraft = String(dir.getRange(dirRow, draftCol).getValue() || "").trim();
              if (!existingDraft) {
                dir.getRange(dirRow, draftCol).setValue(scheduleCandidateRaw);
                try { logDevSms_(phone, bodyTrim, "DRAFT_UPSERT schedule_saved_draft raw=[" + scheduleCandidateRaw.slice(0, 60) + "]"); } catch (_) {}
              }
            } catch (_) {}
          } else {
            try { logDevSms_(phone, bodyTrim, "DRAFT_UPSERT schedule_ignored_no_ptr raw=[" + scheduleCandidateRaw.slice(0, 40) + "]"); } catch (_) {}
          }
        }

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
      return didWriteIssue;
    } catch (err) {
      try { logDevSms_(phone, bodyTrim, "DRAFT_UPSERT_ERR " + String(err && err.message ? err.message : err)); } catch (_) {}
      return false;
    }
  }

  // One open per execution for ticket sheet (avoids reopen each inbound).
  function getLogSheet_() {
    if (!globalThis.__logSheetCache) {
      const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
      globalThis.__logSheetCache = ss.getSheetByName(SHEET_NAME);
    }
    return globalThis.__logSheetCache;
  }

  // ============================================================
  // RECOMPUTE DRAFT EXPECTED (Propera Compass — FIX B)
  // Intake order: Issue → Property → Unit → Schedule.
  // Reads Directory and (when pendingRow>0) ticket row for completeness.
  // pendingRow>0 does NOT imply schedule present; schedule = ticket PREF_WINDOW.
  // ============================================================
  function recomputeDraftExpected_(dir, dirRow, phone, sessionOpt) {
    if (!dirRow || dirRow < 2 || !dir) return;
    try {
      var pendingRow = dalGetPendingRow_(dir, dirRow);
      var currentStage = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();
      var session = (sessionOpt != null) ? sessionOpt : ((typeof sessionGet_ === "function") ? sessionGet_(phone) : null);
      if (pendingRow <= 0 && session && (session.stage || session.expected)) {
        currentStage = String(session.stage || session.expected || "").trim().toUpperCase();
      }
      try {
        logDevSms_(phone, "", "RECOMPUTE_ENTRY stage=[" + currentStage + "]");
      } catch (_) {}
      if (currentStage === "EMERGENCY_DONE") return;

      var hasIssue = Boolean(dalGetPendingIssue_(dir, dirRow));
      var hasProperty = Boolean(dalGetPendingProperty_(dir, dirRow).code);
      var pendingUnit = String(dalGetPendingUnit_(dir, dirRow) || "").trim();
      var canonUnit   = String(dalGetUnit_(dir, dirRow) || "").trim();
      var hasUnit     = Boolean(pendingUnit || canonUnit);
      var hasSchedule = false;

      if (pendingRow <= 0 && session) {
        if (session.draftIssue) hasIssue = true;
        if (session.draftProperty) hasProperty = true;
        if (session.draftUnit) hasUnit = true;
        if (session.draftScheduleRaw) hasSchedule = true;
        var buf = session.issueBuf;
        if (buf && buf.length >= 1) hasIssue = true;
      }

      if (pendingRow >= 2 && typeof COL !== "undefined") {
        try {
          const sheet = getLogSheet_();
          if (sheet && pendingRow <= sheet.getLastRow()) {
            const ticketMsg = String(sheet.getRange(pendingRow, COL.MSG).getValue() || "").trim();
            const ticketUnit = String(sheet.getRange(pendingRow, COL.UNIT).getValue() || "").trim();
            const ticketSched = String(sheet.getRange(pendingRow, COL.PREF_WINDOW).getValue() || "").trim();
            if (!hasIssue && ticketMsg) hasIssue = true;
            if (!hasIssue) hasIssue = true; // ticket exists → issue committed; avoid fallback to ISSUE after finalize clears dir col 5
            if (!hasUnit && ticketUnit) hasUnit = true;
            hasSchedule = Boolean(ticketSched);
          }
        } catch (_) {}
      } else {
        hasSchedule = Boolean(String(dir.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.DRAFT_SCHEDULE_RAW : 13).getValue() || "").trim());
      }

  let next = "";

  if (!hasIssue) next = "ISSUE";
  else if (!hasProperty) next = "PROPERTY";
  else if (!hasUnit) next = "UNIT";
  else {
    if (pendingRow > 0 && !hasSchedule) {
      next = "SCHEDULE";
    } else if (pendingRow <= 0) {
      next = "FINALIZE_DRAFT";
    } else {
      next = "";
    }
  }

  // GUARD: Emergency must never transition to SCHEDULE. Durable-first (Directory, Ticket, WI, then ctx).
  if (next === "SCHEDULE") {
    try {
      var _ctx = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
      var _em = (typeof isEmergencyContinuation_ === "function") ? isEmergencyContinuation_(dir, dirRow, _ctx, phone) : { isEmergency: false, source: "" };
      if (_em.isEmergency || (_ctx && _ctx.skipScheduling === true)) {
        next = "EMERGENCY_DONE";
        try { logDevSms_(phone, "", "EMERGENCY_STAGE_OVERRIDE prev=[SCHEDULE] next=[EMERGENCY_DONE] source=[" + (_em.source || "ctx") + "]"); } catch (_) {}
        try { logDevSms_(phone, "", "EMERGENCY_SKIP_SCHEDULE reason=[emergency_continuation]"); } catch (_) {}
      }
    } catch (_) {}
  }

  // compute expiry BEFORE any return paths
  const expiryMins = (next === "SCHEDULE") ? 30 : 10;
  const pendingExpiresAtIso =
    next ? new Date(Date.now() + expiryMins * 60 * 1000).toISOString() : "";

  // DRAFT-ONLY RULE: once an active ticket exists, recompute must NOT destabilize stage ownership.
  // For active tickets (pendingRow >= 2), only allow explicit continuation stages to be written.
  if (pendingRow >= 2) {
    const contWhitelist = ["UNIT", "SCHEDULE", "DETAIL", "EMERGENCY_DONE"];
    if (!next) {
      try { logDevSms_(phone, "", "EXPECT_RECOMPUTED_NEXT_EMPTY keep_stage current=[" + currentStage + "]"); } catch (_) {}
      return;
    }
    if (contWhitelist.indexOf(String(next).toUpperCase()) === -1) {
      try { logDevSms_(phone, "", "EXPECT_RECOMPUTED_BLOCKED active_ticket next=[" + next + "] current=[" + currentStage + "]"); } catch (_) {}
      try { logInvariantFail_(phone, "", "EXPECT_RECOMPUTED_BLOCKED", "next=" + next + " current=" + currentStage); } catch (_) {}
      return;
    }
  }

  // Early exit if stage unchanged (keep Session + ctx synced for pre-ticket)
  if (next === currentStage) {
    if (pendingRow <= 0 && typeof sessionUpsert_ === "function") {
      sessionUpsert_(phone, {
        stage: next,
        expected: next,
        expiresAtIso: pendingExpiresAtIso
      }, "recomputeDraftExpected_sync");
    }
    if (typeof ctxUpsert_ === "function") {
      ctxUpsert_(phone, {
        pendingExpected: next,
        pendingExpiresAt: pendingExpiresAtIso
      }, "recomputeDraftExpected_sync");
    }
    try {
      logDevSms_(phone, "", "EXPECT_RECOMPUTED_SKIP same_stage=[" + next + "]");
    } catch (_) {}
    return;
  }


      if (pendingRow <= 0) {
        if (typeof sessionUpsert_ === "function") {
          sessionUpsert_(phone, {
            stage: next,
            expected: next,
            expiresAtIso: pendingExpiresAtIso
          }, "recomputeDraftExpected_");
        }
        if (typeof ctxUpsert_ === "function") {
          ctxUpsert_(phone, {
            pendingExpected: next,
            pendingExpiresAt: pendingExpiresAtIso
          }, "recomputeDraftExpected_cache");
        }
      } else {
        dalSetPendingStage_(dir, dirRow, next, phone, "recomputeDraftExpected_");
        if (typeof ctxUpsert_ === "function") {
          ctxUpsert_(phone, {
            pendingExpected: next,
            pendingExpiresAt: pendingExpiresAtIso
          }, "recomputeDraftExpected_");
        }
      }
      try {
        logDevSms_(phone, "", "EXPECT_RECOMPUTED expected=[" + next + "] reason=[draft_completeness] issue=[" + (hasIssue ? "1" : "0") + "] prop=[" + (hasProperty ? "1" : "0") + "] unit=[" + (hasUnit ? "1" : "0") + "] sched=[" + (hasSchedule ? "1" : "0") + "]");
      } catch (_) {}
    } catch (_) {}
  }

  // ============================================================
  // RESOLVE EFFECTIVE TICKET STATE (Propera Compass)
  // ===================================================================
  // ===== M6 — STATE RESOLVER ==========================================
  // @MODULE:M6
  // Responsibilities:
  // - Determine effectiveStage deterministically
  //
  // STRICT RULE:
  // - READ ONLY
  // - NO writes
  // - NO replies
  // ===================================================================
  // Single canonical resolver — called once per inbound after
  // compileTurn_ + draftUpsertFromTurn_.
  //
  // Returns:
  //   { stateType: "CONTINUATION" | "DRAFT" | "NEW", stage: string }
  // ============================================================
  function resolveEffectiveTicketState_(dir, dirRow, ctx, session) {
    if (!dirRow || dirRow < 2) return { stateType: "NEW", stage: "" };

    var pendingRow   = dalGetPendingRow_(dir, dirRow);
    var pendingStage = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();

    const continuationStages = ["UNIT", "SCHEDULE", "DETAIL"];
    const draftStages = ["PROPERTY", "UNIT", "ISSUE", "CONFIRM_CONTEXT", "FINALIZE_DRAFT", "INTENT_PICK", "SCHEDULE_DRAFT_MULTI"];

    // Ticket-bound stage with no ticket row: normalize to draft (avoid SCHEDULE without PendingRow)
    if (pendingRow < 2 && continuationStages.indexOf(pendingStage) !== -1) {
      return { stateType: "DRAFT", stage: "ISSUE" };
    }
    // Draft-only multi-issue schedule stage (valid without PendingRow)
    if (pendingRow < 2 && pendingStage === "SCHEDULE_DRAFT_MULTI") {
      return { stateType: "DRAFT", stage: "SCHEDULE_DRAFT_MULTI" };
    }

    // Pre-ticket: Session is authoritative when pendingRow <= 0
    if (pendingRow <= 0 && session) {
      var sessionStage = String(session.stage || session.expected || "").trim().toUpperCase();
      if (sessionStage && draftStages.indexOf(sessionStage) !== -1) {
        return { stateType: "DRAFT", stage: sessionStage };
      }
      if (sessionStage && continuationStages.indexOf(sessionStage) !== -1) {
        return { stateType: "CONTINUATION", stage: sessionStage };
      }
    }

    // Priority 1: EMERGENCY_DONE — always continuation
    if (pendingStage === "EMERGENCY_DONE") {
      return { stateType: "CONTINUATION", stage: "EMERGENCY_DONE" };
    }

    // Priority 2: Active ticket (pointer + continuation stage)
    if (pendingRow > 0 && continuationStages.includes(pendingStage)) {
      return { stateType: "CONTINUATION", stage: pendingStage };
    }

    // Priority 3: Draft in progress (Directory — only when pendingRow <= 0 and Session did not apply)
    if (pendingRow <= 0 && draftStages.includes(pendingStage)) {
      return { stateType: "DRAFT", stage: pendingStage };
    }

    // Priority 4: ctx self-heal (Directory may have been cleared)
    if (ctx) {
      const ctxExp = String(ctx.pendingExpected || "").trim().toUpperCase();
      if (continuationStages.includes(ctxExp) && pendingRow > 0) {
        return { stateType: "CONTINUATION", stage: ctxExp };
      }
      if (draftStages.includes(ctxExp) && pendingRow <= 0) {
        return { stateType: "DRAFT", stage: ctxExp };
      }
    }

    // pendingRow > 0 means draft/ticket exists — never NEW; stage never empty
    // GUARD: Emergency must never resolve to SCHEDULE. Use durable sources first (Directory, Ticket, WI, then ctx).
    if (pendingRow > 0) {
      var emCont = (typeof isEmergencyContinuation_ === "function") ? isEmergencyContinuation_(dir, dirRow, ctx, (ctx && ctx.phoneE164) || "") : { isEmergency: false, source: "" };
      if (emCont.isEmergency) {
        return { stateType: "CONTINUATION", stage: "EMERGENCY_DONE" };
      }
      const ctxExp2 = ctx ? String(ctx.pendingExpected || "").trim().toUpperCase() : "";
      let stage = "";
      if (continuationStages.includes(pendingStage)) stage = pendingStage;
      else if (continuationStages.includes(ctxExp2)) stage = ctxExp2;
      else stage = "SCHEDULE";
      return { stateType: "CONTINUATION", stage: stage };
    }

    return { stateType: "NEW", stage: "" };
  }

  // ============================================================
  // DRAFT DECISION ENGINE (Propera Compass — Draft-First)
  // Returns the next missing required field, or "READY".
  // Unit is intentionally NOT required before ticket creation.
  // ============================================================
  function draftDecideNextStage_(dir, dirRow) {
    if (!dirRow || dirRow < 2) return "PROPERTY";

    var propCode = dalGetPendingProperty_(dir, dirRow).code;
    var issue    = dalGetPendingIssue_(dir, dirRow);

    if (!propCode) return "PROPERTY";
    var buf = getIssueBuffer_(dir, dirRow);
    var hasIssue = Boolean(issue) || (buf && buf.length >= 1);
    if (!hasIssue) return "ISSUE";
    return "READY";
  }

  // ============================================================
  // ISSUE BUFFER (Parent Visit + Child Tickets)
  // Col DIR_COL.ISSUE_BUF_JSON: JSON array of { rawText, createdAt, sourceStage } (single-line for cell).
  // ============================================================
  function singleLine_(s) {
    return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+/g, " | ").trim();
  }

  function getIssueBuffer_(dir, dirRow) {
    if (!dir || !dirRow || dirRow < 2) return [];
    try {
      var raw = String(dir.getRange(dirRow, DIR_COL.ISSUE_BUF_JSON).getValue() || "").trim();
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function setIssueBuffer_(dir, dirRow, arr) {
    if (!dir || !dirRow || dirRow < 2) return;
    var val = Array.isArray(arr) ? JSON.stringify(arr) : "[]";
    val = singleLine_(val);
    dir.getRange(dirRow, DIR_COL.ISSUE_BUF_JSON).setValue(val);
  }

  function issueTextKey_(s) {
    var t = String(s || "").toLowerCase().trim();
    if (!t) return "";
    t = t.replace(/^[\s\-\,\.\|:;]+/, "");
    t = t.replace(/^(and|also|plus)\s+/i, "");
    t = t.replace(/[^\w\s]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  }

  function mergedIssueFromBuffer_(issue, buf, maxLen) {
    var header = String(issue || "").trim() || ((buf && buf[0] && buf[0].rawText) ? String(buf[0].rawText).trim() : "");
    var merged = header;
    var addedHeader = false;
    var seen = {};

    var headerParts = String(header || "").split(/\s*\|\s*/);
    for (var hp = 0; hp < headerParts.length; hp++) {
      var hk = issueTextKey_(headerParts[hp]);
      if (hk) seen[hk] = 1;
    }

    for (var j = 0; j < Math.min(5, (buf || []).length); j++) {
      var part = (buf[j] && buf[j].rawText) ? String(buf[j].rawText).trim().slice(0, 120) : "";
      if (!part) continue;
      var key = issueTextKey_(part);
      if (!key || seen[key]) continue;
      seen[key] = 1;
      if (!addedHeader) { merged += "\n\nAdditional items:"; addedHeader = true; }
      merged += "\n- " + part;
    }

    var cap = (typeof maxLen === "number" && maxLen > 0) ? maxLen : 900;
    if (merged.length > cap) merged = merged.slice(0, cap);
    return merged;
  }

  /** Append one item with fragment coalescing; call inside withWriteLock_. */
  function appendIssueBufferItem_(dir, dirRow, rawText, sourceStage) {
    var normalized = String(rawText || "").trim();
    if (!dir || !dirRow || dirRow < 2 || !normalized) return;
    var buf = getIssueBuffer_(dir, dirRow);
    // Deterministic de-dupe: same normalized text should not exist twice.
    // This prevents double-append from draftUpsert + SCHEDULE_ADD in the same inbound.
    for (var i = buf.length - 1; i >= 0; i--) {
      var rt = String((buf[i] && buf[i].rawText) || "").trim();
      if (rt && rt === normalized) {
        try { logDevSms_("", "", "ISSUEBUF_DEDUP_SKIP match=1"); } catch (_) {}
        return;
      }
    }
    var st = String(sourceStage || "").trim() || "ISSUE";
    var now = new Date();
    var nowMs = now.getTime();
    var merge = false;
    if (buf.length > 0) {
      var last = buf[buf.length - 1];
      var lastCreated = 0;
      try { lastCreated = last.createdAt ? new Date(last.createdAt).getTime() : 0; } catch (_) {}
      var withinWindow = (nowMs - lastCreated) <= 180 * 1000;
      var shortLast = (last.rawText && last.rawText.length < 18) || false;
      var shortNew = normalized.length < 18;
      var sameStage = (String(last.sourceStage || "").trim() || "ISSUE") === st;
      var lastSched = (typeof isScheduleLike_ === "function") && isScheduleLike_(last.rawText || "");
      var newSched = (typeof isScheduleLike_ === "function") && isScheduleLike_(normalized);
      if (withinWindow && (shortLast || shortNew) && sameStage && !lastSched && !newSched) {
        last.rawText = (String(last.rawText || "").trim() + " " + normalized).replace(/\s+/g, " ").trim().slice(0, 500);
        merge = true;
      }
    }
    if (!merge) {
      var clauseType = (typeof classifyIssueClauseType_ === "function") ? classifyIssueClauseType_(normalized) : "";
      var clauseScore = (typeof scoreIssueClause_ === "function") ? scoreIssueClause_(normalized, clauseType) : -999;
      // Only append as separate IssueBuffer item when type=problem; schedule items (SCHEDULE_ADD) and schema bypass
      if (st !== "SCHEDULE_ADD" && st !== "SCHEMA" && clauseType === "request") {
        try { logDevSms_("", "", "CLAUSE_SKIPPED_REQUEST text=[" + normalized.slice(0, 40) + "]"); } catch (_) {}
        try { logDevSms_("", "", "ISSUEBUF_APPEND type=[" + clauseType + "] score=[" + clauseScore + "] text=[" + (normalized.slice(0, 40) || "") + "] SKIP non-problem"); } catch (_) {}
        return;
      }
      if (st !== "SCHEDULE_ADD" && st !== "SCHEMA" && (clauseType !== "problem" || clauseScore < PROBLEM_THRESHOLD)) {
        try { logDevSms_("", "", "ISSUEBUF_APPEND type=[" + clauseType + "] score=[" + clauseScore + "] text=[" + (normalized.slice(0, 40) || "") + "] SKIP non-problem"); } catch (_) {}
        return;
      }
      buf.push({
        rawText: normalized.slice(0, 500),
        createdAt: now.toISOString(),
        sourceStage: st
      });
      if (buf.length > 50) buf = buf.slice(-50);
      try { logDevSms_("", "", "ISSUEBUF_APPEND type=[" + clauseType + "] text=[" + (normalized.slice(0, 40) || "") + "]"); } catch (_) {}
    }
    setIssueBuffer_(dir, dirRow, buf);
    var countBefore = merge ? buf.length : buf.length - 1;
    var countAfter = buf.length;
    try { logDevSms_("", "", "ISSUEBUF_UPDATE action=" + (merge ? "MERGE" : "APPEND") + " count_before=" + countBefore + " count_after=" + countAfter + " reason=" + st); } catch (_) {}
  }

  /** One-time migration: move issue-buffer JSON from col 9 (HandoffSent) into ISSUE_BUF_JSON. Do not call automatically. */
  function migrateDirIssueBufFromHandoff_() {
    var dir;
    try { dir = getSheet_(DIRECTORY_SHEET_NAME); } catch (_) { return; }
    if (!dir || typeof DIR_COL === "undefined") return;
    var lastRow = dir.getLastRow();
    if (lastRow < 2) return;
    var migrated = 0;
    var skipped = 0;
    for (var r = 2; r <= lastRow; r++) {
      var raw = String(dir.getRange(r, DIR_COL.HANDOFF_SENT).getValue() || "").trim();
      if (raw.charAt(0) !== "[" && raw.charAt(0) !== "{") continue;
      var existingBuf = String(dir.getRange(r, DIR_COL.ISSUE_BUF_JSON).getValue() || "").trim();
      if (existingBuf) { skipped++; continue; }
      var arr = [];
      try { arr = JSON.parse(singleLine_(raw)); } catch (_) {}
      if (!Array.isArray(arr)) arr = [];
      dalWithLock_("MIGRATE_ISSUE_BUF", function () {
        setIssueBuffer_(dir, r, arr);
        dir.getRange(r, DIR_COL.HANDOFF_SENT).setValue(true);
        dalSetLastUpdatedNoLock_(dir, r);
        try { logDevSms_("", "", "DAL_WRITE MIGRATE_ISSUE_BUF row=" + r); } catch (_) {}
      });
      migrated++;
    }
    try { logDevSms_("", "", "migrateDirIssueBufFromHandoff_ migrated=" + migrated + " skipped=" + skipped); } catch (_) {}
  }

  // ===================================================================
  // ===== M4 — COMPILER (Extraction + Intent Detection) ================
  // @MODULE:M4
  // Responsibilities:
  // - Extract property/unit/issue/schedule
  // - Deterministic parsing first
  // - LLM fallback allowed ONLY here
  //
  // Forbidden:
  // - Sheet writes
  // - Routing decisions
  // ===================================================================
  // CONTEXT COMPILER — minimal (Propera Compass)
  // Returns { property: {code,name}|null, unit: string, issue: string }.
  // Used by draft accumulator and stage handlers. No recursion.
  // ============================================================
  function compileTurn_(bodyTrim, phone, lang, baseVars) {
    const t = String(bodyTrim || "").trim();
    let property = null;
    let unit = "";
    let issue = "";
    let schedule = null;

    // ---- Schedule: raw preserve when body looks like schedule ----
    try {
      if (typeof isScheduleLike_ === "function" && isScheduleLike_(t)) schedule = { raw: t };
    } catch (_) {}

    // ---- Property: explicit-only first; fallback for long messages when text contains a known property variant (from Properties tab)
    try {
      let pExplicit = (typeof resolvePropertyExplicitOnly_ === "function") ? resolvePropertyExplicitOnly_(t) : null;
      if (!pExplicit && t.length > 30 && typeof resolvePropertyFromText_ === "function" && typeof getActiveProperties_ === "function" && typeof phraseInText_ === "function" && typeof normalizePropText_ === "function") {
        var tNorm = normalizePropText_(t);
        var pl = getActiveProperties_() || [];
        var hasPropertyAnchor = false;
        for (var pi = 0; pi < pl.length; pi++) {
          var pp = pl[pi] || {};
          var vlist = pp._variants || (typeof buildPropertyVariants_ === "function" ? buildPropertyVariants_(pp) : []);
          vlist = [].concat(vlist, pp.code, pp.name, pp.ticketPrefix).filter(Boolean);
          for (var vi = 0; vi < vlist.length; vi++) {
            var tok = String(vlist[vi] || "").trim();
            if (tok && tok.length >= 2) {
              var keyNorm = normalizePropText_(tok);
              if (keyNorm && phraseInText_(tNorm, keyNorm)) { hasPropertyAnchor = true; break; }
            }
          }
          if (hasPropertyAnchor) break;
        }
        if (hasPropertyAnchor) pExplicit = resolvePropertyFromText_(t, { strict: true });
      }
      if (pExplicit && pExplicit.code) {
        property = { code: String(pExplicit.code || "").trim(), name: String(pExplicit.name || "").trim() };
      }
    } catch (_) {}

    // ---- Unit extract ----
    try {
      const rawUnit = (typeof extractUnit_ === "function") ? extractUnit_(t) : "";
      unit = (rawUnit && typeof normalizeUnit_ === "function") ? normalizeUnit_(rawUnit) : (rawUnit || "");
    } catch (_) {}

    // ---- Property-answer heuristic (even if resolver didn't set property) ----
    let looksLikePropertyAnswer = false;
    try {
      const lower = String(t || "").toLowerCase().trim();

      // standalone menu digit only
      if (/^\s*[1-9]\s*$/.test(lower)) looksLikePropertyAnswer = true;

      // obvious property phrase
      if (!looksLikePropertyAnswer && (lower.indexOf("the grand") >= 0 || lower.indexOf("grand at") >= 0)) {
        looksLikePropertyAnswer = true;
      }

      // match against Properties list variants if available
      if (!looksLikePropertyAnswer && typeof getActiveProperties_ === "function") {
        const propsList = getActiveProperties_() || [];
        for (let i = 0; i < propsList.length; i++) {
          const p = propsList[i] || {};
          const variants = []
            .concat(p._variants || [])
            .concat([p.code, p.name, p.ticketPrefix])
            .filter(Boolean)
            .map(x => String(x).toLowerCase().trim());

          if (variants.some(v => v && lower === v)) { looksLikePropertyAnswer = true; break; }
          if (variants.some(v => v && lower.indexOf(v) >= 0)) { looksLikePropertyAnswer = true; break; }
        }
      }
    } catch (_) {}

    // ---- Safety / emergency (shared evaluation; used by resolver + finalize) ----
    var safety = { isEmergency: false, emergencyType: "", skipScheduling: false, requiresImmediateInstructions: false };
    try {
      if (t && typeof evaluateEmergencySignal_ === "function") {
        var sig = evaluateEmergencySignal_(t, { phone: phone });
        if (sig && sig.isEmergency) safety = { isEmergency: true, emergencyType: String(sig.emergencyType || "").trim(), skipScheduling: !!sig.skipScheduling, requiresImmediateInstructions: !!sig.requiresImmediateInstructions };
      }
      try { logDevSms_(phone, "", "COMPILE_EMERGENCY emergency=" + (safety.isEmergency ? "1" : "0") + " type=[" + (safety.emergencyType || "") + "] skipSched=" + (safety.skipScheduling ? "1" : "0")); } catch (_) {}
    } catch (_) {}

    // ---- Issue detect (only if NOT property answer) ----
    try {
      // Only clear issue when message is a property answer; allow issue when property is embedded in long report
      var propAnswerLike = (typeof looksLikePropertyAnswer_ === "function" && looksLikePropertyAnswer_(t)) ||
        (t.length <= 18 && property && property.code);
      if (property && property.code && propAnswerLike) {
        issue = "";
      } else if (!propAnswerLike) {
        if (t && (typeof looksActionableIssue_ === "function") && looksActionableIssue_(t)) {

          // Deterministic parser (AI-feel)
          var parsed = (typeof parseIssueDeterministic_ === "function")
            ? parseIssueDeterministic_(t, {})
            : null;

          if (parsed && parsed.title) {
            issue = parsed.title;
            // Optional: attach extra fields for the seam to copy
            // (safe even if caller ignores)
            return {
              property: property || null,
              unit: unit || "",
              issue: issue || "",
              schedule: schedule || null,
              issueMeta: parsed,
              safety: safety
            };
          }

          // Fallback to raw
          issue = t;
        }
      }
    } catch (_) {}

    return { property: property || null, unit: unit || "", issue: issue || "", schedule: schedule || null, safety: safety };
  }

  // ============================================================
  // WORKITEM ASSIGNMENT (policy-driven)
  // ============================================================

  /**
  * Resolve WorkItem ownership using PropertyPolicy.
  * Phase 1: property default owner only (ASSIGN_DEFAULT_OWNER).
  * Later: add rule-sheet matching first, then fall back to this default.
  *
  * Returns:
  *  { ownerType, ownerId, assignedByPolicy, assignedAt }
  */
  function resolveWorkItemAssignment_(propCode, ctx) {
    // ctx reserved for future (issueType, locationType, etc.)
    var p = String(propCode || "").trim().toUpperCase() || "GLOBAL";

    // Policy-driven ownerId (no hardcode of people)
    var ownerId = String(ppGet_(p, "ASSIGN_DEFAULT_OWNER", ppGet_("GLOBAL", "ASSIGN_DEFAULT_OWNER", "QUEUE_TRIAGE")) || "")
      .trim()
      .toUpperCase() || "QUEUE_TRIAGE";

    var ownerType = "QUEUE";
    if (ownerId.indexOf("STAFF_") === 0) ownerType = "STAFF";
    else if (ownerId.indexOf("VEND_") === 0) ownerType = "VENDOR";
    else if (ownerId.indexOf("TEAM_") === 0) ownerType = "TEAM";

    var assignedByPolicy = "KV:ASSIGN_DEFAULT_OWNER";
    var assignedAt = new Date();

    // Deterministic audit log (no tenant messaging here); skip if no phone (GSM-safe)
    var phoneForLog = String((ctx && ctx.phoneE164) || "").trim();
    if (phoneForLog) {
      try {
        logDevSms_(phoneForLog, "", "POLICY_ASSIGN ownerType=" + ownerType + " ownerId=" + ownerId + " prop=" + p + " by=" + assignedByPolicy);
      } catch (_) {}
    }

    return { ownerType: ownerType, ownerId: ownerId, assignedByPolicy: assignedByPolicy, assignedAt: assignedAt };
  }

  /** Resolve display name for Sheet1 AssignedName: from Staff tab (StaffId→StaffName) or Vendors; no hardcoded names. */
  function resolveAssigneeDisplayName_(ownerType, ownerId) {
    if (!ownerId) return "";
    var id = String(ownerId || "").trim();
    var type = String(ownerType || "").trim().toUpperCase();
    if (type === "STAFF" && typeof getStaffById_ === "function") {
      try {
        var staff = getStaffById_(id);
        if (staff && staff.name) return String(staff.name).trim();
      } catch (_) {}
      return id;
    }
    if (type === "VENDOR" && typeof getVendorById_ === "function") {
      try {
        var vendor = getVendorById_(id);
        if (vendor && vendor.name) return String(vendor.name).trim();
      } catch (_) {}
      return id;
    }
    return id;
  }

  // ============================================================
  // FINALIZE DRAFT AND CREATE TICKET (Propera Compass)
  // Single canonical ticket creator. Called only when
  // draftDecideNextStage_ returns "READY".
  //
  // IMPORTANT — phone/from rule:
  //   Always pass TENANT phone as both `phone` and `from`.
  //
  // Returns: { ok, loggedRow, ticketId, createdWi, nextStage, reason?, ticket? }
  // ============================================================
  function finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, from, opts) {
    opts = opts || {};
    var locationTextHint = String(opts.locationText || "").trim();

    var existingPendingRow = dalGetPendingRow_(dir, dirRow);
    var existingStage = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();

    // ── Guard: never finalize when a ticket row already exists (idempotency) ──
    // Exception: Portal/PM (createdByManager) may create another ticket for the same tenant (e.g. second issue).
    if (existingPendingRow >= 2 && !opts.createdByManager) {
      try { logDevSms_(phone, "", "FINALIZE_DRAFT_BLOCKED row=[" + existingPendingRow + "] stage=[" + existingStage + "]"); } catch (_) {}
      try { logInvariantFail_(phone, "", "NO_NEW_TICKET_WHEN_PENDINGROW", "row=" + existingPendingRow + " stage=" + existingStage); } catch (_) {}
      return { ok: false, reason: "ACTIVE_TICKET_EXISTS" };
    }

    var propCol = dalGetPendingProperty_(dir, dirRow);
    var propCode = propCol.code;
    var propName = propCol.name;
    var pendingUnit = dalGetPendingUnit_(dir, dirRow);
    var canonUnit   = dalGetUnit_(dir, dirRow);
    var unit        = String((pendingUnit || canonUnit) || "").trim();
    var issue    = dalGetPendingIssue_(dir, dirRow);
    var issueSource = "pending";
    var buf      = (typeof getIssueBuffer_ === "function") ? getIssueBuffer_(dir, dirRow) : [];
    if (existingPendingRow < 2 && typeof sessionGet_ === "function") {
      try {
        var _finSess = sessionGet_(phone);
        if (_finSess) {
          if (_finSess.draftIssue) { issue = String(_finSess.draftIssue || "").trim(); issueSource = "session"; }
          if (_finSess.issueBuf && _finSess.issueBuf.length) {
            var dirBufLen = (buf && buf.length) || 0;
            if (dirBufLen < _finSess.issueBuf.length) buf = _finSess.issueBuf;
          }
          if (_finSess.draftProperty && !propCode) propCode = String(_finSess.draftProperty || "").trim();
          if (_finSess.draftUnit && !unit) unit = String(_finSess.draftUnit || "").trim();
        }
      } catch (_) {}
    }
    const hasIssue = Boolean(issue) || (buf && buf.length >= 1);

    if (buf && buf.length >= 1) {
      try { logDevSms_(phone, "", "ISSUEBUF_COUNT n=" + buf.length + " reason=[finalize]"); } catch (_) {}
    }

    if (!propCode || !hasIssue) {
      try { logDevSms_(phone, "", "FINALIZE_DRAFT_SKIP propCode=[" + propCode + "] issue=[" + issue + "] bufLen=" + (buf ? buf.length : 0)); } catch (_) {}
      return { ok: false, reason: "MISSING_FIELDS" };
    }

    var issueForTicket = "";
    var locationDecidePrefetched = null;
    // ── Multi-issue: defer ticket creation until schedule confirmed ──
    // Caller sends one combined message (summary + ASK_WINDOW_SIMPLE); do not send here.
    if (buf && buf.length >= 2) {
      // If schedule already captured from SCHEDULE_DRAFT_MULTI handler, create one merged ticket now.
      if (opts && opts.multiScheduleCaptured === true && opts.capturedScheduleLabel) {
        issueForTicket = mergedIssueFromBuffer_(issue, buf, 900);
      } else if (opts && opts.createdByManager === true) {
        issueForTicket = mergedIssueFromBuffer_(issue, buf, 900);
      } else {
        var issueForTicketMergedDraft = mergedIssueFromBuffer_(issue, buf, 900);

        var spLocDraft = PropertiesService.getScriptProperties();
        var locInputDraft = locationTextHint || issueForTicketMergedDraft;
        locationDecidePrefetched = inferLocationType_(opts.OPENAI_API_KEY || String(spLocDraft.getProperty("OPENAI_API_KEY") || ""), locInputDraft, phone);
        var locTypeDraft = String((locationDecidePrefetched && locationDecidePrefetched.locationType) || "UNIT").toUpperCase();
        if (locTypeDraft !== "UNIT" && locTypeDraft !== "COMMON_AREA") locTypeDraft = "UNIT";
        var locConfDraft = Number(locationDecidePrefetched && locationDecidePrefetched.confidence);
        if (!isFinite(locConfDraft)) locConfDraft = 0;
        var locReasonDraft = String((locationDecidePrefetched && locationDecidePrefetched.reason) || "").trim();
        try { logDevSms_(phone, "", "LOC_TYPE decided=[" + locTypeDraft + "] conf=[" + locConfDraft + "] reason=[" + locReasonDraft + "]"); } catch (_) {}

        if (locTypeDraft === "COMMON_AREA") {
          // Prefer full inbound message for ticket text so we don't lose content (e.g. hallway lights + lobby smell)
          var fullMsg = String(locationTextHint || "").trim();
          if (fullMsg.length >= 40 && fullMsg.length <= 900) {
            issueForTicket = fullMsg;
          } else {
            issueForTicket = issueForTicketMergedDraft;
          }
          unit = "";
          try { logDevSms_(phone, "", "ISSUEBUF_BYPASS_DEFER reason=[COMMON_AREA]"); } catch (_) {}
        } else {
        try { logDevSms_(phone, "", "ISSUEBUF_COUNT n=" + buf.length + " reason=[defer_to_schedule]"); } catch (_) {}
        const nextStage = unit ? "SCHEDULE_DRAFT_MULTI" : "UNIT";
        var summaryMsg = "";
        dalWithLock_("FINALIZE_MULTI_DEFER", function () {
          dalSetPendingRowNoLock_(dir, dirRow, "");
          dalSetPendingStageNoLock_(dir, dirRow, nextStage);
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE FINALIZE_MULTI_DEFER row=" + dirRow + " PendingRow= PendingStage=" + String(nextStage).slice(0, DAL_LOG_LEN)); } catch (_) {}
        });
        try {
          ctxUpsert_(phone, {
            pendingExpected:   nextStage,
            pendingExpiresAt: new Date(Date.now() + (nextStage === "SCHEDULE_DRAFT_MULTI" ? 30 : 10) * 60 * 1000),
            lastIntent:       "MAINT"
          }, "FINALIZE_MULTI_DEFER");
        } catch (_) {}
        var accessNotes = "";
        if (nextStage === "SCHEDULE_DRAFT_MULTI") {
          var lang = String(opts.lang || "en").toLowerCase();
          var baseVars = opts.baseVars || {};
          var itemsText = buf.map(function (it, idx) {
            var txt = (it && it.rawText) ? String(it.rawText).trim().slice(0, 80) : "";
            return txt ? ((idx + 1) + ") " + txt) : "";
          }).filter(Boolean).join("\n");
          var accessNotes = String(dir.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.DRAFT_SCHEDULE_RAW : 13).getValue() || "").trim();
          if (!accessNotes && existingPendingRow < 2 && typeof sessionGet_ === "function") {
            try {
              var _sess = sessionGet_(phone);
              if (_sess && _sess.draftScheduleRaw) accessNotes = String(_sess.draftScheduleRaw || "").trim();
            } catch (_) {}
          }
          var schedulePart = accessNotes
            ? (typeof renderTenantKey_ === "function" ? renderTenantKey_("CONFIRM_WINDOW_FROM_NOTE", lang, Object.assign({}, baseVars, { accessNotes: accessNotes })) : "")
            : (typeof renderTenantKey_ === "function" ? renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars) : "");
          summaryMsg = (typeof renderTenantKey_ === "function")
            ? renderTenantKey_("MULTI_CAPTURED_SUMMARY", lang, Object.assign({}, baseVars, { count: buf.length, itemsText: itemsText, accessNotes: accessNotes, schedulePart: schedulePart }))
            : "";
          if (!summaryMsg && schedulePart) {
            var multiFallback = (typeof renderTenantKey_ === "function" ? renderTenantKey_("MULTI_ISSUE_SUMMARY", lang, Object.assign({}, baseVars, { issueCount: buf.length, issueBullets: itemsText })) : "").trim();
            summaryMsg = multiFallback ? (multiFallback + "\n\n" + schedulePart) : schedulePart;
          }
          if (!summaryMsg) {
            summaryMsg = (typeof renderTenantKey_ === "function" ? renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars) : "");
          }
          if (summaryMsg) {
            try { logDevSms_(phone, summaryMsg.slice(0, 80), "MULTI_SUMMARY_SENT count=" + buf.length); } catch (_) {}
          }
        }
        return { ok: true, loggedRow: 0, ticketId: "", createdWi: "", nextStage: nextStage, multiIssuePending: true, summaryMsg: summaryMsg, accessNotes: accessNotes };
        }
      }
    }
    if (!issueForTicket && !(buf && buf.length >= 2 && opts && (opts.createdByManager === true || (opts.multiScheduleCaptured === true && opts.capturedScheduleLabel)))) {
      issueForTicket = String(issue || "").trim() || ((buf && buf.length >= 1 && buf[0] && buf[0].rawText) ? String(buf[0].rawText).trim() : "");
    }
    var usedSource = String(issue || "").trim() ? issueSource : "buf";
    try { logDevSms_(phone, "", "ISSUE_FOR_TICKET source=[" + usedSource + "]"); } catch (_) {}

    const sp = PropertiesService.getScriptProperties();

    // Enrich single-issue ticket MSG with details if available (keeps title clean)
    if (buf && buf.length === 1 && buf[0] && buf[0].details) {
      var det = String(buf[0].details || "").trim();
      if (det) {
        // Keep deterministic length
        if (det.length > 450) det = det.slice(0, 450);
        issueForTicket = issueForTicket + "\n\nDetails: " + det;
      }
    }
    if (!issueForTicket) issueForTicket = String(issue || "").trim();

    var locInput = locationTextHint || issueForTicket;
    var locationDecide = locationDecidePrefetched || inferLocationType_(opts.OPENAI_API_KEY || String(sp.getProperty("OPENAI_API_KEY") || ""), locInput, phone);
    var locType = String((locationDecide && locationDecide.locationType) || "UNIT").toUpperCase();
    if (locType !== "UNIT" && locType !== "COMMON_AREA") locType = "UNIT";
    var locConf = Number(locationDecide && locationDecide.confidence);
    if (!isFinite(locConf)) locConf = 0;
    var locReason = String((locationDecide && locationDecide.reason) || "").trim();
    if (!locationDecidePrefetched) {
      try { logDevSms_(phone, "", "LOC_TYPE decided=[" + locType + "] conf=[" + locConf + "] reason=[" + locReason + "]"); } catch (_) {}
    }
    if (locType === "COMMON_AREA") {
      unit = ""; // do not store unit on common-area ticket
    }

    // ── Create ticket row via canonical processTicket_() ──
    var parsedIssueForGate = undefined;
    if (typeof parseIssueDeterministic_ === "function") {
      try {
        var parsed = parseIssueDeterministic_(issueForTicket, {});
        if (parsed && (parsed.category || parsed.urgency)) {
          parsedIssueForGate = { category: parsed.category || "", urgency: parsed.urgency || "Normal" };
        }
      } catch (_) {}
    }
    // Prefer caller/portal category when provided (fixes wrong CAT when form sends category or we skip LLM)
    if (opts.parsedIssue) {
      var pi = opts.parsedIssue;
      var piCat = (pi.category != null && pi.category !== undefined) ? String(pi.category).trim() : "";
      var piUrg = (pi.urgency != null && pi.urgency !== undefined) ? String(pi.urgency).trim() : "";
      if (piCat || piUrg) {
        if (!parsedIssueForGate) parsedIssueForGate = { category: "", urgency: "Normal" };
        if (piCat) parsedIssueForGate.category = piCat;
        if (piUrg) parsedIssueForGate.urgency = (piUrg.toUpperCase() === "URGENT" || piUrg.toLowerCase() === "high") ? "Urgent" : "Normal";
      }
    }
    // Propera Compass — Image Signal Adapter (Phase 1): optional first media URL for ticket attachment column
    var firstMediaUrl = String(opts.firstMediaUrl || "").trim() || (Array.isArray(opts.mediaUrls) && opts.mediaUrls[0] ? String(opts.mediaUrls[0]).trim() : "");
    // Optional compact media facts for attachment naming (Phase 1).
    var mediaTypeForAttach = String(opts.mediaType || "").trim();
    var mediaCategoryHintForAttach = String(opts.mediaCategoryHint || "").trim();
    var mediaSubcategoryHintForAttach = String(opts.mediaSubcategoryHint || "").trim();
    var mediaUnitHintForAttach = String(opts.mediaUnitHint || "").trim();
    var attachmentMediaFacts = null;
    if (mediaTypeForAttach || mediaCategoryHintForAttach || mediaSubcategoryHintForAttach || mediaUnitHintForAttach) {
      attachmentMediaFacts = {
        mediaType: mediaTypeForAttach,
        issueHints: {
          category: mediaCategoryHintForAttach,
          subcategory: mediaSubcategoryHintForAttach
        },
        unitHint: mediaUnitHintForAttach
      };
    }

    const ticket = processTicket_(sheet, sp, {
      OPENAI_API_KEY: opts.OPENAI_API_KEY || String(sp.getProperty("OPENAI_API_KEY") || ""),
      TWILIO_SID:     opts.TWILIO_SID     || String(sp.getProperty("TWILIO_SID")     || ""),
      TWILIO_TOKEN:   opts.TWILIO_TOKEN   || String(sp.getProperty("TWILIO_TOKEN")   || ""),
      TWILIO_NUMBER:  opts.TWILIO_NUMBER  || String(sp.getProperty("TWILIO_NUMBER")  || ""),
      ONCALL_NUMBER:  opts.ONCALL_NUMBER  || String(sp.getProperty("ONCALL_NUMBER")  || "")
    }, {
      from:             phone,
      tenantPhone:      phone,
      propertyName:     propName,
      propertyCode:     propCode,
      unitFromText:     unit,
      messageRaw:       issueForTicket,
      createdByManager: !!(opts.createdByManager),
      inboundKey:       opts.inboundKey || ("DRAFT:" + phone + "|TS:" + Date.now()),
      parsedIssue:         parsedIssueForGate,
      locationType:        locType,
      firstMediaUrl:       firstMediaUrl,
      attachmentMediaFacts: attachmentMediaFacts
    });

    var rawRow = ticket != null ? (ticket.rowIndex != null ? ticket.rowIndex : ticket.row) : undefined;
    var loggedRow = parseInt(String(rawRow || "").trim(), 10) || 0;
    if (!loggedRow || loggedRow < 2) {
      try { logDevSms_(phone, issue, "FINALIZE_DRAFT_ROW_ERR " + JSON.stringify(ticket || {})); } catch (_) {}
      return { ok: false, reason: "ROW_ERR" };
    }

    const ticketId  = String(ticket && ticket.ticketId ? ticket.ticketId : "").trim();
    // GUARD: Emergency must never result in SCHEDULE or tenant receiving scheduling SMS.
    // --- MULTI SCHEDULE OVERRIDE (SCHEDULE_DRAFT_MULTI path) ---
    let nextStage = "";
    var isEmergencyTicket = !!(ticket && ticket.classification && ticket.classification.emergency);
    var emergencyTypeForLatch = (ticket && ticket.classification && ticket.classification.emergencyType) ? String(ticket.classification.emergencyType).trim() : "EMERGENCY";

    if (isEmergencyTicket) {
      nextStage = "EMERGENCY_DONE";
      try { logDevSms_(phone, "", "EMERGENCY_LATCH_START type=[" + emergencyTypeForLatch + "] nextStage=EMERGENCY_DONE"); } catch (_) {}
    } else if (locType === "COMMON_AREA") {
      nextStage = "";
    } else {
      nextStage = unit ? "SCHEDULE" : "UNIT";
    }
    if (!isEmergencyTicket && opts && opts.multiScheduleCaptured === true && opts.capturedScheduleLabel) {
      if (nextStage === "SCHEDULE") {
        try { logDevSms_(phone, "", "SDM_GUARD_BLOCKED_REOPEN_SCHEDULE"); } catch (_) {}
        nextStage = "";
      }
    }
    const now       = new Date();

    // ── Write state BEFORE any SMS (crash-resilient) — single lock; one read + one write for Directory row (batched) ──
    dalWithLock_("FINALIZE_DIR_SET_PTR", function () {
      if (loggedRow >= 2) {
        try { logDevSms_(phone, issue, "ISSUE_WRITE site=[finalizeDraftAndCreateTicket_] val=[CLEAR_POST_COMMIT]"); } catch (_) {}
      } else {
        try { logDevSms_(phone, issue, "ISSUE_WRITE_SKIP site=[finalizeDraftAndCreateTicket_] reason=[loggedRow<2]"); } catch (_) {}
      }
      var lastDirCol = typeof DIR_COL !== "undefined" ? DIR_COL.UNIT : 14;
      // getRange(row, column, numRows, numColumns) — use 1 row
      var row = dir.getRange(dirRow, 1, 1, lastDirCol).getValues()[0];
      if (!row || row.length < lastDirCol) row = [];
      while (row.length < lastDirCol) row.push("");
      var idx = function (c) { return (c >= 1 && c <= row.length) ? c - 1 : -1; };
      if (idx(DIR_COL.LAST_UPDATED) >= 0) row[idx(DIR_COL.LAST_UPDATED)] = now;
      if (loggedRow >= 2 && idx(DIR_COL.PENDING_ISSUE) >= 0) row[idx(DIR_COL.PENDING_ISSUE)] = "";
      if (idx(DIR_COL.PENDING_UNIT) >= 0) row[idx(DIR_COL.PENDING_UNIT)] = "";
      if (idx(DIR_COL.PENDING_ROW) >= 0) row[idx(DIR_COL.PENDING_ROW)] = (loggedRow != null && loggedRow !== "") ? Number(loggedRow) : "";
      if (idx(DIR_COL.PENDING_STAGE) >= 0) row[idx(DIR_COL.PENDING_STAGE)] = String(nextStage != null ? nextStage : "").trim();
      if (idx(DIR_COL.ISSUE_BUF_JSON) >= 0) row[idx(DIR_COL.ISSUE_BUF_JSON)] = "[]";
      if (!(opts && opts.createdByManager) && unit && !isInvalidUnit_(unit)) {
        var curCanon = idx(DIR_COL.UNIT) >= 0 ? String(row[idx(DIR_COL.UNIT)] || "").trim() : "";
        if (!curCanon && idx(DIR_COL.UNIT) >= 0) {
          row[idx(DIR_COL.UNIT)] = String(unit).trim();
          try { logDevSms_(phone || "", "", "DAL_WRITE field=Unit row=" + dirRow + " val=[" + String(unit).slice(0, DAL_LOG_LEN) + "] reason=FINALIZE_LEARN_CANON_UNIT"); } catch (_) {}
        }
      }
      dir.getRange(dirRow, 1, 1, lastDirCol).setValues([row]);
      try { logDevSms_(phone || "", "", "DAL_WRITE FINALIZE_DIR_SET_PTR row=" + dirRow + " issue= unit= pendingRow=" + loggedRow + " stage=" + String(nextStage).slice(0, DAL_LOG_LEN)); } catch (_) {}
      if (isEmergencyTicket) try { logDevSms_(phone || "", "", "EMERGENCY_DIR_LATCH row=" + loggedRow + " stage=EMERGENCY_DONE"); } catch (_) {}
    });

    // Emergency latch: Sheet1 EMER/EMER_TYPE + ctx (processTicket_ already wrote EMER; latch ensures ctx + consistency)
    if (isEmergencyTicket && sheet && loggedRow >= 2 && typeof latchEmergency_ === "function") {
      try {
        latchEmergency_(sheet, loggedRow, phone, emergencyTypeForLatch);
        try { logDevSms_(phone, "", "EMERGENCY_LATCH_OK row=" + loggedRow); } catch (_) {}
      } catch (_) {}
    }

    // Close Session: active ticket set, clear draft fields so pre-ticket draft does not reappear
    try {
      if (typeof sessionUpsert_ === "function") {
        sessionUpsert_(phone, {
          activeArtifactKey: ticketId || ("ROW:" + loggedRow),
          draftIssue: "",
          issueBufJson: "[]",
          draftScheduleRaw: "",
          stage: "",
          expected: "",
          expiresAtIso: ""
        }, "finalize_session_close");
      }
    } catch (_) {}

    try {
      // Compass: single AI enrichment enqueue path (canonical)
      enqueueAiEnrichment_(ticketId, propCode, propName, unit, phone, issueForTicket);
    } catch (_) {}

    // Apply draft schedule to ticket when pointer just set and ticket PREF_WINDOW empty
    if (loggedRow >= 2 && typeof COL !== "undefined" && typeof DIR_COL !== "undefined") {
      try {
        const sheet = getLogSheet_();
        if (sheet && loggedRow <= sheet.getLastRow()) {
          const ticketWindow = String(sheet.getRange(loggedRow, COL.PREF_WINDOW).getValue() || "").trim();
          if (!ticketWindow && opts && opts.multiScheduleCaptured === true && opts.capturedScheduleLabel) {
            withWriteLock_("MULTI_SCHEDULE_APPLY", () => {
              sheet.getRange(loggedRow, COL.PREF_WINDOW).setValue(String(opts.capturedScheduleLabel));
              sheet.getRange(loggedRow, COL.LAST_UPDATE).setValue(now);
              // Write structured end datetime for lifecycle engine.
              try {
                var _schedLabel = String(sheet.getRange(loggedRow, COL.PREF_WINDOW).getValue() || "").trim();
                var _schedParsed = (_schedLabel && typeof parsePreferredWindow_ === "function") ? parsePreferredWindow_(_schedLabel, null) : null;
                if (_schedParsed && _schedParsed.end instanceof Date) {
                  sheet.getRange(loggedRow, COL.SCHEDULED_END_AT).setValue(_schedParsed.end);
                } else {
                  sheet.getRange(loggedRow, COL.SCHEDULED_END_AT).clearContent();
                }
              } catch (_) {}
            });
          } else if (!ticketWindow) {
            const draftRaw = String(dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW).getValue() || "").trim();
            if (draftRaw) {
              withWriteLock_("DRAFT_SCHEDULE_APPLY", () => {
                sheet.getRange(loggedRow, COL.PREF_WINDOW).setValue(draftRaw);
                sheet.getRange(loggedRow, COL.LAST_UPDATE).setValue(now);
                dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW).setValue("");
                // Write structured end datetime for lifecycle engine.
                try {
                  var _schedLabel = String(sheet.getRange(loggedRow, COL.PREF_WINDOW).getValue() || "").trim();
                  var _schedParsed = (_schedLabel && typeof parsePreferredWindow_ === "function") ? parsePreferredWindow_(_schedLabel, null) : null;
                  if (_schedParsed && _schedParsed.end instanceof Date) {
                    sheet.getRange(loggedRow, COL.SCHEDULED_END_AT).setValue(_schedParsed.end);
                  } else {
                    sheet.getRange(loggedRow, COL.SCHEDULED_END_AT).clearContent();
                  }
                } catch (_) {}
              });
              try { logDevSms_(phone, issue, "DRAFT_SCHEDULE_APPLIED_TO_TICKET"); } catch (_) {}
            }
          }
        }
      } catch (_) {}
    }

    // ── Resolve assignment (policy-based) ──
    // STAFF_RESOLVER.gs takes priority for maintenance tickets.
    // Falls back to resolveWorkItemAssignment_() if resolver returns nothing.
    var asn = null;
    var _srPatch = null;
    try {
      if (typeof srBuildWorkItemOwnerPatch_ === "function") {
        _srPatch = srBuildWorkItemOwnerPatch_({
          propertyId: propCode,
          domain:     "MAINTENANCE"
        });
      }
    } catch (_) {}

    if (_srPatch && _srPatch.ownerType) {
      asn = {
        ownerType:        _srPatch.ownerType,
        ownerId:          _srPatch.ownerId,
        assignedByPolicy: _srPatch.assignedByPolicy,
        assignedAt:       _srPatch.assignedAt
      };
    } else {
      // Fallback: legacy KV-based resolver
      try {
        asn = resolveWorkItemAssignment_(propCode, { phoneE164: phone });
      } catch (_) {
        asn = { ownerType: "QUEUE", ownerId: "QUEUE_TRIAGE", assignedByPolicy: "ERR:FALLBACK", assignedAt: new Date() };
      }
    }

    // ── Create WorkItem (Primary: STAFF_TRIAGE so ownership engine can triage) ──
    var createdWi = "";
    try {
      createdWi = workItemCreate_({
        type:         "MAINT",
        status:       "OPEN",
        state:        "STAFF_TRIAGE",
        substate:     nextStage,
        phoneE164:    phone,
        propertyId:   propCode,
        unitId:       unit,
        ticketRow:    loggedRow,
        ticketKey:    (ticket && ticket.ticketKey) ? String(ticket.ticketKey).trim() : "",
        metadataJson: JSON.stringify({
          source:     opts.createdByManager ? "MGR_DRAFT" : "DRAFT",
          inboundKey: String(opts.inboundKey || "")
        }),

        // persisted ownership fields (policy-driven)
        ownerType:         (asn && asn.ownerType) || "",
        ownerId:           (asn && asn.ownerId) || "",
        assignedByPolicy:  (asn && asn.assignedByPolicy) || "",
        assignedAt:        (asn && asn.assignedAt) || ""
      });
    } catch (err) {
      try { logDevSms_(phone, issue, "FINALIZE_WI_ERR " + String(err && err.message ? err.message : err)); } catch (_) {}
    }

    // Single read for policy + Sheet1 assignment (avoid second workItemGetById_)
    var wiCached = null;
    try { wiCached = (typeof workItemGetById_ === "function") ? workItemGetById_(createdWi) : null; } catch (_) {}

    // Log STAFF_RESOLVER assignment decision to PolicyEventLog
    try {
      if (createdWi && _srPatch && _srPatch._resolverResult && typeof srLogAssignmentEvent_ === "function") {
        srLogAssignmentEvent_(createdWi, _srPatch._resolverResult);
      }
    } catch (_) {}

    // Emergency: WI must be ACTIVE_WORK/EMERGENCY. GUARD: never allow WAIT_TENANT or SCHEDULE for emergency.
    if (isEmergencyTicket && createdWi && typeof workItemUpdate_ === "function") {
      try {
        workItemUpdate_(createdWi, { state: "ACTIVE_WORK", substate: "EMERGENCY" });
        try { logDevSms_(phone, "", "EMERGENCY_WI_UPDATE wi=" + createdWi + " state=ACTIVE_WORK substate=EMERGENCY"); } catch (_) {}
      } catch (_) {}
    }

    // ── PolicyEngine v1 hook (safe/no-op when POLICY_ENGINE_ENABLED is false) ──
    var pol = { ackOwned: false, ackSent: false, ruleId: "" };
    try {
      if (createdWi && typeof maybePolicyRun_ === "function") {
        var wiForPolicy = wiCached;
        if (!wiForPolicy) {
          wiForPolicy = {
            workItemId: createdWi,
            state: "STAFF_TRIAGE",
            substate: nextStage,
            phoneE164: phone,
            propertyId: propCode,
            unitId: unit,
            ticketRow: loggedRow,
            ownerType: (asn && asn.ownerType) || "",
            ownerId: (asn && asn.ownerId) || "",
            createdAt: new Date()
          };
        } else {
          wiForPolicy.ownerType = (asn && asn.ownerType) || String(wiForPolicy.ownerType || "");
          wiForPolicy.ownerId = (asn && asn.ownerId) || String(wiForPolicy.ownerId || "");
          wiForPolicy.createdAt = wiForPolicy.createdAt || new Date();
        }
        // Pass authoritative category from ticket so policy matches on actual classification (e.g. Electrical), not stale/wrong sheet value
        if (ticket && ticket.classification && typeof ticket.classification.category === "string") {
          wiForPolicy.categoryFromTicket = String(ticket.classification.category).trim().toLowerCase();
        }

        var policyResult = maybePolicyRun_("WORKITEM_CREATED", { phoneE164: phone, lang: "en" }, wiForPolicy, propCode);
        if (policyResult && typeof policyResult === "object") {
          pol.ackOwned = !!policyResult.ackOwned;
          pol.ackSent = !!policyResult.ackSent;
          pol.ruleId = String(policyResult.ruleId || "");
        }
      }
    } catch (policyErr) {
      try { logDevSms_(phone, "", "POLICY_HOOK_ERR " + String(policyErr && policyErr.message ? policyErr.message : policyErr)); } catch (_) {}
    }

    // Defensive: re-enforce emergency WI state after policy so policy cannot set WAIT_TENANT/SCHEDULE for emergency tickets
    if (isEmergencyTicket && createdWi && typeof workItemUpdate_ === "function") {
      try {
        workItemUpdate_(createdWi, { state: "ACTIVE_WORK", substate: "EMERGENCY" });
        try { logDevSms_(phone, "", "EMERGENCY_WI_STATE_ENFORCED wi=" + createdWi + " state=ACTIVE_WORK substate=EMERGENCY"); } catch (_) {}
      } catch (_) {}
    }

    // ── Staff-capture tenant identity enrichment (never blocks; never overwrites existing real phone) ──
    if (opts.createdByManager && createdWi && loggedRow >= 2 && typeof enrichStaffCapTenantIdentity_ === "function") {
      try {
        enrichStaffCapTenantIdentity_(sheet, loggedRow, createdWi, propName, unit, {
          tenantNameHint: opts.tenantNameHint || "",
          tenantNameTrusted: !!opts.tenantNameTrusted,
          locationType: locType
        });
      } catch (_) {}
    }

    // ── Write assignment to Sheet1 (batched; use asn — we just set WI from asn, no second workItemGetById_) ──
    try {
      if (createdWi && loggedRow >= 2 && sheet && typeof COL !== "undefined" && asn) {
        var aType = String((asn.ownerType) || "").trim();
        if (aType === "STAFF" || aType === "VENDOR") {
          var assigneeName = (typeof resolveAssigneeDisplayName_ === "function") ? resolveAssigneeDisplayName_(aType, asn.ownerId) : String(asn.ownerId || "");
          var aAt = asn.assignedAt instanceof Date ? asn.assignedAt : (asn.assignedAt ? new Date(asn.assignedAt) : new Date());
          var aBy = String(asn.assignedByPolicy || "KV:ASSIGN_DEFAULT_OWNER").trim();
          var oId = String(asn.ownerId || "").trim();
          // getRange(row, column, numRows, numColumns)
          if (COL.ASSIGNED_TO) sheet.getRange(loggedRow, COL.ASSIGNED_TO, 1, 1).setValues([[assigneeName]]);
          if (COL.ASSIGNED_TYPE && COL.ASSIGNED_ID && COL.ASSIGNED_NAME && COL.ASSIGNED_AT && COL.ASSIGNED_BY) {
            sheet.getRange(loggedRow, COL.ASSIGNED_TYPE, 1, 5).setValues([[aType, oId, assigneeName, aAt, aBy]]);
          }
          try { logDevSms_(phone, "", "SHEET1_ASSIGN row=" + loggedRow + " type=" + aType + " name=" + assigneeName); } catch (_) {}
        }
      }
    } catch (sheetAssignErr) {
      try { logDevSms_(phone, "", "SHEET1_ASSIGN_ERR " + String(sheetAssignErr && sheetAssignErr.message ? sheetAssignErr.message : sheetAssignErr)); } catch (_) {}
    }

    // ── Update ctx ──
    try {
      ctxUpsert_(phone, {
        activeWorkItemId:  createdWi || "",
        pendingWorkItemId: createdWi || "",
        pendingExpected:   nextStage,
        pendingExpiresAt:  new Date(Date.now() + (nextStage === "SCHEDULE" || nextStage === "SCHEDULE_DRAFT_MULTI" ? 30 : 10) * 60 * 1000),
        lastIntent:        "MAINT"
      }, "FINALIZE_DRAFT");
    } catch (_) {}

    // ── UNSCHEDULED lifecycle: owner set but no schedule (hallway ticket) ──
    if (createdWi && asn && asn.ownerId && !isEmergencyTicket && typeof onWorkItemCreatedUnscheduled_ === "function") {
      var hasSched = false;
      try {
        if (sheet && loggedRow >= 2 && typeof COL !== "undefined" && COL.SCHEDULED_END_AT) {
          var schedVal = sheet.getRange(loggedRow, COL.SCHEDULED_END_AT).getValue();
          hasSched = !!(schedVal && (schedVal instanceof Date && isFinite(schedVal.getTime())));
        }
      }
      catch (_) {}

      if (!hasSched) {
        try { onWorkItemCreatedUnscheduled_(createdWi, propCode); } catch (e) { try { logDevSms_(phone, "", "UNSCHEDULED_HOOK_ERR " + String(e && e.message ? e.message : e)); } catch (_) {} }
      }
    }

    try { logDevSms_(phone, issue, "FINALIZE_DRAFT_OK row=[" + loggedRow + "] tid=[" + ticketId + "] wi=[" + createdWi + "] next=[" + nextStage + "]"); } catch (_) {}

    return { ok: true, loggedRow, ticketId, createdWi, nextStage, locationType: locType, ticket, ackOwnedByPolicy: pol.ackOwned, policyRuleId: pol.ruleId, ownerType: (asn && asn.ownerType) ? String(asn.ownerType) : "", ownerId: (asn && asn.ownerId) ? String(asn.ownerId) : "" };
  }

  // ============================================================
  // PORTAL PM CREATE TICKET (Signal Layer adapter)
  // Form payload → Directory draft → finalizeDraftAndCreateTicket_.
  // Does NOT synthesize Twilio events; does NOT call handleSmsCore_.
  // Returns { ticketId, ticketRow, workItemId, nextStage, ownerType, ownerId }.
  // ============================================================
  function portalPmCreateTicketFromForm_(payload) {
    if (!payload || typeof payload !== "object") return { ok: false, reason: "invalid_payload" };

    var phoneE164 = (payload.phoneE164 || "").toString().trim();
    var property = (payload.property || "").toString().trim();
    var message = (payload.message || "").toString().trim();
    if (!phoneE164 || !property || !message) return { ok: false, reason: "Missing required fields: phoneE164, property, message" };

    property = property.toUpperCase();
    var unit = (payload.unit != null && payload.unit !== undefined) ? String(payload.unit).trim() : "";
    var urgency = (payload.urgency || "NORMAL").toString().trim().toUpperCase() || "NORMAL";
    var status = (payload.status || "OPEN").toString().trim() || "OPEN";
    if (payload.preferredWindow === undefined || payload.preferredWindow === null) {
      payload.preferredWindow = "";
    } else {
      payload.preferredWindow = String(payload.preferredWindow).trim();
    }

    var sheet, dir, dirRow;
    try {
      sheet = getSheet_(SHEET_NAME);
      dir = getSheet_(DIRECTORY_SHEET_NAME);
    } catch (sheetErr) {
      return { ok: false, reason: (sheetErr && sheetErr.message) ? sheetErr.message : "sheet_error" };
    }
    // Use a unique key per request so we always get a NEW directory row (no existing pending ticket).
    // This avoids ACTIVE_TICKET_EXISTS when the tenant's row has a stale PendingRow or we match by phone.
    var draftPhone = "PORTAL_PM:" + Date.now() + "_" + (typeof Utilities !== "undefined" && Utilities.getUuid ? Utilities.getUuid() : String(Math.random()).slice(2, 11));
    dirRow = ensureDirectoryRowForPhone_(dir, draftPhone);
    if (!dirRow || dirRow < 2) return { ok: false, reason: "directory_row_failed" };

    // Resolve property to canonical code + full name (e.g. MORR or Morris → MORRIS + The Grand at Morris)
    var propCode = property;
    var propName = property;
    if (typeof getActiveProperties_ === "function") {
      var pl = getActiveProperties_() || [];
      var inputUpper = String(property || "").trim().toUpperCase().replace(/\s+/g, "");
      for (var i = 0; i < pl.length; i++) {
        var c = String(pl[i].code || "").trim().toUpperCase().replace(/\s+/g, "");
        var tp = String(pl[i].ticketPrefix || "").trim().toUpperCase().replace(/\s+/g, "");
        var sn = (pl[i].shortName != null && pl[i].shortName !== "") ? String(pl[i].shortName || "").trim().toUpperCase().replace(/\s+/g, "") : "";
        if (c === inputUpper || tp === inputUpper || (sn && sn === inputUpper)) {
          propCode = String(pl[i].code || "").trim();
          propName = String(pl[i].name || "").trim() || propCode;
          break;
        }
      }
      if (propName === property && typeof getPropertyByNameOrCode_ === "function") {
        var pRes = getPropertyByNameOrCode_(property);
        if (pRes) {
          propCode = String(pRes.code || "").trim();
          propName = String(pRes.name || "").trim() || propCode;
        }
      }
    }

    // Shared emergency evaluation (same as SMS) so portal-created emergency tickets get EMER/EMER_TYPE and no schedule
    var portalSafety = { isEmergency: false, emergencyType: "", skipScheduling: false };
    try {
      if (typeof evaluateEmergencySignal_ === "function") {
        var sig = evaluateEmergencySignal_(message, { phone: phoneE164 });
        if (sig && sig.isEmergency) portalSafety = { isEmergency: true, emergencyType: String(sig.emergencyType || "").trim(), skipScheduling: !!sig.skipScheduling };
      }
      try { logDevSms_(phoneE164, message.slice(0, 60), "PORTAL_EMERGENCY_EVAL emergency=" + (portalSafety.isEmergency ? "1" : "0") + " type=[" + (portalSafety.emergencyType || "") + "]"); } catch (_) {}
    } catch (_) {}

    // Prefer parsed schedule label (e.g. "Tue Mar 10, 12:00 PM–5:00 PM") over raw text ("tomorrow afternoon") for storage
    var preferredWindowRaw = (payload.preferredWindow != null && payload.preferredWindow !== undefined) ? String(payload.preferredWindow).trim() : "";
    var preferredWindowValue = preferredWindowRaw;
    if (preferredWindowRaw && typeof parsePreferredWindow_ === "function") {
      try {
        var parsed = parsePreferredWindow_(preferredWindowRaw, null);
        if (parsed && parsed.label) preferredWindowValue = String(parsed.label).trim();
      } catch (_) {}
    }
    var turnFacts = {
      property: { code: propCode, name: propName },
      unit: unit,
      issue: message,
      schedule: preferredWindowValue ? { raw: preferredWindowValue } : null,
      safety: portalSafety
    };
    draftUpsertFromTurn_(dir, dirRow, turnFacts, message, phoneE164, { structuredIntake: true });
    if (typeof DIR_COL !== "undefined" && DIR_COL.DRAFT_SCHEDULE_RAW && preferredWindowValue) {
      dalWithLock_("PORTAL_PM_SCHEDULE", function () {
        dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW).setValue(preferredWindowValue);
        dalSetLastUpdatedNoLock_(dir, dirRow);
      });
    }

    var inboundKey = "PORTAL_PM:" + Date.now();
    var result;
    try {
      result = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phoneE164, phoneE164, {
        createdByManager: true,
        inboundKey: inboundKey,
        parsedIssue: {
          category: (payload.category != null) ? String(payload.category).trim() : "",
          urgency: (payload.urgency && String(payload.urgency).toUpperCase() === "URGENT") ? "Urgent" : "Normal"
        }
      });
    } catch (finalizeErr) {
      return { ok: false, reason: (finalizeErr && finalizeErr.message) ? finalizeErr.message : "finalize_error" };
    }

    if (!result || !result.ok) return { ok: false, reason: (result && result.reason) ? result.reason : "creation_failed" };

    if (result.nextStage === "EMERGENCY_DONE") {
      try { logDevSms_(phoneE164, "", "PORTAL_EMERGENCY_LATCH ticketId=" + (result.ticketId || "") + " row=" + (result.loggedRow || "")); } catch (_) {}
    }

    var ticketId = (result.ticketId || "").toString().trim();
    var ticketRow = result.loggedRow != null ? result.loggedRow : (result.ticketRow != null ? result.ticketRow : null);
    // Fallback: if row is missing but we have a ticketId, resolve row via Sheet1 to keep attachments + downstream flows aligned.
    if ((!ticketRow || ticketRow < 2) && ticketId) {
      try { ticketRow = findTicketRowByTicketId_(sheet, ticketId); } catch (_) {}
    }
    var workItemId = (result.createdWi || "").toString().trim();
    var nextStage = (result.nextStage != null) ? String(result.nextStage).trim() : "";
    var ownerType = "";
    var ownerId = "";

    ownerType = String(result.ownerType || "").trim();
    ownerId = String(result.ownerId || "").trim();

    // Write attachment URLs: accept payload.attachments or payload.attachmentUrls (e.g. from pm.uploadAttachment).
    // Always write to the same ticket sheet (sheet) used for creation — never to a log sheet.
    var attachmentList = [];
    if (payload.attachments && (Array.isArray(payload.attachments) ? payload.attachments.length : 1)) {
      attachmentList = Array.isArray(payload.attachments) ? payload.attachments.slice() : [String(payload.attachments)];
    }
    if (payload.attachmentUrls && (Array.isArray(payload.attachmentUrls) ? payload.attachmentUrls.length : 1)) {
      var urls = Array.isArray(payload.attachmentUrls) ? payload.attachmentUrls : [String(payload.attachmentUrls)];
      attachmentList = attachmentList.concat(urls);
    }
    try {
      if (typeof logDevSms_ === "function") {
        logDevSms_(phoneE164, "", "PORTAL_ATTACH_IN count=" + attachmentList.length + " attachments=" + JSON.stringify(payload.attachments || []) + " attachmentUrls=" + JSON.stringify(payload.attachmentUrls || []));
      }
    } catch (_) {}
    if (result.ok && ticketRow >= 2 && attachmentList.length > 0 && typeof COL !== "undefined" && COL.ATTACHMENTS) {
      try {
        if (sheet && ticketRow <= sheet.getLastRow()) {
          var attVal = attachmentList.join("\n");
          sheet.getRange(ticketRow, COL.ATTACHMENTS).setValue(attVal);
          if (typeof logDevSms_ === "function") {
            logDevSms_(phoneE164, "", "PORTAL_ATTACH_WRITE row=" + ticketRow + " col=" + COL.ATTACHMENTS + " count=" + attachmentList.length + " sheet=" + (sheet.getName ? sheet.getName() : "Sheet1"));
          }
        }
      } catch (attachErr) {
        if (typeof logDevSms_ === "function") {
          try { logDevSms_(phoneE164, "", "PORTAL_ATTACH_WRITE_FAIL err=" + (attachErr && attachErr.message ? attachErr.message : String(attachErr))); } catch (_) {}
        }
      }
    }

    try {
      logDevSms_(phoneE164, "", "PM_CREATE_TICKET ticketId=" + (ticketId || "") + " row=" + (ticketRow != null ? ticketRow : "") + " wi=" + (workItemId || "") + " prop=" + property + " unit=" + unit);
    } catch (_) {}

    return {
      ok: true,
      ticketId: ticketId,
      ticketRow: ticketRow,
      workItemId: workItemId,
      nextStage: nextStage,
      ownerType: ownerType,
      ownerId: ownerId
    };
  }

  // ============================================================
  // PORTAL PM: update / complete / delete ticket (Minimum Safe Edit)
  // ============================================================
  /** Returns 1-based Sheet1 row for ticketId, or 0 if not found. Uses exact ticketId match only. */
  function findTicketRowByTicketId_(sheet, ticketId) {
    if (!sheet || !ticketId || typeof ticketId !== 'string') return 0;
    var tid = String(ticketId).trim();
    if (!tid) return 0;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;
    var ids = sheet.getRange(2, COL.TICKET_ID, lastRow, COL.TICKET_ID).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim() === tid) return i + 2;
    }
    return 0;
  }

  /** Returns 1-based Sheet1 row for the given TicketKey, or 0 if not found. For lifecycle/policy lookup only (runtime resolution). */
  function findTicketRowByTicketKey_(sheet, ticketKey) {
    if (!sheet || !ticketKey || typeof ticketKey !== "string") return 0;
    var key = String(ticketKey).trim();
    if (!key) return 0;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;
    var col = (typeof COL !== "undefined" && COL.TICKET_KEY) ? COL.TICKET_KEY : 0;
    if (!col || col < 1) return 0;
    var vals = sheet.getRange(2, col, lastRow, col).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || "").trim() === key) return i + 2;
    }
    return 0;
  }

  /** Returns array of 1-based row numbers where ticketId matches exactly. Used for delete safety (exactly-one check). */
  function findTicketRowsByTicketId_(sheet, ticketId) {
    var out = [];
    if (!sheet || !ticketId || typeof ticketId !== 'string') return out;
    var tid = String(ticketId).trim();
    if (!tid) return out;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return out;
    var ids = sheet.getRange(2, COL.TICKET_ID, lastRow, COL.TICKET_ID).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim() === tid) out.push(i + 2);
    }
    return out;
  }

  /**
  * Portal PM: append attachment URLs to an existing ticket row.
  * Reads current Attachments cell, parses newline/comma-separated, merges with new URLs, dedupes, writes back.
  * Never overwrites; append only. Preserves path-style and Drive URLs.
  */
  function portalPmAddAttachmentToTicket_(payload) {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'invalid_payload' };
    var ticketId = (payload.ticketId || '').toString().trim();
    var newUrls = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (!ticketId) return { ok: false, reason: 'missing_ticketId' };
    if (newUrls.length === 0) return { ok: false, reason: 'attachments_required' };
    newUrls = newUrls.map(function (u) { return String(u).trim(); }).filter(Boolean);
    if (newUrls.length === 0) return { ok: false, reason: 'attachments_required' };

    if (typeof logDevSms_ === 'function') {
      try { logDevSms_('', '', 'PM_ADD_ATTACH_IN ticketId=' + ticketId + ' count=' + newUrls.length); } catch (_) {}
    }

    var sheet;
    try { sheet = getSheet_(SHEET_NAME); } catch (e) { return { ok: false, reason: (e && e.message) || 'sheet_error' }; }
    if (typeof COL === 'undefined' || !COL.ATTACHMENTS) return { ok: false, reason: 'COL.ATTACHMENTS not defined' };

    var ticketRow = findTicketRowByTicketId_(sheet, ticketId);
    if (!ticketRow || ticketRow < 2) {
      if (typeof logDevSms_ === 'function') { try { logDevSms_('', '', 'PM_ADD_ATTACH_FAIL err=ticket_not_found'); } catch (_) {} }
      return { ok: false, reason: 'ticket_not_found' };
    }
    if (typeof logDevSms_ === 'function') {
      try { logDevSms_('', '', 'PM_ADD_ATTACH_FOUND row=' + ticketRow); } catch (_) {}
    }

    var existingVal = '';
    try {
      if (ticketRow <= sheet.getLastRow()) {
        existingVal = String(sheet.getRange(ticketRow, COL.ATTACHMENTS).getValue() || '').trim();
      }
    } catch (e) {
      if (typeof logDevSms_ === 'function') { try { logDevSms_('', '', 'PM_ADD_ATTACH_FAIL err=' + (e && e.message ? e.message : 'read_cell')); } catch (_) {} }
      return { ok: false, reason: (e && e.message) ? e.message : 'read_failed' };
    }

    var existing = existingVal ? existingVal.split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean) : [];
    var seen = {};
    var merged = [];
    for (var i = 0; i < existing.length; i++) {
      var x = existing[i];
      if (!seen[x]) { seen[x] = true; merged.push(x); }
    }
    var addedCount = 0;
    for (var j = 0; j < newUrls.length; j++) {
      var u = newUrls[j];
      if (!seen[u]) { seen[u] = true; merged.push(u); addedCount++; }
    }

    if (addedCount === 0) {
      return { ok: true, ticketId: ticketId, ticketRow: ticketRow, attachments: merged, addedCount: 0 };
    }

    var attVal = merged.join('\n');
    try {
      sheet.getRange(ticketRow, COL.ATTACHMENTS).setValue(attVal);
    } catch (e) {
      if (typeof logDevSms_ === 'function') { try { logDevSms_('', '', 'PM_ADD_ATTACH_FAIL err=' + (e && e.message ? e.message : 'write_cell')); } catch (_) {} }
      return { ok: false, reason: (e && e.message) ? e.message : 'write_failed' };
    }
    if (typeof logDevSms_ === 'function') {
      try { logDevSms_('', '', 'PM_ADD_ATTACH_WRITE row=' + ticketRow + ' added=' + addedCount + ' total=' + merged.length); } catch (_) {}
    }

    return { ok: true, ticketId: ticketId, ticketRow: ticketRow, attachments: merged, addedCount: addedCount };
  }

  var PORTAL_EDIT_ALLOWED_STATUS_ = ['Open', 'Scheduled', 'In Progress', 'Completed', 'Waiting Parts', 'Cancelled', 'Waiting on Tenant', 'Canceled', 'Waiting Vendor'];
  var PORTAL_EDIT_ALLOWED_URGENCY_ = ['Low', 'Normal', 'High'];
  var PORTAL_EDIT_ALLOWED_CATEGORY_ = ['Appliance', 'Cleaning', 'Eletrical', 'General', 'HVAC', 'Lock/Key', 'Plumbing', 'Paint/Repair', 'Pest', 'Safety', 'Others'];

  function portalPmUpdateTicket_(body) {
    if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid_payload' };
    var ticketId = (body.ticketId || '').toString().trim();
    if (!ticketId) return { ok: false, reason: 'missing_ticketId' };

    var sheet;
    try { sheet = getSheet_(SHEET_NAME); } catch (e) { return { ok: false, reason: (e && e.message) || 'sheet_error' }; }

    var row = findTicketRowByTicketId_(sheet, ticketId);
    if (!row) return { ok: false, reason: 'ticket_not_found' };

    var allowedKeys = { status: true, urgency: true, category: true, issue: true, serviceNote: true, schedule: true };
    for (var k in body) {
      if (k !== 'token' && k !== 'ticketId' && body.hasOwnProperty(k) && !allowedKeys[k]) {
        return { ok: false, reason: 'invalid_field_' + k };
      }
    }

    var statusVal = body.status != null ? String(body.status).trim() : null;
    var urgencyVal = body.urgency != null ? String(body.urgency).trim() : null;
    var categoryVal = body.category != null ? String(body.category).trim() : null;
    if (statusVal !== null) {
      var sLower = statusVal.toLowerCase();
      if (sLower === 'canceled') statusVal = 'Cancelled';
      else if (sLower === 'waiting tenant') statusVal = 'Waiting on Tenant';
      if (PORTAL_EDIT_ALLOWED_STATUS_.indexOf(statusVal) < 0) return { ok: false, reason: 'invalid_status' };
    }
    if (urgencyVal !== null && PORTAL_EDIT_ALLOWED_URGENCY_.indexOf(urgencyVal) < 0) return { ok: false, reason: 'invalid_urgency' };
    if (categoryVal !== null && PORTAL_EDIT_ALLOWED_CATEGORY_.indexOf(categoryVal) < 0) return { ok: false, reason: 'invalid_category' };

    var oldCategory = '';
    var oldStatus = '';
    try {
      oldCategory = String(sheet.getRange(row, COL.CAT).getValue() || '').trim();
      if (!oldCategory && typeof COL.CAT_FINAL === 'number') oldCategory = String(sheet.getRange(row, COL.CAT_FINAL).getValue() || '').trim();
      oldStatus = String(sheet.getRange(row, COL.STATUS).getValue() || '').trim();
    } catch (_) {}

    var categoryChanged = (categoryVal !== null && categoryVal !== oldCategory);
    var stillOpen = (statusVal !== null ? statusVal : oldStatus);
    stillOpen = String(stillOpen).toLowerCase();
    var isOpen = ['completed', 'cancelled', 'canceled', 'resolved'].indexOf(stillOpen) < 0;

    // Issue text: COL.MSG (Message) is the canonical editable issue field in Sheet1; no separate Issue column in COL.
    withWriteLock_('PORTAL_PM_UPDATE_TICKET', function () {
      if (statusVal !== null) sheet.getRange(row, COL.STATUS).setValue(statusVal);
      if (urgencyVal !== null) sheet.getRange(row, COL.URG).setValue(urgencyVal);
      if (categoryVal !== null) {
        sheet.getRange(row, COL.CAT).setValue(categoryVal);
        if (typeof COL.CAT_FINAL === 'number') sheet.getRange(row, COL.CAT_FINAL).setValue(categoryVal);
      }
      if (body.issue !== undefined) sheet.getRange(row, COL.MSG).setValue(String(body.issue != null ? body.issue : '').trim());
      if (body.serviceNote !== undefined) sheet.getRange(row, COL.SERVICE_NOTES).setValue(String(body.serviceNote != null ? body.serviceNote : '').trim());
      if (body.schedule !== undefined) {
        var _schedRaw = String(body.schedule != null ? body.schedule : '').trim();
        sheet.getRange(row, COL.PREF_WINDOW).setValue(_schedRaw);
        // Parse and write structured end datetime for lifecycle engine.
        try {
          var _schedParsed = (_schedRaw && typeof parsePreferredWindow_ === "function") ? parsePreferredWindow_(_schedRaw, null) : null;
          if (_schedParsed && _schedParsed.end instanceof Date) {
            sheet.getRange(row, COL.SCHEDULED_END_AT).setValue(_schedParsed.end);
          } else {
            sheet.getRange(row, COL.SCHEDULED_END_AT).clearContent();
          }
        } catch (_) {}
      }
      sheet.getRange(row, COL.LAST_UPDATE).setValue(new Date());
    });

    if (categoryChanged && isOpen && typeof maybePolicyRun_ === 'function') {
      try {
        var propCode = String(sheet.getRange(row, COL.PROPERTY).getValue() || '').trim().toUpperCase();
        var wiId = typeof findWorkItemIdByTicketRow_ === 'function' ? findWorkItemIdByTicketRow_(row) : '';
        var wiForPolicy = null;
        if (wiId && typeof workItemGetById_ === 'function') wiForPolicy = workItemGetById_(wiId);
        if (!wiForPolicy) {
          wiForPolicy = {
            workItemId: wiId || ('WI_PORTAL_' + row),
            ticketRow: row,
            propertyId: propCode,
            state: 'STAFF_TRIAGE',
            categoryFromTicket: (categoryVal !== null ? categoryVal : oldCategory).toLowerCase()
          };
        } else {
          wiForPolicy.categoryFromTicket = (categoryVal !== null ? categoryVal : oldCategory).toLowerCase();
        }
        maybePolicyRun_('WORKITEM_CREATED', { phoneE164: '', lang: 'en' }, wiForPolicy, propCode);
      } catch (policyErr) {
        try { if (typeof logDevSms_ === 'function') logDevSms_('', '', 'PORTAL_PM_POLICY_RERUN_ERR ' + String(policyErr && policyErr.message ? policyErr.message : policyErr)); } catch (_) {}
      }
    }

    return { ok: true, ticketId: ticketId };
  }

  function portalPmCompleteTicket_(body) {
    if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid_payload' };
    var ticketId = (body.ticketId || '').toString().trim();
    if (!ticketId) return { ok: false, reason: 'missing_ticketId' };

    var sheet;
    try { sheet = getSheet_(SHEET_NAME); } catch (e) { return { ok: false, reason: (e && e.message) || 'sheet_error' }; }

    var row = findTicketRowByTicketId_(sheet, ticketId);
    if (!row) return { ok: false, reason: 'ticket_not_found' };

    var now = new Date();
    withWriteLock_('PORTAL_PM_COMPLETE_TICKET', function () {
      sheet.getRange(row, COL.STATUS).setValue('Completed');
      sheet.getRange(row, COL.CLOSED_AT).setValue(now);
      sheet.getRange(row, COL.LAST_UPDATE).setValue(now);
    });

    // Reuse existing completion path: if a work item is linked to this ticket, set it to DONE via wiTransition_.
    try {
      var wiId = typeof findWorkItemIdByTicketRow_ === 'function' ? findWorkItemIdByTicketRow_(row) : '';
      if (wiId && typeof wiTransition_ === 'function') {
        wiTransition_(wiId, 'DONE', '', '', 'PORTAL_PM_COMPLETE');
      }
    } catch (_) {}

    return { ok: true, ticketId: ticketId };
  }

  function portalPmDeleteTicket_(body) {
    if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid_payload' };
    var ticketId = (body.ticketId || '').toString().trim();
    if (!ticketId) return { ok: false, reason: 'missing_ticketId' };

    var sheet;
    try { sheet = getSheet_(SHEET_NAME); } catch (e) { return { ok: false, reason: (e && e.message) || 'sheet_error' }; }

    var rows = findTicketRowsByTicketId_(sheet, ticketId);
    if (rows.length === 0) return { ok: false, reason: 'ticket_not_found' };
    if (rows.length > 1) return { ok: false, reason: 'multiple_ticket_matches' };

    var row = rows[0];
    withWriteLock_('PORTAL_PM_DELETE_TICKET', function () {
      sheet.deleteRow(row);
    });
    return { ok: true, ticketId: ticketId };
  }

  // ============================================================
  // NEW ISSUE INTENT DETECTOR (Propera Compass)
  // Catches "also my heater broken" / "another problem" etc.
  // ============================================================
  function looksLikeNewIssueIntent_(bodyTrim) {
    const t = String(bodyTrim || "").toLowerCase().trim();
    return /\b(new request|new ticket|new issue|new problem|separate issue|another issue|another problem|also my|also the|second issue|unrelated)\b/.test(t);
  }

  // ============================================================
  // MANAGER TICKET CREATOR (Propera Compass)
  // Replaces all 3 fakeEvent+handleSmsCore_ replay sites.
  // Returns: { ok, ticketId, queued }
  // ============================================================
  function mgrCreateTicketForTenant_(sheet, tenantPhone, propertyName, unit, issue, originPhone, opts) {
    opts = opts || {};

    const dir   = getSheet_(DIRECTORY_SHEET_NAME);
    const phone = normalizePhone_(tenantPhone);
    const lang  = String(opts.lang    || "en").toLowerCase();
    const dayWord = String(opts.dayWord || "");

    const sp            = PropertiesService.getScriptProperties();
    const TWILIO_SID    = opts.TWILIO_SID    || String(sp.getProperty("TWILIO_SID")    || "");
    const TWILIO_TOKEN  = opts.TWILIO_TOKEN  || String(sp.getProperty("TWILIO_TOKEN")  || "");
    const TWILIO_NUMBER = opts.TWILIO_NUMBER || String(sp.getProperty("TWILIO_NUMBER") || "");

    const tBaseVars = { brandName: BRAND.name, teamName: BRAND.team };

    // ── Ensure Directory row exists ──
    let dirRow = 0;
    try {
      const digits  = String(phone || "").replace(/\D/g, "").slice(-10);
      const allRows = dir.getDataRange().getValues();
      for (let i = 1; i < allRows.length; i++) {
        if (String(allRows[i][0] || "").replace(/\D/g, "").slice(-10) === digits) {
          dirRow = i + 1; break;
        }
      }
      if (!dirRow) {
        withWriteLock_("MGR_DIR_CREATE_ROW", () => {
          dir.appendRow([phone, "", "", new Date(), "", "", "", "", "", ""]);
          dirRow = dir.getLastRow();
        });
      }
    } catch (err) {
      try { logDevSms_(originPhone, issue, "MGR_TICKET_DIR_ERR " + String(err && err.message ? err.message : err)); } catch (_) {}
      return { ok: false };
    }

    // ── Resolve property object ──
    let propCode = "";
    let propNameFinal = propertyName;
    try {
      const pObj = getPropertyByNameOrKeyword_(propertyName) || detectPropertyFromBody_(propertyName);
      if (pObj) { propCode = pObj.code; propNameFinal = pObj.name; }
    } catch (_) {}

    // ── Check if tenant is mid-conversation ──
    const preBusyRow   = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0;
    const preBusyStage = String(dir.getRange(dirRow, 8).getValue() || "").trim();
    const tenantIsBusy = !!(preBusyStage || preBusyRow > 0);

    // Deterministic inboundKey (stable per manager+tenant+issue within 5-min window)
    const syntheticInboundKey = opts.inboundKey || ("MGR:" + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(
        Utilities.DigestAlgorithm.MD5,
        [originPhone, phone, issue, String(Date.now() - (Date.now() % (5 * 60 * 1000)))].join("|")
      )
    ).slice(0, 16));

    // ── QUEUE BRANCH ──
    if (tenantIsBusy) {
      var mgrLocType = "";
      if (typeof inferLocationTypeDeterministic_ === "function") {
        try {
          var mgrFast = inferLocationTypeDeterministic_(issue);
          var mgrLt = mgrFast && mgrFast.locationType ? String(mgrFast.locationType).toUpperCase() : "";
          if (mgrLt === "UNIT" || mgrLt === "COMMON_AREA") mgrLocType = mgrLt;
        } catch (_) {}
      }
      const ticket = processTicket_(sheet, sp, {
        OPENAI_API_KEY: opts.OPENAI_API_KEY || String(sp.getProperty("OPENAI_API_KEY") || ""),
        TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER,
        ONCALL_NUMBER: opts.ONCALL_NUMBER || String(sp.getProperty("ONCALL_NUMBER") || "")
      }, {
        from: phone, tenantPhone: phone,
        propertyName: propNameFinal, unitFromText: unit, messageRaw: issue,
        createdByManager: true, inboundKey: syntheticInboundKey,
        locationType: mgrLocType
      });

      const loggedRow = (ticket && ticket.rowIndex) ? Number(ticket.rowIndex) : 0;
      const ticketId  = String(ticket && ticket.ticketId ? ticket.ticketId : "").trim();

      if (loggedRow >= 2) {
        withWriteLock_("MGR_QUEUE_STATUS", () => {
          sheet.getRange(loggedRow, COL.STATUS).setValue("Queued");
          sheet.getRange(loggedRow, COL.LAST_UPDATE).setValue(new Date());
        });
        try {
          workItemCreate_({
            type: "MAINT", status: "OPEN", state: "QUEUED", substate: "",
            phoneE164: phone, propertyId: propCode, unitId: unit, ticketRow: loggedRow,
            ticketKey: (ticket && ticket.ticketKey) ? String(ticket.ticketKey).trim() : "",
            metadataJson: JSON.stringify({ source: "MGR_QUEUED", originPhone })
          });
        } catch (_) {}
        try { logDevSms_(phone, issue, "MGR_QUEUED row=[" + loggedRow + "] tid=[" + ticketId + "]"); } catch (_) {}
      }

      return { ok: loggedRow >= 2, ticketId, queued: true };
    }

    // ── ACTIVE BRANCH: write-if-empty draft fill ──
    dalWithLock_("MGR_DRAFT_FILL", function () {
      var existingPropCode = String(dir.getRange(dirRow, 2).getValue() || "").trim();
      var existingUnit     = String(dir.getRange(dirRow, 6).getValue() || "").trim();
      var existingIssue    = String(dir.getRange(dirRow, 5).getValue() || "").trim();
      if (!existingPropCode && propCode) dalSetPendingPropertyNoLock_(dir, dirRow, { code: propCode, name: propNameFinal });
      if (!existingUnit && unit) dalSetPendingUnitNoLock_(dir, dirRow, normalizeUnit_(unit));
      if (!existingIssue && issue) {
        dalSetPendingIssueNoLock_(dir, dirRow, issue);
        try { logDevSms_(phone, issue, "ISSUE_WRITE site=[mgrCreateTicketForTenant_] val=[" + String(issue).slice(0, 40) + "]"); } catch (_) {}
      }
      dalSetPendingRowNoLock_(dir, dirRow, "");
      dalSetPendingStageNoLock_(dir, dirRow, "");
      dalSetLastUpdatedNoLock_(dir, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE MGR_DRAFT_FILL row=" + dirRow); } catch (_) {}
    });

    // ── Finalize ──
    const result = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, {
      inboundKey:       syntheticInboundKey,
      createdByManager: true,
      OPENAI_API_KEY:   opts.OPENAI_API_KEY || String(sp.getProperty("OPENAI_API_KEY") || ""),
      TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER,
      ONCALL_NUMBER: opts.ONCALL_NUMBER || String(sp.getProperty("ONCALL_NUMBER") || "")
    });

    if (!result.ok) {
      try { logDevSms_(originPhone, issue, "MGR_TICKET_FINALIZE_FAILED reason=[" + (result.reason || "") + "]"); } catch (_) {}
      return { ok: false };
    }

    // ── Send tenant handoff SMS ──
    try {
      let tenantMsg = "";

      if (result.nextStage === "") {
        tenantMsg = renderTenantKey_("MGR_CREATED_TICKET_INTRO", lang, Object.assign({}, tBaseVars, { ticketId: String(result.ticketId || "") }));
        if (!result.ackOwnedByPolicy) {
          tenantMsg += "\n\n" + renderTenantKey_("TICKET_CREATED_COMMON_AREA", lang, Object.assign({}, tBaseVars, { ticketId: String(result.ticketId || "") }));
        } else {
          try { logDevSms_(phone, "", "ACK_SUPPRESSED_BY_POLICY workItemId=" + (result.createdWi || "") + " rule=" + (result.policyRuleId || "")); } catch (_) {}
        }
      } else if (result.nextStage === "UNIT") {
        tenantMsg = renderTenantKey_("MGR_CREATED_TICKET_INTRO", lang, tBaseVars)
          + "\n\n"
          + renderTenantKey_("ASK_UNIT", lang, tBaseVars);
      } else {
        const dayLine = dayWord
          ? ("\n" + renderTenantKey_("ASK_WINDOW_DAYLINE_HINT", lang, Object.assign({}, tBaseVars, { dayWord })))
          : "";
        tenantMsg = renderTenantKey_("MGR_CREATED_TICKET_INTRO", lang, tBaseVars)
          + "\n\n"
          + renderTenantKey_("ASK_WINDOW_SIMPLE", lang, Object.assign({}, tBaseVars, { dayLine }));
      }

      if (tenantMsg) {
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, phone, tenantMsg);
        if (result.nextStage === "") {
          try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
        }
        try { logDevSms_(phone, "", "MGR_TENANT_HANDOFF_SMS nextStage=[" + result.nextStage + "]"); } catch (_) {}
      }
    } catch (err) {
      try { logDevSms_(phone, issue, "MGR_TENANT_HANDOFF_SMS_ERR " + String(err && err.message ? err.message : err)); } catch (_) {}
    }

    return { ok: true, ticketId: result.ticketId, queued: false };
  }

  /************************************
  * PROPERA — WORK ENGINE (PHASE 1)
  * - Adds WorkItems + ConversationContext tables
  * - Header-based column lookup (no brittle COL for these new tables)
  ************************************/

  const WORKITEMS_SHEET = "WorkItems";
  const CTX_SHEET = "ConversationContext";
  const SESSIONS_SHEET = "Sessions";

  // --------------------------------------------------
  // Operational domain router (Phase 1 – Compass)
  // --------------------------------------------------
  const OPS_DOMAIN_ROUTER_ENABLED = true;          // Global gate for inner operational router
  const OPS_CLEANING_LIVE_DIVERT_ENABLED = true;   // When false: log-only, always fall back to MAINTENANCE

  const OPS_DOMAIN = {
    MAINTENANCE: "MAINTENANCE",
    CLEANING: "CLEANING",
    COMPLIANCE: "COMPLIANCE",
    ACCESS: "ACCESS",
    TURNOVER: "TURNOVER",
    PREVENTIVE: "PREVENTIVE"
  };

  // Cache header maps for speed
  const __hdrCache = {};

  /** Get or create sheet by name */
  function getOrCreateSheet_(name, headers) {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(name);
    if (sh) return sh;

    return withWriteLock_("SHEET_CREATE_" + name, () => {
      let s2 = ss.getSheetByName(name);
      if (!s2) s2 = ss.insertSheet(name);

      if (headers && s2.getLastRow() < 1) {
        s2.getRange(1, 1, 1, headers.length).setValues([headers]);
      }
      return s2;
    });
  }

  /** Ensure Visits sheet exists in same workbook as ticket log (LOG_SHEET_ID). Returns sheet. */
  function ensureVisitsSheet_() {
    var ss;
    try {
      var id = typeof LOG_SHEET_ID !== "undefined" ? LOG_SHEET_ID : null;
      ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
      if (!ss) return null;
    } catch (_) { ss = SpreadsheetApp.getActive(); }
    var sh = ss.getSheetByName(VISITS_SHEET_NAME);
    if (sh) return sh;
    return withWriteLock_("SHEET_CREATE_VISITS", function () {
      sh = ss.getSheetByName(VISITS_SHEET_NAME);
      if (!sh) sh = ss.insertSheet(VISITS_SHEET_NAME);
      if (sh.getLastRow() < 1) {
        sh.getRange(1, 1, 1, 7).setValues([["VisitId", "PropertyCode", "PropertyName", "Unit", "ScheduleWindowLabel", "CreatedAt", "Phone"]]);
      }
      return sh;
    });
  }

  /** Create one Visit record; call inside withWriteLock_ or ensure caller holds lock. Returns visitId. */
  function createVisit_(visitsSheet, propCode, propName, unit, scheduleLabel, phone) {
    if (!visitsSheet) return "";
    var visitId = "V_" + Utilities.getUuid().slice(0, 8);
    var now = new Date();
    visitsSheet.appendRow([
      visitId,
      String(propCode || "").trim(),
      String(propName || "").trim(),
      String(unit || "").trim(),
      String(scheduleLabel || "").trim(),
      now,
      String(phone || "").trim()
    ]);
    return visitId;
  }


  /** Build a header->colIndex map (1-indexed) */
  function getHeaderMap_(sheet) {
    const key = sheet.getName();
    const lastCol = sheet.getLastColumn();

    const cached = __hdrCache[key];
    if (cached && cached.lastCol === lastCol) return cached.map;

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(h => String(h || "").trim());

    const map = {};
    headers.forEach((h, i) => { if (h) map[h] = i + 1; });

    __hdrCache[key] = { lastCol, map };
    return map;
  }


  function col_(sheet, headerName) {
    const map = getHeaderMap_(sheet);
    const c = map[headerName];
    if (!c) throw new Error(`Missing header "${headerName}" in sheet "${sheet.getName()}"`);
    return c;
  }


  // Per-execution lookup memo (NOT persisted, cleared at end of doPost)
  var __FINDROW_CACHE__ = {};

  /** Find row by exact match in a column (returns sheet row number or 0) */
  function findRowByValue_(sheet, headerName, value) {
    const needle = String(value || "").trim();
    if (!needle) return 0;

    // Cache key is sheetId + headerName + needle
    let sid = "";
    try { sid = String(sheet.getSheetId()); } catch (_) { sid = "unknown"; }
    const ck = sid + "|" + String(headerName || "").trim() + "|" + needle;
    if (__FINDROW_CACHE__.hasOwnProperty(ck)) return __FINDROW_CACHE__[ck];

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) { __FINDROW_CACHE__[ck] = 0; return 0; }

    const c = col_(sheet, headerName);
    if (!c || c < 1) { __FINDROW_CACHE__[ck] = 0; return 0; }

    const rng = sheet.getRange(2, c, lastRow - 1, 1);

    // Fast path: TextFinder in Sheets (avoids pulling entire column into JS)
    let foundRow = 0;
    try {
      const cell = rng.createTextFinder(needle).matchEntireCell(true).findNext();
      if (cell) foundRow = cell.getRow();
    } catch (e) {
      // Fallback: old scan
      const vals = rng.getValues();
      for (let i = 0; i < vals.length; i++) {
        if (String(vals[i][0] || "").trim() === needle) { foundRow = i + 2; break; }
      }
    }

    __FINDROW_CACHE__[ck] = foundRow;
    return foundRow;
  }

  /** Ensure backbone sheets exist */
  function ensureWorkBackbone_() {
    getOrCreateSheet_(WORKITEMS_SHEET, [
      "WorkItemId","Type","Status","State","Substate","PhoneE164","PropertyId","UnitId","TicketRow","MetadataJson","CreatedAt","UpdatedAt",
      "OwnerType","OwnerId","AssignedByPolicy","AssignedAt","TicketKey"
    ]);
    // Upgrade-in-place: append missing headers at end (TicketKey last so we never shift existing columns)
    try {
      var wiSh = getActiveSheetByNameCached_(WORKITEMS_SHEET);
      if (wiSh && wiSh.getLastRow() >= 1) {
        var lastCol = wiSh.getLastColumn();
        var row1 = wiSh.getRange(1, 1, 1, lastCol).getValues()[0];
        var hdr = row1.map(function (x) { return String(x || "").trim(); });
        var needOwner = ["OwnerType", "OwnerId", "AssignedByPolicy", "AssignedAt"];
        if (hdr.indexOf("TicketKey") < 0) needOwner.push("TicketKey");
        var missing = [];
        for (var i = 0; i < needOwner.length; i++) {
          if (hdr.indexOf(needOwner[i]) < 0) missing.push(needOwner[i]);
        }
        if (missing.length > 0) {
          withWriteLock_("WORKITEMS_UPGRADE_HEADERS", function () {
            var nextCol = wiSh.getLastColumn() + 1;
            for (var j = 0; j < missing.length; j++) {
              wiSh.getRange(1, nextCol + j, 1, nextCol + j).setValue(missing[j]);
            }
          });
        }
      }
    } catch (_) {}

    getOrCreateSheet_(CTX_SHEET, [
      "PhoneE164","Lang","ActiveWorkItemId","PendingWorkItemId","PendingExpected","PendingExpiresAt","LastIntent","UpdatedAt"
    ]);
    getOrCreateSheet_(SESSIONS_SHEET, [
      "Phone","Stage","Expected","Lane","DraftProperty","DraftUnit","DraftIssue","IssueBufJson","DraftScheduleRaw","ActiveArtifactKey","ExpiresAtIso","UpdatedAtIso"
    ]);
  }


  function workItemCreate_(obj) {
    ensureWorkBackbone_();
    var sh = getActiveSheetByNameCached_(WORKITEMS_SHEET);
    var id = obj.workItemId || ("WI_" + Utilities.getUuid().slice(0, 8));
    var now = new Date();

    var row = [
      id,
      String(obj.type || "MAINT").trim(),
      String(obj.status || "OPEN").trim(),
      String(obj.state || "INTAKE").trim(),
      String(obj.substate || "").trim(),
      String(obj.phoneE164 || "").trim(),
      String(obj.propertyId || "").trim(),
      String(obj.unitId || "").trim(),
      obj.ticketRow ? Number(obj.ticketRow) : "",
      String(obj.metadataJson || "").trim(),
      now,
      now,

      // ownership fields
      String(obj.ownerType || "").trim(),
      String(obj.ownerId || "").trim(),
      String(obj.assignedByPolicy || "").trim(),
      (obj.assignedAt instanceof Date) ? obj.assignedAt : (obj.assignedAt ? new Date(obj.assignedAt) : ""),

      // TicketKey last (append-only; avoids shifting columns)
      String(obj.ticketKey || "").trim()
    ];

    withWriteLock_("WORKITEM_CREATE", function () {
      sh.appendRow(row);
    });
    return id;
  }

  function workItemGetById_(workItemId) {
    ensureWorkBackbone_();
    const sh = getActiveSheetByNameCached_(WORKITEMS_SHEET);
    const r = findRowByValue_(sh, "WorkItemId", workItemId);
    if (!r) return null;

    const map = getHeaderMap_(sh);
    const lastCol = sh.getLastColumn();
    const vals = sh.getRange(r, 1, 1, lastCol).getValues()[0];

    function v_(key) {
      var c = map[key];
      return (c >= 1 && c <= vals.length) ? vals[c - 1] : undefined;
    }
    // minimal object (include assignment fields for Sheet1 sync; ticketKey = canonical WI↔ticket link)
    return {
      row: r,
      workItemId: v_("WorkItemId"),
      type: v_("Type"),
      status: v_("Status"),
      state: v_("State"),
      substate: v_("Substate"),
      phoneE164: v_("PhoneE164"),
      propertyId: v_("PropertyId"),
      unitId: v_("UnitId"),
      ticketRow: v_("TicketRow"),
      ticketKey: v_("TicketKey"),
      metadataJson: v_("MetadataJson"),
      ownerType: v_("OwnerType"),
      ownerId: v_("OwnerId"),
      assignedByPolicy: v_("AssignedByPolicy"),
      assignedAt: v_("AssignedAt")
    };
  }

  function workItemUpdate_(workItemId, patch) {
    ensureWorkBackbone_();
    const sh = getActiveSheetByNameCached_(WORKITEMS_SHEET);
    const r = findRowByValue_(sh, "WorkItemId", workItemId);
    if (!r) return false;

    withWriteLock_("WORKITEM_UPDATE", () => {
      if (patch.status !== undefined) sh.getRange(r, col_(sh, "Status")).setValue(String(patch.status));
      if (patch.state !== undefined) sh.getRange(r, col_(sh, "State")).setValue(String(patch.state));
      if (patch.substate !== undefined) sh.getRange(r, col_(sh, "Substate")).setValue(String(patch.substate));
      if (patch.phoneE164 !== undefined) sh.getRange(r, col_(sh, "PhoneE164")).setValue(String(patch.phoneE164 || ""));
      if (patch.propertyId !== undefined) sh.getRange(r, col_(sh, "PropertyId")).setValue(String(patch.propertyId));
      if (patch.unitId !== undefined) sh.getRange(r, col_(sh, "UnitId")).setValue(String(patch.unitId));
      if (patch.ticketRow !== undefined) sh.getRange(r, col_(sh, "TicketRow")).setValue(patch.ticketRow ? Number(patch.ticketRow) : "");
      if (patch.ticketKey !== undefined) sh.getRange(r, col_(sh, "TicketKey")).setValue(String(patch.ticketKey || "").trim());
      if (patch.metadataJson !== undefined) sh.getRange(r, col_(sh, "MetadataJson")).setValue(String(patch.metadataJson || ""));
      sh.getRange(r, col_(sh, "UpdatedAt")).setValue(new Date());
    });

    return true;
  }

  // ============================================================
  // Operational Domain Router (Compass – Phase 1)
  // Slot-based, future-extensible between MAINT / CLEANING etc.
  // ============================================================

  // Cleaning subtype (Phase 1 v1): PET_WASTE | TRASH | SPILL | BIOHAZARD | GENERAL
  function inferCleaningSubtype_(text) {
    var t = String(text || "").toLowerCase().trim();
    if (!t) return "GENERAL";
    if (/\b(poop|feces|faeces|dog\s*waste|pet\s*waste|animal\s*waste|urine|pee)\b/.test(t)) return "PET_WASTE";
    if (/\b(blood|biohazard|hazardous)\b/.test(t)) return "BIOHAZARD";
    if (/\b(trash|garbage|litter|debris)\b/.test(t)) return "TRASH";
    if (/\b(spill|vomit|mess|dirty|filthy|cleanup|clean\s*up)\b/.test(t)) return "SPILL";
    return "GENERAL";
  }

  function getOperationalDomainSlots_() {
    // Slot registry: enabled domains first, then stubs (disabled).
    return [
      {
        domain: OPS_DOMAIN.MAINTENANCE,
        enabled: true,
        priority: 100,
        reviewOnly: false,
        dispatchTarget: "MAINT_PIPELINE",
        hardMatch: function (signal, ctx) {
          var text = String((signal && (signal.turnFacts && signal.turnFacts.issue)) || signal.mergedBody || signal.rawBody || "").toLowerCase();
          if (!text) return null;
          var re = /\b(leak|leaking|clogged|broken|not working|no heat|no hot water|smoke detector|outlet|heater|furnace|ac|air conditioner|fridge|refrigerator|stove|dishwasher)\b/;
          if (re.test(text)) return { matched: true, code: "MAINT_KEYWORD_STRONG" };
          return null;
        },
        veto: function (signal, ctx) {
          return null;
        },
        score: function (signal, ctx) {
          var reasons = [];
          var score = 0;
          var text = String((signal && (signal.turnFacts && signal.turnFacts.issue)) || signal.mergedBody || signal.rawBody || "").toLowerCase();
          if (!text) return { score: 0, reasons: ["no_text"] };

          var maintWords = [
            "leak", "leaking", "clogged", "broken", "not working", "stop working", "stopped working", "no heat",
            "no hot water", "heater", "furnace", "radiator", "smoke detector", "beeping", "outlet", "socket",
            "sink", "toilet", "shower", "tub", "bathroom", "kitchen", "fridge", "refrigerator", "stove",
            "oven", "dishwasher", "window", "door", "lock"
          ];
          for (var i = 0; i < maintWords.length; i++) {
            if (text.indexOf(maintWords[i]) >= 0) {
              score += 2;
              reasons.push("kw:" + maintWords[i]);
            }
          }

          var broad = String(signal && signal.locationScopeBroad || "").toUpperCase();
          if (broad === "UNIT") {
            score += 2;
            reasons.push("loc_broad_unit");
          }

          if (!reasons.length) reasons.push("baseline");
          return { score: score, reasons: reasons };
        }
      },
      {
        domain: OPS_DOMAIN.CLEANING,
        enabled: true,
        priority: 90,
        reviewOnly: false,
        dispatchTarget: "CLEANING_WORKITEM",
        hardMatch: function (signal, ctx) {
          var text = String((signal && (signal.turnFacts && signal.turnFacts.issue)) || signal.mergedBody || signal.rawBody || "").toLowerCase();
          if (!text) return null;
          var re = /\b(poop|feces|faeces|trash|garbage|litter|spill|vomit|urine|pee|blood|mess|dirty|filthy|debris)\b/;
          if (re.test(text)) return { matched: true, code: "CLEANING_KEYWORD_STRONG" };
          return null;
        },
        veto: function (signal, ctx) {
          // If explicit repair language present, do not let CLEANING steal it.
          var text = String((signal && (signal.turnFacts && signal.turnFacts.issue)) || signal.mergedBody || signal.rawBody || "").toLowerCase();
          if (!text) return null;
          var maintRe = /\b(leak|leaking|clogged|broken|not working|no heat|no hot water|heater|furnace|radiator|smoke detector|outlet|socket|stove|dishwasher)\b/;
          if (maintRe.test(text)) return { code: "VETO_REPAIR_LANGUAGE" };
          return null;
        },
        score: function (signal, ctx) {
          var reasons = [];
          var score = 0;
          var text = String((signal && (signal.turnFacts && signal.turnFacts.issue)) || signal.mergedBody || signal.rawBody || "").toLowerCase();
          if (!text) return { score: 0, reasons: ["no_text"] };

          var cleaningWords = [
            "poop", "feces", "faeces", "trash", "garbage", "litter", "spill", "vomit",
            "urine", "pee", "blood", "mess", "dirty", "filthy", "debris", "cleanup", "clean up", "sanit"
          ];
          for (var i = 0; i < cleaningWords.length; i++) {
            if (text.indexOf(cleaningWords[i]) >= 0) {
              score += 3;
              reasons.push("kw:" + cleaningWords[i]);
            }
          }

          var broad = String(signal && signal.locationScopeBroad || "").toUpperCase();
          var refined = String(signal && signal.locationScopeRefined || "").toUpperCase();
          if (broad === "COMMON_AREA") {
            score += 2;
            reasons.push("loc_broad_common_area");
          }
          if (refined && refined !== "UNIT" && refined !== "UNKNOWN") {
            score += 1;
            reasons.push("loc_refined_" + refined);
          }

          var subtype = (typeof inferCleaningSubtype_ === "function") ? inferCleaningSubtype_(text) : "GENERAL";
          if (!reasons.length) reasons.push("baseline");
          return { score: score, reasons: reasons, subtype: subtype };
        }
      },
      // --- Future domains (stubs; disabled) ---
      { domain: OPS_DOMAIN.COMPLIANCE, enabled: false, priority: 50, reviewOnly: true, dispatchTarget: "COMPLIANCE_STUB",
        hardMatch: function () { return null; }, veto: function () { return null; }, score: function () { return { score: 0, reasons: ["stub"] }; } },
      { domain: OPS_DOMAIN.ACCESS, enabled: false, priority: 50, reviewOnly: true, dispatchTarget: "ACCESS_STUB",
        hardMatch: function () { return null; }, veto: function () { return null; }, score: function () { return { score: 0, reasons: ["stub"] }; } },
      { domain: OPS_DOMAIN.TURNOVER, enabled: false, priority: 50, reviewOnly: true, dispatchTarget: "TURNOVER_STUB",
        hardMatch: function () { return null; }, veto: function () { return null; }, score: function () { return { score: 0, reasons: ["stub"] }; } },
      { domain: OPS_DOMAIN.PREVENTIVE, enabled: false, priority: 50, reviewOnly: true, dispatchTarget: "PREVENTIVE_STUB",
        hardMatch: function () { return null; }, veto: function () { return null; }, score: function () { return { score: 0, reasons: ["stub"] }; } }
    ];
  }

  function buildDomainSignal_(opts) {
    opts = opts || {};
    var bodyTrim = String(opts.bodyTrim || "").trim();
    var mergedBodyTrim = String(opts.mergedBodyTrim || bodyTrim).trim();
    var turnFacts = opts.turnFacts || {};
    var mediaFacts = opts.mediaFacts || {};
    var phone = String(opts.phone || "").trim();
    var lang = String(opts.lang || "en").trim();

    var locInput = opts.locationTextHint || mergedBodyTrim || bodyTrim;
    var aiLoc = null;
    if (opts.OPENAI_API_KEY && typeof inferLocationType_ === "function" && locInput) {
      try {
        aiLoc = inferLocationType_(opts.OPENAI_API_KEY, locInput, phone);
      } catch (_) {}
    }

    var locScope = inferLocationScope_(mergedBodyTrim, {
      aiFallback: aiLoc,
      turnFacts: turnFacts,
      mediaFacts: mediaFacts
    });

    var signal = {
      rawBody: bodyTrim,
      mergedBody: mergedBodyTrim,
      phoneE164: phone,
      lang: lang,
      mode: String(opts.mode || "").toUpperCase(),
      propertyCode: String(opts.propertyCode || "").trim(),
      propertyName: String(opts.propertyName || "").trim(),
      pendingUnit: String(opts.pendingUnit || "").trim(),
      dirRow: Number(opts.dirRow || 0) || 0,
      pendingStage: String(opts.pendingStage || "").trim(),
      ticketStateType: String(opts.ticketStateType || "").trim(),
      turnFacts: turnFacts,
      mediaFacts: mediaFacts,
      ctx: opts.ctx || null,

      locationScopeBroad: locScope.locationScopeBroad,
      locationScopeRefined: locScope.locationScopeRefined,
      locationText: locScope.locationText,
      locationSource: locScope.locationSource,
      locationConfidence: locScope.locationConfidence,
      placeKey: locScope.placeKey
    };

    try {
      logDevSms_(phone, (mergedBodyTrim || "").slice(0, 80),
        "DOMAIN_SIGNAL_BUILT broad=[" + signal.locationScopeBroad + "] refined=[" + signal.locationScopeRefined + "] src=[" + signal.locationSource + "] conf=" + signal.locationConfidence);
    } catch (_) {}

    return signal;
  }

  function routeOperationalDomain_(domainSignal, opts) {
    opts = opts || {};
    if (!OPS_DOMAIN_ROUTER_ENABLED || !domainSignal) {
      return {
        detectedDomain: OPS_DOMAIN.MAINTENANCE,
        subtype: "",
        confidence: 0.5,
        selectedEngine: "MAINT_PIPELINE",
        reasons: ["router_disabled"],
        reviewOnly: false,
        fallbackDomain: OPS_DOMAIN.MAINTENANCE,
        locationScopeBroad: (domainSignal && domainSignal.locationScopeBroad) || "UNKNOWN",
        locationScopeRefined: (domainSignal && domainSignal.locationScopeRefined) || "UNKNOWN",
        locationText: (domainSignal && domainSignal.locationText) || "",
        placeKey: (domainSignal && domainSignal.placeKey) || "",
        locationSource: (domainSignal && domainSignal.locationSource) || "none",
        locationConfidence: Number(domainSignal && domainSignal.locationConfidence) || 0,
        preserveMaintenancePath: true,
        evidenceSummary: "",
        issueSummary: (domainSignal && domainSignal.turnFacts && domainSignal.turnFacts.issue) || (domainSignal && domainSignal.mergedBody) || ""
      };
    }

    var slots = getOperationalDomainSlots_();
    var ctx = { mode: opts.mode || "", phone: domainSignal.phoneE164 || "" };

    var bestDomain = OPS_DOMAIN.MAINTENANCE;
    var bestScore = -1;
    var bestReasons = ["baseline"];
    var bestSubtype = "";
    var bestReviewOnly = false;
    var hadCleaningCandidate = false;
    var cleaningScore = -1;
    var maintScore = -1;

    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (!s || !s.domain) continue;
      if (!s.enabled) continue;

      var veto = null;
      try { veto = s.veto(domainSignal, ctx); } catch (_) {}
      if (veto && veto.code) {
        try { logDevSms_(ctx.phone, "", "DOMAIN_SLOT_SCORE domain=[" + s.domain + "] score=VETO reason=[" + veto.code + "] broad=[" + String(domainSignal.locationScopeBroad || "") + "] refined=[" + String(domainSignal.locationScopeRefined || "") + "]"); } catch (_) {}
        continue;
      }

      var slotScore = { score: 0, reasons: ["no_score"] };
      try { slotScore = s.score(domainSignal, ctx) || slotScore; } catch (_) {}

      try {
        logDevSms_(ctx.phone, "", "DOMAIN_SLOT_SCORE domain=[" + s.domain + "] score=" + String(slotScore.score || 0) +
          " reasons=[" + String((slotScore.reasons || []).join("|")).slice(0, 80) + "] broad=[" + String(domainSignal.locationScopeBroad || "") + "] refined=[" + String(domainSignal.locationScopeRefined || "") + "]");
      } catch (_) {}

      if (s.domain === OPS_DOMAIN.MAINTENANCE) maintScore = Number(slotScore.score || 0);
      if (s.domain === OPS_DOMAIN.CLEANING) {
        cleaningScore = Number(slotScore.score || 0);
        if (cleaningScore >= 4) hadCleaningCandidate = true;
      }

      if (slotScore.score > bestScore) {
        bestScore = slotScore.score;
        bestDomain = s.domain;
        bestReasons = slotScore.reasons || ["slot"];
        bestSubtype = slotScore.subtype || "";
        bestReviewOnly = !!s.reviewOnly || !!slotScore.reviewOnly;
      }
    }

    var detectedDomain = OPS_DOMAIN.MAINTENANCE;
    var confidence = 0.5;
    var reasons = bestReasons.slice();
    var preserveMaintenancePath = true;

    var divertEligible = 0;
    if (hadCleaningCandidate && cleaningScore >= 4 && cleaningScore >= (maintScore + 2)) {
      detectedDomain = OPS_DOMAIN.CLEANING;
      confidence = Math.min(0.99, 0.6 + (cleaningScore / 10));
      preserveMaintenancePath = false;
      divertEligible = 1;
    } else {
      detectedDomain = OPS_DOMAIN.MAINTENANCE;
      confidence = Math.min(0.95, 0.5 + Math.max(0, maintScore) / 10);
      preserveMaintenancePath = true;
      if (hadCleaningCandidate) reasons.push("cleaning_fallback_to_maint");
    }

    var scoreGap = (cleaningScore - maintScore);
    try {
      logDevSms_(ctx.phone, "", "DOMAIN_SCORE_GAP maintScore=" + String(maintScore) + " cleaningScore=" + String(cleaningScore) + " scoreGap=" + String(scoreGap) + " divertEligible=" + String(divertEligible));
    } catch (_) {}

    var finalSubtype = bestSubtype || "";
    if (detectedDomain === OPS_DOMAIN.CLEANING && !finalSubtype && typeof inferCleaningSubtype_ === "function") {
      var issueText = (domainSignal && domainSignal.turnFacts && domainSignal.turnFacts.issue) || (domainSignal && domainSignal.mergedBody) || "";
      finalSubtype = inferCleaningSubtype_(issueText);
    }

    var decision = {
      detectedDomain: detectedDomain,
      subtype: finalSubtype || "",
      confidence: confidence,
      selectedEngine: detectedDomain === OPS_DOMAIN.CLEANING ? "CLEANING_WORKITEM" : "MAINT_PIPELINE",
      reasons: reasons,
      reviewOnly: bestReviewOnly,
      fallbackDomain: OPS_DOMAIN.MAINTENANCE,
      locationScopeBroad: (domainSignal && domainSignal.locationScopeBroad) || "UNKNOWN",
      locationScopeRefined: (domainSignal && domainSignal.locationScopeRefined) || "UNKNOWN",
      locationText: (domainSignal && domainSignal.locationText) || "",
      placeKey: (domainSignal && domainSignal.placeKey) || "",
      locationSource: (domainSignal && domainSignal.locationSource) || "none",
      locationConfidence: Number(domainSignal && domainSignal.locationConfidence) || 0,
      preserveMaintenancePath: preserveMaintenancePath,
      evidenceSummary: "",
      issueSummary: (domainSignal && domainSignal.turnFacts && domainSignal.turnFacts.issue) || (domainSignal && domainSignal.mergedBody) || ""
    };

    try {
      logDevSms_(ctx.phone, "", "DOMAIN_ROUTE_SELECTED domain=[" + decision.detectedDomain + "] conf=" + decision.confidence.toFixed(2) +
        " broad=[" + decision.locationScopeBroad + "] refined=[" + decision.locationScopeRefined + "] reasons=[" + String((decision.reasons || []).join("|")).slice(0, 80) + "]");
    } catch (_) {}

    if (decision.detectedDomain !== OPS_DOMAIN.MAINTENANCE && decision.preserveMaintenancePath) {
      try { logDevSms_(ctx.phone, "", "DOMAIN_ROUTE_FALLBACK src=[" + decision.detectedDomain + "] dst=[MAINTENANCE] reason=[preserve_path]"); } catch (_) {}
      decision.detectedDomain = OPS_DOMAIN.MAINTENANCE;
      decision.selectedEngine = "MAINT_PIPELINE";
    }

    return decision;
  }

  function dispatchOperationalDomain_(decision, routeCtx) {
    routeCtx = routeCtx || {};
    if (!decision || !OPS_DOMAIN_ROUTER_ENABLED) {
      return { handled: false };
    }

    var phone = String(routeCtx.phone || "").trim();

    try {
      logDevSms_(phone, "", "DOMAIN_DISPATCH_START domain=[" + (decision.detectedDomain || "") + "] conf=" + String(decision.confidence || ""));
    } catch (_) {}

    if (decision.detectedDomain === OPS_DOMAIN.CLEANING) {
      if (!OPS_CLEANING_LIVE_DIVERT_ENABLED || decision.reviewOnly || decision.confidence < 0.75) {
        try { logDevSms_(phone, "", "DOMAIN_DISPATCH_CLEANING_FALLBACK conf=" + String(decision.confidence || "") + " reviewOnly=" + String(decision.reviewOnly || false)); } catch (_) {}
        return { handled: false };
      }

      var createResult = createCleaningWorkItemFromDomain_(decision, routeCtx);
      var wiId = (createResult && createResult.workItemId) ? String(createResult.workItemId).trim() : "";
      var deduped = !!(createResult && createResult.deduped);

      if (deduped) {
        try { logDevSms_(phone, "", "CLEANING_DEDUPE_ACK"); } catch (_) {}
        return { handled: true, deduped: true };
      }

      if (!wiId) {
        try { logDevSms_(phone, "", "CLEANING_ROUTE_ABORTED reason=[workitem_create_failed]"); } catch (_) {}
        return { handled: false };
      }

      try {
        logDevSms_(phone, "", "DOMAIN_DISPATCH_CLEANING wiId=[" + wiId + "] broad=[" + (decision.locationScopeBroad || "") + "] refined=[" + (decision.locationScopeRefined || "") + "] subtype=[" + (decision.subtype || "") + "]");
        logDevSms_(phone, "", "CLEANING_WORKITEM_CREATED wiId=[" + wiId + "] domain=[CLEANING]");
      } catch (_) {}

      return {
        handled: true,
        cleaningWorkItemId: wiId
      };
    }

    // Default / MAINTENANCE path: let existing draft/ticket spine run.
    try {
      logDevSms_(phone, "", "DOMAIN_DISPATCH_MAINT domain=[" + (decision.detectedDomain || "MAINTENANCE") + "]");
    } catch (_) {}

    return { handled: false };
  }

  function createCleaningWorkItemFromDomain_(decision, routeCtx) {
    routeCtx = routeCtx || {};
    var phone = String(routeCtx.phone || "").trim();
    var propCode = String(routeCtx.propertyCode || "").trim();
    var propName = String(routeCtx.propertyName || "").trim();
    var unitVal = "";
    if (String(decision.locationScopeBroad || "").toUpperCase() === "UNIT") {
      unitVal = String(routeCtx.pendingUnit || routeCtx.unit || "").trim();
    }

    var issueSummary = String(decision.issueSummary || routeCtx.bodyTrim || "").slice(0, 300);

    // Lightweight dedupe: same phone + time window + normalized issue + property + location + first media URL
    var normIssue = String(issueSummary || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
    var firstMedia = "";
    try {
      if (routeCtx.mediaFacts && routeCtx.mediaFacts.mediaUrls && routeCtx.mediaFacts.mediaUrls[0]) firstMedia = String(routeCtx.mediaFacts.mediaUrls[0]).trim();
      else if (routeCtx.turnFacts && routeCtx.turnFacts.meta && routeCtx.turnFacts.meta.mediaUrls && routeCtx.turnFacts.meta.mediaUrls[0]) firstMedia = String(routeCtx.turnFacts.meta.mediaUrls[0]).trim();
    } catch (_) {}
    var timeBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    var fpParts = [phone, String(timeBucket), normIssue, propCode, String(decision.locationScopeRefined || ""), firstMedia];
    var fpRaw = fpParts.join("|");
    var fpHash = "";
    try { fpHash = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, fpRaw)); } catch (_) { fpHash = fpRaw.slice(0, 32); }
    var dedupeKey = "CLEANING_DEDUPE_" + fpHash;
    try {
      var cache = CacheService.getDocumentCache();
      if (cache && cache.get(dedupeKey)) {
        try { logDevSms_(phone, "", "CLEANING_DEDUPE_HIT key=" + dedupeKey.slice(0, 40)); } catch (_) {}
        return { workItemId: "", deduped: true };
      }
    } catch (_) {}

    var mediaUrls = [];
    try {
      if (routeCtx.mediaFacts && routeCtx.mediaFacts.mediaUrls && routeCtx.mediaFacts.mediaUrls.length) {
        mediaUrls = routeCtx.mediaFacts.mediaUrls;
      } else if (routeCtx.turnFacts && routeCtx.turnFacts.meta && routeCtx.turnFacts.meta.mediaUrls) {
        mediaUrls = routeCtx.turnFacts.meta.mediaUrls;
      }
    } catch (_) {}

    var metadata = {
      domain: OPS_DOMAIN.CLEANING,
      subtype: decision.subtype || "",
      propertyCode: propCode,
      propertyName: propName,
      locationScopeBroad: decision.locationScopeBroad || "UNKNOWN",
      locationScopeRefined: decision.locationScopeRefined || "UNKNOWN",
      locationText: decision.locationText || "",
      placeKey: decision.placeKey || "",
      issueSummary: issueSummary,
      locationSource: decision.locationSource || "",
      locationConfidence: Number(decision.locationConfidence || 0),
      mediaUrls: mediaUrls,
      phoneE164: phone,
      sourceChannel: routeCtx.channel || "",
      source: "SMS_CORE",
      state: "NEW"
    };

    var asn = null;
    try {
      if (typeof resolveWorkItemAssignment_ === "function" && propCode) {
        asn = resolveWorkItemAssignment_(propCode, { phoneE164: phone, domain: OPS_DOMAIN.CLEANING });
      }
    } catch (_) {
      asn = null;
    }

    var ownerType = (asn && asn.ownerType) || "STAFF";
    var ownerId = (asn && asn.ownerId) || "";
    var assignedByPolicy = (asn && asn.assignedByPolicy) || "OPS_CLEANING_DEFAULT";
    var assignedAt = (asn && asn.assignedAt) || new Date();

    var wiId = "";
    try {
      wiId = workItemCreate_({
        type: "CLEANING",
        status: "OPEN",
        state: "STAFF_TRIAGE",
        substate: "NEW",
        phoneE164: phone,
        propertyId: propCode,
        unitId: unitVal,
        ticketRow: "",
        metadataJson: JSON.stringify(metadata),
        ownerType: ownerType,
        ownerId: ownerId,
        assignedByPolicy: assignedByPolicy,
        assignedAt: assignedAt
      });
    } catch (err) {
      try { logDevSms_(phone, "", "CLEANING_WORKITEM_CREATE_ERR " + String(err)); } catch (_) {}
      return { workItemId: "", deduped: false };
    }

    try {
      var cache = CacheService.getDocumentCache();
      if (cache) cache.put(dedupeKey, "1", 600);
    } catch (_) {}

    // Optional: update ctx so future turns know about active cleaning work item
    try {
      if (typeof ctxUpsert_ === "function" && phone) {
        ctxUpsert_(phone, {
          activeWorkItemId: wiId,
          pendingWorkItemId: wiId,
          pendingExpected: "",
          pendingExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          lastIntent: "CLEANING"
        }, "OPS_CLEANING_CREATE");
      }
    } catch (_) {}

    return { workItemId: wiId, deduped: false };
  }

  /** Clear maintenance draft residue for a directory row after cleaning dispatch (Phase 1). */
  function clearMaintenanceDraftResidue_(dir, dirRow, phone) {
    if (!dir || !dirRow || dirRow < 2) return;
    try {
      dalWithLock_("CLEANING_CLEAR_DRAFT_RESIDUE", function () {
        dalSetPendingIssueNoLock_(dir, dirRow, "");
        dalSetPendingUnitNoLock_(dir, dirRow, "");
        dalSetPendingStageNoLock_(dir, dirRow, "");
        dalSetPendingRowNoLock_(dir, dirRow, "");
        if (typeof DIR_COL !== "undefined" && DIR_COL.DRAFT_SCHEDULE_RAW) {
          dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW).setValue("");
        }
        dalSetLastUpdatedNoLock_(dir, dirRow);
      });
      try { logDevSms_(phone || "", "", "CLEANING_CLEAR_DRAFT_RESIDUE row=" + dirRow); } catch (_) {}
    } catch (_) {}
  }

  function isLangCode_(v) {
    const s = String(v || "").trim().toLowerCase();
    return (s === "en" || s === "es" || s === "pt" || s === "fr");
  }

  function sanitizeCtxPatch_(patch, phone, traceTag) {
    const out = Object.assign({}, patch || {});
    const badKeys = ["activeWorkItemId", "pendingWorkItemId"];

    for (let i = 0; i < badKeys.length; i++) {
      const k = badKeys[i];
      if (k in out) {
        const v = out[k];
        if (isLangCode_(v)) {
          // Tripwire log so we can find the caller later
          try { logDevSms_(phone, "", "CTX_SANITIZE blocked " + k + "=[" + v + "] tag=" + String(traceTag || "")); } catch (_) {}
          out[k] = ""; // prevent poisoning
        }
      }
    }

    // Optional: also block ridiculously short workItemIds (defensive)
    if ("activeWorkItemId" in out) {
      const s = String(out.activeWorkItemId || "").trim();
      if (s && s.length < 6) out.activeWorkItemId = "";
    }
    if ("pendingWorkItemId" in out) {
      const s = String(out.pendingWorkItemId || "").trim();
      if (s && s.length < 6) out.pendingWorkItemId = "";
    }

    return out;
  }


  function ctxGet_(phoneAny) {
    ensureWorkBackbone_();
    const phone = phoneKey_(phoneAny);

    if (phone && __CTX_CACHE__.hasOwnProperty(phone)) return __CTX_CACHE__[phone];

    const sh = getActiveSheetByNameCached_(CTX_SHEET);

    if (!phone) {
      const out0 = {
        phoneE164: "",
        lang: "en",
        activeWorkItemId: "",
        pendingWorkItemId: "",
        pendingExpected: "",
        pendingExpiresAt: "",
        lastIntent: ""
      };
      return out0;
    }

    const r = findRowByValue_(sh, "PhoneE164", phone);
    if (!r) {
      const out1 = {
        phoneE164: phone,
        lang: "en",
        activeWorkItemId: "",
        pendingWorkItemId: "",
        pendingExpected: "",
        pendingExpiresAt: "",
        lastIntent: ""
      };
      __CTX_CACHE__[phone] = out1;
      return out1;
    }

    const map = getHeaderMap_(sh);
    const vals = sh.getRange(r, 1, 1, sh.getLastColumn()).getValues()[0];

    const out = {
      row: r,
      phoneE164: String(vals[(map["PhoneE164"] || 1) - 1] || phone),
      lang: String(vals[(map["Lang"] || 8) - 1] || "en") || "en",
      activeWorkItemId: String(vals[(map["ActiveWorkItemId"] || 2) - 1] || ""),
      pendingWorkItemId: String(vals[(map["PendingWorkItemId"] || 3) - 1] || ""),
      pendingExpected: String(vals[(map["PendingExpected"] || 4) - 1] || ""),
      pendingExpiresAt: vals[(map["PendingExpiresAt"] || 5) - 1] || "",
      lastIntent: String(vals[(map["LastIntent"] || 6) - 1] || "")
    };

    __CTX_CACHE__[phone] = out;
    return out;
  }


  function ctxUpsert_(phoneAny, patch, traceTag) {
    ensureWorkBackbone_();

    const sh = getActiveSheetByNameCached_(CTX_SHEET);
    const phone = phoneKey_(phoneAny);
    if (!phone) return false;

    try {
      const p = phoneKey_(phoneAny || phone || "");
      if (p && __CTX_CACHE__) delete __CTX_CACHE__[p];
    } catch (_) {}

    const clean = sanitizeCtxPatch_(patch, phone, traceTag || "CTX_UPSERT");

    // ------------------------------------------------
    // SAFETY: only TENANT phones may set pending stage
    // ------------------------------------------------
    try {
      const isPendingWrite =
        ("pendingExpected" in clean) ||
        ("pendingExpiresAt" in clean) ||
        ("pendingWorkItemId" in clean);

      if (isPendingWrite) {
        if (typeof isManager_ === "function" && isManager_(phone)) {
          logDevSms_(phone, "", "CTX_BLOCK manager_pending");
          return false;
        }
        if (typeof isVendor_ === "function" && isVendor_(phone)) {
          logDevSms_(phone, "", "CTX_BLOCK vendor_pending");
          return false;
        }
      }
    } catch (_) {}

    withWriteLock_("CTX_UPSERT", () => {
      let r = findRowByValue_(sh, "PhoneE164", phone);

      if (!r) {
        sh.appendRow([phone, "", "", "", "", "", new Date(), "en"]);
        r = sh.getLastRow();
      }

      if (clean.activeWorkItemId !== undefined)
        sh.getRange(r, col_(sh, "ActiveWorkItemId")).setValue(String(clean.activeWorkItemId || ""));

      if (clean.pendingWorkItemId !== undefined)
        sh.getRange(r, col_(sh, "PendingWorkItemId")).setValue(String(clean.pendingWorkItemId || ""));

      if (clean.pendingExpected !== undefined)
        sh.getRange(r, col_(sh, "PendingExpected")).setValue(String(clean.pendingExpected || ""));

      if (clean.pendingExpiresAt !== undefined)
        sh.getRange(r, col_(sh, "PendingExpiresAt")).setValue(clean.pendingExpiresAt || "");

      if (clean.lastIntent !== undefined)
        sh.getRange(r, col_(sh, "LastIntent")).setValue(String(clean.lastIntent || ""));

      if (clean.lang !== undefined)
        sh.getRange(r, col_(sh, "Lang")).setValue(String(clean.lang || "en"));

      sh.getRange(r, col_(sh, "UpdatedAt")).setValue(new Date());
    });

    return true;
  }

  // ============================================================
  // SESSION DAL (Propera Compass — pre-ticket source of truth)
  // Sessions sheet (16 cols): Phone, SessionId, Lane, State, Expected, Intent, Draft, Drafunit, DraftIssue, IssueBufJson, DraftScheduleRaw, ActiveArtifactKey, LastPromptKey, ExpiresAtIso, UnlinkedMediaJson, UpdatedAtIso
  // One row per phone; use normalizeSessionPhoneKey_ for lookup.
  // ============================================================

  var SESSION_COL = {
    PHONE: 1,
    SESSION_ID: 2,
    LANE: 3,
    STATE: 4,
    EXPECTED: 5,
    INTENT: 6,
    DRAFT: 7,
    DRAFT_UNIT: 8,
    DRAFT_ISSUE: 9,
    ISSUE_BUF_JSON: 10,
    DRAFT_SCHEDULE_RAW: 11,
    ACTIVE_ARTIFACT_KEY: 12,
    LAST_PROMPT_KEY: 13,
    EXPIRES_AT_ISO: 14,
    UNLINKED_MEDIA_JSON: 15, // ✅ new
    UPDATED_AT_ISO: 16       // ✅ shifted
  };

  function normalizeSessionPhoneKey_(phone) {
    var s = String(phone || "").trim();
    if (s.indexOf("+") === 0) s = s.slice(1).trim();
    return s;
  }

  // Blank UpdatedAtIso sorts as oldest (so "newest" selection is consistent).
  var SESSION_OLDEST_ISO = "1970-01-01T00:00:00.000Z";
  function sessionUpdatedAtForSort_(iso) {
    var s = String(iso || "").trim();
    return s || SESSION_OLDEST_ISO;
  }

  // Mergeable columns (for dedupe): State, Expected, Lane, Draft, Drafunit, DraftIssue, IssueBufJson, DraftScheduleRaw, ActiveArtifactKey, ExpiresAtIso
  var SESSION_MERGE_COLS = [SESSION_COL.STATE, SESSION_COL.EXPECTED, SESSION_COL.LANE, SESSION_COL.DRAFT, SESSION_COL.DRAFT_UNIT, SESSION_COL.DRAFT_ISSUE, SESSION_COL.ISSUE_BUF_JSON, SESSION_COL.DRAFT_SCHEDULE_RAW, SESSION_COL.ACTIVE_ARTIFACT_KEY, SESSION_COL.EXPIRES_AT_ISO];

  // Scan Sessions sheet for rows where Phone (col 1) normalizes to phoneKey. Data rows = 2..lastRow (inclusive via numRows).
  // Guard: lastRow < 2 => no getRange.
  // Returns { matching: [ { row: number, updatedAtIso: string } ] }.
  function sessionScanRowsByPhone_(sh, phoneKey) {
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return { matching: [] };

    var numRows = lastRow - 1;
    var phones = sh.getRange(2, SESSION_COL.PHONE, numRows, 1).getValues();
    var updatedVals = sh.getRange(2, SESSION_COL.UPDATED_AT_ISO, numRows, 1).getValues();
    var matching = [];
    for (var i = 0; i < phones.length; i++) {
      var cellPhone = String(phones[i][0] || "").trim();
      if (normalizeSessionPhoneKey_(cellPhone) === phoneKey) {
        matching.push({
          row: i + 2,
          updatedAtIso: String(updatedVals[i] && updatedVals[i][0] != null ? updatedVals[i][0] : "").trim()
        });
      }
    }
    return { matching: matching };
  }

  // Pick the session row with newest UpdatedAtIso (primary). Merge non-empty fields from older rows into primary.
  function sessionPickNewestAndMerge_(sh, matching) {
    if (!matching || matching.length === 0) return null;
    if (matching.length === 1) return matching[0].row;

    matching = matching.slice().sort(function (a, b) {
      return sessionUpdatedAtForSort_(b.updatedAtIso).localeCompare(sessionUpdatedAtForSort_(a.updatedAtIso), undefined, { numeric: false });
    });
    var primaryRow = matching[0].row;
    var lastCol = Math.max(sh.getLastColumn(), SESSION_COL.UPDATED_AT_ISO);
    var primaryVals = sh.getRange(primaryRow, 1, primaryRow, lastCol).getValues()[0];
    var merged = false;
    for (var o = 1; o < matching.length; o++) {
      var otherVals = sh.getRange(matching[o].row, 1, matching[o].row, lastCol).getValues()[0];
      for (var k = 0; k < SESSION_MERGE_COLS.length; k++) {
        var col = SESSION_MERGE_COLS[k];
        var primaryVal = String(primaryVals[col - 1] != null ? primaryVals[col - 1] : "").trim();
        var otherVal = String(otherVals[col - 1] != null ? otherVals[col - 1] : "").trim();
        if (!primaryVal && otherVal) {
          primaryVals[col - 1] = otherVal;
          merged = true;
        }
      }
    }
    if (merged) {
      for (var k = 0; k < SESSION_MERGE_COLS.length; k++) {
        var col = SESSION_MERGE_COLS[k];
        if (primaryVals[col - 1] != null) sh.getRange(primaryRow, col).setValue(primaryVals[col - 1]);
      }
    }
    return primaryRow;
  }

  function sessionGet_(phoneAny) {
    ensureWorkBackbone_();
    var phone = normalizeSessionPhoneKey_((typeof phoneKey_ === "function") ? phoneKey_(phoneAny) : phoneAny);
    if (!phone) return null;

    var sh = getActiveSheetByNameCached_(SESSIONS_SHEET);
    if (!sh || sh.getLastRow() < 2) return null;

    var scan = sessionScanRowsByPhone_(sh, phone);
    var matching = scan.matching;

    var r = 0;
    if (matching.length === 0) return null;
    if (matching.length > 1) {
      try { logDevSms_(phone, "", "SESSION_DUPES_GET phone=[" + phone + "] rows=[" + matching.map(function (m) { return m.row; }).join(",") + "]"); } catch (_) {}
      matching = matching.slice().sort(function (a, b) {
        return sessionUpdatedAtForSort_(b.updatedAtIso).localeCompare(sessionUpdatedAtForSort_(a.updatedAtIso), undefined, { numeric: false });
      });
      r = matching[0].row;
    } else {
      r = matching[0].row;
    }

    var lastCol = Math.max(sh.getLastColumn(), SESSION_COL.UPDATED_AT_ISO);
    var vals = sh.getRange(r, 1, r, lastCol).getValues()[0];
    function v(col) { return vals[col - 1]; }
    var rawBuf = String(v(SESSION_COL.ISSUE_BUF_JSON) || "").trim();
    var buf = [];
    try { if (rawBuf) buf = JSON.parse(rawBuf); } catch (_) {}
    if (!Array.isArray(buf)) buf = [];

    return {
      phone: String(v(SESSION_COL.PHONE) || "").trim(),
      stage: String(v(SESSION_COL.STATE) || "").trim(),
      expected: String(v(SESSION_COL.EXPECTED) || "").trim(),
      lane: String(v(SESSION_COL.LANE) || "").trim(),
      draftProperty: String(v(SESSION_COL.DRAFT) || "").trim(),
      draftUnit: String(v(SESSION_COL.DRAFT_UNIT) || "").trim(),
      draftIssue: String(v(SESSION_COL.DRAFT_ISSUE) || "").trim(),
      issueBufJson: rawBuf,
      issueBuf: buf,
      draftScheduleRaw: String(v(SESSION_COL.DRAFT_SCHEDULE_RAW) || "").trim(),
      activeArtifactKey: String(v(SESSION_COL.ACTIVE_ARTIFACT_KEY) || "").trim(),
      expiresAtIso: String(v(SESSION_COL.EXPIRES_AT_ISO) || "").trim(),
      unlinkedMediaJson: String(v(SESSION_COL.UNLINKED_MEDIA_JSON) || "[]").trim(),
      updatedAtIso: String(v(SESSION_COL.UPDATED_AT_ISO) || "").trim(),
      row: r
    };
  }

  // No-lock variant: does Sessions sheet writes only. Call only when caller already holds a write lock (e.g. inside DRAFT_UPSERT).
  function sessionUpsertNoLock_(phoneAny, patch, reason) {
    ensureWorkBackbone_();
    var phone = normalizeSessionPhoneKey_((typeof phoneKey_ === "function") ? phoneKey_(phoneAny) : phoneAny);
    if (!phone) return false;

    var nowIso = new Date().toISOString();
    var sh = getActiveSheetByNameCached_(SESSIONS_SHEET);
    if (!sh) return false;

    var scan = sessionScanRowsByPhone_(sh, phone);
    var matching = scan.matching;

    var r;
    if (matching.length === 0) {
      sh.appendRow([
        phone, "", "", "", "", "", "", "", "", "[]", "", "", "", "", "[]", nowIso
      ]);
      r = sh.getLastRow();
    } else if (matching.length === 1) {
      r = matching[0].row;
    } else {
      try { logDevSms_(phone, "", "SESSION_DUPES phone=[" + phone + "] rows=[" + matching.map(function (m) { return m.row; }).join(",") + "]"); } catch (_) {}
      r = sessionPickNewestAndMerge_(sh, matching);
      if (!r) r = matching[0].row;
      var extraRows = matching.filter(function (m) { return m.row !== r; }).map(function (m) { return m.row; }).sort(function (a, b) { return b - a; });
      for (var e = 0; e < extraRows.length; e++) {
        try { sh.deleteRow(extraRows[e]); } catch (_) {}
      }
      var scan2 = sessionScanRowsByPhone_(sh, phone);
      if (scan2.matching && scan2.matching.length >= 1) {
        r = scan2.matching.length === 1 ? scan2.matching[0].row : (scan2.matching.slice().sort(function (a, b) {
          return sessionUpdatedAtForSort_(b.updatedAtIso).localeCompare(sessionUpdatedAtForSort_(a.updatedAtIso), undefined, { numeric: false });
        })[0].row);
      }
    }

    function setVal(col, val) {
      if (col) sh.getRange(r, col).setValue(val != null ? val : "");
    }

    if (patch.stage !== undefined) setVal(SESSION_COL.STATE, String(patch.stage || "").trim());
    if (patch.expected !== undefined) setVal(SESSION_COL.EXPECTED, String(patch.expected || "").trim());
    if (patch.lane !== undefined) setVal(SESSION_COL.LANE, String(patch.lane || "").trim());
    if (patch.draftProperty !== undefined) setVal(SESSION_COL.DRAFT, String(patch.draftProperty || "").trim());
    if (patch.draftUnit !== undefined) setVal(SESSION_COL.DRAFT_UNIT, String(patch.draftUnit || "").trim());
    if (patch.draftIssue !== undefined) setVal(SESSION_COL.DRAFT_ISSUE, String(patch.draftIssue || "").trim());
    if (patch.issueBufJson !== undefined) setVal(SESSION_COL.ISSUE_BUF_JSON, typeof patch.issueBufJson === "string" ? patch.issueBufJson : (Array.isArray(patch.issueBufJson) ? JSON.stringify(patch.issueBufJson) : "[]"));
    if (patch.draftScheduleRaw !== undefined) setVal(SESSION_COL.DRAFT_SCHEDULE_RAW, String(patch.draftScheduleRaw || "").trim());
    if (patch.activeArtifactKey !== undefined) setVal(SESSION_COL.ACTIVE_ARTIFACT_KEY, String(patch.activeArtifactKey || "").trim());
    if (patch.expiresAtIso !== undefined) setVal(SESSION_COL.EXPIRES_AT_ISO, String(patch.expiresAtIso || "").trim());
    if (patch.unlinkedMediaJson !== undefined) setVal(
      SESSION_COL.UNLINKED_MEDIA_JSON,
      typeof patch.unlinkedMediaJson === "string"
        ? patch.unlinkedMediaJson
        : (Array.isArray(patch.unlinkedMediaJson) ? JSON.stringify(patch.unlinkedMediaJson) : "[]")
    );

    // Always write UpdatedAtIso on every upsert (unconditional)
    setVal(SESSION_COL.UPDATED_AT_ISO, nowIso);
    try { logDevSms_(phone, "", "SESSION_UPSERT reason=[" + String(reason || "") + "]"); } catch (_) {}
    return true;
  }

  function sessionUpsert_(phoneAny, patch, reason) {
    var phone = (typeof phoneKey_ === "function") ? phoneKey_(phoneAny) : String(phoneAny || "").trim();
    if (!phone) return false;
    withWriteLock_("SESSION_UPSERT", function () {
      sessionUpsertNoLock_(phone, patch, reason);
    });
    return true;
  }

  function getPropertyIdByCode_(propertyCode) {
    const code = String(propertyCode || "").trim();
    if (!code) return "";

    const sh = SpreadsheetApp.getActive().getSheetByName("Properties");
    if (!sh) return "";

    const lastRow = sh.getLastRow();
    if (lastRow < 2) return "";

    const vals = sh.getRange(2, 1, lastRow - 1, 5).getValues();
    // Columns:
    // A = PropertyID
    // B = PropertyCode
    // C = PropertyName

    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][1] || "").trim() === code) {
        return String(vals[i][0] || "").trim(); // PROP_*
      }
    }
    return "";
  }

  function syncActiveWorkItemFromTicketRow_(phoneAny, ticketRow, propertyCode, unit) {
    const phone = phoneKey_(phoneAny);
    if (!phone) return false;

    const ctx = ctxGet_(phone);
    const wi = ctx && ctx.activeWorkItemId ? String(ctx.activeWorkItemId) : "";
    if (!wi) return false;

    const pCode = String(propertyCode || "").trim();
    const u = String(unit || "").trim();

    const propertyId = getPropertyIdByCode_(pCode);
    const unitId = (pCode && u) ? (pCode + "-" + u) : "";

    return workItemUpdate_(wi, {
      propertyId: propertyId || "",
      unitId: unitId || "",
      ticketRow: (ticketRow && ticketRow > 1) ? Number(ticketRow) : ""
    });
  }

  // =============================================================================
  //  HELPER: findWorkItemIdByTicketRow_
  //  Looks up WorkItemId from the WorkItems sheet given a ticket sheet row number.
  // =============================================================================
  function findWorkItemIdByTicketRow_(ticketRow) {
    var row = Number(ticketRow || 0);
    if (row < 2) return "";

    try {
      var wiSh = SpreadsheetApp.getActive().getSheetByName(WORKITEMS_SHEET);
      if (!wiSh) return "";

      var wiLastRow = wiSh.getLastRow();
      if (wiLastRow < 2) return "";

      var wiMap = getHeaderMap_(wiSh);
      var trCol = (wiMap["TicketRow"] || 9) - 1;
      var idCol = (wiMap["WorkItemId"] || 1) - 1;

      var wiData = wiSh.getRange(2, 1, wiLastRow - 1, wiSh.getLastColumn()).getValues();
      for (var i = 0; i < wiData.length; i++) {
        if (Number(wiData[i][trCol]) === row) {
          return String(wiData[i][idCol] || "").trim();
        }
      }
    } catch (_) {}
    return "";
  }

  // =============================================================================
  //  HELPER: wiTransition_
  //  Generic WorkItem state+substate transition with a single deterministic log.
  // =============================================================================
  function wiTransition_(wiId, state, substate, phone, logTag) {
    var id = String(wiId || "").trim();
    if (!id) return false;

    var patch = { state: String(state || ""), substate: String(substate || "") };
    if (String(state || "").toUpperCase() === "DONE") patch.status = "COMPLETED";
    var ok = workItemUpdate_(id, patch);

    if (ok) {
      try {
        logDevSms_(
          String(phone || "(system)"),
          "",
          String(logTag || "WI_TRANSITION") +
            " wi=[" + id + "]" +
            " state=" + String(state || "") +
            " sub=" + String(substate || "")
        );
      } catch (_) {}
    }
    return ok;
  }

  // =============================================================================
  //  HELPER: wiSetWaitTenant_
  //  Finds the active WI for a phone (via ctx) and sets WAIT_TENANT + substate.
  // =============================================================================
  function wiSetWaitTenant_(phone, substate) {
    try {
      var ctx = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
      if (!ctx) return false;

      var wi = String(ctx.pendingWorkItemId || ctx.activeWorkItemId || "").trim();
      if (!wi) return false;

      var ok = workItemUpdate_(wi, { state: "WAIT_TENANT", substate: String(substate || "") });
      if (ok) {
        try {
          logDevSms_(
            String(phone || ""),
            "",
            "WI_WAIT_TENANT wi=[" + wi + "] sub=" + String(substate || "")
          );
        } catch (_) {}
      }
      return ok;
    } catch (_) {}
    return false;
  }

  function renderKeyOrFallback_(key, lang, fallbackText) {
    try {
      var s = (typeof renderTenantKey_ === "function") ? renderTenantKey_(key, lang || "en", {}) : "";
      s = String(s || "").trim();
      // If key missing, some implementations return the key or empty.
      if (!s || s === key) return String(fallbackText || "").trim();
      return s;
    } catch (_) {
      return String(fallbackText || "").trim();
    }
  }

  function isDigitReply_(s, d) {
    var v = String(s || "").trim();
    return v === String(d);
  }

  function cloneEventWithBody_(e, newBody, opts) {
    opts = opts || {};
    const e2 = Object.assign({}, e || {});
    e2.parameter = Object.assign({}, (e && e.parameter) ? e.parameter : {});
    e2.parameter.Body = String(newBody || "");

    if (opts.mode) e2.parameter._mode = String(opts.mode);
    if (opts.internal === true) e2.parameter._internal = "1"; // sanctioned router injection
    if (opts.allowInternal === true) e2.parameter._allowInternal = "1";

    return e2;
  }

  /************************************
  * ENTRY POINTS
  ************************************/

  // ===================================================================
  // ===== M2 — ROUTER (Lane + Compliance + Intent Gate) ===============
  // @MODULE:M2
  // Responsibilities:
  // - STOP/START/HELP compliance
  // - Lane decision
  // - Intent gate handling
  // Forbidden:
  // - Ticket writes
  // - Stage handling
  // ===================================================================

  // ===================================================================
  // GLOBAL TENANT COMMAND LAYER (Propera Compass)
  // Runs BEFORE pendingExpected, router branches, and state machine.
  // ===================================================================

  function detectTenantCommand_(text) {
    if (!text) return null;

    var t = String(text).trim().toLowerCase();

    if (t === "my tickets" || t === "my ticket" || t === "tickets" || t === "requests")
      return "CMD_MY_TICKETS";

    if (t === "status" || t === "ticket status")
      return "CMD_STATUS";

    if (t === "change time" || t === "update time" || t === "reschedule")
      return "CMD_CHANGE_TIME";

    if (t === "cancel" || t === "cancel ticket" || t === "cancel tickets" || t === "cancel request")
      return "CMD_CANCEL";

    if (t === "start over" || t === "startover" || t === "reset" || t === "restart")
      return "CMD_START_OVER";

    if (t === "options" || t === "menu")
      return "CMD_OPTIONS";

    if (t === "help")
      return "CMD_HELP";

    return null;
  }

  /**
   * Stage-shaped continuation: true when inbound message strongly looks like an answer for the expected stage.
   * Used to bypass pending expiration so valid replies (e.g. "unit 304" when exp=UNIT) are not dropped into INTENT_PICK.
   * @returns {{ match: boolean, subtype?: string, value?: string }}
   */
  function routerInboundStrongStageMatch_(expectedStage, bodyTrim) {
    var exp = String(expectedStage || "").trim().toUpperCase();
    var t = String(bodyTrim || "").trim();
    if (!t) return { match: false };

    if (exp === "UNIT") {
      if (typeof extractUnit_ === "function") {
        var u = extractUnit_(t);
        if (u && String(u).trim().length > 0) return { match: true, subtype: "extractUnit", value: String(u).trim() };
      }
      if (/\b(?:unit|apt|apartment|suite|#)\s*[\d]{1,5}\b/i.test(t)) return { match: true, subtype: "unit_pattern" };
      if (/^\d{2,5}$/.test(t) && !/^20\d{2}$/.test(t) && !/^\d{5}$/.test(t)) return { match: true, subtype: "unit_digits" };
      return { match: false };
    }

    if (exp === "CONFIRM_CONTEXT") {
      if (/^(yes|no|y|n)$/i.test(t)) return { match: true, subtype: "confirm", value: t.toLowerCase().slice(0, 1) };
      return { match: false };
    }

    if (exp === "PROPERTY") {
      // Only numeric menu choice 1–9 (or 1..N if property list available). No broad short-string acceptance.
      var n = parseInt(t, 10);
      if (/^[1-9]\d*$/.test(t) && !isNaN(n)) {
        var max = 9;
        if (typeof getActiveProperties_ === "function") {
          try {
            var list = getActiveProperties_() || [];
            if (list.length > 0) max = list.length;
          } catch (_) {}
        }
        if (n >= 1 && n <= max) return { match: true, subtype: "property_choice", value: String(n) };
      }
      return { match: false };
    }

    if (exp === "ISSUE" || exp === "DETAIL") {
      var lower = t.toLowerCase();
      if (t.length < 2) return { match: false };
      if (/^(yes|no|ok|help|stop|start|menu|options)$/i.test(t)) return { match: false };
      if (/^(maintenance|leasing|amenities)$/i.test(lower)) return { match: false };
      return { match: true, subtype: exp === "ISSUE" ? "issue" : "detail" };
    }

    return { match: false };
  }

  function listMyTickets_(sheet, phone, limit) {
    var rows = findTenantTicketRows_(sheet, phone, { includeClosed: false });
    if (!rows || !rows.length) return { msg: "", ids: [] };

    var cap = Math.min(rows.length, limit || 5);
    var lines = [];
    var ids = [];
    for (var i = 0; i < cap; i++) {
      var t = readTicketForTenant_(sheet, rows[i]);
      var tid = t.ticketId || ("Row " + rows[i]);
      ids.push(tid);
      lines.push((i + 1) + ") " + tid + " — " + (t.status || "Open") + (t.prefWindow ? " | " + t.prefWindow : ""));
    }
    var header = "Your open tickets (" + rows.length + "):";
    return { msg: header + "\n" + lines.join("\n"), ids: ids };
  }

  function handleTenantCommandGlobal_(cmd, ctx, phone, lang) {
    try { logDevSms_(phone, "", "CMD_EXEC " + cmd); } catch (_) {}

    var L = String(lang || "en").toLowerCase();
    var sheet, dir;
    try { sheet = getSheet_(SHEET_NAME); } catch (_) { sheet = null; }
    try { dir = getSheet_(DIRECTORY_SHEET_NAME); } catch (_) { dir = null; }
    var digits = (typeof normalizePhoneDigits_ === "function") ? normalizePhoneDigits_(phone) : String(phone || "").replace(/\D/g, "");

    switch (cmd) {

      case "CMD_MY_TICKETS": {
        if (!sheet) return sendRouterSms_(phone, tenantMsg_("TENANT_MY_TICKETS_EMPTY_FALLBACK", L, {}), "CMD_MY_TICKETS");
        var out = listMyTickets_(sheet, phone, 5);
        return sendRouterSms_(phone, String(out && out.msg ? out.msg : tenantMsg_("TENANT_MY_TICKETS_EMPTY_FALLBACK", L, {})), "CMD_MY_TICKETS");
      }

      case "CMD_STATUS": {
        if (!sheet) return sendRouterSms_(phone, tenantMsg_("TENANT_STATUS_FALLBACK", L, {}), "CMD_STATUS");
        var out2 = tenantStatusCommand_(sheet, phone, "", L);
        return sendRouterSms_(phone, String(out2 && out2.msg ? out2.msg : tenantMsg_("TENANT_STATUS_FALLBACK", L, {})), "CMD_STATUS");
      }

      case "CMD_CANCEL": {
        if (!sheet || !dir) return sendRouterSms_(phone, tenantMsg_("TENANT_CANCEL_FALLBACK", L, {}), "CMD_CANCEL");
        var out3 = tenantCancelTicketCommand_(sheet, dir, digits, phone, "cancel", L, { brandName: BRAND.name, teamName: BRAND.team });
        return sendRouterSms_(phone, String(out3 && out3.msg ? out3.msg : tenantMsg_("TENANT_CANCEL_FALLBACK", L, {})), "CMD_CANCEL");
      }

      case "CMD_CHANGE_TIME": {
        if (!sheet) return sendRouterSms_(phone, tenantMsg_("TENANT_NO_TICKETS_TO_CHANGE", L, {}), "CMD_CHANGE_TIME");
        var my = listMyTickets_(sheet, phone, 5);
        var ids = (my && my.ids) ? my.ids : [];
        if (!ids.length) return sendRouterSms_(phone, tenantMsg_("TENANT_NO_TICKETS_TO_CHANGE", L, {}), "CMD_CHANGE_TIME");
        try { setAwaiting_(digits, "CHANGE_TIME_PICK", { ids: ids }, 900); } catch (_) {}
        return sendRouterSms_(phone, tenantMsg_("TENANT_CHANGE_TIME_PICK_PROMPT", L, { ticketsText: String(my.msg || "") }), "CMD_CHANGE_TIME");
      }

      case "CMD_START_OVER": {
        try {
          if (dir) {
            var dirRow = ensureDirectoryRowForPhone_(dir, phone);
            if (dirRow >= 2) {
              dalWithLock_("DIR_RESET_TENANT", function () {
                dalSetPendingIssueNoLock_(dir, dirRow, "");
                try { logDevSms_(phone, "", "ISSUE_WRITE site=[CMD_GLOBAL_RESET] val=[CLEAR_RESET]"); } catch (_) {}
                dalSetPendingUnitNoLock_(dir, dirRow, "");
                dalSetPendingRowNoLock_(dir, dirRow, "");
                dalSetPendingStageNoLock_(dir, dirRow, "");
                dalSetLastUpdatedNoLock_(dir, dirRow);
                try { logDevSms_(phone, "", "DAL_WRITE DIR_RESET_TENANT row=" + dirRow); } catch (_) {}
              });
            }
          }
        } catch (err) {
          try { logDevSms_(phone, "", "CMD_GLOBAL_RESET_ERR " + String(err)); } catch (_) {}
        }
        try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "", pendingWorkItemId: "", activeWorkItemId: "", lastIntent: "" }, "CMD_GLOBAL_RESET"); } catch (_) {}
        return sendRouterSms_(phone, renderTenantKey_("TENANT_RESET_OK", L, {}), "CMD_START_OVER");
      }

      case "CMD_OPTIONS":
        return sendRouterSms_(phone, renderTenantKey_("TENANT_OPTIONS_MENU", L, {}), "CMD_OPTIONS");

      case "CMD_HELP":
        return sendRouterSms_(phone, renderTenantKey_("SMS_HELP", L, {}), "CMD_HELP");
    }
  }

  function handleSmsRouter_(e) {
    const p = (e && e.parameter) ? e.parameter : {};
    let bodyRaw = String(globalThis.__bodyOverride || p.Body || "").trim();
    if (String(globalThis.__bodyOverride || "").toUpperCase() === "ATTACHMENT_ONLY") {
      bodyRaw = ""; // ✅ never let marker become "text"
    }
    const bodyTrim = bodyRaw;

    // ============================================================
    // STAFF CAPTURE ADAPTER (Signal Layer Phase 1)
    // ============================================================
    if (bodyTrim && bodyTrim.charAt(0) === "#") {

      const stripped = bodyTrim.replace(/^#\s*/, "").trim();

      const e2 = cloneEventWithBody_(e, stripped, {});
      e2.parameter = e2.parameter || {};
      e2.parameter._staffCapture = "1";

      return routeToCoreSafe_(e2, { mode: "MANAGER" });
    }

    const fromRaw = String(p.From || "").trim();
    const isWa = fromRaw.toLowerCase().indexOf("whatsapp:") === 0;
    const channel = isWa ? "whatsapp" : "sms";
    const fromForNormalize = isWa ? fromRaw.replace(/^whatsapp:/i, "") : fromRaw;
    const phone = normalizePhone_(fromForNormalize);
    if (!phone) return;

    // STAFF_CHECK: always log for non-# so we see why staff path is taken or skipped (unconditional).
    if (bodyTrim && bodyTrim.charAt(0) !== "#") {
      var _hasIsStaff = typeof isStaffSender_ === "function";
      var _hasRoute = typeof staffHandleLifecycleCommand_ === "function";
      var _isStaff = _hasIsStaff ? isStaffSender_(phone) : false;
      var _lifecycleOn = (typeof lifecycleEnabled_ !== "function") ? true : lifecycleEnabled_("GLOBAL");
      try {
        logDevSms_(phone, bodyTrim,
          "STAFF_CHECK phone=[" + String(phone || "") + "] hasIsStaff=[" + _hasIsStaff + "] hasRoute=[" + _hasRoute + "] isStaff=[" + _isStaff + "] lifecycleOn=[" + _lifecycleOn + "]");
      } catch (_) {}
    }

    // Non-# staff operational: lifecycle handles updates; # remains canonical STAFF CAPTURE in core.
    // When LIFECYCLE_ENABLED is false, skip lifecycle routing so message continues to existing Propera Main flow.
    if (bodyTrim && bodyTrim.charAt(0) !== "#" && typeof isStaffSender_ === "function" && typeof staffHandleLifecycleCommand_ === "function" &&
        (typeof lifecycleEnabled_ !== "function" || lifecycleEnabled_("GLOBAL")) &&
        isStaffSender_(phone)) {
      var handled = staffHandleLifecycleCommand_(phone, bodyTrim);
      if (handled) return;
    }

    try { SIM_PHONE_SCOPE_ = phone || ""; } catch (_) {}
    try { if (e && e.parameter) e.parameter._phoneE164 = phone; } catch (_) {}

    const numMediaN = parseInt(String(p.NumMedia || "0"), 10) || 0;
    const mediaUrls = [];
    const mediaTypes = [];
    for (var i = 0; i < numMediaN; i++) {
      var url = String(p["MediaUrl" + i] || "").trim();
      var typ = String(p["MediaContentType" + i] || "").trim();
      if (url) {
        mediaUrls.push(url);
        mediaTypes.push(typ);
      }
    }
    const weak = (!bodyTrim) || ((typeof isWeakIssue_ === "function") && isWeakIssue_(bodyTrim));
    const hasMediaOnly = (numMediaN > 0) && weak;

    const bodyLower = bodyTrim.toLowerCase().trim();

    const messageSid = String(p.MessageSid || p.SmsMessageSid || "").trim();

    chaosInit_(e, phone, messageSid);
    try { writeTimeline_("IN", { msg: bodyTrim, len: bodyTrim.length }, null); } catch (_) {}

    const inbound = normalizeInboundEvent_(channel, {
      actorType: "unknown",
      actorId: phone,
      body: bodyRaw,
      eventId: messageSid,
      meta: {
        to: String(p.To || "").trim(),
        numMedia: String(p.NumMedia || "0"),
        mediaUrls: mediaUrls,
        mediaTypes: mediaTypes,
        hasMediaOnly: hasMediaOnly,
        channel: channel
      }
    });

    // LANE DECISION (single source of truth)
    const decision = decideLane_(inbound);

    try { writeTimeline_("LANE", { lane: (decision && decision.lane) || "", reason: (decision && decision.reason) || "" }, null); } catch (_) {}

    // optional shadow logs during rollout (NO re-decision)
    try { shadowRouteLog_(decision, inbound); } catch (_) {}
    try { shadowLaneDispatch_(decision, inbound); } catch (_) {}

    const norm = normMsg_(bodyTrim);

    // ROUTER TRACE (always)
    try {
      logDevSms_(phone, bodyTrim, "ROUTER_IN lower=[" + bodyLower + "] norm=[" + norm + "]");
    } catch (_) {}

    // 1) COMPLIANCE OVERRIDE (exact-only)
    const comp = complianceIntent_(bodyTrim);
    if (comp === "STOP") {
      withWriteLock_("SMS_OPTOUT_STOP", () => setSmsOptOut_(phone, true, norm));
      sendRouterSms_(phone, renderTenantKey_("SMS_STOP_CONFIRM", "en", {}), "ROUTER_SMSCOMPLIANCE");
      return;
    }
    if (comp === "START") {
      withWriteLock_("SMS_OPTOUT_START", () => setSmsOptOut_(phone, false, norm));
      sendRouterSms_(phone, renderTenantKey_("SMS_START_CONFIRM", "en", {}), "ROUTER_SMSCOMPLIANCE");
      return;
    }
    if (comp === "HELP") {
      sendRouterSms_(phone, renderTenantKey_("SMS_HELP", "en", {}), "ROUTER_SMSCOMPLIANCE");
      return;
    }

    // 2) OPT-OUT SUPPRESSION (everything else)
    if (isSmsOptedOut_(phone)) {
      try { logDevSms_(phone, bodyTrim, "ROUTER_SUPPRESS opted_out=true"); } catch (_) {}
      return;
    }

    // -------------------------------------------------
    // 2.4) LANE ROUTING (single decision)
    // -------------------------------------------------
    try {
      const lane = String((decision && decision.lane) || "tenantLane");

      if (lane === "vendorLane") {
        try { logDevSms_(phone, bodyTrim, "ROUTER_LANE VENDOR reason=[" + String(decision.reason || "") + "]"); } catch (_) {}
        return routeToCoreSafe_(e, { mode: "VENDOR" });
      }

      if (lane === "managerLane") {
        try { logDevSms_(phone, bodyTrim, "ROUTER_LANE MANAGER reason=[" + String(decision.reason || "") + "]"); } catch (_) {}
        return routeToCoreSafe_(e, { mode: "MANAGER" });
      }

      if (lane === "systemLane") {
        try { logDevSms_(phone, bodyTrim, "ROUTER_LANE SYSTEM reason=[" + String(decision.reason || "") + "]"); } catch (_) {}
        return routeToCoreSafe_(e, { mode: "SYSTEM" });
      }

      try { logDevSms_(phone, bodyTrim, "ROUTER_LANE TENANT reason=[" + String(decision.reason || "") + "]"); } catch (_) {}

    } catch (err) {
      try { logDevSms_(phone, bodyTrim, "ROUTER_LANE_ERR " + (err && err.message ? err.message : err)); } catch (_) {}
    }

    // 2.5) WORK ENGINE CONTEXT (read-only)
    let ctx = null;
    try {
      ensureWorkBackbone_();
      ctx = ctxGet_(phone);

      try {
        logDevSms_(
          phone,
          bodyTrim,
          "ROUTER_CTX lang=[" + String((ctx && ctx.lang) || "en") + "]" +
          " active=[" + String((ctx && ctx.activeWorkItemId) || "") + "]" +
          " pending=[" + String((ctx && ctx.pendingWorkItemId) || "") + "]" +
          " exp=[" + String((ctx && ctx.pendingExpected) || "") + "]"
        );
      } catch (_) {}

    } catch (err) {
      try { logDevSms_(phone, bodyTrim, "ROUTER_CTX_ERR " + (err && err.message ? err.message : err)); } catch (_) {}
      ctx = null;
    }

    // 2.55) GLOBAL TENANT COMMAND INTERCEPTOR (Propera Compass)
    // Must run BEFORE pendingExpected and all router branches.
    var cmd = detectTenantCommand_(bodyTrim);
    if (cmd) {
      try { logDevSms_(phone, bodyTrim, "CMD_INTERCEPT " + cmd); } catch (_) {}
      var cmdLang = String((ctx && ctx.lang) || "en").toLowerCase();
      handleTenantCommandGlobal_(cmd, ctx, phone, cmdLang);
      return;
    }

    // 2.6) PENDING EXPECTED OVERRIDE (deterministic)
    // Stage-shaped continuation beats expiration: if inbound strongly matches expected stage, do NOT clear.
    try {
      if (ctx && ctx.pendingExpected) {
        const exp = String(ctx.pendingExpected || "").trim();
        let expiresMs = 0;

        const pe = ctx.pendingExpiresAt;
        if (pe instanceof Date) {
          expiresMs = pe.getTime();
        } else {
          const parsed = Date.parse(String(pe || ""));
          expiresMs = isNaN(parsed) ? 0 : parsed;
        }

        const nowMs = Date.now();
        const isExpired = (expiresMs > 0 && nowMs > expiresMs);

        if (isExpired) {
          var bypassResult = (typeof routerInboundStrongStageMatch_ === "function") ? routerInboundStrongStageMatch_(exp, bodyTrim) : { match: false };
          if (bypassResult && bypassResult.match) {
            var bypassLog = "ROUTER_PENDING_EXPIRED_BYPASS expected=" + exp + " reason=strong_stage_match";
            if (bypassResult.subtype) bypassLog += " subtype=" + bypassResult.subtype;
            if (bypassResult.value !== undefined && bypassResult.value !== "") bypassLog += " value=" + String(bypassResult.value).slice(0, 32);
            try { logDevSms_(phone, bodyTrim, bypassLog); } catch (_) {}
            const extendMs = nowMs + 10 * 60 * 1000;
            try {
              ctxUpsert_(phone, { pendingExpiresAt: new Date(extendMs) });
              if (ctx) ctx.pendingExpiresAt = new Date(extendMs);
            } catch (_) {}
            // Do NOT clear pendingExpected; fall through so core runs with continuation
          } else {
            try {
              ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "", pendingWorkItemId: "" });

              // IMPORTANT: also clear the in-memory ctx so downstream gates can run this same inbound
              try {
                ctx.pendingExpected = "";
                ctx.pendingExpiresAt = "";
                ctx.pendingWorkItemId = "";
              } catch (_) {}

              try { logDevSms_(phone, bodyTrim, "ROUTER_PENDING_EXPIRED cleared exp=[" + exp + "]"); } catch (_) {}
            } catch (_) {}
          }
        } else {
          if (!isGlobalResetCommand_(bodyLower)) {
            const expUp = String(exp || "").toUpperCase();

  const isMaintExpected =
              expUp === "PROPERTY" || expUp === "UNIT" || expUp === "ISSUE" || expUp === "DETAIL" ||
              expUp === "SCHEDULE" || expUp === "CONFIRM_CONTEXT" || expUp === "EMERGENCY_DONE" ||
              expUp === "SCHEDULE_UNKNOWN" || expUp.indexOf("SCHEDULE_") === 0;

            const isAmenityExpected = (expUp.indexOf("AMENITY_") === 0);
            const isIntentExpected  = (expUp === "INTENT_PICK");
            const isUnknownGateExpected = (expUp === "UNKNOWN_GATE");

            if ((isMaintExpected || isAmenityExpected || isIntentExpected || isUnknownGateExpected) && !isManagerPhone_(phone) && !isVendorPhone_(phone)) {
              try { logDevSms_(phone, bodyTrim, "ROUTER_PENDING_OVERRIDE exp=[" + expUp + "]"); } catch (_) {}

              if (isUnknownGateExpected) {
                var choice = String(bodyTrim || "").trim();
                var expiresAtIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();

                if (choice === "1") {
                  try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "unknown_gate_service"); } catch (_) {}
                  return routeToCoreSafe_(e);
                }

                if (choice === "2") {
                  try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "unknown_gate_leasing"); } catch (_) {}
                  // Force the leasing branch deterministically WITHOUT changing leasing lane internals
                  e.parameter = e.parameter || {};
                  e.parameter.Body = "leasing";
                  return handleSmsRouter_(e);
                }

                // Invalid reply → re-ask, keep expectation
                try { ctxUpsert_(phone, { pendingExpected: "UNKNOWN_GATE", pendingExpiresAt: expiresAtIso }, "unknown_gate_retry"); } catch (_) {}

                var msg =
                  "Are you a resident requesting service, or looking to rent?\n" +
                  "Reply 1) Service  2) Leasing";
                return sendRouterSms_(phone, msg, "UNKNOWN_GATE");
              }

              if (isIntentExpected) {
                var choice = String(bodyTrim || "").trim();
                var choiceLower = choice.toLowerCase();

                // extend expiry only on invalid
                var expiresAtIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();

                // Word picks (accept synonyms)
                var isMaintWord =
                  (choiceLower.indexOf("maint") >= 0) ||
                  (choiceLower.indexOf("service") >= 0) ||
                  (choiceLower.indexOf("repair") >= 0) ||
                  (choiceLower.indexOf("fix") >= 0);

                var isLeasingWord =
                  (choiceLower.indexOf("leas") >= 0) ||
                  (choiceLower.indexOf("avail") >= 0) ||
                  (choiceLower.indexOf("rent") >= 0) ||
                  (choiceLower.indexOf("apply") >= 0);

                var isAmenityWord =
                  (choiceLower.indexOf("amen") >= 0) ||
                  (choiceLower.indexOf("pool") >= 0) ||
                  (choiceLower.indexOf("gym") >= 0) ||
                  (choiceLower.indexOf("parking") >= 0) ||
                  (choiceLower.indexOf("reservation") >= 0);

                if (isDigitReply_(choice, 1)) {
                  // 1) Maintenance — DO NOT inject "service" into core (it becomes an issue).
                  // Move deterministically to ISSUE prompt.
                  try {
                    ctxUpsert_(phone, {
                      pendingExpected: "ISSUE",
                      pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                      lastIntent: "MAINT"
                    }, "intent_pick_1_to_issue");
                  } catch (_) {}
                  return sendRouterSms_(
                    phone,
                    renderTenantKey_("ASK_ISSUE_GENERIC", String((ctx && ctx.lang) || "en"), {}),
                    "ASK_ISSUE_GENERIC"
                  );
                }

                if (isDigitReply_(choice, 2)) {
                  try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "intent_pick_2"); } catch (_) {}
                  // 2) Leasing — re-enter router with internal hint
                  return handleSmsRouter_(cloneEventWithBody_(e, "leasing", { internal: true, allowInternal: true }));
                }

                if (isDigitReply_(choice, 3)) {
                  try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "intent_pick_3"); } catch (_) {}
                  // 3) Amenity — re-enter router with internal hint
                  return handleSmsRouter_(cloneEventWithBody_(e, "reservation", { internal: true, allowInternal: true }));
                }

                // Word choices (same behavior as digits)
                if (isMaintWord) {
                  try {
                    ctxUpsert_(phone, {
                      pendingExpected: "ISSUE",
                      pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                      lastIntent: "MAINT"
                    }, "intent_pick_word_maint_to_issue");
                  } catch (_) {}
                  return sendRouterSms_(
                    phone,
                    renderTenantKey_("ASK_ISSUE_GENERIC", String((ctx && ctx.lang) || "en"), {}),
                    "ASK_ISSUE_GENERIC"
                  );
                }

                if (isLeasingWord) {
                  try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "intent_pick_word_leasing"); } catch (_) {}
                  return handleSmsRouter_(cloneEventWithBody_(e, "leasing", { internal: true, allowInternal: true }));
                }

                if (isAmenityWord) {
                  try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "intent_pick_word_amenity"); } catch (_) {}
                  return handleSmsRouter_(cloneEventWithBody_(e, "reservation", { internal: true, allowInternal: true }));
                }

                // Invalid → keep expectation + template reprompt
                try { ctxUpsert_(phone, { pendingExpected: "INTENT_PICK", pendingExpiresAt: expiresAtIso }, "intent_pick_retry"); } catch (_) {}
                try { if (typeof sessionUpsert_ === "function") sessionUpsert_(phone, { expected: "INTENT_PICK", stage: "INTENT_PICK", expiresAtIso: expiresAtIso }, "intent_pick_retry"); } catch (_) {}
                return sendRouterSms_(
                  phone,
                  renderTenantKey_("INTENT_PICK", String((ctx && ctx.lang) || "en"), {}),
                  "INTENT_PICK"
                );
              }

              if (isMaintExpected) return routeToCoreSafe_(e);
              if (isAmenityExpected) return handleAmenitySms_(e);
            }
          }
        }
      }
    } catch (pendingOverrideErr) {
      // ✅ FIX B: Log pending override errors (was silently swallowed)
      try { logDevSms_(phone, bodyTrim, "PENDING_OVERRIDE_ERR " + String(pendingOverrideErr && pendingOverrideErr.message ? pendingOverrideErr.message : pendingOverrideErr)); } catch (_) {}
    }

    // 3) GLOBAL COMMANDS (router-only)
    if (isGlobalResetCommand_(bodyLower)) {
      try { logDevSms_(phone, bodyTrim, "ROUTER_BRANCH GLOBAL_RESET"); } catch (_) {}
      return handleGlobalReset_(e);
    }

    // 4) AMENITY (single deterministic branch)
    try {
      const amenityCmd = isAmenityCommand_(bodyLower);
      const amenityStage = isAmenityExpected_(ctx);
      const amenitySticky = hasActiveAmenityFlow_(phone);

      if (amenityCmd || amenityStage || amenitySticky) {
        try {
          logDevSms_(
            phone,
            bodyTrim,
            "ROUTER_BRANCH AMENITY single cmd=" + amenityCmd + " stage=" + amenityStage + " sticky=" + amenitySticky
          );
        } catch (_) {}

        return handleAmenitySms_(e);
      }
    } catch (_) {}

    // 5) LEASING LANE (availability, tours)
  // Long-term rule:
  // - Leasing may run if (a) explicit leasing keywords OR (b) already in leasing stage.
  // - Leasing must NOT hijack known maintenance conversations or numeric/unit replies.
  // - ctx must be null-safe.
  let leasingIntent = null;
  const hasStrongLeasing = (typeof isLeasingIntentStrong_ === "function") && isLeasingIntentStrong_(bodyTrim);
  const maintVeto = (typeof isMaintenanceVeto_ === "function") && isMaintenanceVeto_(bodyTrim);

  // Null-safe leasing stage flag
  const leasingPending = String((ctx && ctx.leasingPendingExpected) || "");
  let isLeasingStage = (leasingPending.indexOf("LEASING_") === 0);

  // Guard A: Never hijack maintenance conversations (pendingExpected)
  const maintExpectedForLeasing = String((ctx && ctx.pendingExpected) || "").trim().toUpperCase();
  const isMaintBusy = (
    maintExpectedForLeasing === "PROPERTY" ||
    maintExpectedForLeasing === "UNIT" ||
    maintExpectedForLeasing === "ISSUE" ||
    maintExpectedForLeasing === "DETAIL" ||
    maintExpectedForLeasing === "SCHEDULE" ||
    maintExpectedForLeasing === "CONFIRM_CONTEXT" ||
    maintExpectedForLeasing === "EMERGENCY_DONE" ||
    maintExpectedForLeasing.indexOf("SCHEDULE_") === 0
  );

  if (isMaintBusy) {
    try { logDevSms_(phone, bodyTrim, "LEASING_GUARD_SKIP maintExpected=[" + maintExpectedForLeasing + "]"); } catch (_) {}
    isLeasingStage = false; // prevent leasing stage from stealing it
  } else {

    // Guard B: Bare numbers are never leasing
    const trimmedForLeasing = String(bodyTrim || "").trim();
    if (/^\d{1,6}$/.test(trimmedForLeasing)) {
      try { logDevSms_(phone, bodyTrim, "LEASING_GUARD_BARE_NUMBER rejected=[" + trimmedForLeasing + "]"); } catch (_) {}
      leasingIntent = null;
    } else {
      var _detectLeasing = (typeof detectLeasingIntent_ === "function") && detectLeasingIntent_(bodyLower, ctx);
      if (maintVeto && (_detectLeasing || isLeasingStage)) {
        try { logDevSms_(phone, bodyTrim.slice(0, 60), "ROUTER_VETO leasing_blocked_by_maint maint=1 leasingStrong=" + (hasStrongLeasing ? 1 : 0)); } catch (_) {}
      }
      leasingIntent = (_detectLeasing && hasStrongLeasing && !maintVeto) ? _detectLeasing : null;
      if (maintVeto) isLeasingStage = false;
    }

    // OPTIONAL Guard C (recommended): Known tenants default to CORE unless explicit leasing intent
    // If you don't have isKnownTenantPhone_ yet, comment this block out.
    try {
      if (!isLeasingStage && !leasingIntent && typeof isKnownTenantPhone_ === "function") {
        if (isKnownTenantPhone_(phone)) {
          try { logDevSms_(phone, bodyTrim, "LEASING_GUARD_KNOWN_TENANT default=CORE"); } catch (_) {}
          leasingIntent = null;
          isLeasingStage = false;
        }
      }
    } catch (_) {}
  }

  if (leasingIntent || isLeasingStage) {
    try { logDevSms_(phone, bodyTrim, "ROUTER_BRANCH LEASING"); } catch (_) {}

    // Null-safe ctx write
    if (!ctx) ctx = {};
    ctx.leasingPendingExpected = "";

    // Lookup active thread (your existing code, unchanged)
    try {
      const contactKey = phoneKey_(phone);
      const contactSheet = getSheet_(LEASING_SHEETS.CONTACTS);
      const contactRow = findRowByValue_(contactSheet, "PhoneE164", contactKey);

      if (contactRow) {
        const contactMap = getHeaderMap_(contactSheet);
        const contactId = String(contactSheet.getRange(contactRow, contactMap["ContactID"]).getValue());

        const threadSheet = getSheet_(LEASING_SHEETS.THREADS);
        const threadLastRow = threadSheet.getLastRow();

        if (threadLastRow >= 2) {
          const threadMap = getHeaderMap_(threadSheet);
          const threadData = threadSheet.getRange(2, 1, threadLastRow - 1, threadSheet.getLastColumn()).getValues();

          for (let i = 0; i < threadData.length; i++) {
            const rowContact = String(threadData[i][threadMap["ContactID"] - 1] || "");
            const rowStatus = String(threadData[i][threadMap["Status"] - 1] || "");

            if (rowContact === contactId && rowStatus === "ACTIVE") {
              ctx.leasingPendingExpected = String(threadData[i][threadMap["PendingExpected"] - 1] || "");
              break;
            }
          }
        }
      }
    } catch (_) {}

    var leasingStageNow = String(ctx.leasingPendingExpected || "").trim().toUpperCase();
    if ((!leasingStageNow || leasingStageNow === "NONE") && (typeof isMaintenanceVeto_ === "function") && isMaintenanceVeto_(bodyTrim)) {
      try { logDevSms_(phone, bodyTrim.slice(0, 60), "LEASING_FALLBACK_TO_CORE maint_veto"); } catch (_) {}
      return routeToCoreSafe_(e);
    }

    const result = handleLeasingLane_(inbound, ctx, leasingIntent);

    if (result && result.threadId && result.nextStage !== undefined) {
      try {
        leasingDal_().threads.updateStage(result.threadId, {
          pendingExpected: result.nextStage || "",
          pendingJson: result.pendingData || {}
        });
      } catch (_) {}
    }

    sendLeasingKey_(phone, result.replyKey, result.vars || {}, "LEASING_REPLY");
    return;
  }


    // 6) ACK-ONLY (no suppression — let CORE decide)
    if (looksLikeAckOnly_(bodyLower) && !isGlobalResetCommand_(bodyLower)) {
      try { logDevSms_(phone, bodyTrim, "ROUTER_ACK_ONLY_PASS_TO_CORE"); } catch (_) {}
    }

    // 7) DOMAIN INTENT GATE (weak/unspecific tenant text)
    // Prevent "hi need help" from entering maintenance core and being committed as ISSUE.
    try {
      var modeUp = String((e && e.parameter && e.parameter._mode) || "TENANT").toUpperCase();
      if (modeUp === "TENANT") {
        var t = String(bodyTrim || "").trim();
        var lower0 = String(bodyLower || "").toLowerCase();

        // Only when no active work + no pendingExpected (router owns the first question)
        var exp0 = String((ctx && ctx.pendingExpected) || "").trim();
        var hasActive = !!String((ctx && ctx.activeWorkItemId) || "").trim();
        var hasPending = !!String((ctx && ctx.pendingWorkItemId) || "").trim();

        if (!exp0 && !hasActive && !hasPending) {
          var weakIntent = (typeof isWeakIssue_ === "function") && isWeakIssue_(t);
          var specific = (typeof looksSpecificIssue_ === "function") && looksSpecificIssue_(t);

          var hasStrongLeasing0 = (typeof isLeasingIntentStrong_ === "function") && isLeasingIntentStrong_(t);
          var maintVeto0 = (typeof isMaintenanceVeto_ === "function") && isMaintenanceVeto_(t);
          // If clearly leasing or amenity, let existing branches handle it (no gate)
          var leasingHit = (typeof detectLeasingIntent_ === "function") && !!detectLeasingIntent_(lower0, ctx) && hasStrongLeasing0 && !maintVeto0;
          var amenityHit =
            ((typeof isAmenityCommand_ === "function") && isAmenityCommand_(lower0)) ||
            ((typeof looksLikeAmenityByKeywords_ === "function") && looksLikeAmenityByKeywords_(lower0));

          // ✅ If media is present, never run INTENT_PICK gating.
          // Photo-only or photo+typo should route to core so it can attach to the active ticket / prompt properly.
          try {
            var _nm = parseInt(String(p && p.NumMedia ? p.NumMedia : "0"), 10) || 0;
            if (_nm > 0) {
              try { logDevSms_(phone, t, "ROUTER_INTENT_GATE_BYPASS reason=media numMedia=" + _nm); } catch (_) {}
              // fall through to normal core routing (do NOT show menu)
              // Important: do not return here; let the router continue to DEFAULT_TO_CORE branch.
            } else if ((weakIntent || !specific) && !leasingHit && !amenityHit) {
              var expiresAtIso2 = new Date(Date.now() + 10 * 60 * 1000).toISOString();
              try { ctxUpsert_(phone, { pendingExpected: "INTENT_PICK", pendingExpiresAt: expiresAtIso2 }, "intent_gate_set"); } catch (_) {}
              try { if (typeof sessionUpsert_ === "function") sessionUpsert_(phone, { expected: "INTENT_PICK", stage: "INTENT_PICK", expiresAtIso: expiresAtIso2 }, "intent_gate_set"); } catch (_) {}
              try { logDevSms_(phone, t, "ROUTER_INTENT_GATE weak=[" + (weakIntent ? 1 : 0) + "] specific=[" + (specific ? 1 : 0) + "]"); } catch (_) {}

              var lang0 = String((ctx && ctx.lang) || "en").toLowerCase();
              var menuMsg2 = renderTenantKey_("INTENT_PICK", lang0, {});
              return sendRouterSms_(phone, menuMsg2, "INTENT_PICK");
            }
          } catch (_) {
            // If anything goes wrong in media detection, keep existing behavior (safe default).
            if ((weakIntent || !specific) && !leasingHit && !amenityHit) {
              var expiresAtIso2b = new Date(Date.now() + 10 * 60 * 1000).toISOString();
              try { ctxUpsert_(phone, { pendingExpected: "INTENT_PICK", pendingExpiresAt: expiresAtIso2b }, "intent_gate_set"); } catch (_) {}
              try { if (typeof sessionUpsert_ === "function") sessionUpsert_(phone, { expected: "INTENT_PICK", stage: "INTENT_PICK", expiresAtIso: expiresAtIso2b }, "intent_gate_set"); } catch (_) {}
              try { logDevSms_(phone, t, "ROUTER_INTENT_GATE weak=[" + (weakIntent ? 1 : 0) + "] specific=[" + (specific ? 1 : 0) + "]"); } catch (_) {}
              var lang0b = String((ctx && ctx.lang) || "en").toLowerCase();
              var menuMsg2b = renderTenantKey_("INTENT_PICK", lang0b, {});
              return sendRouterSms_(phone, menuMsg2b, "INTENT_PICK");
            }
          }
        }
      }
    } catch (_) {}

    // 8) DEFAULT
    try { logDevSms_(phone, bodyTrim, "ROUTER_BRANCH DEFAULT_TO_CORE"); } catch (_) {}
    return routeToCoreSafe_(e);
  }




  // ===================================================================
  // ===== M1 — GATEWAY (Webhook Entry + Validation + Normalization) ====
  // @MODULE:M1
  // Responsibilities:
  // - Twilio/SIM validation
  // - Normalize inbound event
  // - NO business logic
  // ===================================================================

  /** Writes one row to DebugLog sheet (script container). Visible even when Executions hide Logger. Never throws. */
  function debugLogToSheet_(stage, pathOrPayload, detail) {
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) return;
      var sh = ss.getSheetByName("DebugLog");
      if (!sh) {
        sh = ss.insertSheet("DebugLog");
        sh.getRange(1, 1, 1, 4).setValues([["Timestamp", "Stage", "PathOrPayload", "Detail"]]);
      }
      var detailStr = (detail != null && detail !== undefined) ? String(detail).slice(0, 500) : "";
      sh.appendRow([new Date(), stage, String(pathOrPayload || "").slice(0, 200), detailStr]);
    } catch (_) {}
  }

  function doPost(e) {
    const OK = ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    var pathVal = (e && e.parameter && e.parameter.path) ? String(e.parameter.path).trim() : "(none)";
    var postLen = (e && e.postData && e.postData.contents) ? String(e.postData.contents).length : 0;
    try { Logger.log("DOPOST_ENTER path=" + pathVal); } catch (_) {}
    debugLogToSheet_("DOPOST_ENTER", pathVal, "postLen=" + postLen);

    // --- Portal API route: single doPost gateway; path in query → delegate to ProperaPortalAPI ---
    try {
      const path = (e && e.parameter && e.parameter.path) ? String(e.parameter.path).trim() : "";
      if (path) {
        try { Logger.log("GATEWAY_POST route=PORTAL path=" + path); } catch (_) {}
        debugLogToSheet_("PORTAL_ENTER", path, "");
        var portalOut = (typeof portalDoPost_ === "function") ? portalDoPost_(e) : OK;
        try { if (typeof flushDevSmsLogs_ === "function") flushDevSmsLogs_(); } catch (_) {}
        debugLogToSheet_("PORTAL_DONE", path, "ok");
        return portalOut;
      }
    } catch (portalErr) {
      var errStr = (portalErr && portalErr.message) ? portalErr.message : String(portalErr);
      if (portalErr && portalErr.stack) errStr += " " + String(portalErr.stack).slice(0, 300);
      try { Logger.log("GATEWAY_POST PORTAL_ERR " + errStr); } catch (_) {}
      debugLogToSheet_("PORTAL_ERR", pathVal, errStr);
      try { if (typeof flushDevSmsLogs_ === "function") flushDevSmsLogs_(); } catch (_) {}
      // Return JSON so Portal API clients (e.g. Next.js upload route) can parse; do not return plain "OK".
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "portal_error", message: errStr })).setMimeType(ContentService.MimeType.JSON);
    }

    // --- AppSheet early route (must be BEFORE Twilio gate) ---
    try {
      const ct  = String((e && e.postData && e.postData.type) ? e.postData.type : "").toLowerCase();
      const raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : "";

      // Always log something visible (does not depend on From/Body)
      try { Logger.log("APPSHEET_GATE ct=" + ct + " rawLen=" + raw.length); } catch (_) {}

      // Heuristic: if raw looks like JSON, attempt parse even if ct is missing
      const looksJson = raw && raw.charAt(0) === "{";
      if ((ct.indexOf("application/json") >= 0 || looksJson) && raw) {
        let data = null;
        try { data = JSON.parse(raw); } catch (parseErr) {
          // IMPORTANT: Do not fall through into Twilio logic.
          // Return OK so AppSheet doesn't show "doPost failed".
          try { Logger.log("APPSHEET_JSON_PARSE_FAIL " + String(parseErr)); } catch (_) {}
          return OK;
        }

        // ---- Alexa gate ----
        if (data && data.alexaRequest === true) {
          try {
            var alexaOut = handleAlexaWebhook_(data);
            try { if (typeof flushDevSmsLogs_ === "function") flushDevSmsLogs_(); } catch (_) {}
            return ContentService.createTextOutput(JSON.stringify(alexaOut))
              .setMimeType(ContentService.MimeType.JSON);
          } catch (err) {
            Logger.log("ALEXA_HANDLER_CRASH " + String(err));
            try { if (typeof flushDevSmsLogs_ === "function") flushDevSmsLogs_(); } catch (_) {}
            return ContentService.createTextOutput(
              JSON.stringify(alexaBuildErrorResponse_("System error. Please try again."))
            ).setMimeType(ContentService.MimeType.JSON);
          }
        }

        // If payload has ownership keys, route it
        if (data && (data.action || data.ticketId || data.ticketRow || data.tenantPhone || data.to || data.message)) {
          try { Logger.log("GATEWAY_POST route=APPSHEET"); } catch (_) {}
          try {
            // This is the DevLog equivalent for AppSheet
            logDevSms_("(appsheet)", "", "APPSHEET_HIT action=" + String(data.action || "") + " row=" + String(data.ticketRow || ""));
          } catch (_) {}

          // Wrap handler so we ALWAYS return OK even if handler crashes
          try {
            const out = handleAppSheetWebhook(e);
            return out || OK;
          } catch (err) {
            try { Logger.log("APPSHEET_HANDLER_CRASH " + String(err && err.stack ? err.stack : err)); } catch (_) {}
            return OK;
          }
        }

        // JSON but not for us — still return OK (avoid Twilio path)
        return OK;
      }
    } catch (err) {
      try { Logger.log("APPSHEET_GATE_CRASH " + String(err && err.stack ? err.stack : err)); } catch (_) {}
      return OK; // safest for AppSheet callers
    }

    // --- Twilio path continues below exactly as you already have it ---
    let out;

    // Always have request-scoped TwiML outbox
    var twimlOutbox = [];
    TWIML_OUTBOX_ = twimlOutbox;

    function devEmitTwiML_(msg) {
      var s = String(msg || "").trim();
      if (!s) return;
      twimlOutbox.push(s);
    }
    DEV_EMIT_TWIML_ = devEmitTwiML_;

    // Snapshot params once (avoid repeated e.parameter reads)
    const p = (e && e.parameter) ? e.parameter : {};
    const from0   = String(p.From || "").trim();
    const body0   = String(p.Body || "").trim();
    const action0 = String(p.action || "").trim();
    const sid0    = String(p.MessageSid || p.SmsMessageSid || "").trim();

    // If media-only message, inject a harmless marker so downstream never sees empty body.
    try {
      const numMediaN0 = parseInt(String(p.NumMedia || "0"), 10) || 0;
      if (!body0 && numMediaN0 > 0) {
        globalThis.__bodyOverride = "ATTACHMENT_ONLY";
      } else {
        globalThis.__bodyOverride = "";
      }
    } catch (_) { globalThis.__bodyOverride = ""; }

    // Request-scoped inbound channel (reply_ uses this to choose sendSms_ vs sendWhatsApp_)
    try {
      var fromRaw0 = String(e && e.parameter && e.parameter.From ? e.parameter.From : "");
      globalThis.__inboundChannel = (/^whatsapp:/i.test(fromRaw0)) ? "WA" : "SMS";
      globalThis.__fromRaw = fromRaw0;
    } catch (_) {
      globalThis.__inboundChannel = "SMS";
    }

    // 🔴 HARD PROOF: visible in Executions regardless of dev log buffer/flush
    try {
      Logger.log(
        "DOPOST_ENTRY from=" + (from0 || "(no-from)") +
        " sid=" + (sid0 || "(no-sid)") +
        (action0 ? (" action=" + action0) : "") +
        " body=" + (body0 ? body0.slice(0, 80) : "(no-body)")
      );
    } catch (_) {}

    try {
      // Buffered dev log (sheet) — may be suppressed by chaos rules; still keep it
      try {
        logDevSms_(
          from0 || "(no-from)",
          body0 || "(no-body)",
          "DOPOST_HIT" + (sid0 ? (" sid=" + sid0) : "") + (action0 ? (" action=" + action0) : "")
        );
      } catch (_) {}

      // --------------------------------------------
      // REQUEST-SCOPED DEV MODE (emulator / demos)
      // only when SIM enabled + From in allowlist
      // --------------------------------------------
      try {
        const dry = String(p._dryrun || p._dev || "").trim();
        if (dry === "1" || dry.toLowerCase() === "true") {
          const fromKey = phoneKey_(String(p.From || "").trim());
          if (simEnabled_() && fromKey && isSimAllowedPhone_(fromKey)) devReqOn_();
        }
      } catch (_) {}

      const action = String(p.action || "").trim().toLowerCase();

      // -------------------------------------------------
      // COMM ROUTER (AppSheet/webhook) — returns JSON
      // -------------------------------------------------
      const isBuild = (action === "comm_build" || action === "build");
      const isQueue = (action === "comm_queue" || action === "queue");

      if (isBuild || isQueue) {
        try {
          const commId = String(p.commId || "").trim();
          const secret = String(p.secret || "").trim();
          var commSecret = commWebhookSecret_();
          if (secret !== commSecret || !commId) {
            out = ContentService
              .createTextOutput(JSON.stringify({ ok: false, error: "Forbidden or missing commId" }))
              .setMimeType(ContentService.MimeType.JSON);
          } else {
            const res = isBuild ? buildRecipients(commId) : queueCommunication(commId);
            out = ContentService
              .createTextOutput(JSON.stringify(res))
              .setMimeType(ContentService.MimeType.JSON);
          }
        } catch (err) {
          out = ContentService
            .createTextOutput(JSON.stringify({
              ok: false,
              error: String(err && err.message ? err.message : err)
            }))
            .setMimeType(ContentService.MimeType.JSON);
        }
        return out;
      }

      // -------------------------------------------------
      // TWILIO WEBHOOK GATE (Propera Compass – Phase A)
      // Runs ONLY for SMS webhooks (no action param)
      // -------------------------------------------------
      // Non-Twilio request fallback (AppSheet / other webhooks)
      // If it somehow bypassed the JSON router, do NOT run Twilio validation.
      // Always return OK so AppSheet doesn't show "doPost failed".
      if (!from0 && !body0) {
        try {
          const raw1 = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : "";
          logDevSms_("(appsheet)", raw1.slice(0, 80), "APPSHEET_FALLBACK_OK rawLen=" + String(raw1.length));
        } catch (_) {}
        return OK;
      }
      try { Logger.log("GATEWAY_POST route=TWILIO"); } catch (_) {}
      try {
        const gate = validateTwilioWebhookGate_(e);
        if (!gate.ok) {
          try {
            logDevSms_(from0 || "(no-from)", body0 || "(no-body)", "WEBHOOK_DENY why=" + gate.why);
          } catch (_) {}
          try {
            var _eid = String((e && e.parameter && (e.parameter.MessageSid || e.parameter.SmsMessageSid || e.parameter.sid)) || "");
            logInvariantFail_(from0 || "(no-from)", _eid, "WEBHOOK_DENY", "why=" + (gate.why || ""));
          } catch (_) {}
          out = twimlEmpty_();
          return out;
        }
      } catch (gateErr) {
        try {
          logDevSms_(
            from0 || "(no-from)",
            body0 || "(no-body)",
            "WEBHOOK_GATE_CRASH " + String(gateErr && gateErr.stack ? gateErr.stack : gateErr)
          );
        } catch (_) {}
        out = twimlEmpty_();
        return out;
      }

      // -------------------------------------------------
      // SMS ROUTER (always returns TwiML)
      // -------------------------------------------------
      try {
        // ✅ FRAG REMOVED (2026-02-17): All messages pass straight through.
        // Carrier splits handled by state machine (compileTurn_ + context accumulation).
        handleSmsRouter_(e);
      } catch (err) {
        try {
          const fromKey = phoneKey_(String(p.From || "").trim());
          logDevSms_(
            from0 || "(no-from)",
            body0 || "(no-body)",
            "ROUTER_CRASH " + String(err && err.stack ? err.stack : err)
          );

          // Compass-safe fallback message (no state mutation) — via Outgate when available
          if (fromKey) {
            var _ogCrash = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_CRASH_FALLBACK", recipientType: "TENANT", recipientRef: fromKey, lang: "en", channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: {}, meta: { source: "doPost", stage: "ROUTER_CRASH", flow: "FALLBACK" } }) : { ok: false };
            if (!(_ogCrash && _ogCrash.ok)) sendRouterSms_(fromKey, renderTenantKey_("ERR_CRASH_FALLBACK", "en", {}), "CRASH_FALLBACK");
          }
        } catch (_) {}
      }

      if (TWIML_OUTBOX_ && TWIML_OUTBOX_.length >= 1) {
        out = twimlWithMessage_(TWIML_OUTBOX_[TWIML_OUTBOX_.length - 1]);
      } else {
        out = twimlEmpty_();
      }
      return out;

    } finally {
      // Cleanup: never let request-scoped globals bleed across executions
      try { clearExecutionSheetCaches_(); } catch (_) {}
      try { __FINDROW_CACHE__ = {}; } catch (_) {}
      try { __CTX_CACHE__ = {}; } catch (_) {}
      try { TWIML_OUTBOX_ = null; DEV_EMIT_TWIML_ = null; } catch (_) {}
      try { globalThis.__bodyOverride = ""; } catch (_) {}
      try { SIM_PHONE_SCOPE_ = ""; } catch (_) {}
      try { devReqOff_(); } catch (_) {}

      // ✅ Always flush dev logs, even on early returns
      try {
        flushDevSmsLogs_();
      } catch (err) {
        // Do NOT swallow — if dev logs don't appear, we need this in Executions
        try { Logger.log("DEVLOG_FLUSH_DOPOST_ERR " + (err && err.stack ? err.stack : err)); } catch (_) {}
      }
    }
  }

  function doGet(e) {
    const p = (e && e.parameter) ? e.parameter : {};
    const path = (p.path) ? String(p.path).trim() : "";
    if (path) {
      try { Logger.log("GATEWAY_GET route=PORTAL path=" + path); } catch (_) {}
      try {
        return (typeof portalDoGet_ === "function") ? portalDoGet_(e) : ContentService.createTextOutput(JSON.stringify({ error: "portal_unavailable" })).setMimeType(ContentService.MimeType.JSON);
      } catch (portalErr) {
        try { Logger.log("GATEWAY_GET PORTAL_ERR " + String(portalErr && portalErr.stack ? portalErr.stack : portalErr)); } catch (_) {}
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "portal_error" })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    try {
      const action = String(p.action || "").trim();

      if (action === "sim_read_last_outbound") {
        const secret = String(p.secret || "").trim();
        const simSecret = PropertiesService.getScriptProperties().getProperty("SIM_READ_SECRET") || "";
        if (!secret || secret !== simSecret) {
          return ContentService.createTextOutput(JSON.stringify({ ok: false, why: "bad_secret" }))
            .setMimeType(ContentService.MimeType.JSON);
        }

        const phoneRaw = String(p.phone || "").trim();
        const phone = (typeof phoneKey_ === "function") ? phoneKey_(phoneRaw) : phoneRaw;
        try { SIM_PHONE_SCOPE_ = phone || ""; } catch (_) {}

        const result = simReadLastOutboundFromLog_(phone);
        const payload = { ok: true, found: result.found };
        if (result.found) {
          payload.ts = result.ts;
          payload.message = result.message;
          payload.status = result.status;
          payload.extra = result.extra;
        }
        return ContentService.createTextOutput(JSON.stringify(payload))
          .setMimeType(ContentService.MimeType.JSON);
      }
    } catch (_) {}
    return ContentService.createTextOutput(JSON.stringify({ ok: false }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  function twimlEmpty_() {
    return ContentService
      .createTextOutput('<?xml version="1.0" encoding="UTF-8"?><Response/>')
      .setMimeType(ContentService.MimeType.XML);
  }

  /** Returns TwiML <Response><Message>escaped(text)</Message></Response> for chaosRunner (DEV_MODE). */
  function twimlWithMessage_(text) {
    var s = String(text || "");
    s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return ContentService
      .createTextOutput('<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + s + '</Message></Response>')
      .setMimeType(ContentService.MimeType.XML);
  }

  //Router Helpers


  // -------------------------
  // RouterDecision v1 (shared)
  // -------------------------
  function makeRouterDecision_(patch) {
    const P = patch || {};
    return {
      v: 1,

      lane: String(P.lane || "tenantLane"),          // tenantLane/managerLane/vendorLane/systemLane
      reason: String(P.reason || "default"),         // why chosen

      mode: String(P.mode || ""),                    // "TENANT" | "MANAGER" | "VENDOR" | "SYSTEM"
      confidence: (P.confidence === undefined ? "" : Number(P.confidence)),

      // optional routing hints
      routeKey: String(P.routeKey || ""),
      workItemType: String(P.workItemType || ""),
      expected: String(P.expected || ""),

      tags: Array.isArray(P.tags) ? P.tags : [],

      // debug
      trace: String(P.trace || "")
    };
  }

  // -------------------------
  // Normalize inbound events
  // -------------------------
  function normalizeInboundEvent_(source, opts) {
    const O = opts || {};

    const body = String(O.body || "");
    const bodyTrim = body.trim();

    // keep meta always a plain object
    let meta = {};
    try {
      meta = (O.meta && typeof O.meta === "object") ? O.meta : {};
    } catch (_) {
      meta = {};
    }

    return {
      v: 1,
      source: String(source || "unknown").toLowerCase(),

      actorType: String(O.actorType || "unknown").toLowerCase(),
      actorId: String(O.actorId || ""),

      body: body,
      bodyTrim: bodyTrim,
      bodyLower: bodyTrim.toLowerCase(),

      eventId: String(O.eventId || Utilities.getUuid()),
      timestamp: O.timestamp || new Date(),

      meta: meta
    };
  }

  // -------------------------
  // Lane classification (ONE source of truth)
  // -------------------------
  function classifyLane_(inbound) {
    let lane = "tenantLane";
    let reason = "default";

    try {
      if (isVendor_(inbound.actorId)) {
        lane = "vendorLane";
        reason = "isVendor_";
      } else if (isManager_(inbound.actorId)) {
        lane = "managerLane";
        reason = "isManager_";
      } else if (String(inbound.source || "") === "aiq") {
        lane = "systemLane";
        reason = "aiq_source";
      }
    } catch (_) {}

    const mode =
      (lane === "vendorLane")  ? "VENDOR"  :
      (lane === "managerLane") ? "MANAGER" :
      (lane === "systemLane")  ? "SYSTEM"  :
                                "TENANT";

    return { lane: lane, reason: reason, mode: mode };
  }

  // -------------------------
  // Decide lane ONCE (REAL decision object)
  // -------------------------
  function decideLane_(inbound) {
    const c = classifyLane_(inbound);
    return makeRouterDecision_({
      lane: c.lane,
      reason: c.reason,
      mode: c.mode,
      trace: "lane_v1"
    });
  }

  // -------------------------
  // Shadow route log (no behavior change)
  // -------------------------
  function shadowRouteLog_(decision, inbound) {
    try { } catch (_) {}
  }

  // -------------------------
  // Shadow lane-enter log (optional)
  // -------------------------
  function shadowLaneDispatch_(decision, inbound) {
    const lane = String((decision && decision.lane) || "tenantLane");

    try {
      if (lane === "vendorLane") return vendorLaneShadow_(inbound, decision);
      if (lane === "managerLane") return managerLaneShadow_(inbound, decision);
      if (lane === "systemLane") return systemLaneShadow_(inbound, decision);
      return tenantLaneShadow_(inbound, decision);
    } catch (_) {}
  }

  function tenantLaneShadow_(inbound, decision) {
    try { } catch (_) {}
  }
  function managerLaneShadow_(inbound, decision) {
    try { } catch (_) {}
  }
  function vendorLaneShadow_(inbound, decision) {
    try { } catch (_) {}
  }
  function systemLaneShadow_(inbound, decision) {
    try { } catch (_) {}
  }

  // -------------------------
  // Real dispatch (behavior lives in lane handlers)
  // -------------------------
  function laneDispatch_(decision, inbound) {
    const lane = String((decision && decision.lane) || "tenantLane");

    // Always log lane-enter (deterministic)
    try {
      logDevSms_(
        inbound.actorId,
        inbound.bodyTrim,
        "LANE_ENTER lane=[" + lane + "] reason=[" + String(decision.reason || "") + "] eid=[" + inbound.eventId + "]"
      );
    } catch (_) {}

    if (lane === "vendorLane")  return handleVendorLane_(inbound, decision);
    if (lane === "managerLane") return handleManagerLane_(inbound, decision);
    if (lane === "systemLane")  return handleSystemLane_(inbound, decision);
    return handleTenantLane_(inbound, decision);
  }

  // -------------------------
  // Lane handlers v1 (THIN WRAPPERS)
  // -------------------------
  function handleTenantLane_(inbound, decision) {
    try { logDevSms_(inbound.actorId, inbound.bodyTrim, "LANE TENANT eid=[" + inbound.eventId + "]"); } catch (_) {}
    return handleTenantInbound_(inbound, decision);
  }
  function handleManagerLane_(inbound, decision) {
    try { logDevSms_(inbound.actorId, inbound.bodyTrim, "LANE MANAGER eid=[" + inbound.eventId + "]"); } catch (_) {}
    return handleManagerInbound_(inbound, decision);
  }
  function handleVendorLane_(inbound, decision) {
    try { logDevSms_(inbound.actorId, inbound.bodyTrim, "LANE VENDOR eid=[" + inbound.eventId + "]"); } catch (_) {}
    return handleVendorInbound_(inbound, decision);
  }
  function handleSystemLane_(inbound, decision) {
    try { logDevSms_(inbound.actorId, inbound.bodyTrim, "LANE SYSTEM eid=[" + inbound.eventId + "]"); } catch (_) {}
    return handleSystemInbound_(inbound, decision);
  }

  // -------------------------
  // Optional: event logging
  // -------------------------
  function logEvent_(type, data) {
    try {
      withWriteLock_("LOG_EVENT_" + type, () => {
        const ss = SpreadsheetApp.getActive();
        const sh = ss.getSheetByName("EventLog") || ss.insertSheet("EventLog");
        sh.appendRow([ new Date(), String(type), JSON.stringify(data || {}) ]);
      });
    } catch (_) {}
  }


  // =====================================================
  // PROPERA COMPASS: Router → Safe → Core (never bypass)
  // =====================================================

  function routeToCoreSafe_(e, opts) {
    opts = opts || {};

    // Make sure parameter object exists
    e = e || {};
    e.parameter = e.parameter || {};

    // Mode support (you already have)
    if (opts.mode) e.parameter._mode = String(opts.mode);

    // ✅ ONLY mark internal injections (Core replays, synthetic calls, etc.)
    if (opts.internal === true) e.parameter._internal = "1";

    return handleSmsCore_(e);
  }


  function validateTwilioWebhookGate_(e) {
    const p = (e && e.parameter) ? e.parameter : {};
    const from = phoneKey_(String(p.From || "").trim());
    const body = String(p.Body || "").trim();
    const sec  = String(p.twhsec || "").trim();
    const acct = String(p.AccountSid || "").trim();

    // ✅ Allow attachment-only messages (Body may be empty when NumMedia > 0)
    const numMediaN = parseInt(String(p.NumMedia || "0"), 10) || 0;
    const hasBody  = body.length > 0;
    const hasMedia = numMediaN > 0;

    if (!from || (!hasBody && !hasMedia)) return { ok:false, why:"missing_from_or_body" };

    try {
      const simSec = String(PropertiesService.getScriptProperties().getProperty("SIM_WEBHOOK_SECRET") || "");
      const allowRaw = String(PropertiesService.getScriptProperties().getProperty("SIM_ALLOW_PHONES") || "");
      const simModeRaw = String(PropertiesService.getScriptProperties().getProperty("SIM_MODE") || "");
      const killedRaw = String(PropertiesService.getScriptProperties().getProperty("SIM_KILL") || "");

      function mask_(s) {
        s = String(s || "");
        if (s.length <= 8) return "len=" + s.length;
        return s.slice(0, 4) + "..." + s.slice(-4) + " (len=" + s.length + ")";
      }

      logDevSms_(
        String(p.From || ""),
        String(p.Body || ""),
        "SIM_GATE_DEBUG",
        "sec=" + mask_(String(p.twhsec || "")) +
        " simSec=" + mask_(simSec) +
        " SIM_MODE=" + simModeRaw +
        " SIM_KILL=" + killedRaw +
        " allowRaw=" + allowRaw +
        " NumMedia=" + String(numMediaN)
      );

    } catch (_) {}

    // SIM path (must run BEFORE production checks)
    try {
      const simSec = String(PropertiesService.getScriptProperties().getProperty("SIM_WEBHOOK_SECRET") || "").trim();
      if (simEnabled_() && from && isSimAllowedPhone_(from) && simSec && sec === simSec) {
        if (simKilled_()) return { ok:false, why:"sim_killed" };
        return { ok:true, sim:true };
      }
    } catch (_) {}

    // PROD path
    if (!sec || sec !== String(TWILIO_WEBHOOK_SECRET || "").trim()) return { ok:false, why:"bad_secret" };
    if (!acct || acct !== String(TWILIO_SID || "").trim()) return { ok:false, why:"bad_accountsid" };
    return { ok:true };
  }

  function normMsg_(s) {
    return String(s || "").toUpperCase().replace(/\s+/g, " ").trim();
  }
  function normNoSpace_(s) {
    return normMsg_(s).replace(/\s+/g, "");
  }

  /*******************************************************
  * COMPLIANCE INTENT (EXACT-ONLY)
  * - Returns: "STOP" | "START" | "HELP" | ""
  * - Exact match only (after normalization)
  * - STOP includes carrier synonyms + STOPALL
  *******************************************************/
  function complianceIntent_(rawAny) {
    const s0 = String(rawAny || "");
    if (!s0) return "";

    // Normalize: trim, uppercase, remove common punctuation, collapse spaces
    // Keep behavior deterministic and "exact-only".
    const s = s0
      .trim()
      .toUpperCase()
      .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width junk
      .replace(/[.,!?:;'"`(){}\[\]<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!s) return "";

    // STOP-class (opt-out). Treat all as STOP.
    // Carrier common set + user list:
    // STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, REVOKE
    const STOP_WORDS = {
      "STOP": 1,
      "STOPALL": 1,
      "UNSUBSCRIBE": 1,
      "CANCEL": 1,
      "END": 1,
      "QUIT": 1,
      "OPTOUT": 1,
      "OPT OUT": 1,        // allow split version
      "REVOKE": 1
    };

    if (STOP_WORDS[s]) return "STOP";

    // START-class (opt back in) — exact only
    const START_WORDS = {
      "START": 1,
      "UNSTOP": 1
    };

    if (START_WORDS[s]) return "START";

    // HELP-class — exact only
    const HELP_WORDS = {
      "HELP": 1,
      "INFO": 1
    };

    if (HELP_WORDS[s]) return "HELP";

    return "";
  }


  function isSmsOptedOut_(phoneAny) {
    const sh = getOptOutSheet_();
    const last = sh.getLastRow();
    if (last < 2) return false;

    const key = phoneKey_(phoneAny);
    if (!key) return false;

    const vals = sh.getRange(2, 1, last - 1, 2).getValues(); // phone, optedOut
    for (let i = 0; i < vals.length; i++) {
      const rowKey = phoneKey_(vals[i][0]);
      if (rowKey === key) {
        const v = vals[i][1];
        // ✅ handle boolean TRUE/FALSE and string "TRUE"/"FALSE"
        if (v === true) return true;
        return String(v).toUpperCase() === "TRUE";
      }
    }
    return false;
  }

  function setSmsOptOut_(phoneAny, optedOut, keyword) {
    return withWriteLock_("OPTOUT_UPDATE", () => {
      const sh = getOptOutSheet_();
      const key = phoneKey_(phoneAny);
      if (!key) return;

      const last = sh.getLastRow();

      if (last >= 2) {
        const phones = sh.getRange(2, 1, last - 1, 1).getValues();
        for (let i = 0; i < phones.length; i++) {
          const rowKey = phoneKey_(phones[i][0]);
          if (rowKey === key) {
            sh.getRange(i + 2, 1).setValue(key); // force canonical
            sh.getRange(i + 2, 2, 1, 3).setValues([[!!optedOut, new Date(), String(keyword || "")]]);
            return;
          }
        }
      }

      sh.appendRow([key, !!optedOut, new Date(), String(keyword || "")]);
    });
  }


  function tenantCancelTicketCommand_(sheet, dir, digits, phone, bodyTrim, lang, baseVars) {
    const raw = String(bodyTrim || "").trim();
    const norm = raw.toLowerCase().replace(/\s+/g, " ").trim();

    const L = String(lang || "en").toLowerCase();
    const vars = baseVars || {}; // { brandName, teamName } etc

    // Extract ticket id if present: "cancel ticket PENN-2026..." or "cancel PENN-..."
    let ticketId = "";
    const m = norm.match(/^(cancel(\s+ticket)?|cancel\s+request)\s+([a-z0-9\-]{6,})$/i);
    if (m && m[3]) ticketId = String(m[3] || "").trim();

    // Load all rows (scan from bottom for most recent)
    const data = sheet.getDataRange().getValues();
    if (!data || data.length < 2) {
      return { ok: false, msg: tenantMsg_("CANCEL_NONE_TICKETS", L, vars) };
    }

    const headers = data[0].map(h => String(h || "").trim().toLowerCase());

    // Flexible header matching (works across your versions)
    const idxTicketId =
      headers.indexOf("ticketid") >= 0 ? headers.indexOf("ticketid") :
      headers.indexOf("ticket id") >= 0 ? headers.indexOf("ticket id") :
      headers.indexOf("ticket") >= 0 ? headers.indexOf("ticket") : -1;

    const idxPhone =
      headers.indexOf("phone") >= 0 ? headers.indexOf("phone") :
      headers.indexOf("from") >= 0 ? headers.indexOf("from") :
      headers.indexOf("tenantphone") >= 0 ? headers.indexOf("tenantphone") : -1;

    const idxStatus =
      headers.indexOf("status") >= 0 ? headers.indexOf("status") :
      headers.indexOf("ticketstatus") >= 0 ? headers.indexOf("ticketstatus") : -1;

    const idxLastUpdate =
      headers.indexOf("last_update") >= 0 ? headers.indexOf("last_update") :
      headers.indexOf("last update") >= 0 ? headers.indexOf("last update") :
      headers.indexOf("updatedat") >= 0 ? headers.indexOf("updatedat") : -1;

    if (idxPhone < 0) {
      return { ok: false, msg: tenantMsg_("CANCEL_SHEET_MISSING_PHONE", L, vars) };
    }
    if (idxStatus < 0) {
      return { ok: false, msg: tenantMsg_("CANCEL_SHEET_MISSING_STATUS", L, vars) };
    }

    const phoneKey = phoneKey_(phone || digits || "");

    // Helper: is this status cancelable?
    function isCancelableStatus_(s) {
      const v = String(s || "").toLowerCase().trim();
      if (!v) return true; // blank -> treat as open
      if (v.includes("completed") || v.includes("closed") || v.includes("done")) return false;
      if (v.includes("canceled") || v.includes("cancelled")) return false;
      return true;
    }

    // Find row to cancel
    let targetRowIndex = 0; // 1-based sheet row index
    let targetTicketId = "";

    if (ticketId && idxTicketId >= 0) {
      // Cancel specific ticket
      for (let i = 1; i < data.length; i++) {
        const r = data[i];
        const rid = String(r[idxTicketId] || "").trim();
        if (rid && rid.toLowerCase() === ticketId.toLowerCase()) {
          const rPhoneKey = phoneKey_(r[idxPhone]);
          if (rPhoneKey !== phoneKey) {
            return { ok: false, msg: tenantMsg_("CANCEL_TICKET_NOT_YOURS", L, vars) };
          }
          if (!isCancelableStatus_(r[idxStatus])) {
            return { ok: false, msg: tenantMsg_("CANCEL_TICKET_NOT_CANCELABLE", L, vars) };
          }
          targetRowIndex = i + 1; // + header row
          targetTicketId = rid;
          break;
        }
      }

      if (!targetRowIndex) {
        return {
          ok: false,
          msg: tenantMsg_("CANCEL_TICKET_NOT_FOUND", L, Object.assign({}, vars, { ticketId: ticketId }))
        };
      }
    } else {
      // Cancel most recent cancelable ticket for this phone (scan bottom-up)
      for (let i = data.length - 1; i >= 1; i--) {
        const r = data[i];
        const rPhoneKey = phoneKey_(r[idxPhone]);
        if (rPhoneKey !== phoneKey) continue;
        if (!isCancelableStatus_(r[idxStatus])) continue;

        targetRowIndex = i + 1;
        targetTicketId = (idxTicketId >= 0) ? String(r[idxTicketId] || "").trim() : "";
        break;
      }

      if (!targetRowIndex) {
        return { ok: false, msg: tenantMsg_("CANCEL_NONE_OPEN", L, vars) };
      }
    }

    // Perform cancel + optional Directory clear (ALL under lock)
    const CANCEL_STATUS = "Canceled";

    withWriteLock_("TENANT_CANCEL_TICKET", function () {
      sheet.getRange(targetRowIndex, idxStatus + 1).setValue(CANCEL_STATUS);
      if (idxLastUpdate >= 0) {
        sheet.getRange(targetRowIndex, idxLastUpdate + 1).setValue(new Date());
      }
    });
    try {
      if (dir && typeof findDirectoryRowByPhone_ === "function") {
        var dr = findDirectoryRowByPhone_(dir, phone);
        if (dr > 0) {
          dalWithLock_("TENANT_CANCEL_DIR", function () {
            dalSetPendingIssueNoLock_(dir, dr, "");
            try { logDevSms_(phone, "", "ISSUE_WRITE site=[TENANT_CANCEL_TICKET] val=[CLEAR_CANCEL]"); } catch (_) {}
            dalSetPendingUnitNoLock_(dir, dr, "");
            dalSetPendingRowNoLock_(dir, dr, "");
            dalSetPendingStageNoLock_(dir, dr, "");
            dalSetLastUpdatedNoLock_(dir, dr);
            try { logDevSms_(phone || "", "", "DAL_WRITE TENANT_CANCEL_DIR row=" + dr); } catch (_) {}
          });
        }
      }
    } catch (_) {}

    // ✅ Send cancellation receipt immediately (do NOT rely on onEdit)
    try {
      sendCancelReceiptForRow_(sheet, targetRowIndex, { mode: "SMS", lang: L, vars: vars });
    } catch (_) {}

    // Return template-based success
    if (targetTicketId) {
      return {
        ok: true,
        msg: tenantMsg_("CANCEL_SUCCESS_WITH_ID", L, Object.assign({}, vars, { ticketId: targetTicketId }))
      };
    }
    return { ok: true, msg: tenantMsg_("CANCEL_SUCCESS_NO_ID", L, vars) };
  }




  function phoneKey_(raw) {
    const digits = String(normalizePhone_(raw) || "").replace(/\D/g, "");
    // If US 10-digit, prefix country code
    if (digits.length === 10) return "1" + digits;
    // If already 11-digit starting with 1, keep
    if (digits.length === 11 && digits.startsWith("1")) return digits;
    // Fallback: return digits if any, else empty
    return digits || "";
  }



  function isLeasingIntentStrong_(text) {
    if (!text || typeof text !== "string") return false;
    var lower = String(text).trim().toLowerCase();
    if (/^unit\s*\d*$/.test(lower)) return false;
    var strong = [
      "rent", "renting", "lease", "leasing", "availability", "available", "tour", "showing",
      "schedule a tour", "apply", "application", "move in", "move-in", "pricing", "price",
      "deposit", "requirements", "bedroom", "studio", "1br", "2br", "3br", "pet policy",
      "income", "credit"
    ];
    for (var i = 0; i < strong.length; i++) {
      if (lower.indexOf(strong[i]) !== -1) return true;
    }
    return false;
  }

  function isMaintenanceVeto_(text) {
    if (!text || typeof text !== "string") return false;
    var lower = String(text).trim().toLowerCase();
    if (lower.indexOf("maintenance") !== -1 || lower.indexOf("repair") !== -1) return true;
    var signals = [
      "toilet", "sink", "leak", "water", "backed up", "clogged", "drain", "pipe", "faucet", "shower",
      "heater", "heat", " ac ", "a/c", "hvac", "thermostat", "outlet", "breaker", "electric", "lights",
      "door lock", "lock", "window", "fridge", "dishwasher", "washer", "dryer", "mold", "smell", "smoke",
      "pest", "roach", "mice", "flooded", "not working", "broken", "stopped working", "fix",
      "broke", "doesn't work", "isn't working", "leaking", "no hot water", "no heat", "no ac",
      "won't start", "won't turn on", "won't flush", "overflow", "smells like gas"
    ];
    for (var j = 0; j < signals.length; j++) {
      if (lower.indexOf(signals[j]) !== -1) return true;
    }
    return false;
  }

  function isAmenityCommand_(s) {
    // Commands we WILL support (explicit)
    // - RESERVE GAMEROOM <time>
    // - CANCEL RESERVATION
    // - CHANGE RESERVATION <new time>
    // - HELP RESERVATION
    return (
      s.startsWith("reserve ") ||
      s === "reserve" ||
      s.startsWith("book ") ||
      s.startsWith("cancel reservation") ||
      s.startsWith("cancel booking") ||
      s.startsWith("change reservation") ||
      s.startsWith("change booking") ||
      s.startsWith("reschedule reservation") ||
      s.startsWith("help reservation") ||
      s.startsWith("reservation help") ||
      s.startsWith("my reservations")
    );
  }

  function isMaintenanceCommand_(s) {
    // Future-proof commands (won’t break anything now)
    return (
      s.startsWith("cancel ticket") ||
      s.startsWith("change ticket") ||
      s.startsWith("reschedule ticket") ||
      s.startsWith("help maintenance") ||
      s.startsWith("maintenance help") ||
      s.startsWith("my tickets")
    );
  }

  function getOptOutSheet_() {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName("OptOuts");
    if (sh) return sh;

    return withWriteLock_("OPTOUTS_SHEET_CREATE", () => {
      let s2 = ss.getSheetByName("OptOuts");
      if (!s2) {
        s2 = ss.insertSheet("OptOuts");
        s2.getRange(1, 1, 1, 4).setValues([["PhoneE164", "OptedOut", "UpdatedAt", "Keyword"]]);
      }
      return s2;
    });
  }

  function getActiveProperties_() {
    // ✅ safe init without redeclare
    if (typeof __propertiesCache === "undefined") __propertiesCache = null;
    if (typeof __propertiesCacheAt === "undefined") __propertiesCacheAt = 0;

    const now = Date.now();
    if (__propertiesCache && (now - __propertiesCacheAt) < 1000 * 60 * 10) return __propertiesCache; // 10 min

    const sh = (typeof getSheet_ === "function")
      ? getSheet_("Properties")
      : SpreadsheetApp.getActive().getSheetByName("Properties");

    if (!sh || sh.getLastRow() < 2) {
      __propertiesCache = [];
      __propertiesCacheAt = now;
      return __propertiesCache;
    }

    // A:PropertyID B:PropertyCode C:PropertyName D:Active E:Address F:TicketPrefix G:ShortName
    const lastCol = Math.max(7, (sh.getLastColumn() || 6));
    const vals = sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues();

    const list = [];
    for (let i = 0; i < vals.length; i++) {
      const propertyId = String(vals[i][0] || "").trim();
      const code = String(vals[i][1] || "").trim().toUpperCase();
      const name = String(vals[i][2] || "").trim();
      const activeVal = vals[i][3];
      const address = String(vals[i][4] || "").trim();
      const ticketPrefix = String(vals[i][5] || "").trim().toUpperCase();
      const shortName = (vals[i][6] != null && vals[i][6] !== "") ? String(vals[i][6] || "").trim() : "";

      // ✅ more tolerant active check (prevents empty list surprise)
      const av = String(activeVal || "").trim().toUpperCase();
      const isActive = (activeVal === true) || av === "TRUE" || av === "YES" || av === "Y" || av === "1";
      if (!isActive) continue;

      if (!code || !name) continue;

      const p = { propertyId, code, name, address, ticketPrefix, shortName };

      // ✅ variants must never crash properties load
      try {
        p._variants = (typeof buildPropertyVariants_ === "function") ? buildPropertyVariants_(p) : [];
      } catch (_) {
        p._variants = [];
      }

      list.push(p);
    }

    __propertiesCache = list;
    __propertiesCacheAt = now;
    return __propertiesCache;
  }


  function looksLikeAmenityByKeywords_(s) {
    // Only used when there is no active flow and no explicit commands
    return (
      s.includes("gameroom") ||
      s.includes("game room") ||
      s.includes("game-room") ||
      s.includes("terrace") ||
      s.includes("party") ||
      s.includes("reservation") ||
      s.includes("book") ||
      s.includes("reserve")
    );
  }

  function hasActiveAmenityFlow_(phone) {
    // Sticky routing via cache OR AmenityDirectory
    if (getAmenityStageCache_(phone)) return true;
    try {
      const dir = getAmenityDir_(phone);
      return !!String(dir && dir.Stage ? dir.Stage : "").trim();
    } catch (_) {
      return false;
    }
  }



  /***********************
  * Maintenance AI Triage (SMS ONLY)
  * Google Sheets + Twilio + OpenAI
  *
  * Twilio Messaging Webhook (SMS):
  *   POST -> https://script.google.com/macros/s/<DEPLOY_ID>/exec
  *
  * Sheets:
  *  - Ticket log tab: "Sheet1"
  *  - Directory tab:  "Directory"
  *
  *  * Directory columns (A:I): A Phone, B PropertyCode, C PropertyName, D UpdatedAt,
  *   E PendingIssue, F PendingUnit, G PendingRow, H PendingStage, I IssueBuffer (JSON)
  ***********************/

  // IMPORTANT:
  // Twilio webhooks MUST always return valid TwiML XML.
  // Do NOT return plain text or HtmlService from doPost().



  const LOG_SHEET_ID = (PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID")) || "";

  const DEV_MODE = false;                 // true = no real SMS sent; logs only

  // Request-scoped dev/dryrun flag (default false)
  var DEV_REQ_ = false;
  function devReqOn_()  { DEV_REQ_ = true; }
  function devReqOff_() { DEV_REQ_ = false; }
  // Use this everywhere instead of DEV_MODE directly for sending
  function isDevSendMode_() {
    return !!DEV_MODE || !!DEV_REQ_;
  }

  // ============================================================
  // SHEET HANDLE CACHE (per execution)
  // - Avoid repeated openById/getSheetByName in the same webhook
  // - Cache ONLY Spreadsheet/Sheet objects (NOT row data)
  // ============================================================
  var __SS_CACHE__ = {};     // key -> Spreadsheet
  var __SH_CACHE__ = {};     // key -> Sheet
  var __CTX_CACHE__ = {};

  function ssByIdCached_(id) {
    var sid = String(id || "").trim();
    if (!sid) throw new Error("ssByIdCached_: id is blank");
    var k = "id:" + sid;
    if (!__SS_CACHE__[k]) __SS_CACHE__[k] = SpreadsheetApp.openById(sid);
    return __SS_CACHE__[k];
  }

  function ssActiveCached_() {
    var k = "active";
    if (!__SS_CACHE__[k]) __SS_CACHE__[k] = SpreadsheetApp.getActiveSpreadsheet();
    return __SS_CACHE__[k];
  }

  function sheetFromSsCached_(ss, name) {
    var ssId = "";
    try { ssId = ss.getId(); } catch (_) { ssId = "active"; }
    var nm = String(name || "").trim();
    var k = "sh:" + ssId + ":" + nm;

    if (__SH_CACHE__[k]) return __SH_CACHE__[k];

    var sh = ss.getSheetByName(nm);
    if (!sh) return null; // do NOT cache null
    __SH_CACHE__[k] = sh;
    return sh;
  }

  // Sheets that live in the LOG_SHEET_ID workbook
  function getLogSheetByNameCached_(name) {
    return sheetFromSsCached_(ssByIdCached_(LOG_SHEET_ID), name);
  }

  // Sheets that live in the bound (active) spreadsheet
  function getActiveSheetByNameCached_(name) {
    return sheetFromSsCached_(ssActiveCached_(), name);
  }

  function clearExecutionSheetCaches_() {
    __SS_CACHE__ = {};
    __SH_CACHE__ = {};
  }

  const BUILD_MARKER = "2026-02-FINALIZE";  // change when deploying to confirm version
  const SHEET_NAME = "Sheet1";           // ticket log tab name EXACTLY
  const DIRECTORY_SHEET_NAME = "Directory";
  const TENANTS_SHEET_NAME = "Tenants";
  const MGR_NEW_TICKET_PREFIX = "__MGR_NEW_TICKET__";
  const AMENITIES_SHEET_NAME = "Amenities";
  const AMENITY_RES_SHEET_NAME = "AmenityReservations";
  const AMENITY_DIR_SHEET_NAME = "AmenityDirectory";
  const VISITS_SHEET_NAME = "Visits";

  const DEFAULT_GAMEROOM_KEY = "PENN_GAMEROOM";

  const MAX_COL = 55; // keep in sync with the last COL.* index

  // Ticket log column positions (1-indexed). Must match your Sheet1 columns order:
  // Timestamp(1), Phone(2), Property(3), Unit(4), Message(5), Category(6), Emergency(7),
  // EmergencyType(8), Confidence(9), NextQuestions(10), AutoReplySent(11), EscalatedToYou(12), ThreadId(13)
  const COL = {
    TS: 1,                     // Timestamp
    PHONE: 2,                  // Phone
    PROPERTY: 3,               // Property
    UNIT: 4,                   // Unit
    MSG: 5,                    // Message
    CAT: 6,                    // Category
    EMER: 7,                   // Emergency
    EMER_TYPE: 8,              // Emergency Type
    URG: 9,                    // Urgency
    URG_REASON: 10,            // UrgencyReason
    CONF: 11,                  // Confidence
    NEXT_Q: 12,                // Next Question
    REPLY_SENT: 13,            // AutoReply
    ESCALATED: 14,             // EscaletedToYou
    THREAD_ID: 15,             // ThreadId

    TICKET_ID: 16,             // TicketID
    STATUS: 17,                // Status
    ASSIGNED_TO: 18,           // AssignedTo
    DUE_BY: 19,                // DueBy
    LAST_UPDATE: 20,           // LastUpdateAt
    PREF_WINDOW: 21,           // PreferredWindow
    HANDOFF_SENT: 22,          // HandoffSent

    // AppSheet / Ops fields — Z=26 ClosedAt, AA=27 CreatedAt (do not swap)
    CAT_FINAL: 23,             // CategoryFinal
    PRIORITY: 24,              // Priority
    SERVICE_NOTES: 25,         // ServiceNotes
    CLOSED_AT: 26,             // ClosedAt (col Z)
    CREATED_AT: 27,            // CreatedAt (col AA)
    ATTACHMENTS: 28,           // Attachments

    // SMS flags
    COMPLETED_SENT: 29,        // CompletedMsgSent
    COMPLETED_SENT_AT: 30,     // CompleteMsgSentAt
    CREATED_MSG_SENT: 31,      // CreatedMsgSent
    CREATED_MSG_SENT_AT: 32,   // CreatedMsgSentAt
    CREATED_BY_MANAGER: 33,    // CreatedByManager
    CANCEL_MSG_SENT: 34,       // CancelMsgSent
    CANCEL_MSG_SENT_AT: 35,    // CancelMsgSentAt

    // Identity / internal
    PROPERTY_ID: 36,           // PropertyID
    UNIT_ID: 37,               // UnitID
    LOCATION_TYPE: 38,         // LocationType
    WORK_TYPE: 39,             // WorkType
    RESIDENT_ID: 40,           // ResidentID
    UNIT_ISSUE_COUNT: 41,      // UnitIssueCount
    TARGET_PROPERTY_ID: 42,    // TargetPropertyID

    // 🔥 ASSIGNMENT SYSTEM (THIS WAS THE PROBLEM AREA)
    ASSIGNED_TYPE: 43,         // AssignedType   ("Vendor" | "Staff")
    ASSIGNED_ID: 44,           // AssignedID
    ASSIGNED_NAME: 45,         // AssignedName
    ASSIGNED_AT: 46,           // AssignedAt
    ASSIGNED_BY: 47,           // AssignedBy

    VENDOR_STATUS: 48,         // VendorStatus
    VENDOR_APPT: 49,           // VendorAppt
    VENDOR_NOTES: 50,           // VendorNotes
    TICKET_KEY: 51,             // TicketKey (UUID, immutable)
    VISIT_ID: 52,               // VisitId (links to Visits sheet for parent visit + child tickets)
    OWNER_ACTION: 53,           // OwnerAction
    OWNER_ACTION_AT: 54,        // OwnerActionAt
    SCHEDULED_END_AT: 55        // ScheduledEndAt — structured end datetime from parsed schedule
  };



  function resolvePropertyFromFreeText_(text) {
    const propsList = getActiveProperties_();
    const raw = String(text || "");
    const t = normalizePropText_(raw);
    if (!t) return null;

    // 1) Fast path: exact / contains match
  for (let i = 0; i < propsList.length; i++) {
    const p = propsList[i];
    const variants = p._variants || buildPropertyVariants_(p);


      for (let v = 0; v < variants.length; v++) {
        const key = variants[v];
        if (!key) continue;

  // exact always ok
  if (t === key) return p;

  // contains is ok when tenant typed something reasonably long
  if (t.length >= 3 && t.includes(key)) return p;

  // reverse-contains ONLY if tenant typed a real word (not tiny / not numeric)
  const tIsNumeric = /^\d+$/.test(t);
  if (!tIsNumeric && t.length >= 3 && key.includes(t)) return p;

      }
    }

    // 2) Fuzzy path (typo tolerance)
    // We compare the tenant text to each property variant using edit distance
    // and pick the best match if it’s "close enough".
    let best = null;
    let bestScore = 999;

  for (let i = 0; i < propsList.length; i++) {
    const p = propsList[i];
    const variants = p._variants || buildPropertyVariants_(p);

    for (let v = 0; v < variants.length; v++) {
      const key = variants[v];
      if (!key) continue;

      const d = levenshtein_(t, key);
      if (d < bestScore) {
        bestScore = d;
        best = p;
      }
    }
  }

    // Threshold rules:
    // - short inputs need tighter matching
    // - longer strings allow a couple typos
    const len = t.length;
    const threshold =
      (len <= 4) ? 1 :
      (len <= 7) ? 2 :
      3;

    if (best && bestScore <= threshold) return best;

    // 3) Token-based fuzzy: handles "grand pen", "west grand", etc.
    // Compare each token against property tokens; if any token is close, accept.
    const tokens = t.split(" ").filter(Boolean);
    if (tokens.length) {
      let best2 = null;
      let best2Score = 999;

  for (let i = 0; i < propsList.length; i++) {
    const p = propsList[i];
    const variants = p._variants || buildPropertyVariants_(p);


        for (let v = 0; v < variants.length; v++) {
          const keyTokens = variants[v].split(" ").filter(Boolean);

          for (let a = 0; a < tokens.length; a++) {
            for (let b = 0; b < keyTokens.length; b++) {
              const d = levenshtein_(tokens[a], keyTokens[b]);
              if (d < best2Score) {
                best2Score = d;
                best2 = p;
              }
            }
          }
        }
      }

      // token threshold (tight)
      if (best2 && best2Score <= 1) return best2;
    }

    return null;
  }

  function normalizePropText_(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")   // remove punctuation
      .replace(/\s+/g, " ")
      .trim();
  }

  /**************************************
  * Property variant helpers (Compass)
  * - NO brand-specific logic
  * - Safe for any client (Grand, Vermella, etc.)
  **************************************/

  function stripCommonBuildingWords_(s) {
    return String(s || "")
      .replace(/\b(the|at|building|bldg|residences|residence|apartments|apts|complex|real estate)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildPropertyMenuLines_() {
    // MUST match PROPERTY stage order (getActiveProperties_).
    try {
      if (typeof getActiveProperties_ === "function") {
        const propsList = getActiveProperties_();
        if (propsList && Array.isArray(propsList) && propsList.length) {
          return propsList
            .map((p, i) => (i + 1) + ") " + String(p && p.name ? p.name : (p && p.code ? p.code : "")).trim())
            .filter(Boolean)
            .join("\n");
        }
      }
    } catch (_) {}

    // Fallback: Properties sheet (ONLY if getActiveProperties_ missing/broken)
    try {
      const sh = SpreadsheetApp.getActive().getSheetByName("Properties");
      if (!sh) return "";

      const map = getHeaderMap_(sh);
      const lastRow = sh.getLastRow();
      if (lastRow < 2) return "";

      const nameCol = map["Name"] || map["PropertyName"] || map["propertyName"] || map["name"];
      if (!nameCol) return "";

      const vals = sh.getRange(2, nameCol, lastRow - 1, 1).getValues();
      const names = vals.map(r => String(r[0] || "").trim()).filter(Boolean);
      if (!names.length) return "";

      return names.map((n, i) => (i + 1) + ") " + n).join("\n");
    } catch (_) {}

    return "";
  }



  function buildPropertyVariants_(p) {
    const nameRaw = normalizePropText_(p.name || "");
    const codeRaw = normalizePropText_(p.code || "");
    const addrRaw = normalizePropText_(p.address || "");
    const ticketPrefixRaw = normalizePropText_(p.ticketPrefix || "");
    const shortNameRaw = (p.shortName != null && p.shortName !== "") ? normalizePropText_(String(p.shortName || "")) : "";

    // Generic stripping (NOT brand-specific)
    const nameStripped = stripCommonBuildingWords_(nameRaw);

    // Useful fallback token (e.g. "penn", "vermella", "westfield")
    const lastWord = nameStripped.split(" ").slice(-1)[0] || "";

    // Address tokens help cases like "702 pennsylvania"
    const addrTokens = addrRaw.split(" ").filter(Boolean);

    const variants = [
      codeRaw,          // PENN / MORRIS / etc
      nameRaw,          // full normalized name
      nameStripped,     // generic stripped name
      lastWord,         // short keyword
      addrRaw,          // full address
      ...addrTokens,    // address parts
      ticketPrefixRaw,  // MORR / PENN / MURR etc for ticket ID lookup
      shortNameRaw      // Morris / Penn etc from ShortName column
    ];

    // Dedupe + clean
    const seen = {};
    const out = [];
    for (let i = 0; i < variants.length; i++) {
      const v = String(variants[i] || "").trim();
      if (!v) continue;
      if (!seen[v]) {
        seen[v] = true;
        out.push(v);
      }
    }

    return out;
  }


  // Levenshtein edit distance (small + fast enough for 5 properties)
  function levenshtein_(a, b) {
    a = String(a || "");
    b = String(b || "");
    if (a === b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;

    const m = a.length, n = b.length;
    const dp = new Array(n + 1);

    for (let j = 0; j <= n; j++) dp[j] = j;

    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        const cost = (a.charAt(i - 1) === b.charAt(j - 1)) ? 0 : 1;
        dp[j] = Math.min(
          dp[j] + 1,        // deletion
          dp[j - 1] + 1,    // insertion
          prev + cost       // substitution
        );
        prev = tmp;
      }
    }
    return dp[n];
  }

  /**
  * 
  * SMS webhook entry point (Twilio POST)
  */

  //DailySummary


  function sendDailySummary() {
    if (!ONCALL_NUMBER) { Logger.log("sendDailySummary: missing ONCALL_NUMBER"); return; }

    const sheet = getSheet_(SHEET_NAME);
    const tz = Session.getScriptTimeZone() || "America/New_York";

    // Today range
    const now = new Date();
    const start = new Date(now);
    start.setHours(0,0,0,0);

    const values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER, "Daily Summary: no tickets yet.");
      return;
    }

    // Column indexes (0-based)
    const iTS = COL.TS - 1;
    const iProp = COL.PROPERTY - 1;
    const iUnit = COL.UNIT - 1;
    const iMsg = COL.MSG - 1;
    const iEmer = COL.EMER - 1;
    const iUrg = COL.URG - 1;
    const iStatus = COL.STATUS - 1;
    const iTicketId = COL.TICKET_ID - 1;

    let newToday = 0;
    let emergToday = 0;
    let openUrgent = [];
    let waitingTenant = [];

    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const ts = row[iTS] instanceof Date ? row[iTS] : null;
      if (!ts) continue;

      const ticketId = String(row[iTicketId] || "").trim();
      const prop = String(row[iProp] || "").trim();
      const unit = String(row[iUnit] || "").trim();
      const msg = String(row[iMsg] || "").trim();
      const emer = String(row[iEmer] || "").trim();       // "Yes"/"No"
      const urg = String(row[iUrg] || "").trim();         // "Urgent"/"Normal"
      const status = String(row[iStatus] || "").trim();   // "New"/"Waiting Tenant"/...

      const isToday = ts >= start;
      if (isToday) newToday++;

      if (isToday && emer.toLowerCase() === "yes") emergToday++;

      const isOpen = !/^(closed|completed)$/i.test(status);
      if (isOpen && urg === "Urgent") {
        openUrgent.push(formatLine_(ticketId, prop, unit, msg));
      }
      if (isOpen && /^waiting tenant$/i.test(status)) {
        waitingTenant.push(formatLine_(ticketId, prop, unit, msg));
      }
    }

    const lines = [];
    lines.push("Daily Maintenance Summary (" + Utilities.formatDate(now, tz, "MMM d") + ")");
    lines.push("New tickets today: " + newToday);
    lines.push("Emergencies today: " + emergToday);

    lines.push("");
    lines.push("Open Urgent (" + openUrgent.length + "):");
    lines.push(openUrgent.length ? openUrgent.slice(0, 6).join("\n") : "None");

    lines.push("");
    lines.push("Waiting Tenant (" + waitingTenant.length + "):");
    lines.push(waitingTenant.length ? waitingTenant.slice(0, 6).join("\n") : "None");

  const text = lines.join("\n");
  const ALT_SUPER_NUMBER = PropertiesService.getScriptProperties().getProperty("ALT_SUPER_NUMBER");


  const targets = [
    normalizePhone_(ONCALL_NUMBER),
    normalizePhone_(ALT_SUPER_NUMBER)
  ].filter(n => n && n.length >= 10);

  // Send to both (unique)
  const sent = {};
  targets.forEach(n => {
    if (!sent[n]) {
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, n, text);
      sent[n] = true;
    }
  });
  }

  function formatLine_(ticketId, prop, unit, msg) {
    const shortMsg = msg.length > 60 ? (msg.slice(0, 57) + "...") : msg;
    const u = unit ? ("Unit " + unit) : "Unit ?";
    const p = prop || "Property ?";
    const id = ticketId ? ticketId : "(no id)";
    return "• " + id + " | " + p + " | " + u + " | " + shortMsg;
  }


  function logInbound_(e) {
    return withWriteLock_("INBOUND_LOG_APPEND", () => {
      const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
      const sh = ss.getSheetByName("WebhookLog") || ss.insertSheet("WebhookLog");
      if (sh.getLastRow() === 0) {
        sh.appendRow(["Timestamp", "From", "To", "Body", "RawParamKeys", "RawJSON"]);
      }

      const p = (e && e.parameter) ? e.parameter : {};
      const keys = Object.keys(p).join(",");

      sh.appendRow([
        new Date(),
        p.From || "",
        p.To || "",
        p.Body || "",
        keys,
        safeJson_(p)
      ]);
    });
  }


  function logError_(err, e) {
    return withWriteLock_("ERROR_LOG_APPEND", () => {
      const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
      const sh = ss.getSheetByName("WebhookErrors") || ss.insertSheet("WebhookErrors");
      if (sh.getLastRow() === 0) {
        sh.appendRow(["Timestamp", "Error", "Stack", "From", "Body", "RawJSON"]);
      }

      const p = (e && e.parameter) ? e.parameter : {};
      sh.appendRow([
        new Date(),
        String(err),
        err && err.stack ? err.stack : "",
        p.From || "",
        p.Body || "",
        safeJson_(p)
      ]);
    });
  }

  function safeJson_(obj) {
    try { return JSON.stringify(obj); } catch (e) { return ""; }
  }


  function handleAppSheetWebhook(e) {
    const OK = ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    try {
      const raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : "";
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {}; }

      const phone = normalizePhone_(String(data.tenantPhone || data.to || ""));

      // Always log entry (DevSmsLog)
      try {
        logDevSms_(
          "(appsheet)",
          raw.slice(0, 120),
          "APPSHEET_WEBHOOK_IN action=[" + String(data.action || "") + "] row=[" + String(data.ticketRow || "") + "] tid=[" + String(data.ticketId || "") + "] phone=[" + phone + "]"
        );
      } catch (_) {}

      // ===== 1) DEDUPE: 30s per action+ticketId (avoid double fire; allow retry later) =====
      const ticketId = String(data.ticketId || "");
      const action = String(data.action || "");
      if (ticketId && action) {
        const key = "APPSHEET_" + action + "_" + ticketId;
        const cache = CacheService.getScriptCache();
        if (cache.get(key)) {
          try { logDevSms_("(appsheet)", "", "APPSHEET_WEBHOOK_OK"); } catch (_) {}
          return OK;
        }
        cache.put(key, "1", 30);
      }

      // ===== 2) LOG to a SHEET so you don't need "Executions" =====
      logWebhookRow_(raw, data);

      // ===== 3) Ownership engine dispatch =====
      if (data.action) {
        try {
          handleOwnershipActionFromAppSheet_(data);
        } catch (err) {
          try {
            logDevSms_(
              "(appsheet)",
              "",
              "APPSHEET_OWN_DISPATCH_ERR " + String(err && err.stack ? err.stack : err)
            );
          } catch (_) {}
        }
        try { logDevSms_("(appsheet)", "", "APPSHEET_WEBHOOK_OK"); } catch (_) {}
        return OK;
      }

      // ===== 4) Legacy: validate + send SMS =====
      if (!data.to && !phone) {
        try { logDevSms_("(appsheet)", "", "APPSHEET_WEBHOOK_OK"); } catch (_) {}
        return OK;
      }
      if (!data.message) {
        try { logDevSms_("(appsheet)", "", "APPSHEET_WEBHOOK_OK"); } catch (_) {}
        return OK;
      }

      const props = PropertiesService.getScriptProperties();
      sendSms_(
        props.getProperty("TWILIO_SID"),
        props.getProperty("TWILIO_TOKEN"),
        props.getProperty("TWILIO_NUMBER"),
        phone,
        String(data.message)
      );
      try { logDevSms_("(appsheet)", "", "APPSHEET_WEBHOOK_OK"); } catch (_) {}
      return OK;

    } catch (err) {
      try { logWebhookRow_("ERR", { error: String(err) }); } catch (e2) {}
      try { logDevSms_("(appsheet)", "", "APPSHEET_WEBHOOK_CRASH " + String(err && err.stack ? err.stack : err)); } catch (_) {}
      return OK;
    } finally {
      try { flushDevSmsLogs_(); } catch (_) {}
    }
  }

  // Creates a tab called "WebhookLog" and logs every webhook hit
  function logWebhookRow_(raw, data) {
    return withWriteLock_("WEBHOOK_LOG_APPEND", () => {
      const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
      let sh = ss.getSheetByName("WebhookLog");
      if (!sh) {
        sh = ss.insertSheet("WebhookLog");
        sh.appendRow(["TS", "ticketId", "to", "message", "raw"]);
      }
      sh.appendRow([
        new Date(),
        String(data.ticketId || ""),
        String(data.to || ""),
        String(data.message || ""),
        String(raw || "")
      ]);
    });
  }

  // ===================================================================
  // M9 — OWNERSHIP ENGINE (AppSheet webhook actions)
  // ===================================================================
  function getActionPolicy_(act) {
    var def = { tenantNotify: false, tenantTemplateKey: "", vendorNotify: false, vendorTemplateKey: "", setPendingStage: "" };
    try {
      var sh = getActiveSheetByNameCached_("ActionPolicy");
      if (!sh) return def;
      var r = findRowByValue_(sh, "Action", String(act || "").trim().toUpperCase());
      if (!r) return def;
      var map = getHeaderMap_(sh);
      var tenantNotify = false;
      var tenantTemplateKey = "";
      var vendorNotify = false;
      var vendorTemplateKey = "";
      var setPendingStage = "";
      var v = "";
      if (map["TenantNotify"]) { v = sh.getRange(r, map["TenantNotify"]).getValue(); tenantNotify = (v === true || String(v).toLowerCase() === "true" || String(v) === "1"); }
      if (map["TenantTemplateKey"]) tenantTemplateKey = String(sh.getRange(r, map["TenantTemplateKey"]).getValue() || "").trim();
      if (map["VendorNotify"]) { v = sh.getRange(r, map["VendorNotify"]).getValue(); vendorNotify = (v === true || String(v).toLowerCase() === "true" || String(v) === "1"); }
      if (map["VendorTemplateKey"]) vendorTemplateKey = String(sh.getRange(r, map["VendorTemplateKey"]).getValue() || "").trim();
      if (map["SetPendingStage"]) setPendingStage = String(sh.getRange(r, map["SetPendingStage"]).getValue() || "").trim();
      return { tenantNotify: tenantNotify, tenantTemplateKey: tenantTemplateKey, vendorNotify: vendorNotify, vendorTemplateKey: vendorTemplateKey, setPendingStage: setPendingStage };
    } catch (_) { return def; }
  }

  /** PropertyPolicy: propCode → property-specific → GLOBAL → fallback. Sheet: PropertyPolicy (Property, PolicyKey, Value, Type). */
  function ppGet_(propCode, key, fallback) {
    try {
      const p = String(propCode || "").trim().toUpperCase() || "GLOBAL";
      const k = String(key || "").trim().toUpperCase();
      const sh = getActiveSheetByNameCached_("PropertyPolicy");
      if (!sh) return fallback;

      const vals = sh.getDataRange().getValues();
      if (vals.length < 2) return fallback;

      const hdr = vals[0].map(function (x) { return String(x || "").trim(); });
      const colP = hdr.indexOf("Property");
      const colK = hdr.indexOf("PolicyKey");
      const colV = hdr.indexOf("Value");
      const colT = hdr.indexOf("Type");

      function coerce_(v, t) {
        const tt = String(t || "").trim().toUpperCase();
        if (tt === "BOOL" || tt === "BOOLEAN") return String(v).toUpperCase() === "TRUE";
        if (tt === "NUMBER") { const n = Number(v); return isFinite(n) ? n : fallback; }
        return (v === "" || v == null) ? fallback : v;
      }

      for (var i = 1; i < vals.length; i++) {
        var r = vals[i];
        if (String(r[colP] || "").trim().toUpperCase() === p && String(r[colK] || "").trim().toUpperCase() === k) {
          return coerce_(r[colV], r[colT]);
        }
      }
      for (var i = 1; i < vals.length; i++) {
        var r = vals[i];
        if (String(r[colP] || "").trim().toUpperCase() === "GLOBAL" && String(r[colK] || "").trim().toUpperCase() === k) {
          return coerce_(r[colV], r[colT]);
        }
      }
    } catch (_) {}
    return fallback;
  }

  /** One-time seed: add ASSIGN_DEFAULT_OWNER rows to PropertyPolicy. Run once from script editor. */
  /** One-time seeder: PropertyPolicy ASSIGN_DEFAULT_OWNER defaults (idempotent). Multi-tenant: populate PropertyPolicy/Staff/Vendors from your data; runtime uses sheets only. */
  function seedPropertyPolicyAssignDefaultOwner_() {
    try {
      var sh = getActiveSheetByNameCached_("PropertyPolicy");
      if (!sh) {
        try { Logger.log("seedPropertyPolicyAssignDefaultOwner_: PropertyPolicy sheet missing"); } catch (_) {}
        return;
      }

      var rowsToEnsure = [
        ["PENN",   "ASSIGN_DEFAULT_OWNER", "STAFF_NICK",  "TEXT"],
        ["WEST",   "ASSIGN_DEFAULT_OWNER", "STAFF_NICK",  "TEXT"],
        ["WGRA",   "ASSIGN_DEFAULT_OWNER", "STAFF_NICK",  "TEXT"],
        ["MORR",   "ASSIGN_DEFAULT_OWNER", "STAFF_GEFF",  "TEXT"],
        ["MURR",   "ASSIGN_DEFAULT_OWNER", "STAFF_GEFF",  "TEXT"],
        ["GLOBAL", "ASSIGN_DEFAULT_OWNER", "QUEUE_TRIAGE","TEXT"],
      ];

      var vals = sh.getDataRange().getValues();
      if (vals.length < 1) return;

      var hdr = vals[0].map(function (x) { return String(x || "").trim(); });
      var colP = hdr.indexOf("Property");
      var colK = hdr.indexOf("PolicyKey");
      var colV = hdr.indexOf("Value");
      var colT = hdr.indexOf("Type");
      if (colP < 0 || colK < 0 || colV < 0 || colT < 0) {
        try { Logger.log("seedPropertyPolicyAssignDefaultOwner_: missing required columns"); } catch (_) {}
        return;
      }

      var existing = {};
      for (var i = 1; i < vals.length; i++) {
        var p = String(vals[i][colP] || "").trim().toUpperCase();
        var k = String(vals[i][colK] || "").trim().toUpperCase();
        if (p && k) existing[p + "|" + k] = true;
      }

      var toAppend = [];
      for (var i = 0; i < rowsToEnsure.length; i++) {
        var p = String(rowsToEnsure[i][0]).toUpperCase();
        var k = String(rowsToEnsure[i][1]).toUpperCase();
        if (!existing[p + "|" + k]) toAppend.push(rowsToEnsure[i]);
      }

      if (toAppend.length) {
        withWriteLock_("PP_SEED_ASSIGN_DEFAULT_OWNER", function () {
          for (var j = 0; j < toAppend.length; j++) sh.appendRow(toAppend[j]);
        });
        try { Logger.log("seedPropertyPolicyAssignDefaultOwner_: appended " + toAppend.length + " rows"); } catch (_) {}
      } else {
        try { Logger.log("seedPropertyPolicyAssignDefaultOwner_: no-op (already seeded)"); } catch (_) {}
      }
    } catch (e) {
      try { Logger.log("seedPropertyPolicyAssignDefaultOwner_: err " + String(e && e.message ? e.message : e)); } catch (_) {}
    }
  }

  /** Validate schedule against PropertyPolicy. sched: { date?, startHour?, endHour? }. Returns {ok:true} or {ok:false, key, vars}. */
  function validateSchedPolicy_(propCode, sched, now) {
    var earliest = ppGet_(propCode, "SCHED_EARLIEST_HOUR", 9);
    var latest   = ppGet_(propCode, "SCHED_LATEST_HOUR", 18);
    var wkndOk   = !!ppGet_(propCode, "SCHED_ALLOW_WEEKENDS", false);
    var leadHrs  = ppGet_(propCode, "SCHED_MIN_LEAD_HOURS", 12);
    var maxDays  = ppGet_(propCode, "SCHED_MAX_DAYS_OUT", 14);

    var vars = { earliestHour: earliest, latestHour: latest, allowWeekends: wkndOk, minLeadHours: leadHrs, maxDaysOut: maxDays };

    var targetDate = (sched && sched.date) ? new Date(sched.date) : null;
    if (targetDate && !isNaN(targetDate.getTime())) {
      var day = targetDate.getDay();
      var isWknd = (day === 0 || day === 6);
      if (isWknd && !wkndOk) return { ok: false, key: "SCHED_REJECT_WEEKEND", vars: vars };

      var deltaMs = targetDate.getTime() - now.getTime();
      if (deltaMs < leadHrs * 3600 * 1000) return { ok: false, key: "SCHED_REJECT_TOO_SOON", vars: vars };
      if (deltaMs > maxDays * 86400 * 1000) return { ok: false, key: "SCHED_REJECT_TOO_FAR", vars: vars };
    }

    var hStart = (sched && isFinite(Number(sched.startHour))) ? Number(sched.startHour) : null;
    var hEnd   = (sched && isFinite(Number(sched.endHour))) ? Number(sched.endHour) : null;

    if (hStart != null && hStart < earliest) return { ok: false, key: "SCHED_REJECT_HOURS", vars: vars };
    if (hEnd != null && hEnd > latest) return { ok: false, key: "SCHED_REJECT_HOURS", vars: vars };

    return { ok: true };
  }

  function handleOwnershipActionFromAppSheet_(data) {
    var act = String(data.action || "").trim().toUpperCase();
    var ticketRow = Number(data.ticketRow || 0);
    var ticketId = String(data.ticketId || "").trim();
    var phone = normalizePhone_(String(data.tenantPhone || ""));

    try {
      logDevSms_("(appsheet)", "", "OWN_DISPATCH_ENTER act=[" + act + "] row=[" + ticketRow + "] tid=[" + ticketId + "] phone=[" + phone + "]");
    } catch (_) {}

    if (!ticketRow || ticketRow < 2) {
      try { logDevSms_("(appsheet)", "", "OWN_DISPATCH_BAD_ROW row=[" + ticketRow + "]"); } catch (_) {}
      return;
    }

    var wiId = "";
    try { wiId = findWorkItemIdByTicketRow_(ticketRow); } catch (_) { wiId = ""; }

    if (!wiId) {
      try { logDevSms_("(appsheet)", "", "OWN_DISPATCH_NO_WI row=[" + ticketRow + "] tid=[" + ticketId + "]"); } catch (_) {}
      return;
    }

    var wi = workItemGetById_(wiId);
    if (!wi) {
      try { logDevSms_("(appsheet)", "", "OWN_DISPATCH_WI_NOT_FOUND wi=[" + wiId + "]"); } catch (_) {}
      return;
    }

    // Build evt exactly how applyOwnershipAction_ expects it
    var evt = {
      action: act,
      ticketRow: ticketRow,
      ticketId: ticketId,
      tenantPhone: phone,
      actor: String(data.actor || ""),
      actorId: String(data.actorId || ""),
      note: String(data.note || ""),
      templateKey: String(data.templateKey || ""),
      templateVars: data.templateVars || {}
    };

    applyOwnershipAction_(wi, evt);

    try {
      logDevSms_("(appsheet)", "", "OWN_DISPATCH_OK wi=[" + wiId + "] act=[" + act + "]");
    } catch (_) {}
  }

  function applyOwnershipAction_(wi, evt) {
    const wiId = String(wi.workItemId || "").trim();
    const cur  = String(wi.state || "").trim().toUpperCase() || "STAFF_TRIAGE";
    const act  = String(evt.action || "").trim().toUpperCase();
    var phone = normalizePhone_(String(evt.tenantPhone || wi.phoneE164 || "").trim());
    var pol = getActionPolicy_(act);

    let didSend = false;

    // Metadata JSON safe parse
    let meta = {};
    try { meta = wi.metadataJson ? JSON.parse(String(wi.metadataJson)) : {}; } catch (_) { meta = {}; }

    // Append note if present
    if (evt.note) {
      const notes = Array.isArray(meta.notes) ? meta.notes : [];
      notes.push({ at: new Date().toISOString(), by: evt.actorId || evt.actor || "STAFF", text: String(evt.note).slice(0, 500) });
      meta.notes = notes;
    }

    let nextState = cur;
    let nextSub = "";

    if (act === "ADD_NOTE") {
      nextState = cur;
    } else if (act === "TRIAGE_INHOUSE") {
      nextState = "INHOUSE_WORK";
      meta.triageDecision = "INHOUSE";
      meta.ownerRole = "STAFF";
    } else if (act === "TRIAGE_VENDOR") {
      nextState = "VENDOR_DISPATCH";
      meta.triageDecision = "VENDOR";
      meta.ownerRole = "VENDOR";
    } else if (act === "REQUEST_TENANT_INFO") {
      nextState = "WAIT_TENANT";
      nextSub = "DETAIL";
      meta.ownerRole = "TENANT";
      meta.waitReason = "DETAIL";
    } else if (act === "REQUEST_SCHEDULE") {
      nextState = "WAIT_TENANT";
      nextSub = "SCHEDULE";
      meta.ownerRole = "TENANT";
      meta.waitReason = "SCHEDULE";
    } else if (act === "MARK_DONE") {
      nextState = "DONE";
      meta.ownerRole = "STAFF";
    } else {
      try { logDevSms_(phone || "(system)", "", "OWN_ACT_UNKNOWN act=[" + act + "] wi=[" + wiId + "]"); } catch (_) {}
      return;
    }

    const patch = {
      state: nextState,
      substate: nextSub,
      metadataJson: JSON.stringify(meta)
    };
    // Invariant: DONE must not remain OPEN
    if (nextState === "DONE") {
      patch.status = "COMPLETED";
    }

    const ok = workItemUpdate_(wiId, patch);

    if (!ok) {
      try { logDevSms_(phone || "(system)", "", "OWN_ACT_WRITE_FAIL wi=[" + wiId + "]"); } catch (_) {}
      return;
    }

    try { logDevSms_(phone || "(system)", "", "OWN_ACT_OK wi=[" + wiId + "] act=[" + act + "] cur=[" + cur + "] next=[" + nextState + "]"); } catch (_) {}

    // If waiting on tenant, force tenant routing + message
    if (nextState === "WAIT_TENANT" && phone) {
      try { wiSetWaitTenant_(phone, nextSub || "DETAIL"); } catch (_) {}
      try { ownerForceTenantStage_(phone, nextSub || "DETAIL", "OWN_WAIT_TENANT"); } catch (_) {}
      // Policy-gated tenant outbound for WAIT_TENANT
      const allowTenant = !!(pol && pol.tenantNotify);
      let k = String(evt.templateKey || "").trim();

      // If no explicit templateKey provided, use policy default
      if (!k && pol && pol.tenantTemplateKey) k = String(pol.tenantTemplateKey || "").trim();

      // Safe fallback ONLY if policy allows and sheet is missing key
      if (!k && allowTenant) {
        if (nextSub === "DETAIL" || act === "REQUEST_TENANT_INFO") k = "ASK_DETAIL_SIMPLE";
        else if (nextSub === "SCHEDULE" || act === "REQUEST_SCHEDULE") k = "ASK_WINDOW_SIMPLE";
      }

      if (!allowTenant) {
        try { logDevSms_(phone, "", "POLICY_DENY act=[" + act + "] tenantNotify=FALSE"); } catch (_) {}
      } else if (!k) {
        try { logDevSms_(phone, "", "POLICY_MISSING_KEY act=[" + act + "]"); } catch (_) {}
      } else {
        if (ownerSendTenantKey_(phone, k, evt.templateVars || {}, "OWN_WAIT_TENANT")) didSend = true;
        try { logDevSms_(phone, "", "POLICY_ALLOW act=[" + act + "] tenantKey=[" + k + "]"); } catch (_) {}
      }
    }

    if (nextState === "DONE" && phone) {
      const allowTenantDone = !!(pol && pol.tenantNotify);
      var doneKey = String(evt.templateKey || "").trim();
      if (!doneKey && pol && pol.tenantTemplateKey) doneKey = String(pol.tenantTemplateKey || "").trim();

      if (!allowTenantDone) {
        try { logDevSms_(phone, "", "POLICY_DENY act=[" + act + "] tenantNotify=FALSE"); } catch (_) {}
      } else if (doneKey) {
        if (ownerSendTenantKey_(phone, doneKey, evt.templateVars || {}, "OWN_DONE")) didSend = true;
      }
    }

    if (!didSend) {
      var reason = "NO_SEND_PATH";
      if (act === "TRIAGE_VENDOR" || act === "TRIAGE_INHOUSE") reason = "STATE_ONLY";
      else if (nextState === "WAIT_TENANT" && !phone) reason = "MISSING_PHONE";
      else if (nextState === "DONE" && (!phone || !evt.templateKey)) reason = "MISSING_PHONE_OR_TEMPLATEKEY";
      try {
        logDevSms_(phone || "(appsheet)", "", "OWN_NO_OUTBOUND wi=[" + wiId + "] act=[" + act + "] next=[" + nextState + "] sub=[" + nextSub + "] reason=[" + reason + "]");
      } catch (_) {}
    }
  }

  function ownerSendTenantKey_(phone, key, vars, tag) {
    const to = normalizePhone_(phone);
    const templateKey = String(key || "").trim();
    if (!to || !templateKey) {
      try {
        logDevSms_(String(to || "(none)"), "", "OWN_SEND_SKIPPED reason=[MISSING_TO_OR_TEMPLATEKEY] to=[" + String(to || "") + "] key=[" + String(templateKey || "") + "] tag=[" + String(tag || "") + "]");
      } catch (_) {}
      return false;
    }

    let lang = "en";
    try { const ctx = (typeof ctxGet_ === "function") ? ctxGet_(to) : null; if (ctx && ctx.lang) lang = String(ctx.lang); } catch (_) {}

    const msg = String(renderTenantKey_(templateKey, lang, vars || {}) || "").trim();
    if (!msg) {
      try {
        logDevSms_(String(to || "(none)"), "", "OWN_SEND_SKIPPED reason=[EMPTY_RENDER] key=[" + String(templateKey) + "] tag=[" + String(tag || "") + "]");
      } catch (_) {}
      return false;
    }

    try {
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, to, msg);
      try { logDevSms_(to, msg, "OUT_SMS tag=[" + String(tag || "OWNERSHIP") + "] len=" + msg.length); } catch (_) {}
      return true;
    } catch (e) {
      try { logDevSms_(to, "", "OWN_SEND_FAIL key=[" + templateKey + "] err=[" + String(e) + "]"); } catch (_) {}
      return false;
    }
  }

  function ownerForceTenantStage_(phone, stage, reason) {
    const p = normalizePhone_(phone);
    if (!p) return false;
    try {
      const dir = getSheet_(DIRECTORY_SHEET_NAME);
      const dirRow = ensureDirectoryRowForPhone_(dir, p);
      if (!dirRow || dirRow < 2) return false;

      dalSetPendingStage_(dir, dirRow, String(stage || ""), p, String(reason || "OWNER_FORCE_STAGE"));
      return true;
    } catch (e) {
      try { logDevSms_(p, "", "OWNER_FORCE_STAGE_FAIL stage=[" + stage + "] err=[" + String(e) + "]"); } catch (_) {}
      return false;
    }
  }

  /****************************
  * Ticket pipeline (Compass)
  ****************************/
  /****************************
  * Ticket pipeline (Compass)
  * ✅ Deterministic + crash-safe:
  * - processTicket_ ONLY writes Ticket sheet + (optionally) manager/oncall escalation
  * - NO tenant messaging, NO Directory mutations, NO lang/baseVars dependencies
  * - Adds PT_* markers to DevSmsLog so you always see where it dies
  ****************************/
  function processTicket_(sheet, props, creds, payload) {
    const { OPENAI_API_KEY, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER } = creds || {};

    const {
      from,
      tenantPhone,
      propertyName,
      propertyCode,
      unitFromText,
      messageRaw,
      createdByManager,
      inboundKey,
      parsedIssue,
      locationType,
      firstMediaUrl,
      // Optional, used for attachment naming only (Compass media signal)
      attachmentMediaFacts
      // welcomeLine intentionally ignored here (tenant messaging is handleSmsCore_ only)
    } = payload || {};

    // -----------------------------
    // PT markers (always visible in DevSmsLog)
    // -----------------------------
    try { logDevSms_(from, String(messageRaw || ""), "PT_00 ENTER inboundKey=" + String(inboundKey || "")); } catch (_) {}

    // ✅ Determine requesterPhone (tenant phone if manager created)
    let requesterPhone = from;

    const isMgr =
      createdByManager === true ||
      String(createdByManager).toLowerCase() === "true" ||
      String(createdByManager).toLowerCase() === "yes";

    if (isMgr) {
      const tp = normalizePhoneDigits_(tenantPhone || "");
      if (tp) {
        requesterPhone = tp;
      } else {
        const extracted = extractPhoneFromText_(messageRaw || "");
        const digits = normalizePhoneDigits_(extracted);
        if (digits) requesterPhone = digits;
      }
    }

    // Normalize requester phone to E.164 (+1XXXXXXXXXX)
    const reqDigits = normalizePhoneDigits_(requesterPhone);
    if (reqDigits) requesterPhone = "+1" + reqDigits;

    const now = new Date();
    const afterHours = isAfterHours_(now);

    // Small helper: only write a column if it exists + is numeric
    function colNum_(k) {
      const n = (COL && typeof COL[k] === "number") ? COL[k] : 0;
      return (n > 0) ? n : 0;
    }
    function setRowCol_(rowArr, k, val) {
      const c = colNum_(k);
      if (c) rowArr[c - 1] = val;
    }

    // ============================================================
    // 1) LOCKED: HARD DEDUPE + CREATE ROW (fast, atomic)
    // ============================================================
    try { logDevSms_(from, String(messageRaw || ""), "PT_10 BEFORE_CREATE_LOCK"); } catch (_) {}

    const createRes = withWriteLock_("TICKET_CREATE", () => {

      // HARD DEDUPE (inside lock)
      if (inboundKey) {
        const lastRow0 = sheet.getLastRow();
        const lookback = Math.min(120, Math.max(0, lastRow0 - 1));
        if (lookback > 0) {
          const start = lastRow0 - lookback + 1;
          const colThread = colNum_("THREAD_ID");
          if (colThread) {
            const keys = sheet.getRange(start, colThread, lookback, 1).getValues();
            for (let i = keys.length - 1; i >= 0; i--) {
              if (String(keys[i][0] || "").trim() === String(inboundKey).trim()) {
                const existingRow = start + i;
                const ticketIdCol = colNum_("TICKET_ID");
                const ticketKeyCol = colNum_("TICKET_KEY");
                const existingTicketId = ticketIdCol
                  ? String(sheet.getRange(existingRow, ticketIdCol).getValue() || "").trim()
                  : "";
                const existingTicketKey = ticketKeyCol
                  ? String(sheet.getRange(existingRow, ticketKeyCol).getValue() || "").trim()
                  : "";

                try {
                  logDevSms_(from, messageRaw,
                    "TICKET_DEDUPE inboundKey=" + inboundKey +
                    " row=" + existingRow +
                    " ticket=" + existingTicketId
                  );
                } catch (_) {}

                return { deduped: true, rowIndex: existingRow, ticketId: existingTicketId, ticketKey: existingTicketKey };
              }
            }
          }
        }
      }

      // CREATE (atomic under lock)
      const rowIndex = sheet.getLastRow() + 1;

      // Build row aligned to MAX_COL
      const newRow = Array(MAX_COL).fill("");

      // Core required: Portal stores tenant phone; STAFFCAP/SCAP keep PHONE empty (no tenant); SMS flow uses requesterPhone
      const isStaffcap = String(inboundKey || "").startsWith("STAFFCAP:");
      const isRealE164 = /^\+1\d{10}$/.test(String(requesterPhone || "").trim());
      const phoneVal = isStaffcap ? "" : (isMgr ? (isRealE164 ? requesterPhone : "") : requesterPhone);
      setRowCol_(newRow, "TS", now);
      setRowCol_(newRow, "PHONE", phoneVal);
      setRowCol_(newRow, "PROPERTY", propertyName || "");
      setRowCol_(newRow, "UNIT", unitFromText || "");
      setRowCol_(newRow, "MSG", messageRaw || "");

      // LocationType (UNIT vs COMMON_AREA) when caller has already classified it
      var locTypePayload = String(locationType || "").toUpperCase();
      if (locTypePayload === "UNIT" || locTypePayload === "COMMON_AREA") {
        setRowCol_(newRow, "LOCATION_TYPE", locTypePayload);
      }

      // Fast local category (never crashes if COL keys differ)
      const catLocal = localCategoryFromText_(messageRaw);
      const hasAuthoritativeCategoryCreate =
        String(inboundKey || "").indexOf("PORTAL_PM:") === 0 &&
        parsedIssue &&
        typeof parsedIssue.category === "string" &&
        parsedIssue.category.trim() &&
        parsedIssue.category.trim() !== "General" &&
        parsedIssue.category.trim() !== "Unknown";
      const catSeed = hasAuthoritativeCategoryCreate ? parsedIssue.category.trim() : (catLocal || "General");
      setRowCol_(newRow, "CAT", catSeed);

      // Optional: if you have CATEGORY_FINAL col
      setRowCol_(newRow, "CATEGORY_FINAL", catSeed);

      // Dedupe lineage
      setRowCol_(newRow, "THREAD_ID", inboundKey || "");

      // Defaults
      setRowCol_(newRow, "STATUS", "Open");
      setRowCol_(newRow, "REPLY_SENT", "No");
      setRowCol_(newRow, "ESCALATED", "No");
      setRowCol_(newRow, "LAST_UPDATE", now);
      setRowCol_(newRow, "CREATED_AT", now);

      // WorkType + createdByManager
      setRowCol_(newRow, "WORK_TYPE", "MAINTENANCE");
      setRowCol_(newRow, "CREATED_BY_MANAGER", isMgr ? "Yes" : "No");

      // Ticket ID + TicketKey: use propertyCode when present (Portal) so prefix is correct (e.g. PENN not WGRA)
      const propForId = String(propertyCode || propertyName || "").trim();
      const propIsKnown = !!propForId && propForId !== "(Unknown)";

      // ✅ Never allow PENN/WEST/etc if property is unknown
      const safeTicketId = propIsKnown
        ? makeTicketId_(propForId, now, rowIndex)
        : makeTicketId_("UNK", now, rowIndex); // forces UNK prefix (see note below)

      // Propera Compass — Drive-backed inbound attachment (Phase 1).
      // Only applied to firstMediaUrl for now; falls back safely to raw Twilio URL on any failure.
      if (firstMediaUrl && String(firstMediaUrl).trim()) {
        var attVal = "";
        try {
          var mf = attachmentMediaFacts || {};
          var unitForName = String(unitFromText || "").trim();
          var contextHint = "";
          try {
            if (!unitForName && mf && mf.issueHints) {
              contextHint = String(mf.issueHints.category || mf.issueHints.subcategory || "").trim();
            }
          } catch (_) {}
          var saveRes = (typeof saveInboundAttachmentToDrive_ === "function")
            ? saveInboundAttachmentToDrive_(String(firstMediaUrl).trim(), mf, {
                ticketId: safeTicketId || "UNFILED",
                unit: unitForName,
                contextHint: contextHint
              })
            : { ok: false, err: "no_helper" };
          if (saveRes && saveRes.ok && saveRes.webUrl) {
            attVal = String(saveRes.webUrl || "").trim();
          } else {
            attVal = String(firstMediaUrl).trim();
            try {
              if (typeof logDevSms_ === "function") {
                logDevSms_(from, "", "ATTACH_FALLBACK_TWILIO_URL reason=[" + String((saveRes && saveRes.err) || "unknown") + "]");
              }
            } catch (_) {}
          }
        } catch (_) {
          attVal = String(firstMediaUrl).trim();
          try {
            if (typeof logDevSms_ === "function") {
              logDevSms_(from, "", "ATTACH_FALLBACK_TWILIO_URL reason=[exception]");
            }
          } catch (_) {}
        }
        if (attVal) {
          setRowCol_(newRow, "ATTACHMENTS", attVal);
        }
      }

      setRowCol_(newRow, "TICKET_ID", safeTicketId);

      const ticketKey = Utilities.getUuid();
      setRowCol_(newRow, "TICKET_KEY", ticketKey);

      // One write
      sheet.getRange(rowIndex, 1, 1, MAX_COL).setValues([newRow]);

      try {
        logDevSms_(from, messageRaw,
          "TICKET_CREATE ok=1 row=" + rowIndex +
          " ticket=" + safeTicketId +
          " inboundKey=" + (inboundKey || "")
        );
      } catch (_) {}

      return { deduped: false, rowIndex: rowIndex, ticketId: safeTicketId, ticketKey: ticketKey };

    });

    try { logDevSms_(from, String(messageRaw || ""), "PT_11 AFTER_CREATE_LOCK"); } catch (_) {}

    if (!createRes) {
      try { logDevSms_(from, String(messageRaw || ""), "PT_12 CREATE_RES_MISSING"); } catch (_) {}
      return { ok: false, rowIndex: 0, ticketId: "", ticketKey: "", classification: null };
    }

    // If deduped, stop early (don’t re-classify or re-escalate)
    if (createRes.deduped) {
      try { logDevSms_(from, String(messageRaw || ""), "PT_13 DEDUP_RETURN"); } catch (_) {}
      return {
        ok: true,
        deduped: true,
        rowIndex: createRes.rowIndex || 0,
        ticketId: createRes.ticketId || "",
        ticketKey: createRes.ticketKey || "",
        classification: null
      };
    }

    const rowIndex = createRes.rowIndex;
    const ticketId = createRes.ticketId;
    const ticketKey = createRes.ticketKey || "";

    // ============================================================
    // 2) UNLOCKED: CLASSIFY (can be slow)
    // ============================================================
    try { logDevSms_(from, String(messageRaw || ""), "PT_20 BEFORE_CLASSIFY"); } catch (_) {}

    var useLLM = shouldRunLLMClassify_(parsedIssue);
    try { logDevSms_(from, "", "CLASSIFY_GATE use=" + (useLLM ? 1 : 0)); } catch (_) {}

    var classification;
    if (!useLLM) {
      // keep deterministic category already assigned
      var hard = hardEmergency_(messageRaw);
      if (hard && hard.emergency) {
        classification = hard;
      } else {
        var u = String(parsedIssue && parsedIssue.urgency ? parsedIssue.urgency : "normal").toLowerCase().trim();
        classification = {
          category: String(parsedIssue && parsedIssue.category ? parsedIssue.category : "General").trim(),
          emergency: false,
          emergencyType: "",
          confidence: 100,
          nextQuestions: [],
          urgency: (u === "urgent" || u === "high") ? "Urgent" : "Normal",
          urgencyReason: "",
          safetyNote: ""
        };
      }
    } else {
      classification = classify_(OPENAI_API_KEY, messageRaw, unitFromText, afterHours);
    }

    try { logDevSms_(from, String(messageRaw || ""), "PT_21 AFTER_CLASSIFY cat=" + String(classification && classification.category)); } catch (_) {}

    const hasAuthoritativeCategory =
      String(inboundKey || "").indexOf("PORTAL_PM:") === 0 &&
      parsedIssue &&
      typeof parsedIssue.category === "string" &&
      parsedIssue.category.trim() &&
      parsedIssue.category.trim() !== "General" &&
      parsedIssue.category.trim() !== "Unknown";

    const overrideCat = hasAuthoritativeCategory ? "" : detectCategoryOverride_(messageRaw);
    if (overrideCat && classification) classification.category = overrideCat;

    // ============================================================
    // 3) LOCKED: WRITE CLASSIFICATION + FLAGS (Ticket sheet only)
    // ============================================================
    try { logDevSms_(from, String(messageRaw || ""), "PT_30 BEFORE_POSTCLASSIFY_LOCK"); } catch (_) {}

    withWriteLock_("TICKET_POSTCLASSIFY", () => {
      // Batched: one read + one write for classification columns (same outcome, fewer round-trips)
      // getRange(row, column, numRows, numColumns) — use 1 row, not rowIndex rows
      const fullRow = sheet.getRange(rowIndex, 1, 1, MAX_COL).getValues()[0];
      if (!fullRow || fullRow.length < MAX_COL) return;
      function setCol_(k, val) {
        const c = colNum_(k);
        if (c && c <= fullRow.length) fullRow[c - 1] = val;
      }
      setCol_("CAT", classification.category || "");
      setCol_("EMER", classification.emergency ? "Yes" : "No");
      setCol_("EMER_TYPE", classification.emergencyType || "");
      setCol_("URG", classification.urgency || "Normal");
      setCol_("URG_REASON", classification.urgencyReason || "");
      setCol_("CONF", (typeof classification.confidence === "number") ? classification.confidence : "");
      setCol_("NEXT_Q", (classification.nextQuestions || []).join(" | "));
      var dueBy = (typeof computeDueBy_ === "function") ? computeDueBy_(now, classification) : null;
      if (dueBy) setCol_("DUE_BY", dueBy);
      setCol_("LAST_UPDATE", now);
      setCol_("REPLY_SENT", "No");
      sheet.getRange(rowIndex, 1, 1, MAX_COL).setValues([fullRow]);
    });

    try { logDevSms_(from, String(messageRaw || ""), "PT_31 AFTER_POSTCLASSIFY_LOCK"); } catch (_) {}

    // ============================================================
    // 4) Notify manager/oncall (non-tenant messaging allowed here)
    // ============================================================
    try { logDevSms_(from, String(messageRaw || ""), "PT_40 BEFORE_ESCALATION"); } catch (_) {}

    const summary =
      (classification.emergency ? "🚨 EMERGENCY" : (classification.urgency === "Urgent" ? "⚠️ URGENT" : "ℹ️ NEW")) + "\n" +
      "Ticket: " + (ticketId || "") + "\n" +
      "From: " + requesterPhone + "\n" +
      "Property: " + (propertyName || "(unknown)") + "\n" +
      "Unit: " + (unitFromText || "(unknown)") + "\n" +
      "Category: " + (classification.category || "Other") + "\n" +
      (classification.emergencyType ? ("Type: " + classification.emergencyType + "\n") : "") +
      (classification.urgencyReason ? ("UrgencyReason: " + classification.urgencyReason + "\n") : "") +
      "Msg: " + (messageRaw || "");

    const escCol = colNum_("ESCALATED");
    const alreadyEscalated = escCol
      ? (String(sheet.getRange(rowIndex, escCol).getValue() || "").toLowerCase() === "yes")
      : false;

    if (classification.emergency && ONCALL_NUMBER && !alreadyEscalated) {
      try { logDevSms_(from, "", "EMERGENCY_ALERT_CATEGORY source=[" + String(classification.category || "").trim() + "]"); } catch (_) {}
      placeCall_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER,
        "Emergency maintenance ticket. " +
        (propertyName ? ("Property " + propertyName + ". ") : "") +
        (unitFromText ? ("Unit " + unitFromText + ". ") : "") +
        (classification.emergencyType ? ("Type " + classification.emergencyType + ". ") : "") +
        "Please check the log."
      );
      try { logDevSms_(from, "", "EMERGENCY_ONCALL_CALL_SENT to=" + String(ONCALL_NUMBER || "").slice(-4)); } catch (_) {}
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER, summary);
      try { logDevSms_(from, "", "EMERGENCY_ONCALL_SMS_SENT to=" + String(ONCALL_NUMBER || "").slice(-4)); } catch (_) {}
      if (escCol) {
        withWriteLock_("TICKET_ESCALATE", () => {
          sheet.getRange(rowIndex, escCol).setValue("Yes");
        });
      }
    }

    if (!classification.emergency && classification.urgency === "Urgent" && ONCALL_NUMBER && !alreadyEscalated) {
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER, summary);
      if (escCol) {
        withWriteLock_("TICKET_ESCALATE", () => {
          sheet.getRange(rowIndex, escCol).setValue("Yes");
        });
      }
    }

    try { logDevSms_(from, String(messageRaw || ""), "PT_99 RETURN_OK"); } catch (_) {}

    // ✅ Return data ONLY. handleSmsCore_ decides what to send to tenant.
    return {
      ok: true,
      deduped: false,
      rowIndex: rowIndex,
      ticketId: ticketId,
      ticketKey: ticketKey,
      classification: classification
    };
  }


  /****************************
  * SMART EXTRACT (OpenAI)
  * Extract unit, property hint, and a clean issue summary
  *
  * Compass notes:
  * - Not tenant-facing → hardcoded prompt text is OK
  * - Property hints are dynamic (from Properties sheet) → new client = no code change
  * - Uses Script Property OPENAI_MODEL_EXTRACT if set
  ****************************/



  function smartExtract_(apiKey, rawMessage) {
    // If no key, fallback gracefully
    if (!apiKey) {
      return {
        unit: "",
        unitConfidence: 0,
        propertyHint: "",
        propertyConfidence: 0,
        issueSummary: "",
        issueConfidence: 0,
        confidence: 0
      };
    }

    const hints = getPropertyHintsForExtract_();
    const hintLine = hints.length
      ? ("  Return ONLY ONE of these PropertyCode values: " + hints.join(", ") + ".\n")
      : "  If no property is implied, return empty string.\n";

    const system =
      "You extract structured information from tenant SMS messages for property maintenance triage.\n" +
      "Return JSON ONLY. Do not include explanations or extra text.\n\n" +

      "Required JSON keys:\n" +
      "- unit (string)\n" +
      "- unitConfidence (number 0-100)\n" +
      "- propertyHint (string)\n" +
      "- propertyConfidence (number 0-100)\n" +
      "- issueSummary (string)\n" +
      "- issueConfidence (number 0-100)\n" +
      "- confidence (number 0-100)\n\n" +

      "Extraction rules:\n" +
      "- unit:\n" +
      "  Extract the apartment/unit identifier if present.\n" +
      "  Examples include: 'apt 312', 'apartment 312', 'unit 312', '#312', 'for 210', 'service for 210',\n" +
      "  'from 312', 'at 312', 'in 312', \"I'm in 312\", '3B', '402A'.\n" +
      "  Return ONLY the unit value (e.g., '312', '210', '3B', '402A').\n" +
      "  DO NOT return phone numbers, dollar amounts, dates, times (e.g., '24h'), or street/street-address numbers.\n" +
      "  unitConfidence should be HIGH only if the unit is explicitly stated (apt/unit/#) or very clearly implied.\n\n" +

      "- propertyHint:\n" +
      "  If the message implies or names a property, return a PropertyCode.\n" +
      hintLine +
      "  Examples: 'from MORRIS', 'at PENN'.\n" +
      "  If no property is implied, return an empty string.\n" +
      "  propertyConfidence should be HIGH only if the property is clearly stated.\n\n" +

      "- issueSummary:\n" +
      "  Rewrite the tenant’s problem into ONE short, clear maintenance sentence.\n" +
      "  Use professional, neutral wording.\n" +
      "  Examples: 'Kitchen sink is clogged', 'No heat in the apartment', 'Broken door', 'Water leaking under sink'.\n" +
      "  If the issue is unclear, return empty string and low issueConfidence.\n\n" +

      "- issueConfidence:\n" +
      "  90-100 if the issue is specific (e.g., 'sink clogged', 'broken door', 'no heat').\n" +
      "  40-70 if somewhat vague.\n" +
      "  0-30 if unknown.\n\n" +

      "- confidence:\n" +
      "  Overall confidence 0-100 about the combined extraction.\n" +
      "  A simple guideline: confidence should never be higher than the lowest of (unitConfidence, propertyConfidence, issueConfidence) unless the missing fields are intentionally empty.\n";

    const user = 'Message: "' + String(rawMessage || "") + '"';

    const modelName = (typeof props !== "undefined" && props && typeof props.getProperty === "function")
      ? (props.getProperty("OPENAI_MODEL_EXTRACT") || "gpt-4.1-mini")
      : "gpt-4.1-mini";

    var r = (typeof openaiChatJson_ === "function")
      ? openaiChatJson_({
          apiKey: apiKey,
          model: modelName,
          system: system,
          user: user,
          timeoutMs: 20000,
          phone: "",
          logLabel: "SMARTEXTRACT",
          maxRetries: 2
        })
      : { ok: false };
    var out = r.ok && r.json ? r.json : {};

    function num01(x) {
      const n = Number(x);
      if (!isFinite(n)) return 0;
      return Math.max(0, Math.min(100, n));
    }

    const unitRaw = String(out.unit || "").trim();
    const propRaw = String(out.propertyHint || "").trim();

    return {
      unit: (typeof normalizeUnit_ === "function") ? normalizeUnit_(unitRaw) : unitRaw,
      unitConfidence: num01(out.unitConfidence),
      propertyHint: propRaw ? propRaw.toUpperCase() : "",
      propertyConfidence: num01(out.propertyConfidence),
      issueSummary: String(out.issueSummary || "").trim(),
      issueConfidence: num01(out.issueConfidence),
      confidence: num01(out.confidence)
    };
  }



  /****************************
  * Property resolution helpers (Compass)
  * - No PROPERTIES constant
  * - Uses Properties sheet (getActiveProperties_)
  * - Returns BOTH: best match object + best name/code when needed
  ****************************/

  function getPropertyHintsForExtract_() {
    // Used by smartExtract_ prompt; keep as PropertyCode list (stable)
    try {
      const list = (typeof getActiveProperties_ === "function") ? getActiveProperties_() : [];
      return (list || [])
        .map(p => String(p && p.code ? p.code : "").trim().toUpperCase())
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  /**
  * Minimal check: does message look like a property menu answer?
  * Used by stage advance guard to avoid intercepting valid "1" / "The Grand at Penn" replies.
  */
  function looksLikePropertyAnswer_(s) {
    const t = String(s || "").trim().toLowerCase();
    if (!t) return false;
    if (/^\s*[1-5]\s*$/.test(t)) return true;
    if (typeof getActiveProperties_ === "function") {
      const pl = getActiveProperties_() || [];
      for (var i = 0; i < pl.length; i++) {
        const p = pl[i] || {};
        const variants = [].concat(p._variants || [], p.code, p.name, p.ticketPrefix).filter(Boolean).map(function (x) { return String(x).toLowerCase().trim(); });
        if (variants.some(function (v) { return v && t === v; })) return true;
      }
    }
    return false;
  }

  /**
  * Explicit-only property resolution for compileTurn_: exact code or exact full alias only.
  * No contains, no fuzzy. Prevents "morning" -> MORRIS etc.
  * Returns property object or null.
  */
  function resolvePropertyExplicitOnly_(text) {
    const propsList = (typeof getActiveProperties_ === "function") ? getActiveProperties_() : [];
    if (!propsList || !propsList.length) return null;
    const raw = String(text || "").trim();
    const t = (typeof normalizePropText_ === "function") ? normalizePropText_(raw) : raw.toLowerCase().replace(/\s+/g, " ").trim();
    if (!t) return null;
    for (let i = 0; i < propsList.length; i++) {
      const p = propsList[i];
      const codeNorm = (typeof normalizePropText_ === "function") ? normalizePropText_(String(p.code || "")) : String(p.code || "").toLowerCase().trim();
      if (codeNorm && t === codeNorm) return p;
      const variants = p._variants || (typeof buildPropertyVariants_ === "function" ? buildPropertyVariants_(p) : []);
      for (let v = 0; v < variants.length; v++) {
        const key = String(variants[v] || "").trim();
        if (!key) continue;
        const keyNorm = (typeof normalizePropText_ === "function") ? normalizePropText_(key) : key.toLowerCase().trim();
        if (keyNorm && t === keyNorm) return p;
      }
    }
    return null;
  }

  /**
  * Resolve a property from free text.
  * Returns: { propertyId, code, name, address } or null
  */
  function resolvePropertyFromText_(text, opts) {
    const strict = !!(opts && opts.strict);
    const propsList = (typeof getActiveProperties_ === "function") ? getActiveProperties_() : [];
    if (!propsList || !propsList.length) return null;

    const raw = String(text || "");
    const t = normalizePropText_(raw);
    if (!t) return null;

    // 1) Fast path (STRICT: token/phrase boundary; LOOSE: contains)
    for (let i = 0; i < propsList.length; i++) {
      const p = propsList[i];
      const variants = p._variants || buildPropertyVariants_(p);

      for (let v = 0; v < variants.length; v++) {
        const key = variants[v];
        if (!key) continue;

        if (t === key) return p;

        if (strict) {
          // match key as a whole phrase boundary inside t
          if (phraseInText_(t, key)) return p;
        } else {
          if (t.length >= 3 && t.includes(key)) return p;

          const tIsNumeric = /^\d+$/.test(t);
          if (!tIsNumeric && t.length >= 3 && key.includes(t)) return p;
        }
      }
    }

    // ✅ STRICT MODE: stop here if no confident match
  // For manager commands we do NOT allow fuzzy matching
  if (strict) return null;


    // 2) Fuzzy path: edit distance
    let best = null;
    let bestScore = 999;

    for (let i = 0; i < propsList.length; i++) {
      const p = propsList[i];
      const variants = p._variants || buildPropertyVariants_(p);

      for (let v = 0; v < variants.length; v++) {
        const key = variants[v];
        if (!key) continue;

        const d = levenshtein_(t, key);
        if (d < bestScore) {
          bestScore = d;
          best = p;
        }
      }
    }

    const len = t.length;
    const threshold = (len <= 4) ? 1 : (len <= 7) ? 2 : 3;
    if (best && bestScore <= threshold) return best;

    // 3) Token-based fuzzy (tight)
    const tokens = t.split(" ").filter(Boolean);
    if (tokens.length) {
      let best2 = null;
      let best2Score = 999;

      for (let i = 0; i < propsList.length; i++) {
        const p = propsList[i];
        const variants = p._variants || buildPropertyVariants_(p);

        for (let v = 0; v < variants.length; v++) {
          const keyTokens = variants[v].split(" ").filter(Boolean);
          for (let a = 0; a < tokens.length; a++) {
            for (let b = 0; b < keyTokens.length; b++) {
              const d = levenshtein_(tokens[a], keyTokens[b]);
              if (d < best2Score) {
                best2Score = d;
                best2 = p;
              }
            }
          }
        }
      }

      if (best2 && best2Score <= 1) return best2;
    }

    return null;
  }

  /**
  * Resolve a media-derived property hint to a known property object.
  * Uses existing strict resolution (exact/variant match from Properties); no hardcoded property names.
  * Returns { code, name }-shaped object or null.
  */
  function resolvePropertyHintToObj_(hint) {
    var raw = String(hint || "").trim();
    if (!raw) return null;
    if (typeof resolvePropertyFromText_ !== "function") return null;
    var p = resolvePropertyFromText_(raw, { strict: true });
    if (!p || !p.code) return null;
    return { code: String(p.code || "").trim(), name: String(p.name || "").trim() };
  }

  function phraseInText_(tNorm, keyNorm) {
    // Both inputs are already normalizePropText_ style (lowercase, spaces)
    // We want boundary match: " westfield " matches, but "field" doesn't.
    const t = " " + String(tNorm || "").trim() + " ";
    const k = " " + String(keyNorm || "").trim() + " ";
    return t.includes(k);
  }

  /**
  * Back-compat helper:
  * Old callers expect a property NAME string. Keep this wrapper.
  */
  function resolvePropertyNameFromText_(text) {
    const p = resolvePropertyFromText_(text);
    return p ? String(p.name || "").trim() : "";
  }

  /**
  * Back-compat helper:
  * Accepts property name OR code OR keyword-ish input and returns property object or null
  */
  function getPropertyByNameOrCode_(nameOrCode) {
    const propsList = (typeof getActiveProperties_ === "function") ? getActiveProperties_() : [];
    if (!propsList || !propsList.length) return null;

    const raw = String(nameOrCode || "").trim();
    if (!raw) return null;

    const n = normalizePropText_(raw);
    const up = String(raw || "").toUpperCase().replace(/\s+/g, "").trim();

    for (let i = 0; i < propsList.length; i++) {
      const p = propsList[i];
      if (!p) continue;

      if (String(p.code || "").toUpperCase().replace(/\s+/g, "") === up) return p;
      if (normalizePropText_(p.name || "") === n) return p;

      const variants = p._variants || buildPropertyVariants_(p);
      for (let v = 0; v < variants.length; v++) {
        if (normalizePropText_(variants[v]) === n) return p;
      }
    }

    return null;
  }


  /**
  * COMPAT SHIM — replaces old getPropertyByNameOrKeyword_
  * Returns the SAME shape callers expect, but sourced from Properties sheet
  */
  function getPropertyByNameOrKeyword_(nameOrCode) {
    // Delegate to Compass resolver
    return getPropertyByNameOrCode_(nameOrCode);
  }



  /****************************
  * Deterministic-first location type (UNIT vs COMMON_AREA)
  * Issue-location precedence: split into clauses, pick dominant issue clause, run location rules on that clause only.
  * Returns same shape as inferLocationType_ or null when ambiguous.
  ****************************/
  function inferLocationTypeDeterministic_(rawText) {
    var t = String(rawText || "").trim();
    if (!t) return null;

    var clauses = inferLocationTypeClauses_(t);
    if (!clauses || clauses.length === 0) return null;

    var dominant = inferLocationTypeDominantClause_(clauses);
    if (!dominant) return null;

    return inferLocationTypeOnClause_(dominant);
  }

  /** Split message into clauses (sentences / segments). Secondary context like "i also mention... gym" stays in its own clause. */
  function inferLocationTypeClauses_(text) {
    var s = String(text || "").trim();
    if (!s) return [];
    s = s.replace(/\s+/g, " ");
    var parts = s.split(/\s*[.!?]+\s*|\s+(?:also|and\s+also|i\s+also|plus|btw|by\s+the\s+way)\s+/i);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = String(parts[i] || "").trim();
      if (p.length >= 3) out.push(p);
    }
    return out;
  }

  /** Score clause by actionable maintenance-issue strength. Higher = more clearly the primary request. */
  function inferLocationTypeIssueScore_(clause) {
    var lower = clause.toLowerCase();
    var strong = [
      "leaking", "leak", "clogged", "broken", "not working", "stop working", "stopped working", "beeping", "no heat", "no ac", "flooded",
      "smells", "smell", "light out", "not cooling", "won't work", "doesn't work", "stuck", "overflowing",
      "backed up", "no water", "no hot water", "needs repair", "needs new", "battery", "is leaking", "are leaking"
    ];
    var score = 0;
    for (var i = 0; i < strong.length; i++) {
      if (lower.indexOf(strong[i]) >= 0) score += 2;
    }
    var weak = ["my sink", "my toilet", "my bathroom", "my kitchen", "my washer", "my dryer", "hallway", "gym", "lobby", "laundry"];
    for (var j = 0; j < weak.length; j++) {
      if (lower.indexOf(weak[j]) >= 0) score += 1;
    }
    return score;
  }

  /** Pick the clause that contains the dominant maintenance issue (highest score; tie = first). Single-clause: always use it so rule-based location (e.g. "my washer", "apt") can run. */
  function inferLocationTypeDominantClause_(clauses) {
    if (!clauses || clauses.length === 0) return null;
    if (clauses.length === 1) return clauses[0];
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < clauses.length; i++) {
      var score = inferLocationTypeIssueScore_(clauses[i]);
      if (score > bestScore) {
        bestScore = score;
        best = clauses[i];
      }
    }
    return bestScore > 0 ? best : null;
  }

  /** Run location-type keyword rules on a single clause only (no whole-message matching). */
  function inferLocationTypeOnClause_(clause) {
    var t = String(clause || "").trim();
    if (!t) return null;
    var lower = t.toLowerCase().replace(/\s+/g, " ");

    var commonSignals = [
      "hallway", "lobby", "stairwell", "stairs", "laundry room", "laundry area", "parking lot", "parking garage",
      "garage", "basement", "elevator", "entrance", "mail room", "mailroom", "trash room", "boiler room",
      "rooftop", "roof", "common area", "pool", "courtyard", "leasing office", "amenity room", "game room", "lounge",
      "vestibule", "third floor", "3rd floor", "shared space", "sidewalk", "crosswalk", "breezeway",
      "lobby smell", "hallway light", "gym smell", "laundry flooded"
    ];
    for (var c = 0; c < commonSignals.length; c++) {
      if (lower.indexOf(commonSignals[c]) >= 0) {
        return { ok: true, locationType: "COMMON_AREA", confidence: 0.88, reason: "explicit_common_area_keyword" };
      }
    }

    var unitPhrases = [
      "my sink", "my toilet", "my shower", "my bathroom", "my kitchen", "my bedroom", "my apartment", "my unit",
      "inside my apartment", "in my unit", "in apt ", "in unit ", "my ac", "my heat", "my window", "my lock",
      "my ceiling", "my wall", "my stove", "my fridge", "my dishwasher", "my smoke detector", "smoke detector is",
      "needs new battery", "my tub", "my heater", "my dryer", "my washer", "clogged", "beeping"
    ];
    for (var u = 0; u < unitPhrases.length; u++) {
      if (lower.indexOf(unitPhrases[u]) >= 0) {
        return { ok: true, locationType: "UNIT", confidence: 0.85, reason: "explicit_in_unit_phrase" };
      }
    }

    var hasUnitRef = /\b(apt|apartment|unit|#)\s*\d{1,5}\b/i.test(t) || /\b\d{1,5}\s*(apt|unit)\b/i.test(lower);
    var residentialIssue = /\b(smoke detector|battery|clogged|leak|leaking|toilet|sink|shower|fridge|stove|ac|heat|window|lock|beeping|broken|not working)\b/i.test(lower);
    if (hasUnitRef && residentialIssue) {
      return { ok: true, locationType: "UNIT", confidence: 0.75, reason: "unit_only_fallback" };
    }

    return null;
  }

  /****************************
  * LLM location type classifier (UNIT vs COMMON_AREA)
  * Deterministic-first: calls inferLocationTypeDeterministic_ then AI only when ambiguous.
  ****************************/
  function inferLocationType_(apiKey, rawText, phone) {
    const t = String(rawText || "").trim();

    var fast = (typeof inferLocationTypeDeterministic_ === "function") ? inferLocationTypeDeterministic_(t) : null;
    if (fast && fast.ok === true && fast.locationType && Number(fast.confidence) >= 0.70) {
      try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "LOC_TYPE_FAST decided=" + String(fast.locationType)); } catch (_) {}
      return fast;
    }

    const label = "LOC_TYPE";
    const scopedLabel = (function () {
      const digits = String(phone || "").replace(/\D/g, "").slice(-10);
      return digits ? (label + "_" + digits) : label;
    })();

    try {
      if (typeof openaiCooldownActive_ === "function" && openaiCooldownActive_(scopedLabel)) {
        return { ok: false, locationType: "UNIT", confidence: 0.0, reason: "cooldown" };
      }
    } catch (_) {}

    try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "LOC_TYPE_AI_FALLBACK"); } catch (_) {}

    const system = "You are a strict classifier for maintenance ticket location type.";
    const user =
      "Classify whether the maintenance issue described is inside a tenant's apartment/unit or in a building common area.\n" +
      "Return ONLY valid JSON with keys:\n" +
      '{ "locationType": "UNIT" or "COMMON_AREA", "confidence": number from 0 to 1, "reason": string }\n' +
      "Guidance:\n" +
      "- COMMON_AREA: gym, lobby, hallway, entrance, outside, parking, sidewalks, crosswalks, shared spaces.\n" +
      "- UNIT: inside an apartment (dishwasher, sink, toilet, heater in unit, etc.).\n" +
      "- If ambiguous, choose UNIT with confidence <= 0.69.\n\n" +
      "Text:\n" + t;

    const resp = openaiChatJson_({
      apiKey: apiKey,
      model: "gpt-4.1-mini",
      system: system,
      user: user,
      timeoutMs: 8000,
      phone: phone,
      logLabel: label,
      maxRetries: 2
    });

    if (!resp || !resp.ok || !resp.json) {
      try { if (typeof openaiSetCooldown_ === "function") openaiSetCooldown_(scopedLabel, 60); } catch (_) {}
      return { ok: false, locationType: "UNIT", confidence: 0.0, reason: "llm_fail" };
    }

    let lt = String(resp.json.locationType || "").trim().toUpperCase();
    let conf = Number(resp.json.confidence);
    if (!isFinite(conf)) conf = 0;

    if (lt !== "UNIT" && lt !== "COMMON_AREA") {
      return { ok: false, locationType: "UNIT", confidence: 0.0, reason: "bad_json" };
    }

    // Confidence gate
    if (conf < 0.70) {
      return { ok: true, locationType: "UNIT", confidence: conf, reason: "low_conf_" + String(resp.json.reason || "") };
    }

    return { ok: true, locationType: lt, confidence: conf, reason: String(resp.json.reason || "") };
  }

  // --------------------------------------------------
  // Location scope inference (broad+refined) for Ops
  // --------------------------------------------------
  function inferLocationScope_(signalOrText, opts) {
    opts = opts || {};
    var text = "";
    if (typeof signalOrText === "string") {
      text = String(signalOrText || "");
    } else if (signalOrText && typeof signalOrText === "object") {
      text = String(signalOrText.mergedBody || signalOrText.rawBody || "");
    }
    text = text || "";
    var lower = text.toLowerCase();

    var ai = opts.aiFallback || null;
    var broad = "UNKNOWN";
    var refined = "UNKNOWN";
    var source = "none";
    var conf = 0;
    var locationText = "";

    if (ai && ai.locationType) {
      var lt = String(ai.locationType || "").toUpperCase();
      if (lt === "UNIT" || lt === "COMMON_AREA") {
        broad = lt;
        refined = lt;
        conf = Number(ai.confidence || 0) || 0;
        source = "ai_fallback";
      }
    }

    function setRefined(val, src, minConf) {
      refined = val;
      source = src;
      locationText = text;
      if (conf < minConf) conf = minConf;
      if (broad === "UNKNOWN") broad = (val === "UNIT") ? "UNIT" : "COMMON_AREA";
    }

    if (/\b(garage|parking lot|parking garage|parking|driveway|entrance gate)\b/i.test(text)) {
      setRefined("PARKING", "text_rule", 0.85);
    } else if (/\b(gym|terrace|lounge|game room|amenity|pool|clubhouse)\b/i.test(text)) {
      setRefined("AMENITY", "text_rule", 0.85);
    } else if (/\b(utility room|boiler room|electrical room|mechanical room)\b/i.test(text)) {
      setRefined("UTILITY", "text_rule", 0.8);
    } else if (/\b(storage|locker)\b/i.test(text)) {
      setRefined("STORAGE", "text_rule", 0.8);
    } else if (/\b(outside|exterior|sidewalk|front entrance|rear entrance|courtyard|parking lot)\b/i.test(text)) {
      setRefined("EXTERIOR", "text_rule", 0.8);
    } else if (/\b(hallway|hall way|lobby|stairwell|stairs|common area)\b/i.test(text)) {
      setRefined("COMMON_AREA", "text_rule", 0.8);
    } else if (/\b(apartment|apt|unit|room)\b/i.test(text)) {
      setRefined("UNIT", "text_rule", 0.75);
    }

    // Ensure broad scope set when refined is UNIT/COMMON_AREA
    if (refined === "UNIT" && broad === "UNKNOWN") broad = "UNIT";
    if (refined === "COMMON_AREA" && broad === "UNKNOWN") broad = "COMMON_AREA";

    try {
      if (typeof logDevSms_ === "function") {
        logDevSms_("", (text || "").slice(0, 80),
          "LOCATION_SCOPE_INFERRED broad=[" + broad + "] refined=[" + refined + "] src=[" + source + "] conf=" + conf.toFixed(2));
      }
    } catch (_) {}

    return {
      locationScopeBroad: broad,
      locationScopeRefined: refined,
      locationText: locationText,
      locationSource: source,
      locationConfidence: conf,
      placeKey: ""
    };
  }

  /****************************
  * Unit extraction (local, improved)
  ****************************/
  function normalizeUnit_(u) {
    let s = String(u || "").trim();
    if (!s) return "";

    // remove common prefixes
    s = s.replace(/^(apt|apartment|departmento|apartamento|suite|ste|rm|room)\.?\s*[:#-]?\s*/i, "");

    // remove trailing punctuation
    s = s.replace(/[.,;:]$/g, "");

    return s.toUpperCase();
  }

  function extractUnit_(text) {
    const t = String(text || "");

    function accept_(u) {
      const num = String(u || "").trim();
      if (!/^\d{1,5}$/.test(num)) return "";
      if (isBlockedAsAddress_(t, num)) return ""; // ✅ Step 4
      if (/^20\d{2}$/.test(num)) return "";        // year
      if (/^\d{5}$/.test(num)) return "";          // zip
      return num;
    }

    // 1) explicit apt/unit patterns (best)
    let m = t.match(/\b(?:unit|apt|apartment|suite|ste|rm|room)\.?\s*[:#-]?\s*(\d{1,5})\b/i);
    if (m && m[1]) {
      const u = accept_(m[1]);
      if (u) return u;
    }

    // 2) hashtag: #302
    m = t.match(/#\s*(\d{1,5})\b/);
    if (m && m[1]) {
      const u = accept_(m[1]);
      if (u) return u;
    }

    // 3) "from/at/in/for 405" (unit-like phrasing)
    m = t.match(/\b(?:for|at|in|from)\s+(\d{1,5})\b/i);
    if (m && m[1]) {
      const u = accept_(m[1]);
      if (u) return u;
    }

    // 4) last-number fallback (useful for "Joana 310 Morris")
    const nums = t.match(/\b\d{2,5}\b/g) || [];
    for (let i = nums.length - 1; i >= 0; i--) {
      const u = accept_(nums[i]);
      if (u) return u;
    }

    return "";
  }


  // Helper: tokens that should never be treated as a unit
  function isBadUnitToken_(u) {
    const x = String(u || "").toUpperCase().trim();
    if (!x) return true;

    const bad = [
      "MY","ME","MINE","OUR","US","WE","HERE","THERE","THIS","THAT","THE","A","AN",
      "APT","UNIT","ROOM","SUITE","STE"
    ];

    if (bad.includes(x)) return true;

    if (/^(APARTMENT|APTO|APARTAMENTO|DEPARTMENTO)$/i.test(x)) return true;

    return false;
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

    // HVAC: make vent safe
    if (/(heat|heating|no heat|\bac\b|a\/c|air conditioner|air conditioning|cooling|no ac|thermostat|boiler|radiator|furnace|\bvent\b|hvac)/.test(t)) {
      return "HVAC";
    }

    // APPLIANCE
    if (/(washer|dryer|laundry|dishwasher|fridge|refrigerator|freezer|oven|stove|range|microwave|garbage disposal|disposal)/.test(t)) {
      return "Appliance";
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



  function sanitizeTenantText_(s) {
    let t = String(s || "");
    t = t.replace(/""/g, '"');
    t = t.replace(/\u2013|\u2014/g, "-");  // en/em dash -> hyphen
    t = t.replace(/\u2018|\u2019/g, "'");  // smart apostrophe -> '
    t = t.replace(/\u201C|\u201D/g, '"');  // smart quotes -> "
    t = t.replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }

  function shouldAppendCompliance_(key) {
    const k = String(key || "").toUpperCase().trim();
    const ALLOW = {
      // START
      "WELCOME": true,
      "CONFIRM_CONTEXT_NEEDS_CONFIRM": true,
      "SMS_START_CONFIRM": true,
      "SMS_STOP_CONFIRM": true,
      "SMS_HELP": true,

      // END
      "CONF_WINDOW_SET": true,
      "TICKET_CREATED_CONFIRM": true,
      "TICKET_CREATED_COMMON_AREA": true,
      "CLEANING_WORKITEM_ACK": true,
      "EMERGENCY_ACK_RECEIVED": true,
      "VISIT_CONFIRM_MULTI": true
    };
    return !!ALLOW[k];
  }

  // Optional: welcome header only on START keys (if you still want it)
  function shouldPrependWelcome_(key) {
    const k = String(key || "").toUpperCase().trim();
    const ALLOW = {
      "WELCOME": true,
      "CONFIRM_CONTEXT_NEEDS_CONFIRM": true
    };
    return !!ALLOW[k];
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
  /**
  * The ONLY place that is allowed to:
  * - render a template key
  * - prepend welcomeLine (optional + allowlisted)
  * - append compliance (START/END only)
  * - sanitize formatting
  * @param {string} key - Template key
  * @param {string} lang - Language code
  * @param {Object} vars - Placeholder vars
  * @param {Object} [opts] - Optional: { channel: "SMS"|"WA", deliveryPolicy: "DIRECT_SEND"|"NO_HEADER" }. When omitted, current behavior (welcome + compliance per allowlists).
  *   - channel "WA": do not append compliance footer (SMS-only).
  *   - deliveryPolicy "NO_HEADER": do not prepend welcome line.
  */
  function renderTenantKey_(key, lang, vars, opts) {
    const L = String(lang || "en").toLowerCase();
    const V = vars || {};
    const channel = (opts && opts.channel && String(opts.channel).toUpperCase() === "WA") ? "WA" : "SMS";
    const deliveryPolicy = (opts && opts.deliveryPolicy && String(opts.deliveryPolicy).trim() === "NO_HEADER") ? "NO_HEADER" : "DIRECT_SEND";

    let body = tenantMsgSafe_(key, L, V, "ERR_GENERIC_TRY_AGAIN");
    body = sanitizeTenantText_(body);

    // Prepend welcomeLine ONLY for allowlisted keys, when deliveryPolicy !== NO_HEADER, and welcomeLine non-empty.
    if (deliveryPolicy !== "NO_HEADER" && shouldPrependWelcome_(key)) {
      const wl = sanitizeTenantText_(String((V && V.__welcomeLine) || ""));
      if (wl) {
        if (!body.startsWith(wl)) {
          body = wl + "\n\n" + body;
        }
      }
    }

    // Compliance footer: SMS only; WA never gets footer (per Outgate expression map).
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
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, toPhone, msg);
    } catch (err) {
      try { logDevSms_(String(toPhone || ""), String(text || ""), "REPLY_GLOBAL_CRASH " + String(err && err.stack ? err.stack : err)); } catch (_) {}
    }
  }

  function replyNoHeaderGlobal_(toPhone, text) {
    try {
      const msg = String(text || "").trim();
      if (!msg) return;
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, toPhone, msg);
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

  /**
  * Writes outgoing SMS attempts to a sheet so you can SEE them even when logs are not clickable.
  * Creates a tab: DevSmsLog
  */
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
  var CHAOS_PHASES_CORE_ = CHAOS_PHASES_IO_.concat(["LANE", "TURN", "DRAFT", "STATE", "HANDLER"]);
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
      Logger.log("DEV MODE CALL → " + toNumber + ": " + messageToSay);
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
  * Directory / menu helpers (Compass shim)
  * Replaces legacy PROPERTIES / PROPERTY_ADDRESSES usage
  ****************************/

  function getPropertyByCode_(code) {
    const c = String(code || "").trim();
    if (!c) return null;

    const list = (typeof getActiveProperties_ === "function") ? getActiveProperties_() : [];
    const up = c.toUpperCase().replace(/\s+/g, "");

    for (let i = 0; i < (list || []).length; i++) {
      const p = list[i];
      if (!p) continue;
      const pc = String(p.code || "").toUpperCase().replace(/\s+/g, "");
      if (pc === up) return p;
    }
    return null;
  }

  function detectPropertyFromBody_(body) {
    const propsList = (typeof getActiveProperties_ === "function") ? getActiveProperties_() : [];
    if (!propsList || !propsList.length) return null;

    const raw = String(body || "");
    const t = normalizePropText_(raw);
    if (!t) return null;

    const tokens = t.split(" ").filter(Boolean);

    // 1) Menu digit explicit (standalone)
    const digit = tokens.find(x => /^[1-5]$/.test(x));
    if (digit) {
      const idx = parseInt(digit, 10) - 1;
      if (idx >= 0 && idx < propsList.length) {
        const p = propsList[idx];
        return { code: String(p.code || "").trim(), name: String(p.name || "").trim() };
      }
    }

    // 2) Explicit code match (very safe)
    const compact = t.replace(/\s+/g, "");
    for (const p of propsList) {
      const code = String(p.code || "").toLowerCase().replace(/\s+/g, "");
      const ticketPrefix = String(p.ticketPrefix || "").toLowerCase().replace(/\s+/g, "");
      if (code && (compact === code || compact.includes(code))) {
        return { code: String(p.code || "").trim(), name: String(p.name || "").trim() };
      }
      if (ticketPrefix && (compact === ticketPrefix || compact.includes(ticketPrefix))) {
        return { code: String(p.code || "").trim(), name: String(p.name || "").trim() };
      }
    }

    // 3) Strong variant/name contains (but require a strong token, NOT stopwords)
    const STOP = { "the":1, "grand":1, "at":1, "apt":1, "apartment":1, "unit":1 };

    for (const p of propsList) {
      const variants = []
        .concat(p._variants || buildPropertyVariants_(p))
        .concat([p.name])
        .filter(Boolean)
        .map(x => normalizePropText_(String(x)));

      for (const key of variants) {
        if (!key) continue;

        // exact match
        if (t === key) {
          return { code: String(p.code || "").trim(), name: String(p.name || "").trim() };
        }

        // contains match ONLY if strong token overlap exists
        const keyTokens = key.split(" ").filter(Boolean);
        let strongHit = false;
        for (const kt of keyTokens) {
          if (STOP[kt]) continue;
          if (kt.length >= 4 && t.includes(kt)) { strongHit = true; break; }
        }
        if (strongHit) {
          return { code: String(p.code || "").trim(), name: String(p.name || "").trim() };
        }
      }
    }

    return null;
  }


  function detectPropertyFromAddress_(text) {
    // Legacy callers expect: property name string or ""
    const p = resolvePropertyFromText_(String(text || ""));
    return p ? String(p.name || "").trim() : "";
  }



  /****************************
  * Generic helpers
  ****************************/

  // Vendor messaging (template-key only, GSM-7 safe by template discipline)
  function vendorMsg_(key, lang, vars) {
    // Reuse your Templates sheet + renderer (same as tenantMsg_ backing store)
    // Keep vendor content ASCII/GSM-7 in the template bodies.
    return tenantMsg_(String(key || ""), String(lang || "en").toLowerCase(), vars || {});
  }

  /**
  * Build vendor dispatch SMS body via template VENDOR_DISPATCH_REQUEST only.
  * GSM-7 safe: cleans placeholders (no em dash, smart quotes, etc.).
  * Does not add template row to any file; template must exist on Templates sheet.
  */
  function buildVendorDispatchMsg_(lang, data) {
    var safeLang = String(lang || "en").toLowerCase();
    function clean_(s) {
      s = String(s || "");
      s = s.replace(/[""]/g, '"')
          .replace(/['']/g, "'")
          .replace(/[–—]/g, "-")
          .replace(/…/g, "...")
          .replace(/\t/g, " ");
      return s;
    }
    var payload = {
      propertyName: clean_(data.propertyName),
      unit: clean_(data.unit),
      category: clean_(data.category),
      issue: clean_(data.issue),
      exampleWindow: clean_(data.exampleWindow || "Tomorrow 8-10am"),
      exampleReason: clean_(data.exampleReason || "Too busy")
    };
    return renderTenantKey_("VENDOR_DISPATCH_REQUEST", safeLang, payload);
  }

  function replyVendorKey_(creds, toPhone, key, lang, vars) {
    replyVendor_(creds, toPhone, vendorMsg_(key, lang, vars));
  }


  function findDirRowByPhone_(dirSheet, phone) {
    const p10 = String(normalizePhoneDigits_(phone) || "").slice(-10);
    if (!p10) return 0;

    const lastRow = dirSheet.getLastRow();
    if (lastRow < 2) return 0;

    const vals = dirSheet.getRange(2, DIR_COL.PHONE, lastRow - 1, 1).getValues();
    for (let i = 0; i < vals.length; i++) {
      const d10 = String(normalizePhoneDigits_(vals[i][0] || "") || "").slice(-10);
      if (d10 && d10 === p10) return i + 2;
    }
    return 0;
  }

  function findNextQueuedTicketRow_(sheet, tenantPhone) {
    const p10 = String(normalizePhoneDigits_(tenantPhone) || "").slice(-10);
    if (!p10) return 0;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;

    // Pull only needed cols: Phone, Status, CreatedAt
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

    let bestRow = 0;
    let bestTs = null;

    for (let i = 0; i < data.length; i++) {
      const r = i + 2;

      const r10 = String(normalizePhoneDigits_(data[i][COL.PHONE - 1] || "") || "").slice(-10);
      if (r10 !== p10) continue;

      const status = String(data[i][COL.STATUS - 1] || "").trim().toLowerCase();
      if (status !== "queued") continue;

      const created = data[i][COL.CREATED_AT - 1] || data[i][COL.TIMESTAMP - 1] || null;
      const createdMs = created instanceof Date ? created.getTime() : (created ? new Date(created).getTime() : null);

      if (!bestRow) {
        bestRow = r;
        bestTs = createdMs;
        continue;
      }

      if (createdMs != null && (bestTs == null || createdMs < bestTs)) {
        bestRow = r;
        bestTs = createdMs;
      }
    }

    return bestRow;
  }

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║  CHANGE 6 (v2): advanceTenantQueueOrClear_                         ║
  // ║  Replaces old advanceTenantQueueIfAny_.                            ║
  // ║                                                                     ║
  // ║  Compass-safe pattern:                                              ║
  // ║    LOCK  → claim queued ticket + update directory (atomic)          ║
  // ║    UNLOCK → WorkItem + ctx updates (use their own internal locks)   ║
  // ║    UNLOCK → SMS side effect (never under lock)                      ║
  // ║                                                                     ║
  // ║  FIX 1: Builds fresh baseVars from BRAND (not stale caller vars)   ║
  // ║  FIX 2: Atomic clear-old + claim-new (no gap for races)            ║
  // ║  FIX 4: Single lock scope for all state mutations                   ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  function advanceTenantQueueOrClear_(sheet, dir, dirRow, tenantPhone, lang) {
    const phone = phoneKey_(tenantPhone);
    if (!phone || !dirRow || dirRow < 2) {
      // Fallback: at minimum clear stale directory + ctx (no tenant SMS here)
      try { dalSetPendingStage_(dir, dirRow, "", phone, "QUEUE_OR_CLEAR_FALLBACK"); } catch (_) {}
      try {
        ctxUpsert_(phone, {
          pendingWorkItemId: "",
          pendingExpected: "",
          pendingExpiresAt: "",
          activeWorkItemId: ""
        }, "QUEUE_OR_CLEAR_FALLBACK");
      } catch (_) {}
      return null;
    }

    // ── READ (no lock needed): find next queued ticket ──
    const nextRow = findNextQueuedTicketRow_(sheet, tenantPhone);

    // ── LOCK: atomic state transition (sheet + Directory in one lock; dir uses NoLock setters + one LastUpdated + one log) ──
    const claimed = dalWithLock_("QUEUE_ADVANCE_OR_CLEAR", function () {
      const now = new Date();

      if (!nextRow) {
        dalSetPendingIssueNoLock_(dir, dirRow, "");
        dalSetPendingStageNoLock_(dir, dirRow, "");
        dalSetPendingRowNoLock_(dir, dirRow, "");
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(tenantPhone || "", "", "DAL_WRITE QUEUE_ADVANCE_OR_CLEAR row=" + dirRow); } catch (_) {}
        return null;
      }

      const currentStatus = String(sheet.getRange(nextRow, COL.STATUS).getValue() || "").trim().toLowerCase();
      if (currentStatus !== "queued") {
        dalSetPendingIssueNoLock_(dir, dirRow, "");
        dalSetPendingStageNoLock_(dir, dirRow, "");
        dalSetPendingRowNoLock_(dir, dirRow, "");
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(tenantPhone || "", "", "DAL_WRITE QUEUE_ADVANCE_OR_CLEAR row=" + dirRow); } catch (_) {}
        return null;
      }

      sheet.getRange(nextRow, COL.STATUS).setValue("In Progress");
      sheet.getRange(nextRow, COL.LAST_UPDATE).setValue(now);

      dalSetPendingRowNoLock_(dir, dirRow, nextRow);
      dalSetPendingStageNoLock_(dir, dirRow, "SCHEDULE");
      dalSetPendingIssueNoLock_(dir, dirRow, "");
      dalSetLastUpdatedNoLock_(dir, dirRow);
      try { logDevSms_(tenantPhone || "", "", "DAL_WRITE QUEUE_ADVANCE_OR_CLEAR row=" + dirRow); } catch (_) {}

      return {
        nextRow: nextRow,
        ticketId: String(sheet.getRange(nextRow, COL.TICKET_ID).getValue() || "").trim()
      };
    });

    // ── UNLOCKED: clear old ctx always (safe reset) ──
    try {
      ctxUpsert_(phone, {
        pendingWorkItemId: "",
        pendingExpected: "",
        pendingExpiresAt: "",
        activeWorkItemId: ""
      }, "QUEUE_OR_CLEAR_CTX_RESET");
    } catch (_) {}

    if (!claimed) {
      try { logDevSms_(phone, "", "QUEUE_DRAIN_NONE"); } catch (_) {}
      return null;
    }

    // ── UNLOCKED: find WorkItem for claimed ticket + set state ──
    let nextWi = "";
    try {
      const wiSh = SpreadsheetApp.getActive().getSheetByName(WORKITEMS_SHEET);
      if (wiSh) {
        const wiLastRow = wiSh.getLastRow();
        if (wiLastRow >= 2) {
          const wiData = wiSh.getRange(2, 1, wiLastRow - 1, wiSh.getLastColumn()).getValues();
          const wiMap = getHeaderMap_(wiSh);

          for (let i = 0; i < wiData.length; i++) {
            const tr = Number(wiData[i][(wiMap["TicketRow"] || 9) - 1]);
            if (tr === claimed.nextRow) {
              nextWi = String(wiData[i][(wiMap["WorkItemId"] || 1) - 1] || "").trim();
              try { workItemUpdate_(nextWi, { state: "WAIT_TENANT", substate: "SCHEDULE" }); } catch (_) {}
              break;
            }
          }
        }
      }
    } catch (_) {}

    // ── UNLOCKED: set ctx expectation for SCHEDULE ──
    try {
      ctxUpsert_(phone, {
        activeWorkItemId: nextWi,
        pendingWorkItemId: nextWi,
        pendingExpected: "SCHEDULE",
        pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
        lastIntent: "MAINT"
      }, "QUEUE_ADVANCE_CTX");
    } catch (_) {}

    // ── UNLOCKED: tenant SMS (TEMPLATE ONLY, no hardcoded tenant strings) ──
    try {
      const freshVars = { brandName: BRAND.name, teamName: BRAND.team };

      const dayWord = scheduleDayWord_(new Date());
      const dayLine = dayWord
        ? ("\n" + renderTenantKey_("ASK_WINDOW_DAYLINE_HINT", lang, Object.assign({}, freshVars, { dayWord: dayWord })))
        : "";

      const out = renderTenantKey_("QUEUE_NEXT_TICKET_SCHEDULE_PROMPT", lang, Object.assign({}, freshVars, {
        dayLine: dayLine
      }));

      replyNoHeaderGlobal_(phone, out);

      try { logDevSms_(phone, "", "QUEUE_DRAIN_ADVANCED row=[" + claimed.nextRow + "] tid=[" + claimed.ticketId + "]"); } catch (_) {}
    } catch (smsErr) {
      try { logDevSms_(phone, "", "QUEUE_ADVANCE_SMS_ERR " + (smsErr && smsErr.message ? smsErr.message : smsErr)); } catch (_) {}
    }

    return claimed;
  }

  // Legacy wrapper (safety net)
  function advanceTenantQueueIfAny_(sheet, dir, dirRow, tenantPhone, lang, baseVars) {
    return !!advanceTenantQueueOrClear_(sheet, dir, dirRow, tenantPhone, lang);
  }




  function isEmergencyRow_(sheet, row) {
    if (!row || row < 2) return false;
    const v = sheet.getRange(row, COL.EMER).getValue();
    const s = String(v || "").trim().toLowerCase();
    return v === true || s === "yes" || s === "y" || s === "true" || s === "1";
  }

  /**
  * Durable-first emergency continuation check. Priority: 1) Directory.PendingStage,
  * 2) Ticket row EMER, 3) WorkItem substate, 4) ctx.flowMode.
  * Returns { isEmergency: boolean, source: string } for resolver/recompute.
  */
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

  function isEmergencyLatched_(sheet, row, ctx) {
    try {
      if (ctx && String(ctx.flowMode || "").toUpperCase() === "EMERGENCY") return true;
    } catch (_) {}
    return isEmergencyRow_(sheet, row);
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

  function looksLikeEmergencyText_(text) {
    return !!detectEmergencyKind_(text);
  }


  function isEmergencyContext_(sheet, row) {
    if (isEmergencyRow_(sheet, row)) return true;
    const msg = String(sheet.getRange(row, COL.MSG).getValue() || "");
    return looksLikeEmergencyText_(msg);
  }

  // Helper: read Ticket ID (use COL, not hardcoded P)
  function ticketIdFromRow_(sheet, row) {
    try {
      return String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim();
    } catch (_) {
      return "";
    }
  }

  // Helper: what to do when emergency is complete enough (prop+unit+issue)
  function finishEmergencyIfReady_(sheet, dir, dirRow, row, lang) {
    const hasProp = String(sheet.getRange(row, COL.PROPERTY).getValue() || "").trim();
    const hasUnit = String(sheet.getRange(row, COL.UNIT).getValue() || "").trim();
    const hasMsg  = String(sheet.getRange(row, COL.MSG).getValue() || "").trim();

    if (hasProp && hasUnit && hasMsg) {
      const tid = ticketIdFromRow_(sheet, row);
      var finishPhone = String(sheet.getRange(row, COL.PHONE).getValue() || "").trim();
      try { dalSetPendingStage_(dir, dirRow, "", finishPhone, "finishEmergencyIfReady_"); } catch (_) {}
      setStatus_(sheet, row, "In Progress");

      if (tid) {
        var _ogE = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED_WITH_TICKET", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, { ticketId: tid }), meta: { source: "finishEmergencyIfReady_", stage: "EMERGENCY_DONE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogE && _ogE.ok)) reply_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED_WITH_TID", lang, { ...baseVars, ticketId: tid }));
      } else {
        var _ogE2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "finishEmergencyIfReady_", stage: "EMERGENCY_DONE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogE2 && _ogE2.ok)) reply_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED", lang, baseVars));
      }
      return true;
    }
    return false;
  }


  function inferStageDayFromText_(text, fallbackDayWord) {
    const s = String(text || "").toLowerCase();

    if (/\b(tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr)\b/.test(s)) return "Tomorrow";
    if (/\btoday\b/.test(s)) return "Today";

    // If user says a weekday or a date, your parseDayTarget_ will handle it.
    // We only need a fallback anchor when they say ONLY "9-11" with no day.
    const fb = String(fallbackDayWord || "").toLowerCase();
    if (/tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr/.test(fb)) return "Tomorrow";
    return "Today";
  }



  /**
  * Normalize to digits only (10-digit US expected).
  * Returns "" if no digits.
  */
  function normalizePhoneDigits_(s) {
    const d = String(s || "").replace(/\D+/g, "");
    // If it includes country code 1 + 10 digits, keep last 10
    if (d.length === 11 && d[0] === "1") return d.slice(1);
    // If already 10 digits, return as-is
    if (d.length === 10) return d;
    // If longer, keep last 10 (common when prefixed with country/extra)
    if (d.length > 10) return d.slice(-10);
    return d; // could be short; caller decides
  }


  function replyAskPropertyMenu_(lang, baseVars, opts) {
    const o = opts || {};
    const vars = baseVars || {};
    const menu = String(buildPropertyMenuLines_() || "").trim();

    // Always provide something (never blank)
    const propertyMenu = menu
      ? ("\n" + menu + "\n")
      : "\nReply with your property name (example: Penn).\n";

    const unitLine = (vars && vars.unit)
      ? ("We got your unit: " + vars.unit + ".\n")
      : "";

    // Must use renderTenantKey_ (per your rule)
    const menuMsg = renderTenantKey_("ASK_PROPERTY_MENU", lang, Object.assign({}, vars, {
      propertyMenu: propertyMenu,
      unitLine: unitLine
    }));

    let prefix = "";
    try {
      if (o.prefixKey) prefix = String(renderTenantKey_(String(o.prefixKey), lang, baseVars || {}) || "").trim();
    } catch (_) {}

    if (prefix) return prefix + "\n\n" + menuMsg;
    return menuMsg;
  }

  function enqueueAiQForTicketCreate_(ticketRow, payload, src) {
    const r = Number(ticketRow) || 0;
    if (r < 2) return;

    const P = payload || {};
    const source = String(src || "unknown");

    // Idempotency key: ticket row is stable and unique
    const dedupeKey = "TROW:" + String(r);

    // Write-lock protected
    withWriteLock_("AIQ_ENQUEUE_" + source, () => {
      const ss = SpreadsheetApp.getActive();
      const q = ss.getSheetByName("AIQueue");
      if (!q) throw new Error('Missing sheet "AIQueue"');

      // If already enqueued, exit cleanly
      if (aiqHasKey_(q, dedupeKey)) return;

      // Minimal row format (adjust columns if you already have a schema)
      // [CreatedAt, Status, DedupeKey, TicketRow, PhoneE164, PropertyCode, PropertyName, IssueText, Source, TicketKey]
      q.appendRow([
        new Date(),
        "NEW",
        dedupeKey,
        r,
        String(P.phoneE164 || ""),
        String(P.propertyCode || ""),
        String(P.propertyName || ""),
        String(P.issueText || ""),
        source,
        String(P.ticketKey || "")
      ]);
    });

    try { logDevSms_(String(P.phoneE164 || ""), String(P.issueText || ""), "AIQ_ENQUEUE ok=1 trow=" + String(ticketRow) + " src=" + source); } catch (_) {}
  }

  function aiqHasKey_(qSheet, dedupeKey) {
    const key = String(dedupeKey || "").trim();
    if (!key) return false;

    // Simple scan of the DedupeKey column (3rd col in the appendRow above).
    // If your AIQueue schema differs, change colIndex to match.
    const colIndex = 3;
    const last = qSheet.getLastRow();
    if (last < 2) return false;

    const values = qSheet.getRange(2, colIndex, last - 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0] || "").trim() === key) return true;
    }
    return false;
  }

  // ⛔ DEPRECATED — no longer called. Replaced by finalizeDraftAndCreateTicket_().
  // Remove after one stable deploy cycle.
  function createTicketFromPendingIssue_(sheet, ctx) {
    const now = new Date();
    const phone = String(ctx.phone || "").trim();
    const propertyName = String(ctx.propertyName || "").trim();
    const issueText = String(ctx.issueText || "").trim();
    const ticketKey = String(ctx.inboundKey || ctx.ticketKey || "").trim() || ("PHONE:" + phone + "|TS:" + now.getTime());

    // Guard required COLs (prevents (number,null) getRange crashes)
    const requiredCols = ["TS","PHONE","PROPERTY","UNIT","MSG","TICKET_ID","STATUS","CREATED_AT","LAST_UPDATE","TICKET_KEY"];
    for (const k of requiredCols) {
      const v = COL[k];
      if (!v || typeof v !== "number") {
        throw new Error("createTicketFromPendingIssue_: COL." + k + " is invalid: " + v);
      }
    }

    const row = sheet.getLastRow() + 1;

    sheet.getRange(row, COL.TS).setValue(now);
    sheet.getRange(row, COL.PHONE).setValue(phone);
    sheet.getRange(row, COL.PROPERTY).setValue(propertyName);
    sheet.getRange(row, COL.UNIT).setValue("");
    sheet.getRange(row, COL.MSG).setValue(issueText);

    sheet.getRange(row, COL.TICKET_ID).setValue("UNK-" + fmtDateYYYYMMDD_(now) + "-" + String(row).padStart(4, "0"));
    sheet.getRange(row, COL.STATUS).setValue("In Progress");
    sheet.getRange(row, COL.CREATED_AT).setValue(now);
    sheet.getRange(row, COL.LAST_UPDATE).setValue(now);

    sheet.getRange(row, COL.TICKET_KEY).setValue(ticketKey);

    return { ok: true, row };
  }



  function upgradeTicketIdIfUnknown_(sheet, row, propertyName) {
    if (!row || row < 2) throw new Error("upgradeTicketIdIfUnknown_: bad row=" + row);

    const prop = String(propertyName || "").trim();
    if (!prop) throw new Error("upgradeTicketIdIfUnknown_: empty propertyName");

    const current = String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim();
    if (!current) throw new Error("upgradeTicketIdIfUnknown_: TicketID blank at row=" + row);

    if (!/^UNK-/i.test(current)) return; // already upgraded

    const createdAt = sheet.getRange(row, COL.CREATED_AT).getValue();
    const when = createdAt instanceof Date ? createdAt : new Date();

    const newId = makeTicketId_(prop, when, row);

    if (!newId || /^UNK-/i.test(newId)) {
      throw new Error("upgradeTicketIdIfUnknown_: makeTicketId_ returned " + newId);
    }

    sheet.getRange(row, COL.TICKET_ID).setValue(newId);
  }





  function refreshTicketIdIfReady_(sheet, rowIndex) {
    const prop = String(sheet.getRange(rowIndex, COL.PROPERTY).getValue() || "").trim();
    if (!prop || prop.toLowerCase() === "(unknown)") return;

    const ts = sheet.getRange(rowIndex, COL.TS).getValue();
    const when = ts instanceof Date ? ts : new Date(ts);

    const ticketId = makeTicketId_(prop, when, rowIndex);
    sheet.getRange(rowIndex, COL.TICKET_ID).setValue(ticketId);
  }


  function applyTenantAvailability_(sheet, phone, ticketId, preferredWindow, lang, vars) {
    const L = String(lang || "en").toLowerCase();
    const V = vars || {};

    // ===== COLUMN CONSTANTS (1-based, from your header) =====
    const COL_PHONE       = 2;   // Phone
    const COL_TICKET_ID   = 16;  // TicketID
    const COL_PREF_WINDOW = 21;  // PreferredWindow (U)
    const COL_LAST_UPDATE = 20;  // LastUpdateAt (T)

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return {
        ok: false,
        msg: tenantMsg_("TENANT_NO_TICKETS_FOUND", L, V)
      };
    }

    const phoneKey = phoneKey_(phone);
    const targetId = String(ticketId || "").trim().toUpperCase();

    // Read only what we need (fast + safe)
    const data = sheet.getRange(
      2,
      1,
      lastRow - 1,
      Math.max(COL_PREF_WINDOW, COL_LAST_UPDATE)
    ).getValues();

    // Scan bottom-up (most recent tickets first)
    for (let i = data.length - 1; i >= 0; i--) {
      const row = data[i];

      const rowTicketId = String(row[COL_TICKET_ID - 1] || "").trim().toUpperCase();
      if (rowTicketId !== targetId) continue;

      const rowPhoneKey = phoneKey_(row[COL_PHONE - 1]);
      if (rowPhoneKey !== phoneKey) {
        return {
          ok: false,
          msg: tenantMsg_("TENANT_TICKET_PHONE_MISMATCH", L, V)
        };
      }

      const sheetRow = i + 2; // account for header row

      sheet.getRange(sheetRow, COL_PREF_WINDOW)
        .setValue(String(preferredWindow || "").trim());

      sheet.getRange(sheetRow, COL_LAST_UPDATE)
        .setValue(new Date());

      return {
        ok: true,
        msg: tenantMsg_(
          "TENANT_PREF_WINDOW_UPDATED",
          L,
          Object.assign({}, V, {
            ticketId: String(ticketId || "").trim(),
            window: String(preferredWindow || "").trim()
          })
        )
      };
    }

    return {
      ok: false,
      msg: tenantMsg_("MGR_TICKET_NOT_FOUND", L, {
        ref: String(ticketId || "").trim()
      })
    };
  }




  function setAwaiting_(digits, val, payloadObj, ttlSec) {
    try {
      const obj = { v: String(val || ""), p: payloadObj || {}, t: Date.now() };
      CacheService.getScriptCache().put("AWAIT_" + String(digits || ""), JSON.stringify(obj), ttlSec || 900);
    } catch (_) {}
  }

  function getAwaiting_(digits) {
    try {
      const raw = CacheService.getScriptCache().get("AWAIT_" + String(digits || ""));
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function clearAwaiting_(digits) {
    try { CacheService.getScriptCache().remove("AWAIT_" + String(digits || "")); } catch (_) {}
  }



  function bypassOptOutKey_(toAny) {
    return "BYPASS_OPTOUT_" + phoneKey_(toAny);
  }

  function allowOptOutBypass_(toAny, seconds) {
    const key = bypassOptOutKey_(toAny);
    CacheService.getScriptCache().put(key, "1", Math.max(1, Number(seconds || 10)));
  }

  function isOptOutBypassActive_(toAny) {
    const key = bypassOptOutKey_(toAny);
    return CacheService.getScriptCache().get(key) === "1";
  }


  // Returns Sheet1 row numbers for tickets that belong to this tenant phone.
  // options.includeClosed: if true, include Done/Closed/Cancelled.
  function findTenantTicketRows_(sheet, phone, opt) {
    opt = opt || {};
    const key = phoneKey_(phone);
    if (!key) return [];

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const n = lastRow - 1;

    const phoneVals  = sheet.getRange(2, COL.PHONE, n, 1).getValues();
    const statusVals = sheet.getRange(2, COL.STATUS, n, 1).getValues();

    function isTerminal_(stAny) {
      const st = String(stAny || "").trim().toLowerCase();
      if (!st) return false;
      return (
        st.includes("done") ||
        st.includes("closed") ||
        st.includes("completed") ||
        st.includes("complete") ||
        st.includes("canceled") ||
        st.includes("cancelled")
      );
    }

    const rows = [];
    for (let i = 0; i < n; i++) {
      const rowKey = phoneKey_(phoneVals[i][0]);
      if (rowKey !== key) continue;

      const st = String(statusVals[i][0] || "").trim().toLowerCase();
      if (!opt.includeClosed && isTerminal_(st)) continue;

      rows.push(i + 2);
    }

    // newest first
    rows.sort((a, b) => b - a);
    return rows;
  }


  // Reads minimal info used by tenantChangeTimeCommand_ listing.
  function readTicketForTenant_(sheet, row) {
    if (!row || row < 2) return {};
    return {
      rowIndex: row,
      ticketId: String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim(),
      status: String(sheet.getRange(row, COL.STATUS).getValue() || "").trim(),
      prefWindow: String(sheet.getRange(row, COL.PREF_WINDOW).getValue() || "").trim(),
      property: String(sheet.getRange(row, COL.PROPERTY).getValue() || "").trim(),
      unit: String(sheet.getRange(row, COL.UNIT).getValue() || "").trim()
    };
  }


  function tenantChangeTimeCommand_(sheet, dir, dirRow, phone, bodyTrim, dayWord, lang) {
    const L = String(lang || "en").toLowerCase();

    const text = String(bodyTrim || "").trim();
    const m = text.match(/^(change time|update time|reschedule)\s+(.+)$/i);
    const ticketId = m ? String(m[2] || "").trim() : "";

    const rows = findTenantTicketRows_(sheet, phone, { includeClosed: false });

    if (!rows.length) {
      return {
        ok: false,
        msg: tenantMsg_("TENANT_NO_ACTIVE_TICKETS_RESCHEDULE", L, {})
      };
    }

    let row = 0;

    // If ticketId provided, use it
    if (ticketId) {
      row = findTicketRowByTicketId_(sheet, ticketId) || 0;
      if (!row) {
        return {
          ok: false,
          msg: tenantMsg_("TENANT_TICKET_NOT_FOUND_WITH_HINT", L, { ticketId })
        };
      }
    } else {
      // No ticketId: if exactly one active ticket, use it; else ask which one
      if (rows.length === 1) {
        row = rows[0];
      } else {
        const list = rows.slice(0, 5).map(r => {
          const t = readTicketForTenant_(sheet, r);
          const win = t.prefWindow ? (" — " + t.prefWindow) : "";
          return "• " + (t.ticketId || ("Row " + r)) + " — " + (t.status || "(no status)") + win;
        }).join("\n");

        return {
          ok: false,
          msg: tenantMsg_("TENANT_CHANGE_TIME_PICK_WITH_LIST", L, { list })
        };
      }
    }

    // Anchor conversation to this ticket row and move to schedule stage
    var schedStageLabel = "SCHEDULE_" + String(dayWord || "Today").toUpperCase();
    dalWithLock_("TENANT_CHANGE_TIME_SET_PTR_STAGE", function () {
      dalSetPendingRowNoLock_(dir, dirRow, row);
      dalSetPendingStageNoLock_(dir, dirRow, schedStageLabel);
      dalSetLastUpdatedNoLock_(dir, dirRow);
      try { logDevSms_("", "", "DAL_WRITE TENANT_CHANGE_TIME_SET_PTR_STAGE row=" + dirRow + " ptr=" + row); } catch (_) {}
    });

    // Optional: mark waiting tenant again
    try { setStatus_(sheet, row, "Waiting Tenant"); } catch (_) {}

    const tid = String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim();

    return {
      ok: true,
      msg:
        tenantMsg_("TENANT_CHANGE_TIME_CONFIRM_PREFIX", L, { ticketId: tid }) +
        "\n\n" +
        tenantMsg_("ASK_WINDOW", L, { dayWord })
    };
  }

  
  function tenantStatusCommand_(sheet, phone, bodyTrim, lang) {
    const L = String(lang || "en").toLowerCase();

    const text = String(bodyTrim || "").trim();
    const m = text.match(/^status\s+(.+)$/i);
    const ticketId = m ? String(m[1] || "").trim() : "";

    const rows = findTenantTicketRows_(sheet, phone, { includeClosed: false });

    if (!rows.length) {
      return {
        ok: false,
        msg: tenantMsg_("TENANT_NO_ACTIVE_TICKETS_STATUS", L, {})
      };
    }

    // If ticketId provided, find that one
    if (ticketId) {
      const row = findTicketRowByTicketId_(sheet, ticketId);
      if (!row) {
        return {
          ok: false,
          msg: tenantMsg_("TENANT_TICKET_NOT_FOUND_WITH_HINT", L, { ticketId })
        };
      }

      const t = readTicketForTenant_(sheet, row);
      return { ok: true, msg: formatTenantStatus_(t) };
    }

    // No ticketId: if only one active ticket, show it
    if (rows.length === 1) {
      const t = readTicketForTenant_(sheet, rows[0]);
      return { ok: true, msg: formatTenantStatus_(t) };
    }

    // Multiple active tickets -> show a short list
    const list = rows.slice(0, 5).map(r => {
      const t = readTicketForTenant_(sheet, r);
      return "• " + (t.ticketId || ("Row " + r)) + " — " + (t.status || "(no status)");
    }).join("\n");

    return {
      ok: false,
      msg: tenantMsg_("TENANT_STATUS_PICK_WITH_LIST", L, { list })
    };
  }


  function isPureChitchat_(raw) {
    const s = String(raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!s) return true; // emojis / punctuation only

    // Very short greetings
    if (s.length <= 3) return true; // hi, yo, ok, lol

    // Common greeting / courtesy patterns
    const patterns = [
      /^hi$/,
      /^hi there$/,
      /^hello$/,
      /^hey$/,
      /^hey there$/,
      /^yo$/,
      /^sup$/,
      /^wassup$/,
      /^what'?s up$/,
      /^how are you$/,
      /^how r u$/,
      /^how are u$/,
      /^how are you doing$/,
      /^how'?s it going$/,
      /^good (morning|afternoon|evening)$/,
      /^thanks$/,
      /^thank you$/,
      /^thanks a lot$/,
      /^ok$/,
      /^okay$/,
      /^k$/,
      /^lol$/,
      /^haha$/,
      /^test$/,
      /^just checking$/,
      /^checking$/,
      /^ping$/,
      /^anyone there$/
    ];

    if (patterns.some(rx => rx.test(s))) return true;

    // If message is short AND contains no service-related signal words
    const serviceSignals = /(leak|water|toilet|heat|ac|hvac|broken|not working|repair|maintenance|unit|apt|property|reserve|reservation|book)/;
    if (s.split(" ").length <= 4 && !serviceSignals.test(s)) {
      return true;
    }

    return false;
  }



  function makeSyntheticSid_(phone, body) {
    const raw = String(phone || "") + "|" + String(body || "") + "|" + new Date().getTime();
    return "SYNTH_" + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw)
    ).slice(0, 24);
  }

  function getPropertyByMenuPick_(s) {
    const t = String(s || "").trim();
    if (!t) return null;

    // Find the first standalone number (so "1", "pick 1", "1)" all work)
    const m = t.match(/\b(\d{1,3})\b/);
    const n = m ? parseInt(m[1], 10) : 0;
    if (!n) return null;

    const list = (typeof getActiveProperties_ === "function") ? getActiveProperties_() : [];
    if (!list || !list.length) return null;

    // Menu is 1-based; array is 0-based
    const p = list[n - 1];
    return p || null;
  }

  function lookupTenantByPhoneDigits_(phoneDigits) {
    const sh = getSheet_("Tenants");
    const last = sh.getLastRow();
    if (last < 2) return null;

    const target = String(phoneDigits || "").replace(/\D/g, "").slice(-10);
    if (!target) return null;

    const n = last - 1;

    const COL_PROPERTY_NAME = 1;
    const COL_UNIT = 2;
    const COL_PHONE = 3;
    const COL_ACTIVE = 7;

    const phones = sh.getRange(2, COL_PHONE, n, 1).getValues();
    const actives = sh.getRange(2, COL_ACTIVE, n, 1).getValues();

    for (let i = 0; i < n; i++) {
      const a = String(actives[i][0] || "").trim().toLowerCase();
      const isActive = (actives[i][0] === true) || (a === "true" || a === "yes" || a === "y" || a === "1");
      if (!isActive) continue;

      const raw = phones[i][0];
      const d = normalizePhoneDigits_(raw);
      const d10 = d ? String(d).slice(-10) : "";

      if (d10 && d10 === target) {
        const row = i + 2;
        const propertyName = String(sh.getRange(row, COL_PROPERTY_NAME).getValue() || "").trim();
        const unit = String(sh.getRange(row, COL_UNIT).getValue() || "").trim();

        const p = getPropertyByNameOrKeyword_(propertyName);
        if (!p) return null;

        return { propertyCode: p.code, propertyName: p.name, unit };
      }
    }
    return null;
  }

  // ----------------------------
  // Cancel receipt helpers (KEEP)
  // ----------------------------
  function wasTrue_(v) {
    return v === true || String(v || "").trim().toLowerCase() === "true" || String(v || "").trim() === "1";
  }

  function markCancelSent_(sheet, row) {
    sheet.getRange(row, COL.CANCEL_MSG_SENT).setValue(true);
    sheet.getRange(row, COL.CANCEL_MSG_SENT_AT).setValue(new Date());
  }

  // NOTE: kept name + behavior, but made message template-key based.
  // Optional args: meta.lang, meta.vars

  function sendCancelReceiptForRow_(sheet, row) {
    withWriteLock_("CANCEL_RECEIPT_ROW_" + row, () => {
      const alreadySent = sheet.getRange(row, COL.CANCEL_MSG_SENT).getValue();
      if (alreadySent === true || String(alreadySent).toLowerCase() === "true") return;

      const phone = String(sheet.getRange(row, COL.PHONE).getValue() || "").trim();
      const ticketId = String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim();
      if (!phone || !ticketId) return;

      const props = PropertiesService.getScriptProperties();

      // ✅ Template-driven (no hardcoded tenant strings)
      const msg = tenantMsg_("TICKET_CANCELED_RECEIPT", "en", {
        brandName: BRAND.name,
        teamName: BRAND.team,
        ticketId: ticketId
      });

      sendSms_(
        props.getProperty("TWILIO_SID"),
        props.getProperty("TWILIO_TOKEN"),
        props.getProperty("TWILIO_NUMBER"),
        phone,
        msg
      );

      // ✅ mark ONLY after sending succeeds
      sheet.getRange(row, COL.CANCEL_MSG_SENT).setValue(true);
      sheet.getRange(row, COL.CANCEL_MSG_SENT_AT).setValue(new Date());
    });
  }


  /*
  DELETED (legacy / non-Compass / duplicate):
  - listMyTickets_
  - TENANT_CANCEL_ALLOWED_STATUSES
  - cancelTicketCommand_
  - findCancelableTicketRow_
  - buildTicketLabel_
  */


  // FROM HERE REVIEW

  function issueIsClear_(issueSummary, issueConf, effectiveMessage) {
    const summary = String(issueSummary || "").trim();
    const conf = Number(issueConf || 0);

    const overrideCat = detectCategoryOverride_(effectiveMessage);
    const localClear = localIssueIsClear_(effectiveMessage);

    const summaryClear = summary.length >= 6;
    const confClear = conf >= 60;

    return !!overrideCat || !!localClear || summaryClear || confClear;
  }

  function extractPhoneFromText_(text) {
    const s = String(text || "");
    const m = s.match(/(\+1\d{10}|\b1\d{10}\b|\b\d{10}\b)/);
    if (!m) return "";
    return normalizePhone_(m[1]);
  }

  function issueLooksClear_(text) {
    const t = String(text || "").toLowerCase();

    // Electrical clear cases
    if (/(outlet|outlets|no power|breaker|tripped|gfci|reset button|lights? out|flicker|burning smell|switch not working)/.test(t)) return true;

    // Plumbing clear cases
    if (/(leak|leaking|clog|clogged|toilet|overflow|no water|hot water|drain|sewage|backed up)/.test(t)) return true;

    // HVAC clear cases
    if (/(no heat|heat not working|ac not working|a\/c not working|no ac|thermostat)/.test(t)) return true;

    // Appliance clear cases
    if (/(washer|dryer|fridge|refrigerator|oven|stove|dishwasher|microwave|disposal)/.test(t)) return true;

    // Lock/Key clear cases
    if (/(locked out|lockout|lost key|key fob|door won.?t open|can.?t get in)/.test(t)) return true;

    // Pest clear cases
    if (/(roaches?|mice|rats|bed bugs?|ants|pest)/.test(t)) return true;

    return false;
  }


  function detectCategoryOverride_(text) {
    const t = String(text || "").toLowerCase();

    // ELECTRICAL
    if (/(outlet|outlets|receptacle|plug|no power|lost power|power is out|breaker|tripped|panel|gfi|gfci|reset button|sparking|spark|burning smell|light switch|switch not working|flicker|flickering|light(s)? not working)/.test(t)) {
      return "Electrical";
    }

    // PLUMBING
    if (/(leak|leaking|drip|dripping|clog|clogged|toilet|sink|faucet|shower|tub|water backup|backing up|drain|sewer)/.test(t)) {
      return "Plumbing";
    }

    // HVAC
    if (/(no heat|heat not working|heater|boiler|radiator|\bac\b|a\/c|air conditioner|not cooling|thermostat)/.test(t)) {
      return "HVAC";
    }

    // APPLIANCE
    if (/(washer|dryer|dishwasher|fridge|refrigerator|stove|oven|microwave|garbage disposal|disposal)/.test(t)) {
      return "Appliance";
    }

    return "";
  }


  function looksLikeWindowReply_(text, stageDay) {
    const s = String(text || "").trim();
    if (!s) return false;

    // Never treat manager commands as schedule replies
    if (looksLikeManagerCommand_(s.toLowerCase())) return false;

    // Long message that clearly describes a problem (e.g. gym AC) — do not treat as schedule even if it contains "morning"
    if (s.length > 75 && (typeof looksActionableIssue_ === "function") && looksActionableIssue_(s)) return false;
    if (s.length > 70 && /\b(gym|lobby|working out|noticed the|check it out|isn'?t working|super hot in there)\b/i.test(s)) return false;

    return !!parsePreferredWindow_(s, stageDay);
  }

  function looksLikeManagerCommand_(sLower) {
    // Block anything that could be a manager command / new ticket
    return (
      /^new\s*ticket\b/i.test(sLower) ||
      /^list\s+open\b/i.test(sLower) ||
      /^list\s+waiting\b/i.test(sLower) ||
      /^status\b/i.test(sLower) ||
      /^setstatus\b/i.test(sLower) ||
      /^pick\s+\d+\b/i.test(sLower) ||
      /^phone\s+\+?\d/i.test(sLower)
    );
  }

  // Returns a clean label like: "Tomorrow morning" or "Today 12–2pm"
  function windowLabel_(text, stageDay) {
    const parsed = parsePreferredWindow_(text, stageDay);
    return parsed ? parsed.label : "";
  }

  /**
  * parsePreferredWindow_(text, stageDay?)
  * Supports:
  * - "tomorrow 9-11"
  * - "friday after 3"
  * - "1/15 10am"
  * - "1/15 at 10"
  * - "between 2 and 4"
  * - "morning / afternoon / evening"
  * - "anytime"
  *
  * Returns:
  * { label: string, start: Date|null, end: Date|null, kind: string }
  */
  function parsePreferredWindow_(text, stageDay) {
    const s0 = String(text || "").trim();
    if (!s0) return null;

    const s = s0.toLowerCase().replace(/\s+/g, " ").trim();
    const tz = Session.getScriptTimeZone();
    const now = new Date();

    // Quick rejects
    if (s.length < 2) return null;

  // "anytime"
  if (/\b(any ?time|whenever|all day|any time)\b/.test(s)) {
    // Prefer explicit date/day in the text (e.g., "Feb 18 anytime", "Friday anytime")
    const baseFromText = parseDayTarget_(s, stageDay, now);
    const base = baseFromText || resolveDayBase_(stageDay, now);
    if (!base) return null;

    const label = formatDay_(base) + " anytime";
    return { label, start: null, end: null, kind: "ANYTIME" };
  }

  // "now" / "asap" / "urgent" (ASAP window)
  if (/\b(now|asap|a\s*s\s*a\s*p|immediately|right now|urgent|emergency)\b/.test(s)) {
    // Prefer explicit date/day if present (rare, but allow "tomorrow asap")
    const baseFromText = parseDayTarget_(s, stageDay, now);
    const base = baseFromText || resolveDayBase_(stageDay, now) || now;

    // Label: "Today ASAP" (or the resolved date)
    const label = formatDay_(base) + " ASAP";
    return { label, start: null, end: null, kind: "ASAP" };
  }

    // Day target (today/tomorrow/weekday/date)
    const baseDay = parseDayTarget_(s, stageDay, now);
    if (!baseDay) {
      // If they only said "9-11" and stageDay exists, use stageDay
      const fallback = resolveDayBase_(stageDay, now);
      if (fallback && looksTimeish_(s)) {
        return parseTimeWindowOnDay_(s, fallback);
      }
      return null;
    }

    // "morning/afternoon/evening"
    const dayPart = parseDayPart_(s);
    if (dayPart) {
      const range = dayPartRange_(baseDay, dayPart);
      const label = formatRangeLabel_(range.start, range.end, dayPart);
      return { label, start: range.start, end: range.end, kind: "DAYPART" };
    }

    // After / Before
    const after = s.match(/\b(after|afterwards)\s+(.+)$/);
    if (after) {
      const t = parseTime_(after[2], baseDay);
      if (!t) return null;
      const label = formatDay_(baseDay) + " after " + formatTime_(t);
      return { label, start: t, end: null, kind: "AFTER" };
    }

    const before = s.match(/\b(before)\s+(.+)$/);
    if (before) {
      const t = parseTime_(before[2], baseDay);
      if (!t) return null;
      const label = formatDay_(baseDay) + " before " + formatTime_(t);
      return { label, start: null, end: t, kind: "BEFORE" };
    }

    // Between X and Y
    const between = s.match(/\b(between)\s+(.+?)\s+(and|to)\s+(.+)$/);
    if (between) {
      const t1 = parseTime_(between[2], baseDay);
      const t2 = parseTime_(between[4], baseDay);
      if (!t1 || !t2) return null;
      const range = orderRange_(t1, t2);
      const label = formatRangeLabel_(range.start, range.end);
      return { label, start: range.start, end: range.end, kind: "RANGE" };
    }

    // Explicit "X-Y" or "X to Y"
    if (looksRangeish_(s)) {
      const r = parseTimeRange_(s, baseDay);
      if (!r) return null;
      const label = formatRangeLabel_(r.start, r.end);
      return { label, start: r.start, end: r.end, kind: "RANGE" };
    }

    // Single time: "at 10", "10am"
    const single = parseTime_(s, baseDay);
    if (single) {
      const label = formatDay_(baseDay) + " at " + formatTime_(single);
      return { label, start: single, end: null, kind: "AT" };
    }

    return null;
  }

  function resolveDayBase_(stageDay, now) {
    const d = String(stageDay || "").toLowerCase();
    if (d.includes("today")) return startOfDay_(now);
    if (/tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr/.test(d)) return startOfDay_(addDays_(now, 1));
    return null;
  }

  function parseDayTarget_(s, stageDay, now) {
    // If message includes a date or weekday, use that
    const explicit = parseExplicitDate_(s, now);
    if (explicit) return startOfDay_(explicit);

    const wd = parseWeekday_(s, now);
    if (wd) return startOfDay_(wd);

    if (/\btoday\b/.test(s)) return startOfDay_(now);
    if (/\b(tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr)\b/.test(s)) return startOfDay_(addDays_(now, 1));

    // If no explicit day but stageDay exists (SCHEDULE_TODAY / TOMORROW)
    const fallback = resolveDayBase_(stageDay, now);
    if (fallback) return fallback;

    return null;
  }

  function parseExplicitDate_(s, now) {
    // formats: 1/15, 01/15, 1/15/2026, 2026-01-15
    let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) {
      const y = +m[1], mo = +m[2], da = +m[3];
      return new Date(y, mo - 1, da);
    }

    m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) {
      const mo = +m[1], da = +m[2];
      let y = m[3] ? +m[3] : now.getFullYear();
      if (y < 100) y = 2000 + y;
      return new Date(y, mo - 1, da);
    }

    return null;
  }

  function parseWeekday_(s, now) {
    const days = [
      ["sun", "sunday"],
      ["mon", "monday"],
      ["tue", "tues", "tuesday"],
      ["wed", "wednesday"],
      ["thu", "thurs", "thursday"],
      ["fri", "friday"],
      ["sat", "saturday"]
    ];

    let target = -1;
    for (let i = 0; i < days.length; i++) {
      for (const name of days[i]) {
        if (new RegExp("\\b" + name + "\\b").test(s)) {
          target = i;
          break;
        }
      }
      if (target >= 0) break;
    }
    if (target < 0) return null;

    const start = startOfDay_(now);
    const cur = start.getDay();
    let delta = target - cur;
    if (delta < 0) delta += 7;
    if (delta === 0) delta = 7; // if they say "Friday" on Friday, assume next Friday
    return addDays_(start, delta);
  }

  function parseDayPart_(s) {
    if (/\bmorning\b/.test(s)) return "morning";
    if (/\bafternoon\b/.test(s)) return "afternoon";
    if (/\bevening\b/.test(s) || /\bnight\b/.test(s)) return "evening";
    return null;
  }

  function dayPartRange_(baseDay, part) {
    const start = new Date(baseDay);
    const end = new Date(baseDay);
    if (part === "morning") { start.setHours(9,0,0,0); end.setHours(12,0,0,0); }
    if (part === "afternoon") { start.setHours(12,0,0,0); end.setHours(17,0,0,0); }
    if (part === "evening") { start.setHours(17,0,0,0); end.setHours(20,0,0,0); }
    return { start, end };
  }

  function looksTimeish_(s) {
    return /(\b\d{1,2}(:\d{2})?\s*(am|pm)?\b)|(\bnoon\b)|(\bmidday\b)/i.test(s);
  }

  function looksRangeish_(s) {
    return /(\b\d{1,2}(:\d{2})?\s*(am|pm)?\s*[-to]+\s*\d{1,2}(:\d{2})?\s*(am|pm)?\b)|(\bbetween\b.+\b(and|to)\b)/i.test(s);
  }

  function parseTimeWindowOnDay_(s, baseDay) {
    const r = parseTimeRange_(s, baseDay);
    if (r) return { label: formatRangeLabel_(r.start, r.end), start: r.start, end: r.end, kind: "RANGE" };

    const t = parseTime_(s, baseDay);
    if (t) return { label: formatDay_(baseDay) + " at " + formatTime_(t), start: t, end: null, kind: "AT" };

    return null;
  }

  function parseTimeRange_(s, baseDay) {
    // "9-11", "9am-11am", "9 to 11", "9:30-11"
    let m = s.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
    if (!m) return null;

    const t1 = parseTime_(m[1], baseDay);
    const t2 = parseTime_(m[2], baseDay);
    if (!t1 || !t2) return null;

    // If second time had no am/pm, and first had it, inherit
    return orderRange_(t1, t2);
  }

  function parseTime_(raw, baseDay) {
    const s = String(raw || "").toLowerCase().trim();

    if (/\bnoon\b/.test(s)) {
      const d = new Date(baseDay); d.setHours(12,0,0,0); return d;
    }

    // "at 10am" -> "10am"
    const clean = s.replace(/\bat\b/g, "").trim();

    // 10, 10am, 10:30, 10:30am
    const m = clean.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (!m) return null;

    let hh = +m[1];
    const mm = m[2] ? +m[2] : 0;
    const ap = m[3] || "";

    if (hh < 0 || hh > 12 || mm < 0 || mm > 59) return null;

    let H = hh;

    if (ap === "pm" && hh !== 12) H = hh + 12;
    if (ap === "am" && hh === 12) H = 0;

    // If no am/pm and hour looks like business time (7-18), accept as-is best guess:
    if (!ap) {
      // interpret 1-6 as pm by default (common tenant behavior)
      if (hh >= 1 && hh <= 6) H = hh + 12;
      else H = hh; // 7-12 stays
    }

    const d = new Date(baseDay);
    d.setHours(H, mm, 0, 0);
    return d;
  }

  function orderRange_(a, b) {
    if (a.getTime() <= b.getTime()) return { start: a, end: b };
    return { start: b, end: a };
  }

  function startOfDay_(d) {
    const x = new Date(d);
    x.setHours(0,0,0,0);
    return x;
  }

  function addDays_(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function formatDay_(d) {
    // Example: "Fri Jan 15"
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "EEE MMM d");
  }

  function formatTime_(d) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "h:mm a");
  }

  function formatRangeLabel_(start, end, part) {
    // Example: "Fri Jan 15, 9:00 AM–11:00 AM"
    const day = formatDay_(start);
    if (end) return day + ", " + formatTime_(start) + "–" + formatTime_(end);
    return day + ", " + formatTime_(start);
  }

  
  function backfillTicketIds() {
    const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) return;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const tsVals = sheet.getRange(2, 1, lastRow - 1, 1).getValues();              // A Timestamp
    const propVals = sheet.getRange(2, 3, lastRow - 1, 1).getValues();            // C Property
    const idVals = sheet.getRange(2, COL.TICKET_ID, lastRow - 1, 1).getValues();  // P TicketID

    for (let i = 0; i < idVals.length; i++) {
      const rowIndex = i + 2;
      const ts = tsVals[i][0];
      const prop = String(propVals[i][0] || "").trim();
      const id = String(idVals[i][0] || "").trim();

      // Only generate if TicketID is missing and we have what makeTicketId_ needs
      if (!id && ts instanceof Date && prop) {
        const newId = makeTicketId_(prop, ts, rowIndex);
        sheet.getRange(rowIndex, COL.TICKET_ID).setValue(newId);
      }
    }
  }


  function scheduleDayWord_(now) {
    const d = now || new Date();

    // After-hours/weekends => tomorrow
    if (isAfterHours_(d)) return "Tomorrow";

    const CUTOFF_HOUR = 16; // ✅ 4 PM
    return (d.getHours() >= CUTOFF_HOUR) ? "Tomorrow" : "Today";
  }


  function isAddressInContext_(text, addr) {
    const t = String(text || "").toLowerCase();
    const num = String(addr.num);

    // must contain the number as a whole token
    if (!new RegExp("\\b" + num + "\\b").test(t)) return false;

    // A) number near a hint (0–3 words between)
    // catches: "618 westfield", "702 pennsylvania", "318 west grand"
    for (let i = 0; i < (addr.hints || []).length; i++) {
      const h = String(addr.hints[i]).toLowerCase();
      const re1 = new RegExp("\\b" + num + "\\b(?:\\s+\\w+){0,3}\\s+" + escRe_(h) + "\\b", "i");
      const re2 = new RegExp("\\b" + escRe_(h) + "\\b(?:\\s+\\w+){0,3}\\s+\\b" + num + "\\b", "i");
      if (re1.test(t) || re2.test(t)) return true;
    }

    // B) number followed by street suffix
    // catches: "705 newark ave", "57 murray st"
    for (let j = 0; j < (addr.suffixes || []).length; j++) {
      const suf = String(addr.suffixes[j]).toLowerCase();
      const reS = new RegExp("\\b" + num + "\\b(?:\\s+\\w+){0,2}\\s+\\b" + escRe_(suf) + "\\b", "i");
      if (reS.test(t)) return true;
    }

    return false;
  }

  function isBlockedAsAddress_(text, numCandidate) {
    const cand = String(numCandidate || "").trim();
    if (!cand) return false;

    // ✅ Guard missing config / wrong type (prevents ReferenceError)
    const list =
      (typeof PROPERTY_ADDRESSES !== "undefined" && Array.isArray(PROPERTY_ADDRESSES))
        ? PROPERTY_ADDRESSES
        : [];

    // ✅ Guard missing helper (prevents next ReferenceError)
    if (typeof isAddressInContext_ !== "function") return false;

    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (String(a && a.num || "") === cand && isAddressInContext_(text, a)) {
        return true; // ✅ block only if written like an address here
      }
    }
    return false;
  }


  

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


  function ensureTenantsSheet_() {
    const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    let sh = ss.getSheetByName(TENANTS_SHEET_NAME);

    if (!sh) {
      sh = ss.insertSheet(TENANTS_SHEET_NAME);
      sh.appendRow([
        "Property",
        "Unit",
        "Phone",
        "Name",
        "UpdatedAt",
        "Notes",
        "Active"
      ]);
    }

    return sh;
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

  function getWelcomeLineOnce_(dirSheet, dirRow, lang) {
    if (!dirSheet || !dirRow) return "";

    const cell = dirSheet.getRange(dirRow, DIR_COL.WELCOME_SENT); // J
    const already = String(cell.getValue() || "").trim().toLowerCase() === "yes";
    if (already) return "";

    cell.setValue("Yes");
    return tenantMsg_("WELCOME", lang);
  }


  /****************************
  * Ticket lookup helpers (forgiving)
  ****************************/


  // Accepts:
  // - Exact TicketID: "PENN-20260108-0012"
  // - Partial TicketID: "0012" or "PENN-20260108" or "PENN-20260108-00"
  // - Row number: "12" or "ROW 12"
  //
  // Behavior:
  // - If EXACT match found -> return it
  // - Else if partial matches:
  //    - If exactly ONE match -> return it
  //    - If multiple matches -> return 0 (forces user to be more specific)

  function getTicketSummary_(sheet, rowIndex) {
    const r = Number(rowIndex);
    if (!r || r < 2) return null;

    const lastCol = COL.HANDOFF_SENT; // last column index in your sheet
    const row = sheet.getRange(r, 1, 1, lastCol).getValues()[0];

    return {
      rowIndex: r,
      ts: row[COL.TS - 1],
      phone: String(row[COL.PHONE - 1] || "").trim(),
      prop: String(row[COL.PROPERTY - 1] || "").trim(),
      unit: String(row[COL.UNIT - 1] || "").trim(),
      msg: String(row[COL.MSG - 1] || "").trim(),
      category: String(row[COL.CAT - 1] || "").trim(),
      emergency: String(row[COL.EMER - 1] || "").trim(),
      emergencyType: String(row[COL.EMER_TYPE - 1] || "").trim(),
      urgency: String(row[COL.URG - 1] || "").trim(),
      status: String(row[COL.STATUS - 1] || "").trim(),
      ticketId: String(row[COL.TICKET_ID - 1] || "").trim(),
      lastUpdate: row[COL.LAST_UPDATE - 1]
    };
  }



  function resolveTicketRow_(sheet, ref) {
    const s0 = String(ref || "").trim();
    if (!s0) return 0;

    // Normalize
    const s = s0.toUpperCase();

    // Row number support
    let m = s.match(/^ROW\s+(\d+)$/i);
    if (m) {
      const n = Number(m[1]);
      if (n >= 2 && n <= sheet.getLastRow()) return n;
      return 0;
    }
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (n >= 2 && n <= sheet.getLastRow()) return n;
      // NOTE: if it's not a valid row, we still allow it to act as partial TicketID (e.g. "0012")
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;

    // Read TicketIDs
    const values = sheet.getRange(2, COL.TICKET_ID, lastRow - 1, 1).getValues();

    // 1) Try exact match first
    for (let i = 0; i < values.length; i++) {
      const cell = String(values[i][0] || "").trim().toUpperCase();
      if (cell && cell === s) return i + 2;
    }

    // 2) Try partial match (contains)
    const matches = [];
    for (let i = 0; i < values.length; i++) {
      const cell = String(values[i][0] || "").trim().toUpperCase();
      if (!cell) continue;

      // forgiving: allow searching by last 4 digits only, or any substring
      if (cell.indexOf(s) !== -1) {
        matches.push(i + 2); // sheet row
        continue;
      }

      // if user typed just the last 4 digits like "0012"
      if (/^\d{2,6}$/.test(s)) {
        const lastChunk = cell.split("-").pop() || "";
        if (lastChunk.endsWith(s)) matches.push(i + 2);
      }
    }

    // If exactly 1 match, return it
    if (matches.length === 1) return matches[0];

    // If many matches, don't guess
    // (prevents updating the wrong ticket)
    return 0;
  }


  function normalizeName_(s) {
    return String(s || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  }

  function scoreNameMatch_(queryName, rowName) {
    const q = normalizeName_(queryName);
    const r = normalizeName_(rowName);
    if (!q || !r) return 0;
    if (q === r) return 100;
    if (r.startsWith(q) || q.startsWith(r)) return 85;   // john vs johnathan
    if (r.includes(q) || q.includes(r)) return 70;
    return 0;
  }

  /** Tenant active normalization for enrichment: only true, "yes", "true", "y", "1" are active; blank/other = inactive. */
  function isTenantActive_(activeRaw) {
    if (activeRaw === true) return true;
    var a = String(activeRaw || "").trim().toLowerCase();
    return (a === "yes" || a === "true" || a === "y" || a === "1");
  }

  // returns [{phone,name,score}]
  function findTenantCandidates_(propertyName, unit, queryName) {
    const sh = ensureTenantsSheet_();

    // Normalize unit the same way everywhere
    const u = normalizeUnit_(String(unit || "").trim());
    if (!u) return [];

    // Resolve property to canonical property code using your existing resolver
    const prop = getPropertyByNameOrKeyword_(String(propertyName || "").trim());
    if (!prop) return [];

    const lastRow = sh.getLastRow();
    if (lastRow < 2) return [];

    // Tenants columns:
    // 1 Property, 2 Unit, 3 Phone, 4 Name, 5 UpdateAt, 6 Notes, 7 Active
    const data = sh.getRange(2, 1, lastRow - 1, 7).getValues();

    const qn = String(queryName || "").trim();
    const qnLower = qn.toLowerCase();

    const found = [];

    for (let i = 0; i < data.length; i++) {
      const rpName = String(data[i][0] || "").trim();
      const ru = normalizeUnit_(String(data[i][1] || "").trim());

      // Phone in your sheet can be:
      //  - 19083380300 (11 digits starting with 1)
      //  - 9083380300  (10 digits)
      //  - +19083380300
      const d10 = String(normalizePhoneDigits_(data[i][2] || "") || "").slice(-10);
      if (!d10) continue;

      const rname = String(data[i][3] || "").trim();

      if (!isTenantActive_(data[i][6])) continue;

      if (ru !== u) continue;

      const rp = getPropertyByNameOrKeyword_(rpName);
      if (!rp || rp.code !== prop.code) continue;

      // Name scoring: if no queryName provided, accept all with neutral score
      const score = qn ? scoreNameMatch_(qnLower, rname) : 100;
      if (qn && score <= 0) continue;

      // Store as +1XXXXXXXXXX (consistent everywhere)
      found.push({ phone: "+1" + d10, name: rname, score: score });
    }

    // Dedupe by phone, keep best score
    const best = {};
    found.forEach(x => {
      if (!best[x.phone] || x.score > best[x.phone].score) best[x.phone] = x;
    });

    return Object.keys(best)
      .map(k => best[k])
      .sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  /** Staff-capture tenant identity enrichment only. Never blocks ticket creation; never guesses when ambiguous. */
  function enrichStaffCapTenantIdentity_(sheet, loggedRow, workItemId, propName, unit, opts) {
    opts = opts || {};
    var tenantNameHint = String(opts.tenantNameHint || "").trim();
    var tenantNameTrusted = !!opts.tenantNameTrusted;
    var locationType = String((opts.locationType || "UNIT")).toUpperCase();

    function isRealPhone_(val) {
      var d = String(val || "").replace(/\D/g, "");
      return (d.length === 11 && d.charAt(0) === "1") || (d.length === 10);
    }

    if (!sheet || !loggedRow || loggedRow < 2) return;
    if (!workItemId) return;
    var pName = String(propName || "").trim();
    if (!pName) {
      if (typeof workItemUpdate_ === "function") {
        try {
          var wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null;
          var meta = {};
          try { if (wi && wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
          meta.tenantLookupStatus = "SKIPPED_NO_PROPERTY";
          workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
        } catch (_) {}
      }
      return;
    }
    var u = String(unit || "").trim();
    if (!u) {
      if (typeof workItemUpdate_ === "function") {
        try {
          var wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null;
          var meta = {};
          try { if (wi && wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
          meta.tenantLookupStatus = "SKIPPED_NO_UNIT";
          workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
        } catch (_) {}
      }
      return;
    }
    if (locationType === "COMMON_AREA") {
      if (typeof workItemUpdate_ === "function") {
        try {
          var wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null;
          var meta = {};
          try { if (wi && wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
          meta.tenantLookupStatus = "SKIPPED_COMMON_AREA";
          workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
        } catch (_) {}
      }
      return;
    }

    var ticketPhone = "";
    var wiPhone = "";
    try {
      if (typeof COL !== "undefined" && COL.PHONE && loggedRow <= sheet.getLastRow()) {
        ticketPhone = String(sheet.getRange(loggedRow, COL.PHONE).getValue() || "").trim();
      }
    } catch (_) {}
    if (isRealPhone_(ticketPhone)) {
      if (typeof workItemUpdate_ === "function") {
        try {
          var wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null;
          var meta = {};
          try { if (wi && wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
          meta.tenantLookupStatus = "SKIPPED_ALREADY_HAS_PHONE";
          workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
        } catch (_) {}
      }
      return;
    }
    try {
      var wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null;
      if (wi && wi.phoneE164 && isRealPhone_(wi.phoneE164)) {
        var meta = {};
        try { if (wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
        meta.tenantLookupStatus = "SKIPPED_ALREADY_HAS_PHONE";
        workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
        return;
      }
    } catch (_) {}

    var candidates = [];
    try {
      candidates = (typeof findTenantCandidates_ === "function") ? findTenantCandidates_(pName, u, tenantNameHint) : [];
    } catch (_) { candidates = []; }

    var status = "";
    var matchedPhone = null;
    var matchedName = null;

    if (tenantNameHint) {
      if (candidates.length !== 1 || !candidates[0] || (candidates[0].score || 0) < 85) {
        status = (candidates.length === 0) ? "NO_MATCH" : (candidates.length > 1) ? "AMBIGUOUS" : "SKIPPED_LOW_CONFIDENCE";
      } else {
        matchedPhone = candidates[0].phone;
        matchedName = candidates[0].name;
        status = "MATCHED";
      }
    } else {
      candidates = (typeof findTenantCandidates_ === "function") ? findTenantCandidates_(pName, u, "") : [];
      if (candidates.length !== 1 || !candidates[0]) {
        status = (candidates.length === 0) ? "NO_MATCH" : "AMBIGUOUS";
      } else {
        matchedPhone = candidates[0].phone;
        matchedName = candidates[0].name;
        status = "MATCHED";
      }
    }

    var wi = null;
    try { wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null; } catch (_) {}
    var meta = {};
    try { if (wi && wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
    meta.tenantNameHint = tenantNameHint;
    meta.tenantNameTrusted = tenantNameTrusted;
    meta.tenantLookupStatus = status;
    if (matchedName != null) meta.tenantLookupMatchedName = matchedName;
    if (matchedPhone != null) meta.tenantLookupMatchedPhone = matchedPhone;

    if (status === "MATCHED" && matchedPhone && typeof workItemUpdate_ === "function") {
      var normPhone = (matchedPhone.indexOf("+1") === 0) ? matchedPhone : "+1" + String(matchedPhone).replace(/\D/g, "").slice(-10);
      try {
        withWriteLock_("STAFFCAP_TENANT_ENRICH", function () {
          if (typeof COL !== "undefined" && COL.PHONE && sheet && loggedRow >= 2 && loggedRow <= sheet.getLastRow()) {
            sheet.getRange(loggedRow, COL.PHONE).setValue(normPhone);
          }
        });
      } catch (_) {}
      try {
        workItemUpdate_(workItemId, { phoneE164: normPhone, metadataJson: JSON.stringify(meta) });
      } catch (_) {}
    } else {
      try {
        if (typeof workItemUpdate_ === "function") workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
      } catch (_) {}
    }
  }

  function upsertTenant_(propertyName, unit, phone, name) {
    const sh = ensureTenantsSheet_();
    const p = String(propertyName || "").trim();
    const u = String(unit || "").trim().toUpperCase();
    const ph = normalizePhone_(phone || "");
    const nm = String(name || "").trim();

    if (!p || !u || !ph) return;

    const lastRow = sh.getLastRow();
    if (lastRow < 2) {
      sh.appendRow([p, u, ph, nm, new Date(), "", "Yes"]);
      return;
    }

    const data = sh.getRange(2, 1, lastRow - 1, 7).getValues();
    for (let i = 0; i < data.length; i++) {
      const rp = String(data[i][0] || "").trim();
      const ru = String(data[i][1] || "").trim().toUpperCase();
      const rph = normalizePhone_(data[i][2] || "");
      if (rp === p && ru === u && rph === ph) {
        // update name if blank, update UpdatedAt, set Active Yes
        if (!String(data[i][3] || "").trim() && nm) sh.getRange(i + 2, 4).setValue(nm);
        sh.getRange(i + 2, 5).setValue(new Date());
        sh.getRange(i + 2, 7).setValue("Yes");
        return;
      }
    }

    // not found -> create new row (supports multiple phones per unit)
    sh.appendRow([p, u, ph, nm, new Date(), "", "Yes"]);
  }

  function mgrKey_(managerPhone) {
    return "MGR_PENDING_" + normalizePhone_(managerPhone);
  }

  function setMgrPending_(managerPhone, obj) {
    const props = PropertiesService.getScriptProperties();
    props.setProperty(mgrKey_(managerPhone), JSON.stringify(obj || {}));
  }

  function getMgrPending_(managerPhone) {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(mgrKey_(managerPhone));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch(e) { return null; }
  }

  function clearMgrPending_(managerPhone) {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty(mgrKey_(managerPhone));
  }


  function buildTicketList_(sheet, mode) {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return "No tickets yet.";

    const nRows = lastRow - 1;
    const data = sheet.getRange(2, 1, nRows, COL.HANDOFF_SENT).getValues();


    const now = new Date();
    const out = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];

      const ticketId = String(row[COL.TICKET_ID - 1] || "").trim();
      const status = String(row[COL.STATUS - 1] || "").trim() || "New";
      const unit = String(row[COL.UNIT - 1] || "").trim() || "?";
      const lastUpdate = row[COL.LAST_UPDATE - 1];

      const isClosed = /^(closed|completed)$/i.test(status);

      if (mode === "open") {
        if (isClosed) continue;
      } else if (mode === "waiting") {
        if (isClosed) continue;
        if (!/^waiting\b/i.test(status)) continue;
      }

      // ID should always exist, but fallback if blank
      const ref = ticketId || "(no id)";

      // Age like: now / 12m / 3h / 2d / 1mo
      const age = (lastUpdate instanceof Date) ? formatAge_(now, lastUpdate) : "?";

      out.push(`• ${ref} | ${unit} | ${status} | ${age}`);

      if (out.length >= 12) break;
    }

    if (!out.length) {
      return mode === "waiting" ? "No waiting tickets right now." : "No open tickets right now.";
    }

    const title = (mode === "waiting") ? "LIST WAITING" : "LIST OPEN";
    return title + "\n" + "ID | Unit | Status | Age\n" + out.join("\n");
  }

  function formatAge_(now, then) {
    const ms = now - then;
    const min = Math.floor(ms / 60000);
    if (min < 1) return "now";
    if (min < 60) return min + "m";

    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + "h";

    const day = Math.floor(hr / 24);
    if (day < 30) return day + "d";

    const mo = Math.floor(day / 30);
    return mo + "mo";
  }


  function fmtDateYYYYMMDD_(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}${mm}${dd}`;
  }

  function fmtDateMMDDYY_(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    const yy = String(dt.getFullYear()).slice(-2);
    return `${mm}${dd}${yy}`;
  }

  function makeTicketId_(propertyNameOrCode, now, rowIndex) {
    const when = (now instanceof Date) ? now : new Date(now);

    const r = parseInt(rowIndex, 10);
    const suffix = (isFinite(r) && r >= 2) ? String(r).padStart(4, "0") : "0000";

    let prefix = "";
    try {
      const p = (typeof getPropertyByNameOrKeyword_ === "function")
        ? getPropertyByNameOrKeyword_(propertyNameOrCode)
        : null;

      // ✅ Prefer TicketPrefix column
      prefix = p && p.ticketPrefix ? String(p.ticketPrefix).trim().toUpperCase() : "";
      // Fallback: property code only if it's already a short prefix
      if (!prefix && p && p.code) prefix = String(p.code).trim().toUpperCase();
    } catch (_) {}

    // final guard: keep it strict
    if (!prefix || !/^[A-Z0-9]{3,5}$/.test(prefix)) prefix = "UNK";

    return `${prefix}-${fmtDateMMDDYY_(when)}-${suffix}`;
  }


  function computeDueBy_(now, classification) {
    const d = new Date(now);

    if (classification?.emergency) {
      d.setMinutes(d.getMinutes() + 30); // emergency due in 30 min
      return d;
    }
    if (classification?.urgency === "Urgent") {
      d.setHours(d.getHours() + 4); // urgent due in 4 hours
      return d;
    }
    return ""; // Normal: blank
  }

  function setStatus_(sheet, rowIndex, status) {
    sheet.getRange(rowIndex, COL.STATUS).setValue(status);
    sheet.getRange(rowIndex, COL.LAST_UPDATE).setValue(new Date());
  }


  function isAfterHours_(d) {
    const day = d.getDay(); // 0 = Sun, 6 = Sat
    const hour = d.getHours();

    // Weekend = after-hours
    if (day === 0 || day === 6) return true;

    // Before 8am or after 6pm
    return (hour < 8 || hour >= 18);
  }


  function findDirectoryRowByPhone_(dirSheet, phone) {
    var targetRaw = String(phone || "").trim();
    var isScap = /^SCAP:/i.test(targetRaw);
    var targetNorm = isScap ? targetRaw : normalizePhone_(targetRaw);
    var lastRow = dirSheet.getLastRow();
    if (lastRow < 2) return 0;
    var col = (typeof DIR_COL !== "undefined" && DIR_COL.PHONE) ? DIR_COL.PHONE : 1;
    var numRows = lastRow - 1;
    var vals = dirSheet.getRange(2, col, numRows, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      var cellRaw = String(vals[i][0] || "").trim();
      if (isScap) {
        if (cellRaw === targetRaw) return i + 2;
      } else {
        if (normalizePhone_(cellRaw) === targetNorm) return i + 2;
      }
    }
    return 0;
  }


  function looksLikeUnitReply_(text) {
    const s = String(text || "").trim();
    if (!s) return false;

    // Must be 1-6 chars alnum (e.g., 210, 3B, 402A)
    if (!/^[A-Za-z0-9]{1,6}$/.test(s)) return false;

    // Reject property menu digits (dynamic: 1..N)
    if (/^\d+$/.test(s)) {
      const list = (typeof getActiveProperties_ === "function") ? getActiveProperties_() : [];
      const n = parseInt(s, 10);
      if (n >= 1 && n <= (list ? list.length : 0)) return false;
    }

    // Reject common junk words
    const bad = ["yes", "no", "ok", "okay", "thanks", "thankyou", "hello", "hi", "help", "service"];
    if (bad.includes(s.toLowerCase())) return false;

    // If contains letters, allow (3B, 402A)
    if (/[A-Za-z]/.test(s)) return true;

    // If numeric only, require >= 2 digits
    if (/^\d+$/.test(s)) return s.length >= 2 && s.length <= 5;

    return false;
  }

  function getDirPendingRow_(dirSheet, dirRow) {
    if (!dirRow) return 0;
    const v = dirSheet.getRange(dirRow, 7).getValue(); // Col G
    const n = parseInt(v, 10);
    return isFinite(n) ? n : 0;
  }

  function setDirPendingRow_(dirSheet, dirRow, rowNum) {
    if (!dirRow) return;
    dirSheet.getRange(dirRow, 7).setValue(rowNum ? Number(rowNum) : "");
  }

  // ✅ Propera Compass: clear stage fields but KEEP the active ticket pointer (PendingRow)
  // Do NOT clear PendingIssue (col 5) here — preserves issue across unit/schedule turns.
  function clearDirPending_(dirSheet, dirRow) {
    if (!dirRow) return;

    // E PendingIssue — leave intact to avoid wiping issue on later turns
    // dirSheet.getRange(dirRow, 5).setValue(""); // REMOVED: no empty overwrite
    // dirSheet.getRange(dirRow, 6).setValue(""); // PendingUnit (optional — leave commented)
    dirSheet.getRange(dirRow, 8).setValue(""); // PendingStage
  }

  // ✅ Only call this when you truly want to drop the pointer (cancel/close/start over)
  function clearDirTicketPointer_(dirSheet, dirRow) {
    if (!dirRow) return;
    dirSheet.getRange(dirRow, 7).setValue(""); // PendingRow
  }

  /** Normalize Directory PendingRow + PendingStage: clear ghost pointer if ticket closed/missing, or restore a sensible stage if pointer valid but stage blank. */
  function normalizeDirTicketPointer_(sheetTickets, dir, dirRow, phone) {
    var pr = dalGetPendingRow_(dir, dirRow) || 0;
    var st = String(dalGetPendingStage_(dir, dirRow) || "").trim().toUpperCase();
    if (pr < 2) return { ok: true, pendingRow: 0, pendingStage: "" };

    var status = "";
    try { status = String(sheetTickets.getRange(pr, COL.STATUS).getValue() || "").trim().toLowerCase(); } catch (e) { status = ""; }
    var closed = (status === "completed" || status === "canceled" || status === "cancelled" || status === "done" || status === "closed");

    if (!status || closed || pr < 2) {
      dalWithLock_("NORM_CLEAR_GHOST_PTR", function () {
        dalSetPendingRowNoLock_(dir, dirRow, "");
        dalSetPendingStageNoLock_(dir, dirRow, "");
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(phone || "", "", "DAL_WRITE NORM_CLEAR_GHOST_PTR row=" + dirRow + " pr=" + pr + " status=" + status); } catch (_) {}
      });
      return { ok: true, pendingRow: 0, pendingStage: "" };
    }

    if (!st) {
      var restoredStage = "SCHEDULE";
      try {
        var pref = String(sheetTickets.getRange(pr, COL.PREF_WINDOW).getValue() || "").trim();
        if (pref) restoredStage = "DETAIL";
      } catch (_) {}
      dalWithLock_("NORM_SET_STAGE_FROM_PTR", function () {
        dalSetPendingStageNoLock_(dir, dirRow, restoredStage);
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(phone || "", "", "DAL_WRITE NORM_SET_STAGE_FROM_PTR row=" + dirRow + " pr=" + pr + " stage=" + restoredStage); } catch (_) {}
      });
      st = restoredStage;
    }

    return { ok: true, pendingRow: pr, pendingStage: st };
  }


  function getTwilioMessageSid_(e) {
    return safeParam_(e, "MessageSid") || safeParam_(e, "SmsMessageSid");
  }

  /*******************************************************
  * isVendor_
  * Determines if a phone belongs to a registered vendor.
  * Deterministic, safe, no side effects.
  *******************************************************/
  function isVendor_(phoneE164) {
    try {
      if (!phoneE164) return false;

      // Normalize to digits
      const digits = String(normalizePhoneDigits_(phoneE164) || "").trim();
      if (!digits) return false;

      // Use last 10 digits (US-safe)
      const d10 = digits.slice(-10);
      if (!d10) return false;

      const vendor = getVendorByPhoneDigits_(d10);
      return !!vendor;

    } catch (_) {
      return false; // Never allow vendor check to crash router
    }
  }



  function isManager_(phoneAny) {
    try {
      const props = PropertiesService.getScriptProperties();

      // Allow either a single manager phone OR a CSV list
      const single = String(props.getProperty("ONCALL_NUMBER") || props.getProperty("MANAGER_PHONE") || "").trim();
      const csv    = String(props.getProperty("MANAGER_PHONES") || "").trim();

      const candidates = []
        .concat(single ? [single] : [])
        .concat(csv ? csv.split(",") : [])
        .map(s => String(s || "").trim())
        .filter(Boolean);

      const me10 = String(normalizePhoneDigits_(phoneAny || "")).slice(-10);
      if (!me10) return false;

      for (let i = 0; i < candidates.length; i++) {
        const c10 = String(normalizePhoneDigits_(candidates[i] || "")).slice(-10);
        if (c10 && c10 === me10) return true;
      }

      return false;
    } catch (_) {
      return false;
    }
  }

  // -----------------------------------------------------------------------------
  // Compatibility wrappers (Compass-safe)
  // -----------------------------------------------------------------------------
  function isManagerPhone_(phoneAny) { return isManager_(phoneAny); }
  function isVendorPhone_(phoneAny)  { return isVendor_(phoneAny); }





  function parseManagerCommand_(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;

    // LIST OPEN
    if (/^LIST\s+OPEN$/i.test(raw)) return { cmd: "LISTOPEN" };

    // LIST WAITING
    if (/^LIST\s+WAITING$/i.test(raw)) return { cmd: "LISTWAITING" };

    // STATUS <ref>
    let m = raw.match(/^STATUS\s+(.+)$/i);
    if (m) return { cmd: "STATUS", ref: String(m[1]).trim() };

    // SETSTATUS <ref> <status...>
    m = raw.match(/^SETSTATUS\s+(\S+)\s+(.+)$/i);
    if (m) return { cmd: "SETSTATUS", ref: String(m[1]).trim(), status: String(m[2]).trim() };

    // PICK (accept: "PICK 1" OR just "1" .. "6" only)
    m = raw.match(/^(?:PICK\s*)?([1-6])(?:[\)\.\:]*)$/i);
    if (m) return { cmd: "PICK", n: parseInt(m[1], 10) };

    // PHONE +1555...
    m = raw.match(/^PHONE\s+(\+?\d[\d\-\(\)\s]{9,})$/i);
    if (m) return { cmd: "PHONE", phone: normalizePhone_(m[1]) };

    // NEW TICKET (natural language, no FROM required)
    if (/^NEW\s+TICKET\b/i.test(raw)) {
      const parsed = parseNewTicketSmart_(raw);
      return parsed;
    }

    return null;
  }

  function extractPropertyChunkForMgr_(text) {
    // text here should already have FROM removed
    let t = String(text || "").trim();

    // Remove unit expressions if still present (belt and suspenders)
    t = t.replace(/\b(?:unit|apt|apartment|suite|ste|rm|room)\.?\s*[:#-]?\s*[a-z0-9]{1,6}\b/ig, " ").trim();
    t = t.replace(/#\s*[a-z0-9]{1,6}\b/ig, " ").trim();

    // Remove leading "need/needs" token if managers type "westfield need lights..."
    t = t.replace(/^\bneed(?:s)?\b\s+/i, "");

    // Property chunk heuristic:
    // take first up to 4 tokens (covers "the grand at westfield")
    const toks = t.split(/\s+/).filter(Boolean);
    if (!toks.length) return "";

    return toks.slice(0, 4).join(" ").trim();
  }




  function parseNewTicketSmart_(raw) {
    let text = String(raw || "").trim();
    if (!/^NEW\s+TICKET\b/i.test(text)) return null;

    // remove leading "NEW TICKET"
    text = text.replace(/^NEW\s+TICKET\b[:\-]?\s*/i, "").trim();

    // ✅ Capture FROM <anything> (phone OR name) and remove it from text
    let fromValue = "";
    const fromMatch = text.match(/\bFROM\b\s*[:=]?\s*(.+)$/i);
    if (fromMatch) {
      fromValue = String(fromMatch[1] || "").trim();
      text = text.slice(0, fromMatch.index).trim(); // remove "FROM ..."
    }

    // clean separators/spaces
    text = text.replace(/[,\|]+/g, " ").replace(/\s+/g, " ").trim();

    // ✅ Extract unit first (so property chunk can ignore it if needed)
    const unit = extractUnit_(text) || "";

    // ✅ Build a clean string for property extraction (remove unit patterns)
    // (This prevents "westfield 201 ..." from confusing resolver)
    let propScan = text;
    propScan = propScan.replace(/\b(?:unit|apt|apartment|suite|ste|rm|room)\.?\s*[:#-]?\s*[a-z0-9]{1,6}\b/ig, " ");
    propScan = propScan.replace(/#\s*[a-z0-9]{1,6}\b/ig, " ");
    if (unit) propScan = propScan.replace(new RegExp("\\b" + escRe_(String(unit)) + "\\b", "ig"), " ");
    propScan = propScan.replace(/\s+/g, " ").trim();

    // ✅ Use your helper: extract a SHORT property chunk (deterministic)
    // Assumes you already added: extractPropertyChunkForMgr_(text)
    const propChunk = extractPropertyChunkForMgr_(propScan);

    // ✅ Resolve ONLY from propChunk (strict; never fuzzy guess)
    // Prefer exact name/code lookup first, then strict resolver as backup
    const propObj =
      getPropertyByNameOrCode_(propChunk) ||
      resolvePropertyFromText_(propChunk, { strict: true });

    const propertyName = propObj ? String(propObj.name || "").trim() : "";
    const propertyCode = propObj ? String(propObj.code || "").trim().toUpperCase() : "";

    // issue: what's left after removing property/unit words
    let issue = text;

    // remove property name + code (if present)
    if (propertyName) issue = issue.replace(new RegExp(escRe_(propertyName), "ig"), " ");
    if (propertyCode) issue = issue.replace(new RegExp("\\b" + escRe_(propertyCode) + "\\b", "ig"), " ");

    // remove unit patterns + explicit unit token
    issue = issue.replace(/\b(?:unit|apt|apartment|suite|ste|rm|room)\.?\s*[:#-]?\s*[a-z0-9]{1,6}\b/ig, " ");
    issue = issue.replace(/#\s*[a-z0-9]{1,6}\b/ig, " ");
    if (unit) issue = issue.replace(new RegExp("\\b" + escRe_(String(unit)) + "\\b", "ig"), " ");

    issue = issue.replace(/\s+/g, " ").trim();

    return {
      cmd: "NEWTICKET",
      propertyName,
      propertyCode,
      unit: String(unit || "").trim(),
      issue: String(issue || "").trim(),
      fromRaw: String(fromValue || "").trim() // phone OR name lives here
    };
  }



  function escRe_(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }


  function ensureDirectoryForTenant_(dir, tenantPhone, propertyNameMaybe) {
    const phone = normalizePhone_(tenantPhone);
    if (!phone) return 0;

    let dirRow = findDirectoryRowByPhone_(dir, phone);
    if (!dirRow) {
      dir.appendRow([phone, "", propertyNameMaybe || "", new Date(), "", "", "", "", "", ""]);
      dirRow = dir.getLastRow();
    } else {
      if (propertyNameMaybe) {
        dalWithLock_("DIR_UPDATE_PROPERTY_NAME", function () {
          dalSetPendingPropertyNoLock_(dir, dirRow, { name: propertyNameMaybe });
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE DIR_UPDATE_PROPERTY_NAME row=" + dirRow); } catch (_) {}
        });
      } else {
        dalWithLock_("DIR_TOUCH_ROW", function () {
          dalSetLastUpdatedNoLock_(dir, dirRow);
        });
      }
    }
    return dirRow;
  }


  function phoneDigits10_(phoneAny) {
    const d = String(normalizePhoneDigits_(phoneAny || "") || "").trim();
    return d ? d.slice(-10) : "";
  }

  function isKnownTenantPhone_(phoneAny) {
    try {
      const d10 = phoneDigits10_(phoneAny);
      if (!d10) return false;
      const t = lookupTenantByPhoneDigits_(d10);
      return !!t;
    } catch (_) {
      return false;
    }
  }


  function withWelcome_(welcomeLine, msg) {
    const w = String(welcomeLine || "").trim();
    const m = String(msg || "").trim();
    if (!m) return "";
    return w ? (w + "\n\n" + m) : m;
  }

  function sendLoggedThenAskWindow_(sid, token, fromNum, toNum, lang, vars) {
    const L = String(lang || "en").toLowerCase();
    const V = vars || {};
    const confirm = tenantMsg_("TENANT_TICKET_LOGGED_CONFIRM", L, V);
    const askWindow = tenantMsg_("ASK_WINDOW", L, V);
    sendSms_(sid, token, fromNum, toNum, confirm + "\n\n" + askWindow);
  }

  function looksActionableIssue_(s) {
    const t = String(s || "").toLowerCase().trim();
    if (!t) return false;

    if (isResolvedOrDismissedClause_(t)) return false;

    // Very short messages are usually not actionable
    if (t.length < 6) return false;

    // Obvious acknowledgements / filler
    if (/^(ok|okay|k|yes|no|yep|nope|sure|thanks|thank you|cool|great|\?)$/.test(t)) return false;

    // Strong maintenance verbs / intents (include "maintenance" so "MAINTENANCE" alone is actionable)
    if (/(leak|leaking|drip|dripping|clog|backup|flood|water|toilet|sink|shower|tub|heater|ac|a\/c|heat|no heat|no hot|hot water|electric|outlet|breaker|sparks|smoke|gas|odor|mold|roach|bug|mouse|lock|door|key|window|broken|not working|doesn'?t work|maintenance)/.test(t)) {
      return true;
    }

    // If it has a problem verb, treat as actionable (include "stop working" / "stops working")
    if (/(not working|doesn'?t work|broken|won'?t|wont|stopped|stop\s+working|stops?\s+working|leak|clog|smell|noise|sparks|tripping|overflow|backup|no heat|no hot|not heating|not cooling|doesn'?t drain|not draining)/.test(t)) return true;

    // Otherwise require meaningful length/detail
    const wordCount = t.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 6 && t.length >= 25) return true;

    return false;
  }

  /** True when the clause only asks for a visit/schedule, not a second problem (e.g. "please have maintenance schedule to check it"). */
  function isScheduleIntentOnly_(s) {
    var t = String(s || "").toLowerCase().trim();
    if (!t || t.length > 120) return false;
    if ((typeof looksActionableIssue_ === "function") && looksActionableIssue_(t)) return false;
    if (/\b(leak|clog|broken|not working|stopped|ac\b|heat\b|toilet|sink|gym|lobby|hallway)\b/.test(t)) return false;
    var scheduleAsk =
      /\b(please\s+)?(have\s+)?(maintenance\s+)?(schedule|someone)\s+(to\s+)?(check|come|look|fix|repair|inspect)/.test(t) ||
      /\b(when\s+can\s+(someone|you|maintenance)\s+come)\b/.test(t) ||
      /\b(please\s+)?(schedule|send)\s+(someone|maintenance|a\s+tech)/.test(t) ||
      /\b(need\s+someone\s+to\s+check)\b/.test(t) ||
      /\b(can\s+someone\s+come\s+(out|by))\b/.test(t);
    return scheduleAsk;
  }

  /** Return true if text looks like a schedule/window reply (today, tomorrow, weekday, time). Compass-safe. */
  function isScheduleLike_(s) {
    var t = String(s || "").toLowerCase().trim();
    if (!t) return false;
    if (/today|tomorrow/.test(t)) return true;
    if (/\b(mon|tue|wed|thu|fri|sat|sun)(sday|sday)?\b/.test(t)) return true;
    if (/\b(morning|afternoon|evening)\b/.test(t)) return true;
    if (/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(t)) return true;
    if (/\b\d{1,2}\s*-\s*\d{1,2}\s*(am|pm)?\b/.test(t)) return true;
    return false;
  }

  /** Strict schedule/window detector used ONLY for suppression + schedule writes. */
  function isScheduleWindowLike_(s) {
    var t = String(s || "").toLowerCase().trim();
    if (!t) return false;

    var hasDay =
      /today|tomorrow/.test(t) ||
      /\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/.test(t);

    var hasTime =
      /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(t) ||
      /\b\d{1,2}\s*-\s*\d{1,2}\s*(am|pm)?\b/.test(t);

    var hasAvailability =
      /\b(available|availability|free|home|around|can you come|come by|stop by|anytime)\b/.test(t);

    var hasDayPart = /\b(morning|afternoon|evening)\b/.test(t);

    // daypart alone is NOT enough
    if (hasDayPart && (hasDay || hasTime || hasAvailability)) return true;

    // day or time alone is enough
    if (hasDay || hasTime) return true;

    return false;
  }

  function isWeakIssue_(s) {
    const v = String(s || "").trim().toLowerCase();
    if (!v) return true;

    var weakList = [
      "hi",
      "hello",
      "hey",
      "help",
      "need help",
      "hi need help",
      "please",
      "anyone"
    ];

    if (weakList.indexOf(v) !== -1) return true;
    if (v.length <= 12 && v.indexOf(" ") === -1) return true;
    return false;
  }

  function looksSpecificIssue_(s) {
    const v = String(s || "").trim().toLowerCase();
    if (!v) return false;

    var keywords = [
      "sink",
      "toilet",
      "leak",
      "clog",
      "water",
      "heat",
      "ac",
      "electric",
      "smell",
      "fire",
      "alarm",
      "door",
      "lock",
      "washer",
      "dryer",
      "fridge",
      "oven",
      "stove",
      "pipe",
      "ceiling",
      "wall",
      "window"
    ];

    for (var i = 0; i < keywords.length; i++) {
      if (v.indexOf(keywords[i]) !== -1) return true;
    }

    if (v.length > 15 && v.indexOf(" ") !== -1) return true;

    return false;
  }

  function safeParam_(e, key) {
    if (!e || !e.parameter || !e.parameter[key]) return "";
    return String(e.parameter[key]).trim();
  }

  function getSheet_(name) {
    var sh = getLogSheetByNameCached_(name);
    if (!sh) throw new Error('Sheet tab not found: "' + name + '"');
    return sh;
  }


  function setDirPendingStage_(dirSheet, dirRow, stage) {
    if (!dirRow) return;
    dirSheet.getRange(dirRow, 8).setValue(stage || "");
  }

  function getDirPendingStage_(dirSheet, dirRow) {
    if (!dirRow) return "";
    return String(dirSheet.getRange(dirRow, 8).getValue() || "").trim();
  }


  function normalizePhone_(p) {
    let s = String(p || "").trim();
    if (!s) return "";

    const digits = s.replace(/[^\d]/g, "");

    // Reject anything that isn't plausibly a phone number
    // (prevents SCAP:D3 -> +13, "17" -> +17, etc.)
    if (digits.length < 10) return "";

    // US 10-digit
    if (digits.length === 10) return "+1" + digits;

    // US 11-digit starting with 1
    if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;

    // E164-ish: keep plus if present and length is reasonable
    if (s.startsWith("+") && digits.length >= 11) return "+" + digits;

    // Otherwise reject (don't guess country codes)
    return "";
  }

  /****************************
  * Tenant language (Spanish-ready)
  * For now: always English (no behavior change)
  ****************************/
  const DIR_COL = {
    PHONE: 1,
    PROPERTY_CODE: 2,
    PROPERTY_NAME: 3,
    LAST_UPDATED: 4,
    PENDING_ISSUE: 5,
    PENDING_UNIT: 6,
    PENDING_ROW: 7,
    PENDING_STAGE: 8,
    HANDOFF_SENT: 9,
    WELCOME_SENT: 10,
    ACTIVE_TICKET_KEY: 11,
    ISSUE_BUF_JSON: 12,
    DRAFT_SCHEDULE_RAW: 13,
    UNIT: 14  // canonical identity unit (draft-only is PENDING_UNIT)
  };

  // ============================================================
  // DAL — Data Access Layer (Propera Compass)
  // Purpose: centralize Sheets reads/writes + logging + locks
  // After this point, do not use getRange on Directory/Tickets directly
  // inside business logic; add DAL wrappers instead.
  // ============================================================

  var DAL_LOG_LEN = 50;

  function dalWithLock_(label, fn) {
    return withWriteLock_(label, fn);
  }

  /** Return directory row index for phone (1-based), or 0. Reuses findDirectoryRowByPhone_. */
  function dalGetDirRowByPhone_(dirSheet, phone) {
    if (typeof findDirectoryRowByPhone_ !== "function") return 0;
    return findDirectoryRowByPhone_(dirSheet, phone) || 0;
  }

  /** Read PendingRow (col G). */
  function dalGetPendingRow_(dirSheet, dirRow) {
    if (!dirRow || dirRow < 2) return 0;
    if (typeof getDirPendingRow_ === "function") return getDirPendingRow_(dirSheet, dirRow) || 0;
    var v = dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_ROW : 7).getValue();
    var n = parseInt(v, 10);
    return isFinite(n) ? n : 0;
  }

  /** Internal: write PendingRow (col G) only. No lock, no log, no LastUpdated. Call inside dalWithLock_; set LastUpdated once at end of group. */
  function dalSetPendingRowNoLock_(dirSheet, dirRow, pendingRow) {
    if (!dirRow || dirRow < 2) return;
    var val = (pendingRow != null && pendingRow !== "") ? Number(pendingRow) : "";
    dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_ROW : 7).setValue(val);
  }

  /** Internal: set LastUpdated (col D) only. No lock, no log. Call once at end of grouped NoLock writes. */
  function dalSetLastUpdatedNoLock_(dirSheet, dirRow) {
    if (!dirRow || dirRow < 2) return;
    dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.LAST_UPDATED : 4).setValue(new Date());
  }

  /** Write PendingRow (col G); locked + DAL_WRITE log. */
  function dalSetPendingRow_(dirSheet, dirRow, pendingRow, phone, reason) {
    if (!dirRow || dirRow < 2) return;
    var val = (pendingRow != null && pendingRow !== "") ? Number(pendingRow) : "";
    dalWithLock_("DAL_SET_PENDING_ROW", function () {
      dalSetPendingRowNoLock_(dirSheet, dirRow, pendingRow);
      dalSetLastUpdatedNoLock_(dirSheet, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingRow row=" + dirRow + " val=[" + String(val).slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
    });
  }

  /** Read PendingStage (col H). */
  function dalGetPendingStage_(dirSheet, dirRow) {
    if (!dirRow || dirRow < 2) return "";
    if (typeof getDirPendingStage_ === "function") return String(getDirPendingStage_(dirSheet, dirRow) || "").trim();
    return String(dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_STAGE : 8).getValue() || "").trim();
  }

  /** Internal: write PendingStage (col H) only. No lock, no log, no LastUpdated. Call inside dalWithLock_; set LastUpdated once at end of group. */
  function dalSetPendingStageNoLock_(dirSheet, dirRow, stage) {
    if (!dirRow || dirRow < 2) return;
    var val = String(stage != null ? stage : "").trim();
    dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_STAGE : 8).setValue(val);
  }

  /** Write PendingStage (col H); locked + DAL_WRITE log. */
  function dalSetPendingStage_(dirSheet, dirRow, stage, phone, reason) {
    if (!dirRow || dirRow < 2) return;
    var val = String(stage != null ? stage : "").trim();
    dalWithLock_("DAL_SET_PENDING_STAGE", function () {
      dalSetPendingStageNoLock_(dirSheet, dirRow, stage);
      dalSetLastUpdatedNoLock_(dirSheet, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingStage row=" + dirRow + " val=[" + val.slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
    });
  }

  /** Read property code (col B) and name (col C). */
  function dalGetPendingProperty_(dirSheet, dirRow) {
    if (!dirRow || dirRow < 2) return { code: "", name: "" };
    var c = typeof DIR_COL !== "undefined" ? DIR_COL.PROPERTY_CODE : 2;
    var n = typeof DIR_COL !== "undefined" ? DIR_COL.PROPERTY_NAME : 3;
    return {
      code: String(dirSheet.getRange(dirRow, c).getValue() || "").trim(),
      name: String(dirSheet.getRange(dirRow, n).getValue() || "").trim()
    };
  }

  /** Internal: write property code (col B) and/or name (col C) only. payload: { code: "", name: "" }. No lock, no log, no LastUpdated. */
  function dalSetPendingPropertyNoLock_(dirSheet, dirRow, payload) {
    if (!dirRow || dirRow < 2) return;
    if (payload && payload.code !== undefined) dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PROPERTY_CODE : 2).setValue(String(payload.code || "").trim());
    if (payload && payload.name !== undefined) dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PROPERTY_NAME : 3).setValue(String(payload.name || "").trim());
  }

  /** Write property code (col B) and/or name (col C). payload: { code: "", name: "" }. Locked + log. */
  function dalSetPendingProperty_(dirSheet, dirRow, payload, phone, reason) {
    if (!dirRow || dirRow < 2) return;
    var code = (payload && payload.code !== undefined) ? String(payload.code || "").trim() : "";
    var name = (payload && payload.name !== undefined) ? String(payload.name || "").trim() : "";
    dalWithLock_("DAL_SET_PENDING_PROPERTY", function () {
      dalSetPendingPropertyNoLock_(dirSheet, dirRow, payload);
      dalSetLastUpdatedNoLock_(dirSheet, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingProperty row=" + dirRow + " val=[" + (code || name).slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
    });
  }

  /** Read PendingUnit (col F). */
  function dalGetPendingUnit_(dirSheet, dirRow) {
    if (!dirRow || dirRow < 2) return "";
    return String(dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_UNIT : 6).getValue() || "").trim();
  }

  /** Internal: write PendingUnit (col F) only. No lock, no log, no LastUpdated. Call inside dalWithLock_; set LastUpdated once at end of group. */
  function dalSetPendingUnitNoLock_(dirSheet, dirRow, unit) {
    if (!dirRow || dirRow < 2) return;
    var val = String(unit != null ? unit : "").trim();
    dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_UNIT : 6).setValue(val);
  }

  /** Write PendingUnit (col F); locked + log. */
  function dalSetPendingUnit_(dirSheet, dirRow, unit, phone, reason) {
    if (!dirRow || dirRow < 2) return;
    var val = String(unit != null ? unit : "").trim();
    dalWithLock_("DAL_SET_PENDING_UNIT", function () {
      dalSetPendingUnitNoLock_(dirSheet, dirRow, unit);
      dalSetLastUpdatedNoLock_(dirSheet, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingUnit row=" + dirRow + " val=[" + val.slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
    });
  }

  /** Invalid-unit guard (no "0", "na", etc.). */
  function isInvalidUnit_(u) {
    const s = String(u || "").trim().toLowerCase();
    return !s || s === "0" || s === "00" || s === "000" || s === "na" || s === "n/a" ||
          s === "none" || s === "unknown" || s === "-" || s === "?";
  }

  /** Read canonical Unit (col 14). */
  function dalGetUnit_(dirSheet, dirRow) {
    if (!dirRow || dirRow < 2) return "";
    return String(dirSheet.getRange(dirRow, DIR_COL.UNIT).getValue() || "").trim();
  }

  /** Internal: write canonical Unit (learn-only in caller). No lock. */
  function dalSetUnitNoLock_(dirSheet, dirRow, unit) {
    if (!dirRow || dirRow < 2) return;
    const val = String(unit != null ? unit : "").trim();
    if (isInvalidUnit_(val)) return;
    dirSheet.getRange(dirRow, DIR_COL.UNIT).setValue(val);
  }

  /** Write canonical Unit (learn-only: do not overwrite existing). Locked + log. */
  function dalSetUnit_(dirSheet, dirRow, unit, phone, reason) {
    if (!dirRow || dirRow < 2) return;
    const val = String(unit != null ? unit : "").trim();
    if (isInvalidUnit_(val)) return;

    dalWithLock_("DAL_SET_UNIT", function () {
      const cur = String(dirSheet.getRange(dirRow, DIR_COL.UNIT).getValue() || "").trim();
      if (cur) return;

      dalSetUnitNoLock_(dirSheet, dirRow, val);
      dalSetLastUpdatedNoLock_(dirSheet, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE field=Unit row=" + dirRow + " val=[" + val.slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
    });
  }

  /** Read PendingIssue (col E). */
  function dalGetPendingIssue_(dirSheet, dirRow) {
    if (!dirRow || dirRow < 2) return "";
    return String(dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_ISSUE : 5).getValue() || "").trim();
  }

  /** Internal: overwrite PendingIssue (col E) only. No lock, no log, no LastUpdated. Call inside dalWithLock_; set LastUpdated once at end of group. */
  function dalSetPendingIssueNoLock_(dirSheet, dirRow, issue) {
    if (!dirRow || dirRow < 2) return;
    var val = String(issue != null ? issue : "").trim();
    if (val.length > 500) val = val.slice(0, 500);
    dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_ISSUE : 5).setValue(val);
  }

  /** Overwrite PendingIssue (col E); locked + log. */
  function dalSetPendingIssue_(dirSheet, dirRow, issue, phone, reason) {
    if (!dirRow || dirRow < 2) return;
    var val = String(issue != null ? issue : "").trim();
    if (val.length > 500) val = val.slice(0, 500);
    dalWithLock_("DAL_SET_PENDING_ISSUE", function () {
      dalSetPendingIssueNoLock_(dirSheet, dirRow, issue);
      dalSetLastUpdatedNoLock_(dirSheet, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingIssue row=" + dirRow + " val=[" + val.slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
    });
  }

  /** Append to PendingIssue with " | " separator; locked + log. Truncates combined to 500. */
  function dalAppendPendingIssue_(dirSheet, dirRow, fragment, phone, reason) {
    if (!dirRow || dirRow < 2 || !fragment) return;
    var sep = " | ";
    var existing = dalGetPendingIssue_(dirSheet, dirRow);
    var combined = existing ? (existing + sep + String(fragment).trim()) : String(fragment).trim();
    if (combined.length > 500) combined = combined.slice(0, 500);
    dalWithLock_("DAL_APPEND_PENDING_ISSUE", function () {
      dalSetPendingIssueNoLock_(dirSheet, dirRow, combined);
      dalSetLastUpdatedNoLock_(dirSheet, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingIssue append row=" + dirRow + " val=[" + String(fragment).slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
    });
  }

  /** Tenant language; wrapper (no Directory column today). */
  function dalGetLang_(dirSheet, dirRow, phone) {
    if (typeof getTenantLang_ === "function") return getTenantLang_(dirSheet, dirRow, phone, "");
    return "en";
  }

  // --- Ticket DAL (minimal) ---

  /** Snapshot of ticket row fields already used (property, unit, issue, schedule, status). */
  function dalTicketGetRowSnapshot_(ticketSheet, row) {
    if (!ticketSheet || !row || row < 2 || typeof COL === "undefined") return { property: "", unit: "", issue: "", schedule: "", status: "" };
    try {
      return {
        property: String(ticketSheet.getRange(row, COL.PROPERTY).getValue() || "").trim(),
        unit: String(ticketSheet.getRange(row, COL.UNIT).getValue() || "").trim(),
        issue: String(ticketSheet.getRange(row, COL.MSG).getValue() || "").trim(),
        schedule: String(ticketSheet.getRange(row, COL.PREF_WINDOW).getValue() || "").trim(),
        status: String(ticketSheet.getRange(row, COL.STATUS).getValue() || "").trim()
      };
    } catch (_) {
      return { property: "", unit: "", issue: "", schedule: "", status: "" };
    }
  }

  /** Set ticket PreferredWindow; locked + log. */
  function dalTicketSetSchedule_(ticketSheet, row, scheduleText, phone, reason) {
    if (!ticketSheet || !row || row < 2 || typeof COL === "undefined") return;
    var val = String(scheduleText != null ? scheduleText : "").trim();
    dalWithLock_("DAL_TICKET_SET_SCHEDULE", function () {
      ticketSheet.getRange(row, COL.PREF_WINDOW).setValue(val);
      ticketSheet.getRange(row, COL.LAST_UPDATE).setValue(new Date());
      try { logDevSms_(phone || "", "", "DAL_WRITE ticket row=" + row + " field=PREF_WINDOW val=[" + val.slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
    });
  }

  /** Append to ServiceNotes if column exists; locked + log. */
  function dalTicketAppendNote_(ticketSheet, row, note, phone, reason) {
    if (!ticketSheet || !row || row < 2 || typeof COL === "undefined" || !COL.SERVICE_NOTES) return;
    var existing = String(ticketSheet.getRange(row, COL.SERVICE_NOTES).getValue() || "").trim();
    var combined = existing ? (existing + "\n" + String(note).trim()) : String(note).trim();
    if (combined.length > 5000) combined = combined.slice(-5000);
    dalWithLock_("DAL_TICKET_APPEND_NOTE", function () {
      ticketSheet.getRange(row, COL.SERVICE_NOTES).setValue(combined);
      ticketSheet.getRange(row, COL.LAST_UPDATE).setValue(new Date());
      try { logDevSms_(phone || "", "", "DAL_WRITE ticket row=" + row + " field=SERVICE_NOTES append reason=" + (reason || "")); } catch (_) {}
    });
  }

  // ============================================================

  /** Parse staff-capture draft id from payload: "d123", "#d123", "d123: rest", "#d26 Morris" → { draftId: "D123", rest: "rest" }. */
  function parseStaffCapDraftId_(s) {
    var t = String(s || "").trim();
    var match = t.match(/^#?d(\d+)\s*[:\-]?\s*(.*)$/i);
    if (match) return { draftId: "D" + match[1], rest: String(match[2] || "").trim() };
    return { draftId: "", rest: t };
  }

  /** True only when payload is truly empty after trim. Short values like 'Morris' or '219' are NOT status-only. */
  function isStaffDraftStatusOnlyPayload_(payloadText) {
    return String(payloadText || "").trim().length === 0;
  }

  /** Next staff-capture draft id (STAFFCAP_SEQ in Script Properties). */
  function nextStaffCapDraftId_() {
    // Atomic increment (prevents two concurrent staff messages generating same D#)
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var sp = PropertiesService.getScriptProperties();
      var v = String(sp.getProperty("STAFFCAP_SEQ") || "0").trim();
      var seq = parseInt(v, 10) || 0;
      seq += 1;
      sp.setProperty("STAFFCAP_SEQ", String(seq));
      return "D" + seq;
    } finally {
      try { lock.releaseLock(); } catch (_) {}
    }
  }

  /** Ensure a Directory row exists for phone; create minimal stub if missing. Safe for staff capture. */
  function ensureDirectoryRowForPhone_(dir, phone) {
    var targetRaw = String(phone || "").trim();
    var isScap = /^SCAP:/i.test(targetRaw);
    var isPortalPm = /^PORTAL_PM:/i.test(targetRaw);
    var exactKeyOnly = isScap || isPortalPm;
    var targetNorm = exactKeyOnly ? targetRaw : normalizePhone_(targetRaw);
    var lastRow = dir.getLastRow();
    var col = (typeof DIR_COL !== "undefined" && DIR_COL.PHONE) ? DIR_COL.PHONE : 1;
    var matches = [];
    if (lastRow >= 2) {
      try {
        var numRows = lastRow - 1;
        var vals = dir.getRange(2, col, numRows, 1).getValues();
        for (var i = 0; i < vals.length; i++) {
          var cellRaw = String(vals[i][0] || "").trim();
          if (exactKeyOnly) {
            if (cellRaw === targetRaw) matches.push(i + 2);
          } else {
            if (normalizePhone_(cellRaw) === targetNorm) matches.push(i + 2);
          }
        }
      } catch (_) {}
    }
    if (matches.length > 0) {
      if (matches.length > 1) {
        try { logDevSms_(phone || "", "", "DIR_DUP_PHONE key=[" + targetRaw + "] count=[" + matches.length + "] first=[" + matches[0] + "] last=[" + matches[matches.length - 1] + "]"); } catch (_) {}
      }
      return matches[0];
    }

    // Allocate newRow inside lock so concurrent requests get different rows (avoids ACTIVE_TICKET_EXISTS race).
    var newRow;
    dalWithLock_("DIR_CREATE_STUB", function () {
      newRow = dir.getLastRow() + 1;
      dir.getRange(newRow, typeof DIR_COL !== "undefined" ? DIR_COL.PHONE : 1).setValue(phone);
      dalSetLastUpdatedNoLock_(dir, newRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE DIR_CREATE_STUB newRow=" + newRow); } catch (_) {}
    });
    return newRow;
  }

  // Later: add LANGUAGE: 10 (K)


  // For now returns "en" always (no behavior change)
  function getTenantLang_(dirSheet, dirRow, phone, bodyRaw) {
    return "en";
  }

  /****************************
  * Tenant message templates
  ****************************/
  const BRAND = {
    name: "The Grand Automated System",
    team: "The Grand Service Team"
  };

  /**
  * tenantMsg_(key, lang, vars)
  * - key: one of the keys above
  * - lang: "en" (future: "es")
  * - vars: optional object for template variables
  */
  // Templates sheet columns (1-indexed):
  // A TemplateID | B TemplateKey | C TemplateName | D TemplateBody

  const TEMPLATES_SHEET_NAME = "Templates";

  function tenantMsg_(key, lang, vars) {
    const k = String(key || "").trim();
    const L = String(lang || "en").trim().toLowerCase();
    const dataIn = vars || {};

    // Always inject brand defaults (caller can override)
    const data = Object.assign({
      brandName: BRAND.name,
      teamName: BRAND.team
    }, dataIn);

    const map = getTemplateMapCached_();

    // Primary: TemplateKey; fallback: TemplateName
    let body = "";
    if (map.byKey && map.byKey[k]) body = map.byKey[k];
    else if (map.byName && map.byName[k]) body = map.byName[k];

    if (!body) {
      try { logDevSms_("", "TEMPLATE_MISSING key=[" + k + "] lang=[" + L + "] Add this key to Templates sheet.", "ERR_TEMPLATE"); } catch (_) {}
      // No long hardcoded tenant-facing copy in MAIN. All tenant text must live in Templates sheet.
      // Minimal safe fallback only when key is missing (GSM-7 safe, no 911/safety wording).
      if (k === "TICKET_CREATED_COMMON_AREA") {
        body = "We have logged your request. Thank you." + (data.ticketId ? " Ticket ID: {ticketId}." : "");
      } else if (k === "CLEANING_WORKITEM_ACK") {
        body = "We have logged this cleaning request. Staff have been notified.";
      } else if (k === "EMERGENCY_TENANT_ACK") {
        body = "We have been notified. Thank you." + (data.ticketId ? " Ticket ID: {ticketId}." : "");
      } else {
        return ""; // safe non-user-text fallback
      }
    }

    body = sanitizeTemplateBody_(body);
    return renderTemplatePlaceholders_(body, data);
  }

  function getTemplateMapCached_() {
    const cache = CacheService.getScriptCache();
    const cacheKey = "TEMPLATE_MAP_V2";
    const cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (_) {}
    }

    const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    const sh = ss.getSheetByName(TEMPLATES_SHEET_NAME);
    if (!sh) return { byKey: {}, byName: {} };

    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 4) return { byKey: {}, byName: {} };

    const rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    const byKey = {};
    const byName = {};

    for (let i = 0; i < rows.length; i++) {
      const templateKey  = String(rows[i][1] || "").trim(); // col B
      const templateName = String(rows[i][2] || "").trim(); // col C
      const templateBody = String(rows[i][3] || "");        // col D

      if (templateKey) byKey[templateKey] = templateBody;
      if (templateName) byName[templateName] = templateBody;
    }

    const map = { byKey, byName };
    try { cache.put(cacheKey, JSON.stringify(map), 300); } catch (_) {} // 5 min
    return map;
  }

  function sanitizeTemplateBody_(body) {
    let s = String(body || "");

    // Strip wrapping quotes if sheet stored them like: "Hello\nWorld"
    s = s.replace(/^\s*"\s*([\s\S]*?)\s*"\s*$/, "$1");

    // Normalize Windows newlines
    s = s.replace(/\r\n/g, "\n");

    // Trim trailing whitespace-only lines
    s = s.replace(/[ \t]+\n/g, "\n");

    return s;
  }

  function renderTemplatePlaceholders_(body, vars) {
    const s = String(body || "");
    const v = vars || {};
    return s.replace(/\{([a-zA-Z0-9_]+)\}/g, function(_, name) {
      const val = v[name];
      return (val === undefined || val === null) ? "" : String(val);
    });
  }


  // Central message dictionary (English only for now)


  /****************************
  * SMS HANDLER (SMART)
  ****************************/
  /****************************
  * SMS HANDLER (SMART) — CLEAN VERSION (PATCHED)
  ****************************/
  function handleSms_(e) {
    return handleSmsSafe_(e);
  }

  // Crash shield wrapper (Compass safety layer)
  function handleSmsSafe_(e) {
    const started = new Date();
    let from = "", body = "", sid = "";
    try {
      from = safeParam_(e, "From") || "";
      body = safeParam_(e, "Body") || "";
      sid  = safeParam_(e, "MessageSid") || safeParam_(e, "SmsMessageSid") || "";

      // Always log inbound once
      try { logDevSms_(from, body, "INBOUND"); } catch (_) {}

      // Core
      return handleSmsCore_(e);

    } catch (err) {
      // Always log crash
      try { logDevSms_(from, String(err && err.stack ? err.stack : err), "CRASH"); } catch (_) {}

      // Soft fallback reply (template-driven) — via Outgate when available
      try {
        const baseVars = { brandName: BRAND.name, teamName: BRAND.team, __welcomeLine: welcomeLine };
        var _ogErr = (typeof dispatchOutboundIntent_ === "function" && from) ? dispatchOutboundIntent_({ intentType: "ERROR_TRY_AGAIN", recipientType: "TENANT", recipientRef: from, lang: "en", channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "handleSmsSafe_", stage: "CRASH", flow: "FALLBACK" } }) : { ok: false };
        if (!(_ogErr && _ogErr.ok)) reply_(renderTenantKey_("ERR_GENERIC_TRY_AGAIN", "en", baseVars));
      } catch (_) {}

      return;
    }
  }

  // ===================================================================
  // ===== M3 — CORE PIPELINE (Orchestrator) ============================
  // @MODULE:M3
  // Flow:
  // compileTurn_()
  // draftUpsertFromTurn_()
  // recomputeDraftExpected_()
  // resolveEffectiveTicketState_()
  // ===================================================================

  /**
  * classifyTenantSignals_
  * Pure function — no reads, no writes, no side effects.
  * Returns tone enum + priorRef string for template injection.
  */
  function classifyTenantSignals_(bodyTrim, ctx) {
    var NULL_SIGNALS = { isRecurring: false, isPostService: false, isFrustrated: false, isUrgent: false, tone: "", priorRef: "" };

    try {
      var b = String(bodyTrim || "").trim();

      // Guard: internal turns, single-digit picks, empty body
      if (!b) return NULL_SIGNALS;
      if (/^[1-5]$/.test(b)) return NULL_SIGNALS;
      if (b === "service" || b === "maintenance" || b === "leasing") return NULL_SIGNALS;
      if (ctx && ctx.internal === true) return NULL_SIGNALS;

      var lower = b.toLowerCase();

      var isUrgent      = /\b(flood(ing)?|no heat|no hot water|emergency|gas leak|leak|fire)\b/i.test(b);
      var isPostService = (function() {
        var serviceTokens = /\b(fixed|repaired?|came|visited|maintenance|plumber|tech|service|serviceman|repairman)\b/i.test(b);
        var pastTokens    = /\b(after|since|last time|already|before|when you)\b/i.test(b);
        return serviceTokens && pastTokens;
      })();
      var isRecurring   = /\b(still|again|same|back again|keeps?|keeps? happening|same issue|same problem)\b/i.test(b);
      var isFrustrated  = /\b(ridiculous|frustrated?|never works?|always broken|unacceptable|tired of|sick of)\b/i.test(b);

      // Strict precedence
      var tone = "";
      if (isUrgent)      tone = "urgent";
      else if (isPostService) tone = "postService";
      else if (isRecurring)   tone = "recurring";
      else if (isFrustrated)  tone = "frustrated";

      // priorRef: ID snippet only, no reads needed
      var priorRef = "";
      try {
        var wiId = String((ctx && (ctx.activeWorkItemId || ctx.pendingWorkItemId)) || "").trim();
        if (wiId) {
          var shortId = wiId.slice(-6).toUpperCase();
          priorRef = " (ref " + shortId + ")";
        }
      } catch (_) {}

      return { isRecurring: isRecurring, isPostService: isPostService, isFrustrated: isFrustrated, isUrgent: isUrgent, tone: tone, priorRef: priorRef };

    } catch (_) {
      return NULL_SIGNALS;
    }
  }

  function handleSmsCore_(e) {

    const t0 = Date.now();   // ⏱️ START TIMER

    // IMPORTANT: SID cache is written ONLY if the run finishes without crashing.
    let hadError = false;
    let sidKey = "";

    try {
      const props = PropertiesService.getScriptProperties();

      const OPENAI_API_KEY = props.getProperty("OPENAI_API_KEY");
      const TWILIO_SID = props.getProperty("TWILIO_SID");
      const TWILIO_TOKEN = props.getProperty("TWILIO_TOKEN");
      const TWILIO_NUMBER = props.getProperty("TWILIO_NUMBER");
      const ONCALL_NUMBER = props.getProperty("ONCALL_NUMBER");

      const sheet = getSheet_(SHEET_NAME);
      const dir = getSheet_(DIRECTORY_SHEET_NAME);

      const fromRaw = safeParam_(e, "From");
      let bodyRaw = String(globalThis.__bodyOverride || safeParam_(e, "Body") || "").trim();
      var overrideU = String(globalThis.__bodyOverride || "").toUpperCase();
      if (overrideU === "ATTACHMENT_ONLY") bodyRaw = ""; // ✅ parsing sees empty
      const isStaffCapture =
        String(safeParam_(e, "_staffCapture") || "").trim() === "1";
      let tenantPhoneForPayload = "";
      const phone = (e && e.parameter && e.parameter._phoneE164) ? String(e.parameter._phoneE164).trim() : normalizePhone_(fromRaw);

      const originPhone = phone;
      const fromIsManager = isManager_(originPhone);
      let requesterPhone = phone;
      let domainDecision = null; // inner operational domain router decision (MAINT / CLEANING / future)

      // Router identity lane (Propera Compass)
      const mode = String((e && e.parameter && e.parameter._mode) || "TENANT").toUpperCase();

  // ✅ RECURSION / INTERNAL REPLAY GUARD — allow sanctioned internal replay
  const p0 = (e && e.parameter) ? e.parameter : {};
  const isInternal = String(p0._internal || p0.__internal || "") === "1";
  const allowInternal = String(p0._allowInternal || "") === "1";

  try { logDevSms_(phone, String(bodyTrim || bodyRaw || ""), "BUILD " + (typeof BUILD_MARKER !== "undefined" ? BUILD_MARKER : "v=2026-02-12_A")); } catch (_) {}

  // 🔎 TEMP DEBUG (place BEFORE skip so we always see values)
  try {
    logDevSms_(originPhone, bodyRaw,
      "CORE_SEES internal=[" + String(p0._internal || p0.__internal || "") + "]" +
      " allow=[" + String(p0._allowInternal || "") + "]" +
      " mode=[" + String(p0._mode || "") + "]" +
      " reason=[" + String(p0._replayReason || "") + "]"
    );
  } catch (_) {}

  if (isInternal && !allowInternal) {
    try { logDevSms_(originPhone, bodyRaw, "CORE_SKIP_INTERNAL"); } catch (_) {}
    return;
  }


      let createdByManagerFlag = false;

      const baseVars = { brandName: BRAND.name, teamName: BRAND.team };


      if (!phone) return;
      if (!bodyRaw && !(parseInt(String(safeParam_(e, "NumMedia") || "0"), 10) > 0)) return;

      // ============================================================
      // STAFF CAPTURE INGEST (early, before any stage handler logic)YYYYYYY
      // ============================================================
      if (isStaffCapture) {

        var originPhoneStaff = originPhone;
        var rawPayload = String(bodyRaw || "").trim();

        var parsed0 = parseStaffCapDraftId_(rawPayload);
        var draftId0 = parsed0.draftId;
        if (!draftId0) draftId0 = nextStaffCapDraftId_();

        // Lock per draft id (prevents duplicate ticket creation + races on same draft)
        try {
          withWriteLock_("STAFF_CAPTURE_INGEST_" + draftId0, function() {

          // Re-parse inside lock (rawPayload unchanged; safe)
          var parsed = parseStaffCapDraftId_(rawPayload);
          var draftId = parsed.draftId || draftId0;
          var payloadText = parsed.rest;
          var draftPhone = "SCAP:" + draftId;

          // 2) Resolve or create directory row (needed for status query and upsert)
          var dirRow = ensureDirectoryRowForPhone_(dir, draftPhone);

          // 5) Determine completeness from Directory (source of truth)
          var propCode = String(dir.getRange(dirRow, 2).getValue() || "").trim();   // B
          var propName = String(dir.getRange(dirRow, 3).getValue() || "").trim();    // C
          var issueVal = String(dir.getRange(dirRow, 5).getValue() || "").trim();   // E
          var unitVal  = String(dir.getRange(dirRow, 6).getValue() || "").trim();    // F
          var dirPendingRow = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0; // G
          var schedRaw = String(dir.getRange(dirRow, 13).getValue() || "").trim();   // M

          var missing = [];
          if (!propCode) missing.push("property");
          if (!unitVal)  missing.push("unit");
          if (!issueVal) missing.push("issue");

          var payloadTrim = String(payloadText || "").trim();
          var payloadIsEmpty = (typeof isStaffDraftStatusOnlyPayload_ === "function") ? isStaffDraftStatusOnlyPayload_(payloadTrim) : (payloadTrim.length === 0);

          // Propera Compass — Image Signal Adapter: run media synthesis before status reply so "#" + screenshot gets analyzed
          var hasMediaStaff = parseInt(String(safeParam_(e, "NumMedia") || "0"), 10) > 0;
          var staffMediaFacts = { hasMedia: false, syntheticBody: "" };
          var mergedPayloadText = payloadText;
          if (hasMediaStaff && typeof imageSignalAdapter_ === "function" && typeof mergeMediaIntoBody_ === "function") {
            staffMediaFacts = imageSignalAdapter_(e, payloadText, originPhoneStaff);
            mergedPayloadText = mergeMediaIntoBody_(payloadText, staffMediaFacts);
          }
          if (!payloadTrim && mergedPayloadText && staffMediaFacts.syntheticBody) {
            try { logDevSms_(originPhoneStaff, (mergedPayloadText || "").slice(0, 60), "STAFF_CAPTURE_MEDIA_ONLY_SCREENSHOT"); } catch (_) {}
          }
          if (mergedPayloadText !== payloadText && staffMediaFacts.syntheticBody) {
            try { logDevSms_(originPhoneStaff, (mergedPayloadText || "").slice(0, 60), "STAFF_CAPTURE_MEDIA_SYNTH text=[" + (mergedPayloadText || "").slice(0, 50) + "]"); } catch (_) {}
          }

          // Only send draft-status reply when payload is truly empty AND no usable synthetic from media (short text like "Morris", "219", "after 3:30 pm" is continuation)
          var hasUsableSynthetic = staffMediaFacts.syntheticBody && (typeof isWeakIssue_ === "function" && !isWeakIssue_(staffMediaFacts.syntheticBody));
          var statusOnly = payloadIsEmpty && !hasUsableSynthetic;
          if (statusOnly) {
            var statusLine =
              "Draft " + draftId + ": " +
              (dirPendingRow >= 2 ? ("Ticket already created (row " + dirPendingRow + ").") : "Not created yet.") + " " +
              (missing.length ? ("Missing: " + missing.join(", ") + ".") : "Missing: none.") + " " +
              "Have: " +
              (propCode ? ("property=" + propCode) : "property=?") + ", " +
              (unitVal ? ("unit=" + unitVal) : "unit=?") + ", " +
              (issueVal ? ("issue=Y") : "issue=?") + ".";
            replyTo_(originPhoneStaff, statusLine);
            return; // Important: do not run compileTurn_ / finalize on empty update
          }

          try { logDevSms_(originPhoneStaff, (mergedPayloadText || "").slice(0, 80), "STAFF_CAPTURE_CONTINUATION_PAYLOAD text=[" + (mergedPayloadText || "").slice(0, 60) + "]"); } catch (_) {}

          // Idempotency: once a ticket exists, don't allow post-create updates via staff ingest.
          if (dirPendingRow >= 2) {
            var doneLine =
              "Draft " + draftId + ": Ticket already created (row " + dirPendingRow + "). " +
              (missing.length ? ("Missing (draft fields): " + missing.join(", ") + ".") : "Missing: none.");
            replyTo_(originPhoneStaff, doneLine);
            return;
          }

          // 1) Compile turn using existing brain
          var turnFacts = compileTurn_(mergedPayloadText, draftPhone, "en", baseVars);
          turnFacts.meta = turnFacts.meta || {};
          var _numMediaStaff = parseInt(String(safeParam_(e, "NumMedia") || "0"), 10) || 0;
          var _mediaUrlsStaff = [];
          for (var _si = 0; _si < _numMediaStaff; _si++) {
            var _u = String(safeParam_(e, "MediaUrl" + _si) || "").trim();
            if (_u) _mediaUrlsStaff.push(_u);
          }
          turnFacts.meta.mediaUrls = _mediaUrlsStaff;

          // Attach media facts to turn for downstream
          if (typeof maybeAttachMediaFactsToTurn_ === "function") maybeAttachMediaFactsToTurn_(turnFacts, staffMediaFacts);

          // STAFF CAPTURE debug: log media-derived hints
          try {
            var _propH = (turnFacts.meta && turnFacts.meta.mediaPropertyHint) ? String(turnFacts.meta.mediaPropertyHint).trim() : "";
            var _unitH = (turnFacts.meta && turnFacts.meta.mediaUnitHint) ? String(turnFacts.meta.mediaUnitHint).trim() : "";
            var _tenantH = (turnFacts.meta && turnFacts.meta.mediaTenantNameHint) ? String(turnFacts.meta.mediaTenantNameHint).trim() : "";
            if (_propH || _unitH || _tenantH) logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_MEDIA_HINTS prop=[" + _propH + "] unit=[" + _unitH + "] tenant=[" + _tenantH + "]");
          } catch (_) {}

          // STAFF CAPTURE fallback: issue from merged payload when compileTurn_ left it blank/weak
          var issueBlankOrWeak = !turnFacts.issue || (typeof isWeakIssue_ === "function" && isWeakIssue_(turnFacts.issue));
          var mergedTrim = String(mergedPayloadText || "").trim();
          var mergedUsable = mergedTrim.length > 0 && (typeof isWeakIssue_ !== "function" ? mergedTrim.length >= 8 : !isWeakIssue_(mergedTrim));
          if (issueBlankOrWeak && mergedUsable) {
            turnFacts.issue = mergedTrim;
            try { logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_SYNTH_ISSUE_APPLIED"); } catch (_) {}
          }

          // STAFF CAPTURE fallback: property/unit from media hints only when confidence >= 0.6 (avoids misread numbers e.g. 310→31O)
          var mediaConfident = (typeof staffMediaFacts.confidence === "number" && staffMediaFacts.confidence >= 0.6);
          if (mediaConfident && !turnFacts.property && turnFacts.meta && turnFacts.meta.mediaPropertyHint) {
            var hintProp = (typeof resolvePropertyHintToObj_ === "function") ? resolvePropertyHintToObj_(turnFacts.meta.mediaPropertyHint) : null;
            if (hintProp && hintProp.code) {
              turnFacts.property = { code: hintProp.code, name: hintProp.name || "" };
              try { logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_MEDIA_PROP_APPLIED prop=[" + (hintProp.code || "") + "]"); } catch (_) {}
            }
          }
          if (mediaConfident && !turnFacts.unit && turnFacts.meta && turnFacts.meta.mediaUnitHint) {
            var mediaUnitVal = String(turnFacts.meta.mediaUnitHint || "").trim();
            if (mediaUnitVal) {
              turnFacts.unit = (typeof normalizeUnit_ === "function") ? normalizeUnit_(mediaUnitVal) : mediaUnitVal;
              try { logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_MEDIA_UNIT_APPLIED unit=[" + (turnFacts.unit || "") + "]"); } catch (_) {}
            }
          }

          var weakStaff = !payloadTrim || (typeof isWeakIssue_ === "function" && isWeakIssue_(payloadTrim));
          turnFacts.meta.hasMediaOnly = (_numMediaStaff > 0) && weakStaff;
          if (staffMediaFacts.syntheticBody && (typeof isWeakIssue_ === "function" && !isWeakIssue_(staffMediaFacts.syntheticBody))) turnFacts.meta.hasMediaOnly = false;

          // 3) Draft upsert (staffCapture so multi-issue gets combined title)
          draftUpsertFromTurn_(dir, dirRow, turnFacts, mergedPayloadText, draftPhone, { staffCapture: true });

          // 4) Recompute expected stage
          try { recomputeDraftExpected_(dir, dirRow, draftPhone); } catch (_) {}

          // Re-read Directory after upsert (may have changed)
          propCode = String(dir.getRange(dirRow, 2).getValue() || "").trim();
          propName = String(dir.getRange(dirRow, 3).getValue() || "").trim();
          issueVal = String(dir.getRange(dirRow, 5).getValue() || "").trim();
          unitVal  = String(dir.getRange(dirRow, 6).getValue() || "").trim();
          dirPendingRow = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0;
          schedRaw = String(dir.getRange(dirRow, 13).getValue() || "").trim();
          missing = [];
          if (!propCode) missing.push("property");
          if (!unitVal)  missing.push("unit");
          if (!issueVal) missing.push("issue");

          // Promote to real ticket ONLY when triad complete and no ticket exists yet (canonical factory)
          var createdTicket = false;
          var ticketId = "";
          var loggedRow = 0;

          if (dirRow >= 2 && !missing.length && dirPendingRow < 2) {
            var sid = String(safeParam_(e, "MessageSid") || safeParam_(e, "SmsMessageSid") || "").trim();
            var staffCapInboundKey = sid
              ? ("STAFFCAP:" + draftId + ":" + sid)
              : (function() {
                  var payload = String(originPhoneStaff || "") + "|" + draftId + "|" + payloadText;
                  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, payload, Utilities.Charset.UTF_8);
                  var hex12 = digest.slice(0, 6).map(function(b) { return ("0" + ((b + 256) % 256).toString(16)).slice(-2); }).join("").slice(0, 12);
                  return "STAFFCAP_FALLBACK:" + draftId + ":" + hex12;
                })();

            var staffMediaUrl = (turnFacts.meta && turnFacts.meta.mediaUrls && turnFacts.meta.mediaUrls[0]) ? String(turnFacts.meta.mediaUrls[0]).trim() : "";
            var result = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, draftPhone, originPhoneStaff, {
              inboundKey: staffCapInboundKey,
              OPENAI_API_KEY: OPENAI_API_KEY,
              TWILIO_SID: TWILIO_SID,
              TWILIO_TOKEN: TWILIO_TOKEN,
              TWILIO_NUMBER: TWILIO_NUMBER,
              ONCALL_NUMBER: ONCALL_NUMBER,
              createdByManager: true,
              lang: "en",
              baseVars: baseVars,
              firstMediaUrl: staffMediaUrl,
              mediaType: (staffMediaFacts && staffMediaFacts.mediaType) ? String(staffMediaFacts.mediaType || "").trim() : "",
              mediaCategoryHint: (staffMediaFacts && staffMediaFacts.issueHints && staffMediaFacts.issueHints.category) ? String(staffMediaFacts.issueHints.category || "").trim() : "",
              mediaSubcategoryHint: (staffMediaFacts && staffMediaFacts.issueHints && staffMediaFacts.issueHints.subcategory) ? String(staffMediaFacts.issueHints.subcategory || "").trim() : "",
              mediaUnitHint: (staffMediaFacts && staffMediaFacts.unitHint) ? String(staffMediaFacts.unitHint || "").trim() : "",
              tenantNameHint: (turnFacts.meta && turnFacts.meta.mediaTenantNameHint) ? String(turnFacts.meta.mediaTenantNameHint).trim() : "",
              tenantNameTrusted: !!(turnFacts.meta && turnFacts.meta.mediaTenantNameTrusted)
            });

            if (result && result.ok && Number(result.loggedRow || 0) >= 2 && String(result.ticketId || "").trim()) {
              createdTicket = true;
              ticketId = String(result.ticketId || "").trim();
              loggedRow = Number(result.loggedRow || 0) || 0;

              schedRaw = String(dir.getRange(dirRow, 13).getValue() || "").trim();
            }
          }

          // Phase 1: do not require schedule for staff capture
          // if (!missing.length && !schedRaw) missing.push("schedule");

          var line =
            "Draft " + draftId + ": " +
            (createdTicket ? "Ticket created. " : "Draft created. ") +
            (missing.length ? ("Missing: " + missing.join(", ") + ".") : "Missing: none.");

          replyTo_(originPhoneStaff, line);

          try {
            logDevSms_(originPhoneStaff, payloadText.slice(0, 60),
              "STAFF_CAPTURE_CONFIRM draftId=[" + draftId + "] missing=[" + (missing.join("|") || "none") +
              "] prop=[" + (propCode || "") + "] unit=[" + (unitVal || "") + "] sched=[" + (schedRaw ? "Y" : "N") + "]" +
              (createdTicket ? " ticketId=[" + ticketId + "]" : ""));
          } catch (_) {}

          });
        } catch (err) {
          try {
            logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_INGEST_ERR msg=[" + (err && err.message ? err.message : String(err)) + "]");
            if (err && err.stack) logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_INGEST_STACK " + String(err.stack).slice(0, 900));
          } catch (_) {}
          replyTo_(originPhoneStaff, "Captured, but error ingesting draft.");
        }

        return;
      }



      

  // -------------------------
  // MANAGER NEW TICKET (phone first, then name lookup)
  // Compass-safe deterministic flow
  // -------------------------
  const bodyTrim0 = String(bodyRaw || "").trim();

  if (fromIsManager && /^new\s*ticket\b/i.test(bodyTrim0)) {

    // ======================================================
    // 1) PHONE MODE (highest priority)
    // ======================================================
    const tenantDigits = normalizePhoneDigits_(extractPhoneFromText_(bodyTrim0));

    if (tenantDigits) {

      createdByManagerFlag = true;

      const cleaned = sanitizeManagerText_(bodyTrim0);
      bodyRaw = cleaned;

      tenantPhoneForPayload = "+1" + tenantDigits;
      phone = "+1" + tenantDigits;

      requesterPhone = phone;

    } else {

      // ======================================================
      // 2) NAME / LOOKUP MODE
      // ======================================================
      const parsed = parseNewTicketSmart_(bodyTrim0); // should call strict resolver inside

      // Strict validation (Compass rule)
      if (!parsed || !parsed.propertyName || !parsed.unit || !parsed.issue) {
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          tenantMsg_("MGR_NEW_TICKET_NEEDS_FIELDS", "en", baseVars)
        );
        return; // manager phone should not enter tenant pipeline
      }

      const nameHint = String(parsed.fromRaw || "").trim();

      // Attempt strict match: property + unit + name
      let candidates = findTenantCandidates_(
        String(parsed.propertyName || "").trim(),
        String(parsed.unit || "").trim(),
        nameHint
      );

      // Fallback: property + unit only (typo-safe)
      let candidatesUnitOnly = [];
      if ((!candidates || !candidates.length) && nameHint) {
        candidatesUnitOnly = findTenantCandidates_(
          String(parsed.propertyName || "").trim(),
          String(parsed.unit || "").trim(),
          ""
        );
      }

      // EXACT MATCH FOUND
      if (candidates && candidates.length === 1) {

        const p10 = String(normalizePhoneDigits_(candidates[0].phone || "") || "").slice(-10);
        if (!p10) {
          sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
            tenantMsg_("MGR_NEW_TICKET_BAD_TENANT_PHONE", "en", baseVars)
          );
          return;
        }

        createdByManagerFlag = true;

        const cleaned = sanitizeManagerText_(bodyTrim0);
        bodyRaw = cleaned;

        tenantPhoneForPayload = "+1" + p10;
        phone = "+1" + p10;

        requesterPhone = phone;

      }

      // MULTIPLE MATCHES
      else if (candidates && candidates.length > 1) {

        setMgrPending_(originPhone, {
          body: (String(parsed.propertyName || "").trim() + " apt " + String(parsed.unit || "").trim() + " " + String(parsed.issue || "").trim()).trim(),
          phones: candidates.map(c => c.phone),
          names: candidates.map(c => c.name || "")
        });

        const listLines = candidates.slice(0, 6).map((c, i) =>
          (i + 1) + ") " + (c.name || "(no name)") + " " + (c.phone || "")
        ).join("\n");

        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          tenantMsg_("MGR_NEW_TICKET_MULTI_TENANTS", "en", { ...baseVars, listLines })
        );
        return;
      }

      // NAME FAILED BUT UNIT MATCHED (ask manager to confirm)
      else if (candidatesUnitOnly && candidatesUnitOnly.length === 1) {

        const c = candidatesUnitOnly[0];

        setMgrPending_(originPhone, {
          body: (String(parsed.propertyName || "").trim() + " apt " + String(parsed.unit || "").trim() + " " + String(parsed.issue || "").trim()).trim(),
          phones: [c.phone],
          names: [c.name || ""]
        });

        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          tenantMsg_("MGR_NEW_TICKET_NAME_MISMATCH_CONFIRM", "en", {
            ...baseVars,
            propertyName: parsed.propertyName,
            unit: parsed.unit,
            typedName: nameHint,
            foundName: (c.name || "(no name)"),
            foundPhone: (c.phone || "")
          })
        );
        return;
      }

      // TRULY NO TENANT FOUND
      else {
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          tenantMsg_("MGR_NEW_TICKET_NO_TENANT_FOUND", "en", {
            ...baseVars,
            propertyName: parsed.propertyName,
            unit: parsed.unit
          })
        );
        return;
      }
    }

  }

  // ✅ Canonical digits + canonical trimmed body
  const digits = normalizePhoneDigits_(phone);
  let bodyTrim = String(bodyRaw || "").trim(); // must be LET
  // ✅ Detect manager-created synthetic ticket ASAP (must be BEFORE confirm gate)
  let createdByManager = createdByManagerFlag;

  if (bodyTrim.startsWith(MGR_NEW_TICKET_PREFIX)) {
    createdByManager = true;
    createdByManagerFlag = true;
    bodyTrim = bodyTrim.replace(MGR_NEW_TICKET_PREFIX, "").trim();
  }

  // =====================================
  // VENDOR COMMAND HANDLER (vendor-only; never tenant pipeline)
  // =====================================
  try {
    const d10 = String(normalizePhoneDigits_(phone) || "").slice(-10);
    const vendor = getVendorByPhoneDigits_(d10);

    if (vendor) {
      const creds = { TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER };

      // 1) Normal YES/NO handler (existing)
      let handled = handleVendorAcceptDecline_(vendor, sheet, bodyTrim, creds);

      // ✅ ALWAYS stop if handled (vendor must never fall through)
      if (handled) {
        try { logDevSms_(phone, "VENDOR_GATE handled=true", "VENDOR_GATE"); } catch (_) {}
        return;
      }

      // 2) NEW: availability-only counts as YES
      handled = handleVendorAvailabilityOnly_(vendor, sheet, bodyTrim, creds);

      if (!handled) {
        // 3) Not understood -> instructions
        replyVendor_(
          creds,
          vendor.phone,
          tenantMsg_("VENDOR_CONFIRM_INSTRUCTIONS", "en", {
            brandName: BRAND.name,
            teamName: BRAND.team
          })
        );
      }

      try { logDevSms_(phone, "VENDOR_GATE handled=" + String(handled), "VENDOR_GATE"); } catch (_) {}
      return; // ✅ ALWAYS stop for vendor numbers
    }
  } catch (e) {
    try { logDevSms_(phone, "Vendor handler crash: " + e, "VENDOR_CMD_CRASH"); } catch (_) {}
    // ✅ HARD STOP: never let vendor numbers fall into tenant pipeline
    return;
  }





  const cache = CacheService.getScriptCache();
  const isInternalReplay = String(safeParam_(e, "_internal") || safeParam_(e, "__internal") || "") === "1";



  const sid = safeParam_(e, "MessageSid") || safeParam_(e, "SmsMessageSid");
  // If Twilio SID is missing, use a deterministic digest so retries don't become "new" messages.
  // This only affects dedupe/fingerprint; real Twilio traffic should always have a SID.
  const fromDed = String(safeParam_(e, "From") || "").trim().toLowerCase();
  const sidSafe = sid ? String(sid) : ("NOSID:" + _nosidDigest_(fromDed, bodyTrim));

  // trace id for this execution (lets us correlate logs)
  const trace = Utilities.getUuid().slice(0, 8);
  const bodyShort = String(bodyTrim || "").slice(0, 80);
  const ch = (fromDed.indexOf("whatsapp:") === 0) ? "WA" : "SMS";
  // ✅ inboundKey used by processTicket_ hard-dedupe (stored in ThreadId column)
  const inboundKey = "SID:" + ch + ":" + sidSafe;

  // --------- DEDUPE LAYER 0: Burst duplicate (same phone + same body, short window) ----------
  const burstBody = String(bodyTrim || "").toLowerCase().replace(/\s+/g, " ").trim();
  const burstFpRaw = originPhone + "|" + burstBody;
  const burstFp = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, burstFpRaw)
  );
  const burstKey = "BURST_" + burstFp;

  if (!isInternalReplay) {
    if (cache.get(burstKey)) {
      try { logDevSms_(originPhone, bodyShort, "DEDUP_RESULT trace=" + trace + " sid=" + String(sid || "") + " burst=1 sidHit=0 fpHit=0 inboundKey=" + inboundKey + " internal=" + String(isInternalReplay)); } catch (_) {}
      return;
    }
    cache.put(burstKey, "1", 20);
  }


  // --------- DEDUPE LAYER 1: Twilio MessageSid retries ----------
  if (!isInternalReplay && sid) {
    sidKey = "TWILIO_SID_" + ch + "_" + sid;

    if (cache.get(sidKey)) {
      try { logDevSms_(originPhone, bodyShort, "DEDUP_RESULT trace=" + trace + " sid=" + String(sid || "") + " burst=0 sidHit=1 fpHit=0 inboundKey=" + inboundKey + " internal=" + String(isInternalReplay)); } catch (_) {}
      return;
    }

    // DO NOT cache.put here — finally will put sidKey only if no crash
  }


  // --------- DEDUPE LAYER 2: fingerprint ----------
  if (!isInternalReplay) {
    const fpRaw = originPhone + "|" + bodyTrim + "|" + sidSafe;
    const fp = Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, fpRaw)
    );
    const fpKey = "FP_" + fp;

    if (cache.get(fpKey)) {
      try { logDevSms_(originPhone, bodyShort, "DEDUP_RESULT trace=" + trace + " sid=" + String(sid || "") + " burst=0 sidHit=0 fpHit=1 inboundKey=" + inboundKey + " internal=" + String(isInternalReplay)); } catch (_) {}
      return;
    }
    cache.put(fpKey, "1", 120);
  }

  try { logDevSms_(originPhone, bodyShort, "DEDUP_RESULT trace=" + trace + " sid=" + String(sid || "") + " burst=0 sidHit=0 fpHit=0 inboundKey=" + inboundKey + " internal=" + String(isInternalReplay)); } catch (_) {}

  let cmdObj = null; // ✅ must exist even for tenants


  // -------------------------
  // 0) MANAGER COMMANDS (only from manager phones)
  // -------------------------

  // ✅ Detect manager NEW TICKET text (single source of truth)
  const isMgrNewTicketText =
    fromIsManager &&
    (
      /^new\s*ticket\b/i.test(String(bodyTrim || "")) ||
      String(bodyTrim || "").indexOf("__MGR_NEW_TICKET__") === 0
    );

  // -------------------------
  // MANAGER RESET (clears manager pending draft / pick list)
  // -------------------------
  if (fromIsManager && !createdByManager && !isMgrNewTicketText) {
    const b = String(bodyTrim || "").toLowerCase().trim();
    const isReset = (b === "start over" || b === "reset" || b === "restart" || b === "clear");

    if (isReset) {
      try { clearMgrPending_(originPhone); } catch (_) {}
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
        tenantMsg_("MGR_RESET_OK", "en", baseVars)
      );
      return;
    }
  }


  // IMPORTANT: if we rewrote to tenant flow, skip manager commands

  if (fromIsManager && !createdByManager && !isMgrNewTicketText) {
    cmdObj = parseManagerCommand_(bodyTrim);

    if (cmdObj && cmdObj.cmd) {

      if (cmdObj.cmd === "LISTOPEN") {
        const msg = buildTicketList_(sheet, "open");
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone, msg);
        return;
      }

      if (cmdObj.cmd === "LISTWAITING") {
        const msg = buildTicketList_(sheet, "waiting");
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone, msg);
        return;
      }

      if (cmdObj.cmd === "STATUS") {
        const rowIndex = resolveTicketRow_(sheet, cmdObj.ref);
        if (!rowIndex) {
          sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
            tenantMsg_("MGR_TICKET_NOT_FOUND", "en", { ...baseVars, ref: cmdObj.ref })
          );
          return;
        }

        const t = getTicketSummary_(sheet, rowIndex);

        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          tenantMsg_("MGR_STATUS_SUMMARY", "en", {
            ...baseVars,
            ticketId: (t.ticketId || ("Row " + t.rowIndex)),
            status: (t.status || "(blank)"),
            prop: (t.prop || "(unknown)"),
            unit: (t.unit || "(?)"),
            phone: (t.phone || "(?)"),
            issue: (t.msg ? t.msg.slice(0, 160) : "")
          })
        );
        return;
      }

      if (cmdObj.cmd === "SETSTATUS") {
        const rowIndex = resolveTicketRow_(sheet, cmdObj.ref);
        if (!rowIndex) {
          sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
            tenantMsg_("MGR_TICKET_NOT_FOUND", "en", { ...baseVars, ref: cmdObj.ref })
          );
          return;
        }

        const newStatus = String(cmdObj.status || "").trim();

        try {
          withWriteLock_("MGR_SETSTATUS", () => {
            sheet.getRange(rowIndex, COL.STATUS).setValue(newStatus);
            sheet.getRange(rowIndex, COL.LAST_UPDATE).setValue(new Date());
          });
        } catch (err) {
          Logger.log("MGR_SETSTATUS_ERR " + err);
          try { logDevSms_(originPhone, bodyTrim, "MGR_SETSTATUS_ERR", String(err)); } catch (_) {}
          sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
            tenantMsg_("MGR_TEMP_ERROR_TRY_AGAIN", "en", baseVars)
          );
          return;
        }

        const t = getTicketSummary_(sheet, rowIndex);

        // ▸ PATCH: If terminal status, set WI → DONE
        var nsLower = newStatus.toLowerCase();
        if (nsLower.indexOf("done") >= 0 || nsLower.indexOf("closed") >= 0 ||
            nsLower.indexOf("completed") >= 0 || nsLower.indexOf("complete") >= 0 ||
            nsLower.indexOf("canceled") >= 0 || nsLower.indexOf("cancelled") >= 0) {
          try {
            var closeWiId = findWorkItemIdByTicketRow_(rowIndex);
            if (closeWiId) {
              wiTransition_(closeWiId, "DONE", "", originPhone, "WI_DONE");
            }
          } catch (_) {}
        }

        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          tenantMsg_("MGR_STATUS_UPDATED", "en", {
            ...baseVars,
            ticketId: (t.ticketId || ("Row " + rowIndex)),
            newStatus: newStatus
          })
        );
        return;
      }

      if (cmdObj.cmd === "PICK") {
        const pend = getMgrPending_(originPhone);
        if (!pend || !pend.phones || !pend.phones.length) {
          sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
            tenantMsg_("MGR_NOTHING_TO_PICK", "en", baseVars)
          );
          return;
        }

        const idx = (cmdObj.n || 0) - 1;
        if (idx < 0 || idx >= pend.phones.length) {
          sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
            tenantMsg_("MGR_INVALID_PICK", "en", baseVars)
          );
          return;
        }

        const tenantPhone = pend.phones[idx];

        clearMgrPending_(originPhone);
        const mgrPickResult = mgrCreateTicketForTenant_(
          sheet, tenantPhone, "", "", pend.body, originPhone,
          { lang, dayWord, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER, OPENAI_API_KEY }
        );
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          mgrPickResult.queued
            ? tenantMsg_("MGR_TICKET_QUEUED_OK", "en", { ...baseVars, ticketId: mgrPickResult.ticketId || "" })
            : tenantMsg_("MGR_STARTED_TENANT_FLOW", "en", { ...baseVars, tenantPhone })
        );
        return;
      }

      if (cmdObj.cmd === "PHONE") {
        const pend = getMgrPending_(originPhone);
        if (!pend || !pend.body) {
          sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
            tenantMsg_("MGR_NO_PENDING_TICKET", "en", baseVars)
          );
          return;
        }

        const tenantPhone = (typeof normalizePhoneDigits_ === "function")
          ? normalizePhoneDigits_(cmdObj.phone || "")
          : normalizePhone_(cmdObj.phone || "");

        if (!tenantPhone) {
          sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
            tenantMsg_("MGR_INVALID_PHONE", "en", baseVars)
          );
          return;
        }

        clearMgrPending_(originPhone);
        const mgrPhoneResult = mgrCreateTicketForTenant_(
          sheet, tenantPhone, "", "", pend.body, originPhone,
          { lang, dayWord, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER, OPENAI_API_KEY }
        );
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          mgrPhoneResult.queued
            ? tenantMsg_("MGR_TICKET_QUEUED_OK", "en", { ...baseVars, ticketId: mgrPhoneResult.ticketId || "" })
            : tenantMsg_("MGR_STARTED_TICKET_FOR_PHONE", "en", { ...baseVars, tenantPhone })
        );
        return;
      }

      // If cmdObj exists but we didn't handle it here, do nothing and fall through
      // (another manager block or default router may handle it)
    }
  }


  // =========================================================
  // NEWTICKET (NAME/LOOKUP ONLY)
  // IMPORTANT:
  // - If a PHONE NUMBER is in the manager message, the TOP quick-rewrite block owns it.
  // - This block should ONLY handle: FROM <Name> or no FROM
  // =========================================================
  if (fromIsManager && !createdByManager && cmdObj && cmdObj.cmd === "NEWTICKET") {


    // If message contains a phone number, skip to avoid conflict with quick-rewrite.
    const hasPhoneInText = !!normalizePhoneDigits_(extractPhoneFromText_(bodyTrim));
    if (hasPhoneInText) {
      // Do NOT return from the whole handler here unless you are 100% sure you're inside it.
      // Instead, fall through so the quick-rewrite logic can run.
    } else {

      if (!cmdObj.propertyName || !cmdObj.unit || !cmdObj.issue) {
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          tenantMsg_("MGR_NEW_TICKET_NEEDS_FIELDS", "en", baseVars)
        );
        return;
      }

      const bodyForTenantFlow = (cmdObj.propertyName + " apt " + cmdObj.unit + " " + cmdObj.issue).trim();

      const fromValueRaw = String(cmdObj.tenantPhone || "").trim();
      const nameHint = fromValueRaw || String(cmdObj.name || "").trim();

      let candidates = findTenantCandidates_(cmdObj.propertyName, cmdObj.unit, nameHint);

      if ((!candidates || !candidates.length) && nameHint) {
        candidates = findTenantCandidates_(cmdObj.propertyName, cmdObj.unit, "");
      }

      if (candidates && candidates.length === 1) {
        const p10 = normalizePhoneDigits_(candidates[0].phone || "");
        if (!p10) {
          sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
            tenantMsg_("MGR_NEW_TICKET_BAD_TENANT_PHONE", "en", baseVars)
          );
          return;
        }

        const tenantPhoneDigits = "+1" + p10;

        const mgrNewResult = mgrCreateTicketForTenant_(
          sheet, tenantPhoneDigits, cmdObj.propertyName, cmdObj.unit, cmdObj.issue, originPhone,
          { lang, dayWord, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER, OPENAI_API_KEY }
        );
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          mgrNewResult.queued
            ? tenantMsg_("MGR_TICKET_QUEUED_OK", "en", { ...baseVars, ticketId: mgrNewResult.ticketId || "" })
            : tenantMsg_("MGR_NEW_TICKET_STARTED_FOR_FOUND_TENANT", "en", {
                ...baseVars, tenantName: candidates[0].name || "(no name)", tenantPhone: tenantPhoneDigits
              })
        );
        return;
      }

      // Store pending (works for multiple AND zero; PHONE command uses body)
      try {
        setMgrPending_(originPhone, {
          body: bodyForTenantFlow,
          phones: (candidates || []).map(c => c.phone),
          names:  (candidates || []).map(c => c.name || "")
        });
      } catch (err) {
        Logger.log("MGR_NEWTICKET_SET_PENDING_ERR " + err);
        try { logDevSms_(originPhone, bodyTrim, "MGR_NEWTICKET_SET_PENDING_ERR", String(err)); } catch (_) {}
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          tenantMsg_("MGR_TEMP_ERROR_TRY_AGAIN", "en", baseVars)
        );
        return;
      }

      if (candidates && candidates.length > 1) {
        const listLines = candidates.slice(0, 6).map((c, i) =>
          (i + 1) + ") " + (c.name || "(no name)") + " " + c.phone
        ).join("\n");

        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
          tenantMsg_("MGR_NEW_TICKET_MULTI_TENANTS", "en", { ...baseVars, listLines: listLines })
        );
        return;
      }

      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
        tenantMsg_("MGR_NEW_TICKET_NO_TENANT_FOUND", "en", {
          ...baseVars,
          propertyName: cmdObj.propertyName,
          unit: cmdObj.unit
        })
      );
      return;
    }
  }

  // NOTE: Do NOT put any "return;" or extra "}" here.
  // Let the surrounding manager router decide what to do next.





  // -------------------------
  // 1) Directory lookup + create (LOCKED DECISION)
  // -------------------------
  let dirRow = 0;

  try {
    withWriteLock_("DIR_FIND_OR_CREATE", () => {
      dirRow = findDirectoryRowByPhone_(dir, phone);

      if (!dirRow) {
        const phoneRaw = String(phone || "").trim();
        const phoneStored = /^SCAP:/i.test(phoneRaw) ? phoneRaw : normalizePhone_(phoneRaw);

        dir.appendRow([phoneStored, "", "", new Date(), "", "", "", "", "", ""]);
        dirRow = dir.getLastRow();
      }
    });
  } catch (err) {
    Logger.log("DIR_FIND_OR_CREATE_ERR " + err);
    try { logDevSms_(phone, bodyRaw || "", "DIR_FIND_OR_CREATE_ERR", String(err)); } catch (_) {}
  }

  // continue with your existing reads
  let propertyCode = "";
  let propertyName = "";
  let pendingIssue = "";
  let pendingUnit = "";
  let pendingRow = 0;

  if (dirRow > 0) {
    var norm = normalizeDirTicketPointer_(sheet, dir, dirRow, phone);
    var propDir = dalGetPendingProperty_(dir, dirRow);
    propertyCode = propDir.code;
    propertyName = propDir.name;
    pendingIssue = dalGetPendingIssue_(dir, dirRow);
    pendingUnit  = dalGetPendingUnit_(dir, dirRow);
    pendingRow   = dalGetPendingRow_(dir, dirRow);

    try {
      dalWithLock_("DIR_TOUCH", function () {
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(phone || "", "", "DAL_WRITE DIR_TOUCH row=" + dirRow); } catch (_) {}
      });
    } catch (err) {
      Logger.log("DIR_TOUCH_ERR " + err);
      try { logDevSms_(phone, bodyRaw || "", "DIR_TOUCH_ERR", String(err)); } catch (_) {}
    }
  }

  let pendingStage = getDirPendingStage_(dir, dirRow);

  // -------------------------
  // language + welcome line (must be before CONTEXT COMPILER so lang is defined for compileTurn_)
  // -------------------------
  const lang = getTenantLang_(dir, dirRow, phone, bodyRaw);
  const welcomeLine = getWelcomeLineOnce_(dir, dirRow, lang);
  const dayWord = scheduleDayWord_(new Date()); // Today/Tomorrow
  const dayLine = dayWord
    ? ("\n" + renderTenantKey_("ASK_WINDOW_DAYLINE_HINT", lang, Object.assign({}, baseVars, { dayWord: dayWord })))
    : "";

  // =============================================================================
  //  CONTEXT COMPILER (Compass-safe, additive)
  // Propera Compass — Image Signal Adapter (Phase 1): merge media synthetic body before compileTurn_
  // =============================================================================
  var mediaFacts = (typeof imageSignalAdapter_ === "function") ? imageSignalAdapter_(e, bodyTrim, originPhone) : { hasMedia: false, syntheticBody: "" };
  var mergedBodyTrim = (typeof mergeMediaIntoBody_ === "function") ? mergeMediaIntoBody_(bodyTrim, mediaFacts) : bodyTrim;
  if (mergedBodyTrim !== bodyTrim && mediaFacts.syntheticBody) {
    try { logDevSms_(originPhone, (mergedBodyTrim || "").slice(0, 80), "MEDIA_SYNTHETIC_BODY text=[" + (mergedBodyTrim || "").slice(0, 60) + "]"); } catch (_) {}
  }

  let turnFacts = { property: null, unit: "", schedule: null, issue: "", isGreeting: false, isAck: false };

  try {
    const compiled = compileTurn_(mergedBodyTrim, phone, lang, baseVars);
    if (compiled) {
      turnFacts = Object.assign({}, turnFacts, {
        property: compiled.property || null,
        unit: compiled.unit != null ? compiled.unit : "",
        issue: compiled.issue != null ? compiled.issue : "",
        schedule: compiled.schedule != null ? compiled.schedule : null,

        // New: deterministic parser output (safe additive)
        issueMeta: compiled.issueMeta || null
      });
    }
    try {
      logDevSms_(originPhone, String(mergedBodyTrim || ""),
        "COMPILE_TURN prop=[" + (turnFacts.property ? turnFacts.property.code : "") + "]" +
        " unit=[" + String(turnFacts.unit || "") + "]" +
        " issue=[" + String(!!turnFacts.issue) + "]"
      );
    } catch (_) {}
  } catch (err) {
    try {
      logDevSms_(originPhone, String(mergedBodyTrim || ""),
        "COMPILE_TURN_ERR " + String(err && (err.stack || err.message) ? (err.stack || err.message) : err)
      );
    } catch (_) {}
  }
  // Pass media-only flag and media URLs for draftUpsertFromTurn_ guard and ISSUE stage (column AB)
  try {
    var _numMedia = parseInt(String(safeParam_(e, "NumMedia") || "0"), 10) || 0;
    var weakBody = (!bodyTrim) || (bodyTrim.length <= 2) || (typeof isWeakIssue_ === "function" && isWeakIssue_(bodyTrim));
    turnFacts.meta = turnFacts.meta || {};
    turnFacts.meta.hasMediaOnly = (_numMedia > 0) && weakBody;
    var _fromDed = String(safeParam_(e, "From") || "").trim().toLowerCase();
    turnFacts.meta.channel = (_fromDed.indexOf("whatsapp:") === 0) ? "whatsapp" : "sms";
    var _mediaUrls = [];
    for (var _i = 0; _i < _numMedia; _i++) {
      var _url = String(safeParam_(e, "MediaUrl" + _i) || "").trim();
      if (_url) _mediaUrls.push(_url);
    }
    turnFacts.meta.mediaUrls = _mediaUrls;
    // Propera Compass — Image Signal Adapter: attach media facts; clear hasMediaOnly when synthetic body is usable
    if (typeof maybeAttachMediaFactsToTurn_ === "function") maybeAttachMediaFactsToTurn_(turnFacts, mediaFacts);
    if (mediaFacts.syntheticBody && (typeof isWeakIssue_ === "function" && !isWeakIssue_(mediaFacts.syntheticBody)) && (!bodyTrim || (typeof isWeakIssue_ === "function" && isWeakIssue_(bodyTrim)))) {
      turnFacts.meta.hasMediaOnly = false;
    }
  } catch (_) {}
  turnFacts.lang = lang;
  try { writeTimeline_("TURN", { issue: (turnFacts.issue || "").slice(0, 80), property: turnFacts.property ? turnFacts.property.code : "", unit: (turnFacts.unit || "").slice(0, 40), schedule: (turnFacts.schedule && turnFacts.schedule.raw) ? "1" : "" }, null); } catch (_) {}

  // -----------------------------
  // Inner operational domain router (Phase 1)
  // Build domain signal + decision BEFORE draft accumulation.
  // -----------------------------
  try {
    var domainSignal = buildDomainSignal_({
      bodyTrim: bodyTrim,
      mergedBodyTrim: mergedBodyTrim,
      turnFacts: turnFacts,
      mediaFacts: mediaFacts,
      phone: phone,
      lang: lang,
      mode: mode,
      propertyCode: propertyCode,
      propertyName: propertyName,
      pendingUnit: pendingUnit,
      dirRow: dirRow,
      pendingStage: pendingStage,
      ticketStateType: "",
      OPENAI_API_KEY: OPENAI_API_KEY
    });
    domainDecision = routeOperationalDomain_(domainSignal, { mode: mode });
  } catch (_) {}

  // Early cleaning dispatch: before draft accumulation, when strong CLEANING and no active maintenance continuation.
  var earlyCleaningHandled = false;
  if (mode === "TENANT" && dirRow > 0 && domainDecision && domainDecision.detectedDomain === OPS_DOMAIN.CLEANING &&
      domainDecision.confidence >= 0.75 && !domainDecision.reviewOnly && OPS_CLEANING_LIVE_DIVERT_ENABLED &&
      (pendingRow <= 0 || !String(pendingStage || "").trim())) {
    try {
      var earlyResult = dispatchOperationalDomain_(domainDecision, {
        phone: phone,
        originPhone: originPhone,
        lang: lang,
        baseVars: baseVars,
        mode: mode,
        propertyCode: propertyCode,
        propertyName: propertyName,
        pendingUnit: pendingUnit,
        bodyTrim: bodyTrim,
        mergedBodyTrim: mergedBodyTrim,
        mediaFacts: mediaFacts,
        turnFacts: turnFacts,
        channel: (turnFacts.meta && turnFacts.meta.channel) ? String(turnFacts.meta.channel || "").toUpperCase() : "SMS"
      });
      if (earlyResult && earlyResult.handled) {
        earlyCleaningHandled = true;
        if (typeof clearMaintenanceDraftResidue_ === "function") clearMaintenanceDraftResidue_(dir, dirRow, phone);
        try { var _ogC0 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "CLEANING_WORKITEM_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "CLEANING_EARLY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (!(_ogC0 && _ogC0.ok)) replyNoHeader_(renderTenantKey_("CLEANING_WORKITEM_ACK", lang, baseVars)); } catch (_) {}
        return;
      }
    } catch (_) {}
  }

  // Captured slots THIS inbound (for smarter re-asks; deterministic).
  // Derived from final turnFacts (same as compileTurn_ output after merge; normalized unit, explicit property, issue).
  const cap = {
    hasProp: !!(turnFacts && turnFacts.property && turnFacts.property.code),
    propCode: (turnFacts && turnFacts.property && turnFacts.property.code) ? String(turnFacts.property.code) : "",
    propName: (turnFacts && turnFacts.property && turnFacts.property.name) ? String(turnFacts.property.name) : "",
    hasUnit: !!(turnFacts && turnFacts.unit && String(turnFacts.unit).trim()),
    unit: (turnFacts && turnFacts.unit) ? String(turnFacts.unit).trim() : "",
    hasIssue: !!(turnFacts && turnFacts.issue && String(turnFacts.issue).trim()),
    issue: (turnFacts && turnFacts.issue) ? String(turnFacts.issue).trim() : "",
    hasSchedule: !!(turnFacts && turnFacts.schedule && turnFacts.schedule.raw)
  };

  // ── DRAFT ACCUMULATOR + STATE RESOLVER (Compass draft-first) ──
  // Run after compileTurn_ produces turnFacts.
  // Load session once per inbound and pass into draft/recompute and resolver (avoid repeated sessionGet_).
  var _resolverCtx = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
  var _session = (typeof sessionGet_ === "function") ? (sessionGet_(phone) || {}) : {};

  // ── SIGNAL CLASSIFIER (pure, no reads, no side effects) ──
  const signals = classifyTenantSignals_(bodyTrim, _resolverCtx);
  baseVars.priorRef = signals.priorRef;
  baseVars.tone     = signals.tone;

  // 1) Fill draft fields (write-if-empty, always safe for TENANT mode)
  var prevStageBeforeRecompute = "";
  var didAppendIssueThisTurn = false;
  if (mode === "TENANT" && dirRow > 0) {
    if (pendingRow <= 0) {
      prevStageBeforeRecompute = (_session && _session.stage) ? String(_session.stage).toUpperCase().trim() : "";
    } else {
      prevStageBeforeRecompute = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();
    }
    try {
      var draftWroteIssue = draftUpsertFromTurn_(dir, dirRow, turnFacts, mergedBodyTrim, phone, _session);
      if (draftWroteIssue) didAppendIssueThisTurn = true;
    } catch (_) {}
    try { recomputeDraftExpected_(dir, dirRow, phone, _session); } catch (_) {}
    if (mode === "TENANT" && pendingRow <= 0 && typeof sessionGet_ === "function") {
      _session = sessionGet_(phone) || {};
      try { logDevSms_(phone, "", "SESSION_RELOAD_BEFORE_RESOLVER stage=[" + String(_session.stage || "").trim() + "] exp=[" + String(_session.expected || "").trim() + "]"); } catch (_) {}
      // Align _resolverCtx with post-recompute session so TURN_SUMMARY / logging use same expected as resolver
      if (_session && _session.expected !== undefined) _resolverCtx.pendingExpected = _session.expected;
    }
  }
  try { writeTimeline_("DRAFT", { set: "prop,unit,issue,sched", appendIssue: "-", issues: (typeof getIssueBuffer_ === "function" && dirRow) ? (getIssueBuffer_(dir, dirRow) || []).length : 0, missing: "-" }, null); } catch (_) {}

  // 2) Single canonical state decision
  const ticketState = resolveEffectiveTicketState_(dir, dirRow, _resolverCtx, _session);

  // Keep effectiveStage as the variable name — all downstream handlers use it unchanged
  let effectiveStage = ticketState.stage;
  pendingStage = effectiveStage;

  try { writeTimeline_("STATE", { effectiveStage: effectiveStage || "", pendingExpected: (_resolverCtx && _resolverCtx.pendingExpected) || "" }, null); } catch (_) {}
  try { writeTimeline_("HANDLER", { fn: effectiveStage || "NEW" }, null); } catch (_) {}

  // Manager->tenant override: force empty stage (Rule A)
  try {
    const o = String(originPhone || "").trim();
    const ph = String(phone || "").trim();
    if (mode === "MANAGER" && o && ph && o !== ph) {
      try { logDevSms_(o, bodyTrim, "MANAGER_TENANT_OVERRIDE was=[" + effectiveStage + "]"); } catch (_) {}
      effectiveStage = "";
      pendingStage = "";
    }
  } catch (_) {}

  // STAGE ADVANCE GUARD: only for conversational prompt stages (PROPERTY, UNIT, SCHEDULE).
  // Never guard system transition stages (FINALIZE_DRAFT, EMERGENCY_DONE, CLOSE) — they must run.
  var prevUp = String(prevStageBeforeRecompute || "").toUpperCase();
  var nextUp = String(effectiveStage || "").toUpperCase();
  if (mode === "TENANT" && dirRow > 0 && nextUp && prevUp !== nextUp) {
    try { logStageDecision_(phone, sidSafe || "", prevStageBeforeRecompute, effectiveStage, "resolver"); } catch (_) {}

    var conversational = { "PROPERTY": 1, "UNIT": 1, "SCHEDULE": 1 };

    if (!conversational[nextUp]) {
      try { logDevSms_(phone, "", "STAGE_ADVANCE_GUARD_SKIP next=[" + nextUp + "]"); } catch (_) {}
    } else {
      try { logDevSms_(phone, (bodyTrim || "").slice(0, 40),
        "STAGE_ADVANCE_GUARD prev=[" + prevUp + "] next=[" + nextUp + "] action=[PROMPT_ONLY]");
      } catch (_) {}

      if (effectiveStage === "PROPERTY") {
        // If message looks like property answer (e.g. "1"), let PROPERTY handler run — do NOT early-return
        if (typeof looksLikePropertyAnswer_ === "function" && looksLikePropertyAnswer_(bodyTrim)) {
          // fall through — PROPERTY stage handler will consume the answer
        } else {
        // If tenant gave unit (or issue) while we need property, acknowledge and ask property.
        if (cap && cap.hasUnit) {
          const v = Object.assign({}, baseVars, { unit: cap.unit });
          try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((_resolverCtx && _resolverCtx.pendingExpected) || ""), "ASK_PROPERTY_GOT_UNIT"); } catch (_) {}
          try { logDevSms_(phone, "", "STAGE_ADVANCE_GUARD_OK prev=" + prevUp + " next=" + nextUp + " replyKey=ASK_PROPERTY_GOT_UNIT"); } catch (_) {}
          reply_(replyAskPropertyMenu_(lang, v, { prefixKey: "ASK_PROPERTY_GOT_UNIT" }));
          return;
        }
        if (cap && cap.hasIssue) {
          try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((_resolverCtx && _resolverCtx.pendingExpected) || ""), "ASK_PROPERTY_GOT_ISSUE"); } catch (_) {}
          try { logDevSms_(phone, "", "STAGE_ADVANCE_GUARD_OK prev=" + prevUp + " next=" + nextUp + " replyKey=ASK_PROPERTY_GOT_ISSUE"); } catch (_) {}
          reply_(replyAskPropertyMenu_(lang, baseVars, { prefixKey: "ASK_PROPERTY_GOT_ISSUE" }));
          return;
        }
        try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((_resolverCtx && _resolverCtx.pendingExpected) || ""), "ASK_PROPERTY"); } catch (_) {}
        try { logDevSms_(phone, "", "STAGE_GUARD_PROMPT prev=[" + prevUp + "] next=[" + nextUp + "] replyKey=[ASK_PROPERTY]"); } catch (_) {}
        reply_(replyAskPropertyMenu_(lang, baseVars));
        return;
        }
      }

      if (effectiveStage === "UNIT") {
        // If tenant gave property while we need unit, acknowledge and ask unit.
        if (cap && cap.hasProp) {
          const v = Object.assign({}, baseVars, { propertyName: cap.propName || cap.propCode });
          try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((_resolverCtx && _resolverCtx.pendingExpected) || ""), "ASK_UNIT_GOT_PROPERTY"); } catch (_) {}
          try { logDevSms_(phone, "", "STAGE_ADVANCE_GUARD_OK prev=" + prevUp + " next=" + nextUp + " replyKey=ASK_UNIT_GOT_PROPERTY"); } catch (_) {}
          var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: v || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          if (_og && _og.ok) replied = true;
          return;
        }
        try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((_resolverCtx && _resolverCtx.pendingExpected) || ""), "ASK_UNIT"); } catch (_) {}
        try { logDevSms_(phone, "", "STAGE_ADVANCE_GUARD_OK prev=" + prevUp + " next=" + nextUp + " replyKey=ASK_UNIT"); } catch (_) {}
        var _og2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og2 && _og2.ok) replied = true;
        return;
      }

      if (effectiveStage === "SCHEDULE") {
        try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((_resolverCtx && _resolverCtx.pendingExpected) || ""), "ASK_WINDOW_SIMPLE"); } catch (_) {}
        try { logDevSms_(phone, "", "STAGE_ADVANCE_GUARD_OK prev=" + prevUp + " next=" + nextUp + " replyKey=ASK_WINDOW_SIMPLE"); } catch (_) {}
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        return;
      }
    }
  }

  try {
    logDevSms_(phone, bodyTrim,
      "STATE_RESOLVED type=[" + ticketState.stateType + "] stage=[" + ticketState.stage + "]" +
      " pendingRow=[" + String(dalGetPendingRow_(dir, dirRow) || "") + "]" +
      " draftIssue=[" + String(dalGetPendingIssue_(dir, dirRow) || "").slice(0, 30) + "]" +
      " activeWI=[" + String(_resolverCtx.activeWorkItemId || "") + "]"
    );
  } catch (_) {}

  try {
    logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((_resolverCtx && _resolverCtx.pendingExpected) || ""), "");
  } catch (_) {}

  // -------------------------
  // 1.1) CTX STABILIZATION (Compass-safe)
  // If Directory shows no active conversation, do NOT carry stale ctx pointers.
  // -------------------------
  try {
    const pr = Number(pendingRow || 0) || 0;
    const ps = String(effectiveStage || "").trim(); // use effectiveStage, not pendingStage

    const hasActiveDir = !!(ps || pr);

    if (!hasActiveDir && ctx) {
      ctx.pendingExpected = "";
      ctx.pendingExpiresAt = "";
      ctx.pendingWorkItemId = "";
      ctx.activeWorkItemId = "";
      try { logDevSms_(originPhone, String(bodyTrim || ""), "CTX_STABILIZE cleared (no dir stage/row) trace=" + trace); } catch (_) {}
    }
  } catch (_) {}



  // -------------------------
  // Reply helper + "never silent" tracking (TENANT FLOW)
  // -------------------------
  var replied = false;

  /** Send to a specific number (e.g. staff reply target). Does not set replied. Mirrors inbound channel (WA/SMS). */
  function replyTo_(toPhone, text) {
    try {
      var msg = String(text || "").trim();
      if (!msg) return;

      var ch = String(globalThis.__inboundChannel || "SMS").toUpperCase();
      if (ch === "WA") {
        sendWhatsApp_(TWILIO_SID, TWILIO_TOKEN, TWILIO_WA_FROM, toPhone, msg);
      } else {
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, toPhone, msg);
      }
    } catch (_) {}
  }

  function reply_(text) {
    replied = true;

    try {
      if (globalThis.__chaos && globalThis.__chaos.enabled) {
        writeTimeline_("OUT", {
          replyKey: "",
          tag: "",
          outLen: String(text || "").length,
          msg: (typeof safeTrunc_ === "function" ? safeTrunc_(text, 140) : String(text || "").slice(0, 140))
        }, null);
      }
    } catch (_) {}

    try {
      const msg = String(text || "").trim();
      if (!msg) {
        Logger.log("REPLY_SKIP_EMPTY");
        try { logDevSms_(phone, String(text || ""), "REPLY_SKIP_EMPTY"); } catch (_) {}
        return;
      }

      var ch = "SMS";
      try { ch = String(globalThis.__inboundChannel || "SMS").toUpperCase(); } catch (_) {}

      if (ch === "WA") {
        sendWhatsApp_(TWILIO_SID, TWILIO_TOKEN, TWILIO_WA_FROM, phone, msg);
      } else {
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, phone, msg);
      }
    } catch (err) {
      Logger.log("REPLY_CRASH " + err);
      try { logDevSms_(phone, String(text || ""), "REPLY_CRASH", String(err)); } catch (_) {}
    }
  }




  function replyNoHeader_(text) {
    replied = true;
    try { if (globalThis.__chaos && globalThis.__chaos.enabled) writeTimeline_("OUT", { replyKey: "", tag: "", outLen: String(text || "").length, msg: (typeof safeTrunc_ === "function" ? safeTrunc_(text, 140) : String(text || "").slice(0, 140)) }, null); } catch (_) {}
    try {
      const msg = String(text || "").trim();
      if (!msg) {
        Logger.log("REPLY_NOHEADER_SKIP_EMPTY");
        try { logDevSms_(phone, String(text || ""), "REPLY_NOHEADER_SKIP_EMPTY"); } catch (_) {}
        return;
      }
      var ch = "SMS";
      try { ch = String(globalThis.__inboundChannel || "SMS").toUpperCase(); } catch (_) {}
      if (ch === "WA") {
        sendWhatsApp_(TWILIO_SID, TWILIO_TOKEN, TWILIO_WA_FROM, phone, msg);
      } else {
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, phone, msg);
      }
    } catch (err) {
      Logger.log("REPLY_NOHEADER_CRASH " + err);
      try { logDevSms_(phone, String(text || ""), "REPLY_NOHEADER_CRASH", String(err)); } catch (_) {}
    }
  }

  // -------------------------------------------------
  // Stability lock: never create tickets from ACK-only
  // unless we're in a pending stage (TENANT only)
  // -------------------------------------------------
  try {
    if (mode === "TENANT") {
      const ackOnly = looksLikeAckOnly_(String(bodyTrim || "").toLowerCase().trim());
      const ctx = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
      const hasPending = !!(ctx && ctx.pendingExpected && String(ctx.pendingExpected).trim());

      if (ackOnly && !hasPending) {
        var _ogA = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TENANT_ACK_NO_PENDING", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ACK_ONLY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogA && _ogA.ok)) reply_(renderTenantKey_("TENANT_ACK_NO_PENDING", lang, baseVars));
        try { logDevSms_(originPhone, String(bodyTrim || ""), "CORE_ACK_ONLY_NO_PENDING"); } catch (_) {}
        return;
      }
    }
  } catch (_) {}


  // -----------------------------
  // TENANT COMMANDS + AWAITING (SCOPED to avoid redeclare errors)
  // - Template-key only (tenantMsg_)
  // - Locked writes for Directory mutations
  // - Deterministic override when awaiting
  // -----------------------------
  {
    function tmsg_(key, vars) {
      return tenantMsg_(key, lang, vars || {});
    }

    function normalizeTenantCmd_(s) {
      let t = String(s || "").toLowerCase().trim();
      t = t.replace(/^[^a-z0-9]+/g, "");
      t = t.replace(/[^a-z0-9\-\s]/g, " ");
      t = t.replace(/\s+/g, " ").trim();
      t = t.replace(/^(hey|hi|hello|yo|pls|please|can you|could you|i want to|i need to)\s+/g, "");
      return t.trim();
    }

    function hasTicketIdInline_(s) {
      return /[a-z]{3,8}\-\d{6,}\-\d{3,6}/i.test(String(s || ""));
    }

    function isCommandOverride_(cmdNow) {
      return /^(help|info|stop|start|options|menu|my\s+tickets|my\s+ticket|tickets?|requests?|status|ticket\s+status|cancel|cancel\s+ticket|cancel\s+request|change\s+time|update\s+time|change\s+availability|update\s+availability|reschedule|start\s+over|startover|reset|restart|clear|clear\s+chat)\b/.test(
        String(cmdNow || "")
      );
    }

    const cmdLocal = normalizeTenantCmd_(bodyTrim);
    const awaitingLocal = getAwaiting_(digits);
    const isCmdOverrideLocal = isCommandOverride_(cmdLocal);

    // If they typed a command while awaiting, clear awaiting so they are not stuck
    if (awaitingLocal && isCmdOverrideLocal) {
      try {
        clearAwaiting_(digits);
      } catch (err) {
        Logger.log("AWAIT_CLEAR_ON_OVERRIDE err=" + err);
        try { logDevSms_(phone, bodyTrim, "AWAIT_CLEAR_ON_OVERRIDE", String(err)); } catch (_) {}
      }
    }

    // START OVER / RESET
    if (cmdLocal === "start over" || cmdLocal === "startover" || cmdLocal === "reset" || cmdLocal === "restart") {
      try {
        dalWithLock_("DIR_RESET_TENANT", function () {
          dalSetPendingIssueNoLock_(dir, dirRow, "");
          try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[TENANT_RESET_CMD] val=[CLEAR_RESET]"); } catch (_) {}
          dalSetPendingUnitNoLock_(dir, dirRow, "");
          dalSetPendingRowNoLock_(dir, dirRow, "");
          dalSetPendingStageNoLock_(dir, dirRow, "");
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE DIR_RESET_TENANT row=" + dirRow); } catch (_) {}
        });
      } catch (err) {
        Logger.log("CMD_RESET_LOCK_ERR " + err);
        try { logDevSms_(phone, bodyTrim, "CMD_RESET_LOCK_ERR", String(err)); } catch (_) {}
      }

      reply_(tmsg_("TENANT_RESET_OK", {}));
      return;
    }

    // OPTIONS / MENU
    if (cmdLocal === "options" || cmdLocal === "menu" || cmdLocal === "options menu") {
      reply_(tmsg_("TENANT_OPTIONS_MENU", {}));
      return;
    }

    // MY TICKETS
    if (/^(my\s+)?tickets?\b/.test(cmdLocal) || /^(my\s+)?requests?\b/.test(cmdLocal)) {
      const out = listMyTickets_(sheet, phone, 5);
      reply_(String(out && out.msg ? out.msg : tmsg_("TENANT_MY_TICKETS_EMPTY_FALLBACK", {})));
      return;
    }

    // STATUS
    if (/^status\b/.test(cmdLocal) || /^ticket\s+status\b/.test(cmdLocal)) {
      const out = tenantStatusCommand_(sheet, phone, bodyTrim);
      reply_(String(out && out.msg ? out.msg : tmsg_("TENANT_STATUS_FALLBACK", {})));
      return;
    }

    // CANCEL
    if (/^(cancel\s+ticket|cancel\s+request|cancel)\b/.test(cmdLocal)) {
      const out = tenantCancelTicketCommand_(sheet, dir, digits, phone, bodyTrim);
      reply_(String(out && out.msg ? out.msg : tmsg_("TENANT_CANCEL_FALLBACK", {})));
      return;
    }

    // CHANGE TIME / RESCHEDULE
    if (
      /^(change|update)\s+time\b/.test(cmdLocal) ||
      /^(change|update)\s+availability\b/.test(cmdLocal) ||
      /^reschedule\b/.test(cmdLocal)
    ) {
      if (hasTicketIdInline_(bodyTrim)) {
        const out = tenantChangeTimeCommand_(sheet, dir, dirRow, phone, bodyTrim, dayWord, lang);
        reply_(String(out && out.msg ? out.msg : tmsg_("TENANT_CHANGE_TIME_FALLBACK", {})));
        return;
      }

      const my = listMyTickets_(sheet, phone, 5);
      const ids = (my && my.ids) ? my.ids : [];

      if (!ids.length) {
        reply_(tmsg_("TENANT_NO_TICKETS_TO_CHANGE", {}));
        return;
      }

      try {
        setAwaiting_(digits, "CHANGE_TIME_PICK", { ids: ids }, 900);
      } catch (err) {
        Logger.log("AWAIT_SET_PICK_ERR " + err);
        try { logDevSms_(phone, bodyTrim, "AWAIT_SET_PICK_ERR", String(err)); } catch (_) {}
        reply_(tmsg_("TENANT_TEMP_ERROR_TRY_AGAIN", {}));
        return;
      }

      reply_(tmsg_("TENANT_CHANGE_TIME_PICK_PROMPT", { ticketsText: String(my.msg || "") }));
      return;
    }

    // AWAITING — PICK
    if (awaitingLocal && awaitingLocal.v === "CHANGE_TIME_PICK" && !isCmdOverrideLocal) {
      const ansRaw = String(bodyTrim || "").trim();
      const ids = (awaitingLocal.p && awaitingLocal.p.ids) ? awaitingLocal.p.ids : [];
      let chosen = "";

      if (/^\d{1,2}$/.test(ansRaw)) {
        const n = parseInt(ansRaw, 10);
        if (n >= 1 && n <= ids.length) chosen = ids[n - 1];
      }

      if (!chosen && /^\d{1,4}$/.test(ansRaw)) {
        const suf4 = ansRaw.padStart(4, "0");
        for (let i = 0; i < ids.length; i++) {
          const id = String(ids[i] || "");
          if (id.endsWith(suf4) || id.endsWith(ansRaw)) { chosen = ids[i]; break; }
        }
      }

      if (!chosen) {
        const ansUp = ansRaw.toUpperCase();
        for (let i = 0; i < ids.length; i++) {
          if (String(ids[i] || "").toUpperCase() === ansUp) { chosen = ids[i]; break; }
        }
      }

      if (!chosen) {
        const listLines = ids.slice(0, 5).map((id, i) => {
          const s = String(id || "");
          return (i + 1) + ") " + s + " (" + s.slice(-4) + ")";
        }).join("\n");

        reply_(tmsg_("TENANT_CHANGE_TIME_PICK_REASK", { listLines: listLines }));
        return;
      }

      try {
        setAwaiting_(digits, "CHANGE_TIME_AVAIL", { ticketId: chosen }, 900);
      } catch (err) {
        Logger.log("AWAIT_SET_AVAIL_ERR " + err);
        try { logDevSms_(phone, bodyTrim, "AWAIT_SET_AVAIL_ERR", String(err)); } catch (_) {}
        reply_(tmsg_("TENANT_TEMP_ERROR_TRY_AGAIN", {}));
        return;
      }

      reply_(tmsg_("TENANT_CHANGE_TIME_ASK_AVAIL", { ticketId: chosen, dayLine: dayLine }));
      return;
    }

    // AWAITING — AVAIL
    if (awaitingLocal && awaitingLocal.v === "CHANGE_TIME_AVAIL" && !isCmdOverrideLocal) {
      const availability = String(bodyTrim || "").trim();
      const ticketId = awaitingLocal.p ? String(awaitingLocal.p.ticketId || "") : "";

      const out = applyTenantAvailability_(sheet, phone, ticketId, availability);

      try {
        clearAwaiting_(digits);
      } catch (err) {
        Logger.log("AWAIT_CLEAR_AFTER_APPLY_ERR " + err);
        try { logDevSms_(phone, bodyTrim, "AWAIT_CLEAR_AFTER_APPLY_ERR", String(err)); } catch (_) {}
      }

      reply_(String(out && out.msg ? out.msg : tmsg_("TENANT_CHANGE_TIME_APPLIED_FALLBACK", { ticketId: ticketId })));
      return;
    }
  }


  // -------------------------
  // 1.4) Tenant DB lookup
  // -------------------------

  // =========================
  // PRE-GATE: Force SCHEDULE route when expected=SCHEDULE and body is schedule-like (avoid menu/issue contamination)
  // =========================
  if (mode === "TENANT" && dirRow > 0 && bodyTrim) {
    const dirStage = String(getDirPendingStage_(dir, dirRow) || "").trim().toUpperCase();
    var ctxExp = "";
    try {
      if (typeof _resolverCtx !== "undefined" && _resolverCtx && _resolverCtx.pendingExpected) {
        ctxExp = String(_resolverCtx.pendingExpected || "");
      }
    } catch (_) {}
    ctxExp = String(ctxExp || "").trim().toUpperCase();
    const expectSchedule = (dirStage === "SCHEDULE") || (ctxExp === "SCHEDULE") || (String(ctxExp || "").indexOf("SCHEDULE") >= 0);
    if (expectSchedule && (typeof isScheduleLike_ === "function") && isScheduleLike_(bodyTrim)) {
      const stForce = String(effectiveStage || "").toUpperCase();
      const prForce = (typeof dalGetPendingRow_ === "function") ? dalGetPendingRow_(dir, dirRow) : 0;
      // ✅ Do NOT collapse draft schedule stages to SCHEDULE
      if (stForce === "SCHEDULE_DRAFT_MULTI" || stForce === "SCHEDULE_DRAFT_SINGLE") {
        try { logDevSms_(phone, bodyTrim, "SCHEDULE_FORCE_SKIP stage=" + stForce + " pr=" + prForce); } catch (_) {}
      } else if (prForce < 2) {
        try { logDevSms_(phone, bodyTrim, "SCHEDULE_FORCE_SKIP_NO_ROW stage=" + stForce + " pr=" + prForce); } catch (_) {}
      } else {
        effectiveStage = "SCHEDULE";
        pendingStage = "SCHEDULE";
        try {
          dalSetPendingStage_(dir, dirRow, "SCHEDULE", phone, "SCHEDULE_FORCE_STAGE");
          try { logDevSms_(phone, bodyTrim, "SCHEDULE_FORCE_ROUTE schedule_like"); } catch (_) {}
        } catch (_) {}
      }
    }
  }

  // =========================
  // PRE-GATE: do NOT run CONFIRM_CONTEXT on greetings / non-issues
  // Fix B: When already in draft stage (ISSUE, PROPERTY, UNIT, etc.), never send generic menu — let stage handlers send next intake question.
  // =========================
  try {
    const modeNow = String((e && e.parameter && e.parameter._mode) || "TENANT").toUpperCase();
    const stageNow2 = String(getDirPendingStage_(dir, dirRow) || "").trim();
    const effStageUp = String(effectiveStage || "").toUpperCase();

    if (modeNow === "TENANT" && dirRow > 0 && !stageNow2 && effStageUp !== "SCHEDULE") {
      // Fix B: If resolver already set draft stage (ISSUE, PROPERTY, UNIT, CONFIRM_CONTEXT, etc.), do NOT send HELP_INTRO — prioritize draft-stage question.
      const draftStages = ["PROPERTY", "UNIT", "ISSUE", "CONFIRM_CONTEXT", "FINALIZE_DRAFT", "INTENT_PICK", "SCHEDULE_DRAFT_MULTI"];
      if (effStageUp && draftStages.indexOf(effStageUp) >= 0) {
        try { logDevSms_(phone, bodyTrim, "PRE_GATE_SKIP draft_stage=" + effStageUp + " (no generic menu)"); } catch (_) {}
      } else {
        const rawTrim = String(bodyTrim || "").trim();
        const lower = rawTrim.toLowerCase();

        const isGreeting = (typeof looksLikeGreetingOnly_ === "function") && looksLikeGreetingOnly_(lower);
        const isAck = looksLikeAckOnly_(lower);
        const actionable = looksActionableIssue_(rawTrim);

        // If Directory has any draft data (issue, property, or unit), do NOT send HELP_INTRO (prevent reset loops)
        let hasDraftData = false;
        try {
          const dirProp  = String(dir.getRange(dirRow, 2).getValue() || "").trim();
          const dirIssue = String(dir.getRange(dirRow, 5).getValue() || "").trim();
          const dirUnit  = String(dir.getRange(dirRow, 6).getValue() || "").trim();
          hasDraftData = !!(dirProp || dirIssue || dirUnit);
        } catch (_) {}

        // If not actionable, skip confirm gate entirely — unless we have draft data (then do not send HELP_INTRO).
        if ((isGreeting || isAck || !actionable) && !hasDraftData) {
          var _ogH = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "SHOW_HELP", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "CONFIRM_GATE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          if (!(_ogH && _ogH.ok)) replyNoHeader_(renderTenantKey_("HELP_INTRO", lang, baseVars));
          try { logDevSms_(phone, bodyTrim, "SKIP_CONFIRM_GATE non_issue greeting=" + String(!!isGreeting) + " ack=" + String(!!isAck) + " actionable=" + String(!!actionable), "CONFIRM_GATE_SKIP"); } catch (_) {}
          return;
        }
      }
    }
  } catch (_) {}



  const tenantMatch = lookupTenantByPhoneDigits_(digits);

  // =========================
  // TENANT DB CONFIRM GATE
  // - Runs only when NOT mid-conversation (no pendingStage)
  // - Skips pure greetings/acks (no CONFIRM prompt on “hey/ok”)
  // - If mismatch or missing context -> go to CONFIRM_CONTEXT
  // =========================
  const stageNow = String(getDirPendingStage_(dir, dirRow) || "").trim();

  if (mode === "TENANT" && !createdByManager && tenantMatch && dirRow > 0 && !stageNow) {

    const dbCtxGate = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
    const dbConfirmedCache = (function () { try { return CacheService.getScriptCache().get("DB_CONFIRMED_" + digits) === "1"; } catch (_) { return false; } })();
    if (dbCtxGate.dbConfirmed === 1 || dbConfirmedCache) {
      try { logDevSms_(phone, bodyTrim, "TENANT_DB_GATE_SKIP dbConfirmed=1"); } catch (_) {}
    } else {

    const msgLower0 = String(bodyTrim || "").toLowerCase().trim();
    if (looksLikeGreetingOnly_(msgLower0) || looksLikeAckOnly_(msgLower0)) {
      var _ogH2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "SHOW_HELP", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "TENANT_DB_GATE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogH2 && _ogH2.ok)) replyNoHeader_(tenantMsg_("HELP_INTRO", lang, baseVars));
      try { logDevSms_(phone, bodyTrim, "TENANT_DB_GATE_SKIP_GREETING_ACK"); } catch (_) {}
      return;
    }

    const dbCode = String(tenantMatch.propertyCode || "").trim();
    const dbName = String(tenantMatch.propertyName || "").trim();
    const dbUnit = normalizeUnit_(String(tenantMatch.unit || "").trim());

    const dirCode = String(propertyCode || "").trim();
    const dirUnit = String(pendingUnit || "").trim();

    const hasStoredProp = !!dirCode;
    const hasStoredUnit = !!dirUnit;

    const mismatch =
      (dbCode && dirCode && dbCode !== dirCode) ||
      (dbUnit && dirUnit && dbUnit !== dirUnit);

    const needsConfirm = mismatch || (!hasStoredProp || !hasStoredUnit);

    if (needsConfirm) {
      if (mismatch) {
        try { CacheService.getScriptCache().remove("DB_CONFIRMED_" + digits); } catch (_) {}
        try { ctxUpsert_(phone, { dbConfirmed: 0 }, "DB_GATE_MISMATCH_REOPEN"); } catch (_) {}
      }
      const cacheKey = "CTX_CONFIRM_" + digits;

      CacheService.getScriptCache().put(
        cacheKey,
        JSON.stringify({
          propertyCode: dbCode,
          propertyName: dbName,
          unit: dbUnit,
          issue: String(bodyTrim || "").trim(),
          mismatch: !!mismatch,
          dirPropertyName: String(propertyName || "").trim(),
          dirUnit: String(pendingUnit || "").trim()
        }),
        3600
      );

      dalSetPendingStage_(dir, dirRow, "CONFIRM_CONTEXT", phone, "CONFIRM_YES_SET_STAGE");

      // Ask confirmation (template-driven)

      if (mismatch) {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "CONFIRM_CONTEXT_MISMATCH", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, { dirPropertyName: String(propertyName || "").trim(), dirUnit: String(pendingUnit || "").trim(), dbPropertyName: dbName, dbUnit: dbUnit }), meta: { source: "HANDLE_SMS_CORE", stage: "CONFIRM_CONTEXT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      } else {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "CONFIRM_CONTEXT_NEEDS_CONFIRM", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { dbPropertyName: dbName, dbUnit: dbUnit }), meta: { source: "HANDLE_SMS_CORE", stage: "CONFIRM_CONTEXT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      }

      // Pending prompt — expect YES/NO next
      try {
        const ctxNow = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
          pendingExpected: "CONFIRM_CONTEXT",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=CONFIRM_CONTEXT src=TENANT_DB_GATE"); } catch (_) {}
      } catch (_) {}

      try { logDevSms_(phone, "MARK_C DB_GATE needsConfirm=1 mismatch=" + String(!!mismatch) + " db=[" + dbCode + " " + dbUnit + "] dir=[" + dirCode + " " + dirUnit + "]", "MARK_C"); } catch (_) {}
      return;
    }
    }
  }


  // -------------------------
  // 1.5) CONFIRM_CONTEXT (Tenant DB confirmation)
  // Rules:
  // - YES: adopt tenant DB context, clear pointers, replay original issue (internal, allowed)
  // - NO:  clear pointers, store issue, ask property menu
  // - Else: re-ask YES/NO
  // -------------------------
  if (pendingStage === "CONFIRM_CONTEXT") {
    const dbCtx = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
    const dbConfirmedCache = (function () { try { return CacheService.getScriptCache().get("DB_CONFIRMED_" + digits) === "1"; } catch (_) { return false; } })();
    if (dbCtx.dbConfirmed === 1 || dbConfirmedCache) {
      dalSetPendingStage_(dir, dirRow, "", phone, "CONFIRM_CONTEXT_ALREADY_DONE");
      recomputeDraftExpected_(dir, dirRow, phone);
      try { logDevSms_(phone, bodyTrim, "CONFIRM_CONTEXT_SKIP dbConfirmed=1 cleared_stage"); } catch (_) {}
      return;
    }

    const cacheKey = "CTX_CONFIRM_" + digits;
    const cached = CacheService.getScriptCache().get(cacheKey);
    const ctxc = cached ? JSON.parse(cached) : null;

    const ansRaw = String(bodyTrim || "").trim();
    const ans = ansRaw.toLowerCase();

    try { logDevSms_(phone, "MARK_D ENTER_CONFIRM_CONTEXT ans=[" + String(bodyTrim || "") + "]", "MARK_D"); } catch (_) {}

    // Helpers
    const yes = (ans === "yes" || ans === "y" || ans.startsWith("yes "));
    const no  = (ans === "no"  || ans === "n" || ans.startsWith("no "));

    // Pull original issue we cached at gate-time (may be blank)
    const resumeIssue = (ctxc && ctxc.issue) ? String(ctxc.issue).trim() : "";
    const resumeLower = String(resumeIssue || "").toLowerCase().trim();

    // YES — adopt tenant DB context, run decision engine, no replay
    if (yes) {

      try {
        dalWithLock_("CONFIRM_CONTEXT_YES", function () {
          dalSetPendingPropertyNoLock_(dir, dirRow, { code: String(ctxc && ctxc.propertyCode ? ctxc.propertyCode : "").trim(), name: String(ctxc && ctxc.propertyName ? ctxc.propertyName : "").trim() });
          dalSetPendingUnitNoLock_(dir, dirRow, normalizeUnit_(String(ctxc && ctxc.unit ? ctxc.unit : "").trim()));
          if (resumeIssue && !looksLikeAckOnly_(resumeLower) && !looksLikeGreetingOnly_(resumeLower)) {
            var existingIssue = String(dir.getRange(dirRow, 5).getValue() || "").trim();
            if (!existingIssue) {
              dalSetPendingIssueNoLock_(dir, dirRow, resumeIssue);
              try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[CONFIRM_CONTEXT_YES] val=[" + resumeIssue.slice(0, 40) + "]"); } catch (_) {}
            }
          }
          dalSetPendingRowNoLock_(dir, dirRow, "");
          dalSetPendingStageNoLock_(dir, dirRow, "");
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE CONFIRM_CONTEXT_YES row=" + dirRow); } catch (_) {}
        });
      } catch (_) {}

      try { CacheService.getScriptCache().remove(cacheKey); } catch (_) {}
      try { CacheService.getScriptCache().put("DB_CONFIRMED_" + digits, "1", 86400 * 7); } catch (_) {}
      try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "", pendingWorkItemId: "", dbConfirmed: 1 }); } catch (_) {}

      const nextMissing = draftDecideNextStage_(dir, dirRow);
      try { logDevSms_(phone, "CONFIRM_YES nextMissing=[" + nextMissing + "]", "CONFIRM_CTX"); } catch (_) {}

      if (nextMissing === "READY") {
        const result = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, {
          inboundKey,
          lang: lang,
          baseVars: baseVars,
          firstMediaUrl: (turnFacts.meta && turnFacts.meta.mediaUrls && turnFacts.meta.mediaUrls[0]) ? String(turnFacts.meta.mediaUrls[0]).trim() : "",
          mediaType: (mediaFacts && mediaFacts.mediaType) ? String(mediaFacts.mediaType || "").trim() : "",
          mediaCategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.category) ? String(mediaFacts.issueHints.category || "").trim() : "",
          mediaSubcategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.subcategory) ? String(mediaFacts.issueHints.subcategory || "").trim() : "",
          mediaUnitHint: (mediaFacts && mediaFacts.unitHint) ? String(mediaFacts.unitHint || "").trim() : ""
        });

        if (!result.ok) {
          if (result.reason === "ACTIVE_TICKET_EXISTS") {
            try { logDevSms_(phone, bodyTrim, "CONFIRM_YES_BLOCKED_REROUTE stage=[" + effectiveStage + "]"); } catch (_) {}
            // Do NOT return — let execution continue into stage handler
          } else {
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_DRAFT_FINALIZE_FAILED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            return;
          }
        } else if (result.multiIssuePending) {
          if (result.nextStage === "UNIT") {
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            if (_og && _og.ok) replied = true;
            return;
          }
          if (result.nextStage === "SCHEDULE" || result.nextStage === "SCHEDULE_DRAFT_MULTI") {
            var combined = (result.summaryMsg && String(result.summaryMsg).trim()) ? String(result.summaryMsg).trim() : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
            try { logDevSms_(phone, combined.slice(0, 120), "MULTI_COMBINED_OUT"); } catch (_) {}
            var _ogC = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { summaryText: combined }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            if (!(_ogC && _ogC.ok)) replyNoHeader_(combined);
            return;
          }
          return;
        } else {
          if (result.nextStage === "") {
            if (!result.ackOwnedByPolicy) {
              var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_COMMON_AREA", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: String(result.ticketId || "") }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
              try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
            } else {
              try { logDevSms_(phone, "", "ACK_SUPPRESSED_BY_POLICY workItemId=" + (result.createdWi || "") + " rule=" + (result.policyRuleId || "")); } catch (_) {}
            }
          } else if (result.nextStage === "UNIT") {
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            if (_og && _og.ok) replied = true;
          } else {
            const dayLine2 = dayWord
              ? ("\n" + renderTenantKey_("ASK_WINDOW_DAYLINE_HINT", lang, Object.assign({}, baseVars, { dayWord })))
              : "";
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { dayLine: dayLine2 }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          }
          return;
        }
      }

      // Not READY — set stage and ask next missing field
      dalSetPendingStage_(dir, dirRow, nextMissing, phone, "CONFIRM_YES_SET_STAGE");
      try {
        ctxUpsert_(phone, {
          pendingExpected: nextMissing,
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        }, "CONFIRM_YES_STAGE");
      } catch (_) {}

      if (nextMissing === "PROPERTY") reply_(replyAskPropertyMenu_(lang, baseVars));
      else if (nextMissing === "UNIT") {
        var _out = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({
          intentType: "ASK_FOR_MISSING_UNIT",
          recipientType: "TENANT",
          recipientRef: phone,
          lang: lang,
          channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS",
          deliveryPolicy: "DIRECT_SEND",
          vars: baseVars || {},
          meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" }
        }) : { ok: false };
        if (_out && _out.ok) replied = true;
      }
      else {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
      }
      return;
    }

    // NO — do not accept tenant DB record; start fresh and ask for property menu
    if (no) {

      // Clear cache
      try { CacheService.getScriptCache().remove(cacheKey); } catch (_) {}

      // Clear context + store issue so we can create NEW ticket after address capture
      try {
        dalWithLock_("CONFIRM_CONTEXT_NO", function () {
          dalSetPendingPropertyNoLock_(dir, dirRow, { code: "", name: "" });
          dalSetPendingUnitNoLock_(dir, dirRow, "");
          if (resumeIssue) {
            dalSetPendingIssueNoLock_(dir, dirRow, resumeIssue);
            try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[CONFIRM_CONTEXT_NO] val=[" + resumeIssue.slice(0, 40) + "]"); } catch (_) {}
          }
          dalSetPendingRowNoLock_(dir, dirRow, "");
          dalSetPendingStageNoLock_(dir, dirRow, "PROPERTY");
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE CONFIRM_CONTEXT_NO row=" + dirRow); } catch (_) {}
        });
      } catch (_) {}

      reply_(replyAskPropertyMenu_(lang, baseVars));


      // Pending prompt — expect PROPERTY answer next
      try {
        const ctxNow = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
          pendingExpected: "PROPERTY",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT",
          dbConfirmed: 0,
          dbOverride: 1
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=PROPERTY src=CONFIRM_CONTEXT_NO"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "PROPERTY"); } catch (_) {}
      } catch (_) {}
      try { CacheService.getScriptCache().remove("DB_CONFIRMED_" + digits); } catch (_) {}

      return;
    }

    // Anything else — re-ask YES/NO (keep expectation)
    var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "CONFIRM_CONTEXT_YESNO_REPROMPT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, { dbPropertyName: String(ctxc && ctxc.propertyName ? ctxc.propertyName : "the tenant record"), dbUnit: String(ctxc && ctxc.unit ? ctxc.unit : "") }), meta: { source: "HANDLE_SMS_CORE", stage: "CONFIRM_CONTEXT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };

    try {
      const ctxNow = ctxGet_(phone);
      ctxUpsert_(phone, {
        pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
        pendingExpected: "CONFIRM_CONTEXT",
        pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        lastIntent: "MAINT"
      });
    } catch (_) {}

    return;
  }



  // ── UNIT-ONLY SALVAGE block DELETED (Step F) ──
  // draftUpsertFromTurn_() now captures unit on every message before any stage logic runs.
  // The salvage block is unreachable.




  // -------------------------
  // 3.5) HANDLE PENDING STAGES
  // -------------------------


  // -------------------------
  // EMERGENCY_DONE: treat any inbound as a follow-up note (no new ticket)
  // GUARD: Emergency follow-up must never create new ticket; never open schedule stage.
  // - NEVER creates a new ticket
  // - Always uses Directory.PendingRow pointer; append only via safe helper
  // - Keeps PendingStage="EMERGENCY_DONE" so future inbound stays follow-up
  // - If pointer missing: log EMERGENCY_CONTINUATION_POINTER_MISSING, ask PROPERTY, stay EMERGENCY_DONE
  // -------------------------
  if (pendingStage === "EMERGENCY_DONE") {
    try { logDevSms_(phone, bodyTrim, "EMERGENCY_CONTINUATION_HIT"); } catch (_) {}
    const now = new Date();
    const pr = dalGetPendingRow_(dir, dirRow);
    const add = String(bodyTrim || "").trim();

    // If pointer missing, safest: ask PROPERTY but KEEP EMERGENCY_DONE stage. Never open new ticket.
    if (pr < 2) {
      try { logDevSms_(phone, "", "EMERGENCY_CONTINUATION_POINTER_MISSING action=ask_property stay=EMERGENCY_DONE"); } catch (_) {}
      reply_(replyAskPropertyMenu_(lang, baseVars));

      try { dalSetPendingStage_(dir, dirRow, "EMERGENCY_DONE", phone, "EMERGENCY_DONE_NO_PTR_KEEP_STAGE"); } catch (_) {}

      // ctx expects PROPERTY next (so PROPERTY handler can recover pointer)
      try {
        const ctxNow = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
        ctxUpsert_(phone, {
          pendingWorkItemId: String(ctxNow.pendingWorkItemId || ctxNow.activeWorkItemId || "").trim(),
          pendingExpected: "PROPERTY",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        }, "EMERGENCY_DONE_NO_PTR_EXPECT_PROPERTY");
        try { wiSetWaitTenant_(phone, "PROPERTY"); } catch (_) {}
      } catch (_) {}

      return;
    }

    // Append follow-up to ticket (and update last update) under lock
    if (add) {
      withWriteLock_("EMERGENCY_DONE_APPEND", () => {
        const prevMsg = String(sheet.getRange(pr, COL.MSG).getValue() || "").trim();
        const combined = prevMsg ? (prevMsg + " | Follow-up: " + add) : ("Follow-up: " + add);

        sheet.getRange(pr, COL.MSG).setValue(combined);
        sheet.getRange(pr, COL.LAST_UPDATE).setValue(now);
      });
      try { logDevSms_(phone, add.slice(0, 60), "EMERGENCY_FOLLOWUP_APPENDED row=" + pr); } catch (_) {}
    }

    // Keep ticket active
    setStatus_(sheet, pr, "In Progress");

    // Keep Directory pointer + stage stable (locked)
    try {
      dalWithLock_("EMERGENCY_DONE_KEEP_STAGE", function () {
        dalSetPendingRowNoLock_(dir, dirRow, pr);
        dalSetPendingStageNoLock_(dir, dirRow, "EMERGENCY_DONE");
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(phone || "", "", "DAL_WRITE EMERGENCY_DONE_KEEP_STAGE row=" + dirRow + " pr=" + pr); } catch (_) {}
        try { logDevSms_(phone || "", "", "EMERGENCY_CONTINUATION_KEEP stage=EMERGENCY_DONE"); } catch (_) {}
      });
    } catch (_) {}

    // ✅ Optional: forward follow-up to oncall (recommended)
    // NOTE: This message is NOT tenant-facing, but still consider migrating to a manager template system later.
    if (add) {
      try {
        const tid  = String(sheet.getRange(pr, COL.TICKET_ID).getValue() || "").trim();
        const prop = String(sheet.getRange(pr, COL.PROPERTY).getValue() || "").trim();
        const unitNow = String(sheet.getRange(pr, COL.UNIT).getValue() || "").trim();

        const mgrMsg = tenantMsg_("EMERGENCY_FOLLOWUP_TO_ONCALL", "en", {
          ticketId: tid,
          phone: phone,
          propertyName: prop,
          unit: unitNow,
          msg: add
        });
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER, mgrMsg);
      } catch (_) {}
    }

    var _ogEu = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_UPDATE_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "EMERGENCY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
    if (!(_ogEu && _ogEu.ok)) reply_(renderTenantKey_("EMERGENCY_UPDATE_ACK", lang, baseVars));
    return;
  }

  // ===================================================================
  // ===== M7 — WORKFLOW (Stage Handlers + Ticket Creation) =============
  // @MODULE:M7
  // Responsibilities:
  // - PROPERTY / UNIT / ISSUE / SCHEDULE handlers
  // - finalizeDraftAndCreateTicket_()
  // - processTicket_()
  // ===================================================================

  // ⚠️ IMPORTANT: Do NOT gate on pendingRow here.
  // PROPERTY/UNIT/ISSUE stages must run even when PendingRow is missing
  // so they can self-heal the ticket pointer.
  // (CUTOVER SEAM removed — now handled by resolveEffectiveTicketState_)

  // ——— Safety net: ticket-bound stage (SCHEDULE/DETAIL) without PendingRow ———
  var ticketBoundNoRow = (effectiveStage === "SCHEDULE" || effectiveStage === "DETAIL") && (pendingRow < 2);
  if (ticketBoundNoRow) {
    try { logDevSms_(phone, (bodyTrim || "").slice(0, 40), "STAGE_REQUIRES_ROW_BUT_NONE stage=[" + effectiveStage + "] action=NORMALIZE_TO_ISSUE"); } catch (_) {}
    var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
    if (_og && _og.ok) replied = true;
    try { dalSetPendingStage_(dir, dirRow, "", phone, "NORMALIZE_STAGE_NO_ROW"); } catch (_) {}
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "normalize_stage_requires_row"); } catch (_) {}
    return;
  }

  // ——— SCHEDULE_DRAFT_MULTI: parse schedule, create one merged ticket, clear stage ———
  if (effectiveStage === "SCHEDULE_DRAFT_MULTI") {
    var bufSdm = (typeof getIssueBuffer_ === "function") ? (getIssueBuffer_(dir, dirRow) || []) : [];
    var stageDaySdm = "Today";
    try {
      if (typeof inferStageDayFromText_ === "function") {
        var inferredSdm = inferStageDayFromText_(String(bodyTrim || "").trim());
        if (inferredSdm) stageDaySdm = inferredSdm;
      }
    } catch (_) {}
    var schedSdm = (typeof parsePreferredWindow_ === "function") ? parsePreferredWindow_(String(bodyTrim || "").trim(), stageDaySdm) : null;
    var accessNotesSdm = String(dir.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.DRAFT_SCHEDULE_RAW : 13).getValue() || "").trim();
    if (!accessNotesSdm && typeof sessionGet_ === "function") {
      try { var _sSdm = sessionGet_(phone); if (_sSdm && _sSdm.draftScheduleRaw) accessNotesSdm = String(_sSdm.draftScheduleRaw || "").trim(); } catch (_) {}
    }
    var ansLower = String(bodyTrim || "").trim().toLowerCase();
    var isYesConfirm = (ansLower === "yes" || ansLower === "y" || ansLower.startsWith("yes ") || ansLower === "confirm");
    if ((!schedSdm || !schedSdm.label) && !(accessNotesSdm && isYesConfirm)) {
      var reaskMsg = accessNotesSdm
        ? (renderTenantKey_("CONFIRM_WINDOW_FROM_NOTE", lang, Object.assign({}, baseVars, { accessNotes: accessNotesSdm })) || renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars))
        : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
      var _ogR = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "SCHEDULE_DRAFT_REASK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { accessNotes: accessNotesSdm }), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE_DRAFT_MULTI", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogR && _ogR.ok)) replyNoHeader_(reaskMsg);
      return;
    }
    var labelSdm = (schedSdm && schedSdm.label) ? String(schedSdm.label || "").trim() : (accessNotesSdm && isYesConfirm ? accessNotesSdm : "");
    var inboundKeySdm = "DRAFT:" + phone + "|TS:" + Date.now();
    var resultSdm = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, {
      inboundKey: inboundKeySdm,
      lang: lang,
      baseVars: baseVars,
      multiScheduleCaptured: true,
      capturedScheduleLabel: labelSdm,
      firstMediaUrl: (turnFacts.meta && turnFacts.meta.mediaUrls && turnFacts.meta.mediaUrls[0]) ? String(turnFacts.meta.mediaUrls[0]).trim() : "",
      mediaType: (mediaFacts && mediaFacts.mediaType) ? String(mediaFacts.mediaType || "").trim() : "",
      mediaCategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.category) ? String(mediaFacts.issueHints.category || "").trim() : "",
      mediaSubcategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.subcategory) ? String(mediaFacts.issueHints.subcategory || "").trim() : "",
      mediaUnitHint: (mediaFacts && mediaFacts.unitHint) ? String(mediaFacts.unitHint || "").trim() : ""
    });
    if (!resultSdm.ok) {
      try { logDevSms_(phone, bodyTrim, "SCHEDULE_DRAFT_MULTI_FINALIZE_FAIL reason=[" + String(resultSdm.reason || "") + "]"); } catch (_) {}
      var accessNotesFail = String(dir.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.DRAFT_SCHEDULE_RAW : 13).getValue() || "").trim();
      if (!accessNotesFail && typeof sessionGet_ === "function") {
        try { var _sFail = sessionGet_(phone); if (_sFail && _sFail.draftScheduleRaw) accessNotesFail = String(_sFail.draftScheduleRaw || "").trim(); } catch (_) {}
      }
      var failMsg = accessNotesFail
        ? (renderTenantKey_("CONFIRM_WINDOW_FROM_NOTE", lang, Object.assign({}, baseVars, { accessNotes: accessNotesFail })) || renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars))
        : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
      var _ogF = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "SCHEDULE_DRAFT_FAIL", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { accessNotes: accessNotesFail }), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE_DRAFT_MULTI", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogF && _ogF.ok)) replyNoHeader_(failMsg);
      return;
    }
    try {
      ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "schedule_draft_multi_done");
    } catch (_) {}
    var countSdm = (bufSdm && bufSdm.length) ? bufSdm.length : 1;
    var confirmVars = Object.assign({}, baseVars, { count: String(countSdm), when: labelSdm });
    var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "MULTI_CREATED_CONFIRM", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: confirmVars, meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE_DRAFT_MULTI", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
    return;
  }

  if (effectiveStage === "PROPERTY" || effectiveStage === "UNIT" || effectiveStage === "ISSUE") {

    // -------------------------
    // PROPERTY (Propera Compass SAFE) — ctx-driven continuation
    // Accepts: "1".."5", "penn", "the grand at penn", "penn 301", "1 apt 301"
    // Rules:
    // - Single canonical handler
    // - Directory writes under lock
    // - PROPERTY stage may ONLY create a ticket if PendingIssue exists but PendingRow is missing
    // - Directory.PendingRow is the active ticket pointer
    // - Next steps are driven by ctx.pendingExpected (PROPERTY/UNIT/ISSUE/DETAIL/SCHEDULE_*)
    // -------------------------
    if (effectiveStage === "PROPERTY") {

      let recovResult = null; // PATCH 4: set when we call finalize; used to respect nextStage
      try {
        try { logDevSms_(phone, "DBG_B ENTER PROPERTY body=[" + String(bodyTrim || "") + "]", "DBG_B"); } catch (_) {}

        const raw   = String(bodyRaw || "");
        const trim  = String(bodyTrim || "").trim();
        const lower = trim.toLowerCase();

        // Always re-read fresh
        let pendingRow     = dalGetPendingRow_(dir, dirRow);
        const pendingIssue = dalGetPendingIssue_(dir, dirRow); // PendingIssue (E)

        // -------------------------
        // Resolve property (sheet-driven; NO PROPERTIES global)
        // -------------------------
        const propsList = getActiveProperties_();
        if (!propsList || !propsList.length) {
          var _ogErr = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_NO_PROPERTIES", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          if (!(_ogErr && _ogErr.ok)) reply_(renderTenantKey_("ERR_NO_PROPERTIES_CONFIGURED", lang, baseVars));
          return;
        }

        const tokens = lower.split(/\s+/).filter(Boolean);

        // menu digit ONLY if it's a standalone token (so "301" won't trigger "3")
        const digit = tokens.find(t => /^[1-5]$/.test(t)) || "";

        let pObj = null;

        // ✅ Menu pick: deterministic order from Properties sheet
        if (digit) {
          const idx = parseInt(digit, 10) - 1;
          if (idx >= 0 && idx < propsList.length) pObj = propsList[idx];
        }

        // ✅ Exact match against variants + code/name/ticketPrefix
        if (!pObj) {
          for (const p of propsList) {
            const variants = []
              .concat(p._variants || [])
              .concat([p.code, p.name, p.ticketPrefix])
              .filter(Boolean)
              .map(x => String(x).toLowerCase().trim());

            if (variants.includes(lower)) { pObj = p; break; }
          }
        }

        // ✅ Contains match (e.g. "the grand at penn", "penn 301")
        if (!pObj) {
          for (const p of propsList) {
            const variants = []
              .concat(p._variants || [])
              .concat([p.code, p.name, p.ticketPrefix])
              .filter(Boolean)
              .map(x => String(x).toLowerCase().trim());

            if (variants.some(v => v && lower.includes(v))) { pObj = p; break; }
          }
        }

        // ✅ Last resort: your existing resolver (if present)
        if (!pObj) {
          const localProp = resolvePropertyFromText_(raw) || resolvePropertyFromText_(trim);
          if (localProp) {
            try {
              const p2 = getPropertyByNameOrKeyword_(localProp);
              if (p2) pObj = p2;
            } catch (_) {}
          }
        }

        // If still no property match, ask menu again + set ctx expected=PROPERTY
  // If still no property match, ask menu again + set ctx expected=PROPERTY
  if (!pObj) {

    var unitCandidate = dalGetPendingUnit_(dir, dirRow);
    var tfUnitNoMatch = (turnFacts && turnFacts.unit) ? String(turnFacts.unit).trim() : "";
    if (!unitCandidate && tfUnitNoMatch) {
      dalSetPendingUnit_(dir, dirRow, tfUnitNoMatch, phone, "UNIT_FROM_TURNFACTS");
      unitCandidate = tfUnitNoMatch;
    }

    const pr0 = dalGetPendingRow_(dir, dirRow);
    if (unitCandidate && pr0 >= 2) {
      try {
        withWriteLock_("TICKET_SET_UNIT_FROM_PROPERTY_NO_MATCH", () => {
          sheet.getRange(pr0, COL.UNIT).setValue(unitCandidate);
          sheet.getRange(pr0, COL.LAST_UPDATE).setValue(new Date());
        });
      } catch (_) {}
    }
    if (unitCandidate) {
      try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_UNIT_FROM_PROPERTY_NO_MATCH unit=[" + unitCandidate + "]"); } catch (_) {}
    }


    const v = Object.assign({}, baseVars, unitCandidate ? { unit: unitCandidate } : {});

    // Tone-aware prefix: signals first, then captured facts, then plain menu
    const _propPrefixKey =
      signals.tone === "urgent"       ? "ASK_PROPERTY_URGENT"       :
      signals.tone === "postService"  ? "ASK_PROPERTY_POST_SERVICE" :
      signals.tone === "recurring"    ? "ASK_PROPERTY_RECURRING"    :
      signals.tone === "frustrated"   ? "ASK_PROPERTY_FRUSTRATED"   :
      (unitCandidate && String(unitCandidate).trim()) ? "ASK_PROPERTY_GOT_UNIT"   :
      (cap && cap.hasIssue)           ? "ASK_PROPERTY_GOT_ISSUE"    :
      null;

    reply_(replyAskPropertyMenu_(lang, v, _propPrefixKey ? { prefixKey: _propPrefixKey } : {}));

    try {
      const ctxNow = ctxGet_(phone);
      ctxUpsert_(phone, {
        pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
        pendingExpected: "PROPERTY",
        pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        lastIntent: "MAINT"
      });
      try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=PROPERTY src=PROPERTY_STAGE_NO_MATCH"); } catch (_) {}
      try { wiSetWaitTenant_(phone, "PROPERTY"); } catch (_) {}
    } catch (_) {}

    return;
  }


        const propertyCode = String(pObj.code || "").trim();
        const propertyName = String(pObj.name || "").trim();
        try { logDevSms_(phone, "DBG_PROPERTY RESOLVED code=" + propertyCode + " name=" + propertyName, "DBG_PROPERTY"); } catch (_) {}

        // -------------------------
        // Persist property to Directory (under lock)
        // -------------------------
        dalSetPendingProperty_(dir, dirRow, { code: propertyCode, name: propertyName }, phone, "DIR_SET_PROPERTY");

        // ✅ Clear PROPERTY expectation on success (prevents loops)
        try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "PROPERTY_RESOLVED"); } catch (_) {}

        // -------------------------
        // Compass-safe recovery: if no pendingRow, only continue if PendingIssue exists
        // -------------------------
        // Fallback: if Directory issue missing, trust draft/session issue
        if (!pendingIssue) {
          try {
            const s = (typeof sessionGet_ === "function" ? sessionGet_(phone) : null) || {};
            if (s && s.draftIssue) pendingIssue = String(s.draftIssue || "").trim();
          } catch (_) {}
        }
        if (pendingRow < 2) {
          if (!pendingIssue) {
            var _ogErr = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_LOST_REQUEST", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            if (!(_ogErr && _ogErr.ok)) reply_(renderTenantKey_("ERR_LOST_OPEN_REQUEST", lang, baseVars));

            dalSetPendingStage_(dir, dirRow, "", phone, "DIR_CLEAR_STAGE_AFTER_LOST_PTR");

            try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }); } catch (_) {}
            return;
          }

          // Canonical ticket creation via finalizeDraftAndCreateTicket_ (Step B)
          recovResult = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, {
            inboundKey, OPENAI_API_KEY, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER,
            lang: lang, baseVars: baseVars,
            firstMediaUrl: (turnFacts.meta && turnFacts.meta.mediaUrls && turnFacts.meta.mediaUrls[0]) ? String(turnFacts.meta.mediaUrls[0]).trim() : ""
          });

          if (!recovResult.ok) throw new Error("PROPERTY recovery: finalize failed reason=[" + (recovResult.reason || "") + "]");

          // ✅ Multi-issue defer: send combined summary + schedule prompt and STOP.
          // (This mirrors Occurrence #3 behavior.)
          if (recovResult.multiIssuePending) {
            const nextStageMi = String(recovResult.nextStage || "").trim().toUpperCase();
            try { logDevSms_(phone, "", "PROPERTY_RECOV_MULTI_DEFER nextStage=[" + nextStageMi + "]"); } catch (_) {}

            if (nextStageMi === "UNIT") {
              var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
              if (_og && _og.ok) replied = true;
              return;
            }

            if (nextStageMi === "SCHEDULE" || nextStageMi === "SCHEDULE_DRAFT_MULTI") {
              var combinedMi = (recovResult.summaryMsg && String(recovResult.summaryMsg).trim())
                ? String(recovResult.summaryMsg).trim()
                : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
              try { logDevSms_(phone, combinedMi.slice(0, 120), "MULTI_COMBINED_OUT_RECOV"); } catch (_) {}
              var _ogMi = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { summaryText: combinedMi }), meta: { source: "HANDLE_SMS_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
              if (!(_ogMi && _ogMi.ok)) replyNoHeader_(combinedMi);
              return;
            }

            // Fallback: just respect stage and exit
            return;
          }

          // Normal path: ticket row exists
          pendingRow = recovResult.loggedRow;
          if (pendingRow < 2 || !sheet || pendingRow > sheet.getLastRow()) {
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_DRAFT_FINALIZE_FAILED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            return;
          }
        }

        const hasTicketPtr = (pendingRow >= 2 && sheet && pendingRow <= sheet.getLastRow());

        // -------------------------
        // Ticket: set property + upgrade ticket id (only when valid pendingRow)
        // -------------------------
        if (hasTicketPtr) {
          withWriteLock_("TICKET_SET_PROPERTY_AND_UPGRADE_ID", () => {
            sheet.getRange(pendingRow, COL.PROPERTY).setValue(propertyName);

            const before = String(sheet.getRange(pendingRow, COL.TICKET_ID).getValue() || "").trim();
            upgradeTicketIdIfUnknown_(sheet, pendingRow, propertyName);
            const after  = String(sheet.getRange(pendingRow, COL.TICKET_ID).getValue() || "").trim();

            try {
              logDevSms_(phone, "TICKET_UPGRADE row=" + pendingRow + " before=[" + before + "] after=[" + after + "] prop=[" + propertyName + "]", "DBG_TICKETID");
            } catch (_) {}
          });
          try { logDevSms_(phone, bodyTrim, "PROP_WRITE_TICKET ok row=[" + pendingRow + "]"); } catch (_) {}

          // Sync active work item — property known (unit may still be blank)
          try {
            syncActiveWorkItemFromTicketRow_(
              phone,
              pendingRow,
              propertyCode,
              dalGetPendingUnit_(dir, dirRow)
            );
          } catch (_) {}
        } else {
          try { logDevSms_(phone, bodyTrim, "PROP_WRITE_TICKET skip no_ptr row=[" + pendingRow + "]"); } catch (_) {}
        }

        // -------------------------
        // PATCH 4: Respect recovResult.nextStage (do not re-read cleared Directory)
        // -------------------------
        if (recovResult) {
          const nextStage = String(recovResult.nextStage || "").trim();
          dalWithLock_("PROPERTY_RECOV_SET_STAGE", function () {
            dalSetPendingStageNoLock_(dir, dirRow, nextStage);
            dalSetLastUpdatedNoLock_(dir, dirRow);
            try { logDevSms_(phone || "", "", "DAL_WRITE PROPERTY_RECOV_SET_STAGE row=" + dirRow + " stage=" + String(nextStage).slice(0, DAL_LOG_LEN)); } catch (_) {}
          });
          try {
            const ctxNowU = ctxGet_(phone);
            ctxUpsert_(phone, {
              pendingWorkItemId: (ctxNowU && ctxNowU.activeWorkItemId) ? String(ctxNowU.activeWorkItemId) : "",
              pendingExpected: nextStage,
              pendingExpiresAt: new Date(Date.now() + (nextStage === "SCHEDULE" || nextStage === "SCHEDULE_DRAFT_MULTI" ? 30 : 10) * 60 * 1000),
              lastIntent: "MAINT"
            });
          } catch (_) {}
          if (nextStage === "") {
            if (!(recovResult && recovResult.ackOwnedByPolicy)) {
              var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_COMMON_AREA", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: String((recovResult && recovResult.ticketId) || "") }), meta: { source: "HANDLE_SMS_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
              try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
            } else {
              try { logDevSms_(phone, "", "ACK_SUPPRESSED_BY_POLICY workItemId=" + (recovResult.createdWi || "") + " rule=" + (recovResult.policyRuleId || "")); } catch (_) {}
            }
          } else if (nextStage === "UNIT") {
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            if (_og && _og.ok) replied = true;
          } else {
            const dayLineRecov = dayWord
              ? ("\n" + renderTenantKey_("ASK_WINDOW_DAYLINE_HINT", lang, Object.assign({}, baseVars, { dayWord })))
              : "";
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { dayLine: dayLineRecov }), meta: { source: "HANDLE_SMS_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          }
          return;
        }

        // -------------------------
        // UNIT (ctx-driven) — only when we did NOT just finalize (recovResult null)
        // -------------------------
        pendingUnit = dalGetPendingUnit_(dir, dirRow);
        var tfUnit = (turnFacts && turnFacts.unit) ? String(turnFacts.unit).trim() : "";
        if (!pendingUnit && tfUnit) {
          dalSetPendingUnit_(dir, dirRow, tfUnit, phone, "UNIT_FROM_TURNFACTS");
          pendingUnit = tfUnit;
        }

        // Ask unit if still missing
        if (!pendingUnit) {
          dalSetPendingStage_(dir, dirRow, "UNIT", phone, "PROPERTY_NEXT_UNIT");
          if (hasTicketPtr) setStatus_(sheet, pendingRow, "Waiting Tenant");
          var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          if (_og && _og.ok) replied = true;

          try {
            const ctxNowU = ctxGet_(phone);
            ctxUpsert_(phone, {
              pendingWorkItemId: (ctxNowU && ctxNowU.activeWorkItemId) ? String(ctxNowU.activeWorkItemId) : "",
              pendingExpected: "UNIT",
              pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
              lastIntent: "MAINT"
            });
            try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=UNIT src=PROPERTY_STAGE"); } catch (_) {}
            try { wiSetWaitTenant_(phone, "UNIT"); } catch (_) {}
          } catch (_) {}

          return;
        }

        // Sync work item now that unit is known
        if (hasTicketPtr) {
          try {
            syncActiveWorkItemFromTicketRow_(phone, pendingRow, propertyCode, pendingUnit);
          } catch (_) {}
        }

        // -------------------------
        // ISSUE (ctx-driven)
        // -------------------------
        const issueText = dalGetPendingIssue_(dir, dirRow);
        if (!issueText) {
          dalSetPendingStage_(dir, dirRow, "ISSUE", phone, "UNIT_NEXT_ISSUE");
          if (hasTicketPtr) setStatus_(sheet, pendingRow, "Waiting Tenant");
          var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          if (_og && _og.ok) replied = true;

          try {
            const ctxNowI = ctxGet_(phone);
            ctxUpsert_(phone, {
              pendingWorkItemId: (ctxNowI && ctxNowI.activeWorkItemId) ? String(ctxNowI.activeWorkItemId) : "",
              pendingExpected: "ISSUE",
              pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
              lastIntent: "MAINT"
            });
            try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=ISSUE src=PROPERTY_STAGE"); } catch (_) {}
            try { wiSetWaitTenant_(phone, "ISSUE"); } catch (_) {}
          } catch (_) {}

          return;
        }

        // Ticket MSG (internal storage)
        if (hasTicketPtr) {
          withWriteLock_("TICKET_SET_MSG", () => {
            sheet.getRange(pendingRow, COL.MSG).setValue("Unit " + pendingUnit + " - " + issueText);
          });
        }

        // -------------------------
        // Emergency short-circuit (template-key only)
        // -------------------------
        if (hasTicketPtr && isEmergencyContext_(sheet, pendingRow)) {
          dalWithLock_("EMERGENCY_DONE_SET_PTR_STAGE", function () {
            dalSetPendingRowNoLock_(dir, dirRow, pendingRow);
            dalSetPendingStageNoLock_(dir, dirRow, "EMERGENCY_DONE");
            dalSetLastUpdatedNoLock_(dir, dirRow);
            try { logDevSms_(phone || "", "", "DAL_WRITE EMERGENCY_DONE_SET_PTR_STAGE row=" + dirRow + " pr=" + pendingRow); } catch (_) {}
          });
          setStatus_(sheet, pendingRow, "In Progress");

          const tid = String(sheet.getRange(pendingRow, COL.TICKET_ID).getValue() || "").trim();
          if (tid) { var _ogE = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED_WITH_TICKET", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: tid }), meta: { source: "HANDLE_SMS_CORE", stage: "EMERGENCY_DONE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (!(_ogE && _ogE.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED_WITH_TID", lang, { ...baseVars, ticketId: tid })); }
          else     { var _ogE2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "EMERGENCY_DONE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (!(_ogE2 && _ogE2.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED", lang, baseVars)); }

          try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }); } catch (_) {}
          return;
        }

        // -------------------------
        // Decide schedule vs detail
        // -------------------------
        let isClear = issueIsClear_("", 0, issueText) || looksActionableIssue_(issueText);

        // ✅ FIX: never reference OPENAI_API_KEY directly
        if (!isClear) {
          try {
            const props = PropertiesService.getScriptProperties();
            const apiKey = String(props.getProperty("OPENAI_API_KEY") || "").trim();
            if (apiKey) {
              const ex = smartExtract_(apiKey, issueText);
              isClear = issueIsClear_(ex.issueSummary, ex.issueConfidence, issueText) || looksActionableIssue_(issueText);
            }
          } catch (_) {}
        }

        if (hasTicketPtr) setStatus_(sheet, pendingRow, "Waiting Tenant");

        if (isClear) {
          const schedStage = "SCHEDULE";

          try {
            dalSetPendingStage_(dir, dirRow, schedStage, phone, "DIR_SET_STAGE_AFTER_PROPERTY");
          } catch (_) {}

          // ✅ SINGLE schedule prompt (no duplicate, no dayLine var) — Phase 2b: semantic intent
          var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_SMS_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };

          try {
            const ctxNowS = ctxGet_(phone);
            ctxUpsert_(phone, {
              pendingWorkItemId: (ctxNowS && ctxNowS.activeWorkItemId) ? String(ctxNowS.activeWorkItemId) : "",
              pendingExpected: "SCHEDULE",
              pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
              lastIntent: "MAINT"
            });
            try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=SCHEDULE src=PROPERTY_STAGE"); } catch (_) {}
            try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
          } catch (_) {}

        } else {
          dalSetPendingStage_(dir, dirRow, "DETAIL", phone, "SCHEDULE_NEXT_DETAIL");
          reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));

          try {
            const ctxNowD = ctxGet_(phone);
            ctxUpsert_(phone, {
              pendingWorkItemId: (ctxNowD && ctxNowD.activeWorkItemId) ? String(ctxNowD.activeWorkItemId) : "",
              pendingExpected: "DETAIL",
              pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
              lastIntent: "MAINT"
            });
            try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=DETAIL src=PROPERTY_STAGE"); } catch (_) {}
            try { wiSetWaitTenant_(phone, "DETAIL"); } catch (_) {}
          } catch (_) {}
        }

        return;

      } catch (err) {
        try { logDevSms_(phone, "PROPERTY_STAGE_CRASH err=" + err + " stack=" + (err && err.stack), "ERR_PROPERTY"); } catch (_) {}
        var _ogErr = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_TRY_AGAIN", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogErr && _ogErr.ok)) reply_(renderTenantKey_("ERR_GENERIC_TRY_AGAIN", lang, baseVars));
        return;
      }
    }



  // -------------------------
  // UNIT (Propera Compass SAFE) — ctx-driven
  // - NEVER creates a new ticket
  // - Only writes to the ACTIVE ticket row (Directory.PendingRow)
  // - Directory is source of truth for Issue (PendingIssue) + Unit (PendingUnit)
  // - ✅ FIX: persist stage transitions in Directory to prevent loops
  // - ✅ FIX: do NOT reference OPENAI_API_KEY directly (avoid ReferenceError)
  // - ✅ FIX: CTX-first stage read via effectiveStage seam
  // - ✅ FIX: template-key only schedule prompt (no dayLine stacking)
  // -------------------------
  if (effectiveStage === "UNIT") {
    const now = new Date();

    // 0) Get ACTIVE ticket row from Directory (single source of truth)
    const pendingRow = dalGetPendingRow_(dir, dirRow);
    if (pendingRow < 2) {
      try { logDevSms_(phone, bodyTrim.slice(0, 40), "LOST_TRACK_BLOCKED exp=UNIT stage=UNIT action=REPROMPT_UNIT"); } catch (_) {}
      try { logInvariantFail_(phone, sidSafe || "", "LOST_TRACK_BLOCKED", "exp=UNIT pendingRow=" + pendingRow); } catch (_) {}
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (_og && _og.ok) replied = true;
      try {
        var ctxUnit = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxUnit && ctxUnit.activeWorkItemId) ? String(ctxUnit.activeWorkItemId) : "",
          pendingExpected: "UNIT",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        }, "UNIT_REPROMPT_NO_PTR");
      } catch (_) {}
      return;
    }

    var dirUnit = dalGetPendingUnit_(dir, dirRow);
    var tfUnit = (turnFacts && turnFacts.unit) ? String(turnFacts.unit).trim() : "";
    if (!dirUnit && tfUnit) {
      dalSetPendingUnit_(dir, dirRow, tfUnit, phone, "UNIT_FROM_TURNFACTS");
      dirUnit = tfUnit;
    }
    const unitCandidate = dirUnit ? normalizeUnit_(dirUnit) : "";

    if (!unitCandidate) {

      // ── CROSS-STAGE FACTS (Compass-safe): save property/issue even if unit is missing ──
      try {

        // A) Save PROPERTY if tenant provided it here (and Directory is blank)
        if (turnFacts && turnFacts.property && turnFacts.property.code) {
          const _propUnit = dalGetPendingProperty_(dir, dirRow);
          const dirPropCode = _propUnit.code;
          if (!dirPropCode) {
            const tProp = turnFacts.property;

            dalWithLock_("DIR_SET_PROPERTY_FROM_UNIT_STAGE", function () {
              dalSetPendingPropertyNoLock_(dir, dirRow, { code: String(tProp.code || "").trim(), name: String(tProp.name || "").trim() });
              dalSetLastUpdatedNoLock_(dir, dirRow);
              try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_PROPERTY_FROM_UNIT_STAGE row=" + dirRow); } catch (_) {}
            });

            // also update ticket row property if we have a pendingRow pointer
            if (pendingRow >= 2) {
              try {
                withWriteLock_("TICKET_SET_PROPERTY_FROM_UNIT_STAGE", () => {
                  const pName = String(tProp.name || "").trim();
                  if (pName) sheet.getRange(pendingRow, COL.PROPERTY).setValue(pName);
                });
              } catch (_) {}
            }

            try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_PROPERTY_FROM_UNIT code=[" + tProp.code + "]"); } catch (_) {}
          }
        }

        // B) Save ISSUE if tenant provided it here (and PendingIssue is blank)
        const issueCandidateUnit = String((turnFacts && turnFacts.issue) || "").trim();
        if (issueCandidateUnit) {
          const prevIssue = dalGetPendingIssue_(dir, dirRow);
          if (!prevIssue) {
            dalWithLock_("DIR_SET_ISSUE_FROM_UNIT_STAGE", function () {
              dalSetPendingIssueNoLock_(dir, dirRow, issueCandidateUnit);
              dalSetLastUpdatedNoLock_(dir, dirRow);
              try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_ISSUE_FROM_UNIT_STAGE row=" + dirRow); } catch (_) {}
            });
            try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[UNIT_STAGE_CROSS] val=[" + issueCandidateUnit.slice(0, 40) + "]"); } catch (_) {}
            try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_ISSUE_FROM_UNIT"); } catch (_) {}
          }
        }

      } catch (_) {}

      // Still need UNIT — re-ask
      if (cap && cap.hasProp) {
        const v = Object.assign({}, baseVars, { propertyName: cap.propName || cap.propCode });
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: v || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
      } else {
        var _og2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og2 && _og2.ok) replied = true;
      }

      // Expect UNIT again (deterministic)
      try {
        const ctxNow = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
          pendingExpected: "UNIT",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=UNIT src=UNIT_STAGE_REASK"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "UNIT"); } catch (_) {}
      } catch (_) {}

      return;
    }


    const unitFinal = normalizeUnit_(unitCandidate);

    // 2) Persist unit to Directory (source of truth) under lock
    dalSetPendingUnit_(dir, dirRow, unitFinal, phone, "DIR_SET_UNIT");
    try {
      dalSetUnit_(dir, dirRow, unitFinal, phone, "CANON_UNIT_LEARNED_FROM_UNIT_STAGE");
    } catch (_) {}

    // ✅ Clear UNIT expectation on success (prevents loops)
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "UNIT_RESOLVED"); } catch (_) {}

    // 3) Write unit to ticket row + update last update (locked)
    withWriteLock_("TICKET_SET_UNIT", () => {
      sheet.getRange(pendingRow, COL.UNIT).setValue(unitFinal);
      sheet.getRange(pendingRow, COL.LAST_UPDATE).setValue(now);
    });

    // WORK ENGINE SYNC — unit confirmed
    try {
      const _propPCode = dalGetPendingProperty_(dir, dirRow);
      const pCodeNow = _propPCode.code;
      syncActiveWorkItemFromTicketRow_(phone, pendingRow, pCodeNow, unitFinal);
    } catch (_) {}

    // Stage discipline: do NOT advance to SCHEDULE unless Directory.PendingIssue (col 5) is non-empty
    const dirIssue = dalGetPendingIssue_(dir, dirRow);
    if (!dirIssue) {
      setStatus_(sheet, pendingRow, "Waiting Tenant");
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (_og && _og.ok) replied = true;
      try {
        dalSetPendingStage_(dir, dirRow, "ISSUE", phone, "DIR_SET_STAGE_ISSUE");
      } catch (eStage) {
        try { logDevSms_(phone, bodyTrim, "DIR_SET_STAGE_ISSUE_ERR " + String(eStage && eStage.message ? eStage.message : eStage)); } catch (_) {}
      }
      try {
        const ctxNow2 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow2 && ctxNow2.activeWorkItemId) ? String(ctxNow2.activeWorkItemId) : "",
          pendingExpected: "ISSUE",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=ISSUE src=UNIT_STAGE_NO_ISSUE"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "ISSUE"); } catch (_) {}
      } catch (_) {}
      return;
    }

    // dirIssue non-empty — advance to SCHEDULE (template-key only: ASK_WINDOW or ASK_WINDOW_WITH_DAYHINT, no dayLine stacking)
    if (pendingRow >= 2) {
      dalSetPendingStage_(dir, dirRow, "SCHEDULE", phone, "DIR_SET_STAGE_SCHEDULE_FROM_UNIT");
      try {
        const ctxNow2 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow2 && ctxNow2.activeWorkItemId) ? String(ctxNow2.activeWorkItemId) : "",
          pendingExpected: "SCHEDULE",
          pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
          lastIntent: "MAINT"
        });
      } catch (_) {}
      try {
        const wiId = (ctxGet_(phone) || {}).activeWorkItemId;
        if (wiId && typeof workItemUpdate_ === "function") workItemUpdate_(wiId, { state: "WAIT_TENANT", substate: "SCHEDULE" });
      } catch (_) {}
      setStatus_(sheet, pendingRow, "Waiting Tenant");
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      return;
    }

    // 5) Ensure ticket message is consistent (internal storage)
    withWriteLock_("TICKET_SET_MSG_FROM_DIR", () => {
      sheet.getRange(pendingRow, COL.MSG).setValue("Unit " + unitFinal + " - " + dirIssue);
    });

    // 6) Emergency stop (template-only, NO schedule)
    // Trigger if: ticket already looks emergency OR Directory issue is emergency OR ctx.flowMode emergency
    let forceEmergency = false;
    let eKind = "";

    try {
      const dirIssueNow = dalGetPendingIssue_(dir, dirRow);
      eKind = detectEmergencyKind_(dirIssueNow) || detectEmergencyKind_(String(sheet.getRange(pendingRow, COL.MSG).getValue() || ""));
      forceEmergency = !!eKind || isEmergencyContext_(sheet, pendingRow);

      // Also honor ctx latch if present
      try {
        const ctxNowE = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
        if (String(ctxNowE.flowMode || "").toUpperCase() === "EMERGENCY") forceEmergency = true;
        if (!eKind) eKind = String(ctxNowE.emergencyKind || "").trim();
      } catch (_) {}
    } catch (_) {}

    if (forceEmergency) {

      // ✅ Latch emergency on the ticket + ctx (authoritative)
      try { latchEmergency_(sheet, pendingRow, phone, eKind || "EMERGENCY"); } catch (_) {}

      // ✅ Put Directory into EMERGENCY_DONE so every future inbound becomes follow-up note
      try {
        dalWithLock_("DIR_SET_EMERGENCY_DONE", function () {
          dalSetPendingRowNoLock_(dir, dirRow, pendingRow);
          dalSetPendingStageNoLock_(dir, dirRow, "EMERGENCY_DONE");
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_EMERGENCY_DONE row=" + dirRow); } catch (_) {}
        });
      } catch (_) {}

      setStatus_(sheet, pendingRow, "In Progress");

      const tid = String(sheet.getRange(pendingRow, COL.TICKET_ID).getValue() || "").trim();
      if (tid) { var _ogE = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED_WITH_TICKET", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: tid }), meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (!(_ogE && _ogE.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED_WITH_TID", lang, { ...baseVars, ticketId: tid })); }
      else     { var _ogE2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (!(_ogE2 && _ogE2.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED", lang, baseVars)); }

      try {
        ctxUpsert_(phone, {
          flowMode: "EMERGENCY",
          emergencyKind: eKind || "EMERGENCY",
          pendingExpected: "",
          pendingExpiresAt: "",
          pendingWorkItemId: ""
        }, "EMERGENCY_CONFIRMED_UNIT_STAGE");
      } catch (_) {}

      return;
    }

    // 7) Decide schedule vs detail (ctx-driven)
    let isClear = issueIsClear_("", 0, dirIssue) || looksActionableIssue_(dirIssue);

    // ✅ FIX: do NOT reference OPENAI_API_KEY directly (avoid ReferenceError)
    if (!isClear) {
      try {
        const props = PropertiesService.getScriptProperties();
        const apiKey = String(props.getProperty("OPENAI_API_KEY") || "").trim();
        if (apiKey) {
          const ex = smartExtract_(apiKey, dirIssue);
          isClear = issueIsClear_(ex.issueSummary, ex.issueConfidence, dirIssue) || looksActionableIssue_(dirIssue);
        }
      } catch (_) {}
    }

    setStatus_(sheet, pendingRow, "Waiting Tenant");

    if (isClear) {

      // ✅ Unified schedule stage (Propera Compass aligned)
      const schedStage = "SCHEDULE";

      // Directory = source of truth
      try {
        dalWithLock_("DIR_SET_STAGE_AFTER_UNIT", function () {
          dalSetPendingRowNoLock_(dir, dirRow, pendingRow);
          dalSetPendingStageNoLock_(dir, dirRow, schedStage);
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_STAGE_AFTER_UNIT row=" + dirRow); } catch (_) {}
        });
      } catch (_) {}

      // ✅ template-key only schedule prompt (no dayLine stacking) — Phase 2b: semantic intent
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };

      // ctx expectation = SCHEDULE
      try {
        const ctxNow3 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow3 && ctxNow3.activeWorkItemId)
            ? String(ctxNow3.activeWorkItemId)
            : "",
          pendingExpected: "SCHEDULE",
          pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=SCHEDULE src=UNIT_STAGE"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
      } catch (_) {}

    } else {
      reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));

      try {
        const ctxNow4 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow4 && ctxNow4.activeWorkItemId) ? String(ctxNow4.activeWorkItemId) : "",
          pendingExpected: "DETAIL",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=DETAIL src=UNIT_STAGE"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "DETAIL"); } catch (_) {}
      } catch (_) {}
    }

    return;
  }


  // -------------------------
  // ISSUE (Propera Compass SAFE) — ctx-driven
  // - Always write to active row from Directory.PendingRow (col 7)
  // - If missing, store issue in Directory and force PROPERTY stage (fail-safe)
  // - ✅ FIX: CTX-first stage read via effectiveStage seam
  // - ✅ FIX: template-key only schedule prompt (no tenantMsg_, no dayLine stacking)
  // -------------------------
  if (effectiveStage === "ISSUE") {
    var issueText = String(bodyTrim || "").trim();
    var issueLower = issueText.toLowerCase();

    // Guard: do not treat intent tokens as tenant issue text
    // (e.g., legacy internal injection "service"/"maintenance")
    var looksLikeIntentToken =
      (issueLower === "service") ||
      (issueLower === "maintenance") ||
      (issueLower === "leasing") ||
      (issueLower === "reservation") ||
      (issueLower === "amenities") ||
      (issueLower === "amenity");

    if (looksLikeIntentToken) {
      const _issueAskKey = { urgent: "ASK_ISSUE_URGENT", postService: "ASK_ISSUE_POST_SERVICE", recurring: "ASK_ISSUE_RECURRING", frustrated: "ASK_ISSUE_FRUSTRATED" }[signals.tone] || "ASK_ISSUE_GENERIC";
      reply_(renderTenantKey_(_issueAskKey, lang, baseVars));
      try {
        const ctxNowTok = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNowTok && ctxNowTok.activeWorkItemId) ? String(ctxNowTok.activeWorkItemId) : "",
          pendingExpected: "ISSUE",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { wiSetWaitTenant_(phone, "ISSUE"); } catch (_) {}
        try { logDevSms_(phone, issueText, "ISSUE_WRITE_SKIP site=[ISSUE_STAGE_RESOLVED] reason=[intent_token]"); } catch (_) {}
      } catch (_) {}
      return;
    }

    const meta2 = (turnFacts && turnFacts.meta) ? turnFacts.meta : {};

    // ✅ Normalize ATTACHMENT_ONLY so it NEVER becomes issue text.
    // If this turn has media and the body override is ATTACHMENT_ONLY, treat as "no issue text" + media-only.
    try {
      var _it = String(issueText || "").trim();
      var _itU = _it.toUpperCase();
      var _mu = (meta2 && Array.isArray(meta2.mediaUrls)) ? meta2.mediaUrls : [];
      if (_itU === "ATTACHMENT_ONLY" && _mu.length > 0) {
        issueText = "";
        meta2.hasMediaOnly = true;
      }
    } catch (_) {}

    // ✅ Photo-only path (ASK_ISSUE_FROM_PHOTO) — but first persist attachments to active ticket if we have one.
    if (!issueText && meta2 && meta2.hasMediaOnly === true) {

      // Persist attachments even when no issue text (so AppSheet shows the photo)
      try {
        var _mu2 = (meta2 && Array.isArray(meta2.mediaUrls)) ? meta2.mediaUrls : [];
        var _ar = dalGetPendingRow_(dir, dirRow);
        if (_ar >= 2 && _mu2.length > 0) {
          withWriteLock_("TICKET_APPEND_ATTACH_FROM_PHOTO_ONLY", () => {
            const abCol = 28; // COL.ATTACHMENTS

            // Prefer meta2.channel; fallback derive from From
            var abChannel = (meta2 && meta2.channel) ? String(meta2.channel) : "";
            if (!abChannel && typeof safeParam_ === "function") {
              var _from = String(safeParam_(e, "From") || "").trim().toLowerCase();
              abChannel = (_from.indexOf("whatsapp:") === 0) ? "whatsapp" : "sms";
            }

            var existing = String(sheet.getRange(_ar, abCol).getValue() || "").trim();
            var lines = existing ? existing.split("\n").filter(Boolean) : [];
            for (var u = 0; u < _mu2.length; u++) {
              var url = String(_mu2[u] || "").trim();
              if (!url) continue;
              if (existing.indexOf(url) === -1) {
                var line = new Date().toISOString() + " | " + (abChannel ? abChannel.toUpperCase() : "MEDIA") + " | " + url;
                lines.push(line);
              }
            }
            if (lines.length > 0) sheet.getRange(_ar, abCol).setValue(lines.slice(-10).join("\n"));
            sheet.getRange(_ar, COL.LAST_UPDATE).setValue(new Date());
          });
        }
      } catch (_) {}

      reply_(renderTenantKey_("ASK_ISSUE_FROM_PHOTO", lang, baseVars));
      try {
        const ctxNowP = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNowP && ctxNowP.activeWorkItemId) ? String(ctxNowP.activeWorkItemId) : "",
          pendingExpected: "ISSUE",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { wiSetWaitTenant_(phone, "ISSUE"); } catch (_) {}
      } catch (_) {}
      return;
    }

    if (!issueText) {
      const _issueAskKey = { urgent: "ASK_ISSUE_URGENT", postService: "ASK_ISSUE_POST_SERVICE", recurring: "ASK_ISSUE_RECURRING", frustrated: "ASK_ISSUE_FRUSTRATED" }[signals.tone] || "ASK_ISSUE_GENERIC";
      reply_(renderTenantKey_(_issueAskKey, lang, baseVars));

      try {
        const ctxNow0 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow0 && ctxNow0.activeWorkItemId) ? String(ctxNow0.activeWorkItemId) : "",
          pendingExpected: "ISSUE",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { wiSetWaitTenant_(phone, "ISSUE"); } catch (_) {}
      } catch (_) {}

      return;
    }

    // Parse and use best clause/title — never write raw bodyTrim (avoids "bible overwrite")
    var resolvedIssue = issueText;
    if (typeof parseIssueDeterministic_ === "function") {
      try {
        var parsed = parseIssueDeterministic_(issueText, {});
        if (parsed && (parsed.bestClauseText || parsed.title)) {
          resolvedIssue = String(parsed.bestClauseText || parsed.title || "").trim();
          if (typeof normalizeIssueText_ === "function") {
            try { resolvedIssue = normalizeIssueText_(resolvedIssue); } catch (_) {}
          }
        }
      } catch (_) {}
    }
    if (!resolvedIssue && typeof normalizeIssueText_ === "function") {
      try { resolvedIssue = normalizeIssueText_(issueText); } catch (_) {}
    }
    if (!resolvedIssue) resolvedIssue = issueText;

    // Always keep issue text in Directory (E) so we don't lose it
    const prevDirIssue = dalGetPendingIssue_(dir, dirRow);
    const mergedIssue = prevDirIssue ? (prevDirIssue + " | " + resolvedIssue) : resolvedIssue;
    const mergedTrim = String(mergedIssue || "").trim();

    if (mergedTrim) {
      dalSetPendingIssue_(dir, dirRow, mergedIssue, phone, "DIR_SET_ISSUE");
      try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[ISSUE_STAGE_RESOLVED] val=[" + mergedTrim.slice(0, 40) + "]"); } catch (_) {}
    } else {
      try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE_SKIP site=[ISSUE_STAGE_RESOLVED] reason=[empty_issueText]"); } catch (_) {}
    }

  // ✅ Clear ISSUE expectation on success (prevents loops)
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "ISSUE_RESOLVED"); } catch (_) {}

    // ── CROSS-STAGE FACTS (Compiler): save property/unit if tenant included them ──
    try {
      const now_i = new Date();

      // A) Save PROPERTY if tenant provided it and Directory is blank
      if (turnFacts && turnFacts.property && turnFacts.property.code) {
        const _propIssue = dalGetPendingProperty_(dir, dirRow);
        const dirPropCode_i = _propIssue.code;
        if (!dirPropCode_i) {
          dalWithLock_("DIR_SET_PROPERTY_FROM_ISSUE_STAGE", function () {
            dalSetPendingPropertyNoLock_(dir, dirRow, { code: String(turnFacts.property.code || "").trim(), name: String(turnFacts.property.name || "").trim() });
            dalSetLastUpdatedNoLock_(dir, dirRow);
            try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_PROPERTY_FROM_ISSUE_STAGE row=" + dirRow); } catch (_) {}
          });
          // Also update ticket row if pointer exists
          const pr_i = dalGetPendingRow_(dir, dirRow);
          if (pr_i >= 2) {
            try {
              withWriteLock_("TICKET_SET_PROPERTY_FROM_ISSUE_STAGE", () => {
                sheet.getRange(pr_i, COL.PROPERTY).setValue(String(turnFacts.property.name || "").trim());
              });
            } catch (_) {}
          }
          try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_PROPERTY_FROM_ISSUE code=[" + turnFacts.property.code + "]"); } catch (_) {}
        }
      }

      // B) Save UNIT if tenant provided it and Directory unit is blank
      if (turnFacts && turnFacts.unit) {
        const dirUnit_i = dalGetPendingUnit_(dir, dirRow);
        if (!dirUnit_i) {
          const u_i = normalizeUnit_(turnFacts.unit);
          dalSetPendingUnit_(dir, dirRow, u_i, phone, "DIR_SET_UNIT_FROM_ISSUE_STAGE");
          const pr_i2 = dalGetPendingRow_(dir, dirRow);
          if (pr_i2 >= 2) {
            try {
              withWriteLock_("TICKET_SET_UNIT_FROM_ISSUE_STAGE", () => {
                sheet.getRange(pr_i2, COL.UNIT).setValue(u_i);
              });
            } catch (_) {}
          }
          try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_UNIT_FROM_ISSUE unit=[" + u_i + "]"); } catch (_) {}
        }
      }

    } catch (_) {}

    // Compass: always locate active ticket row from Directory pointer
    const activeRow = dalGetPendingRow_(dir, dirRow);

    // Fail-safe: if pointer missing, only prompt property when we truly lack it
    if (activeRow < 2) {
      var _dirProp = dalGetPendingProperty_(dir, dirRow);
      var _dirPropCode = String(_dirProp && _dirProp.code ? _dirProp.code : "").trim();
      var _dirPropName = String(_dirProp && _dirProp.name ? _dirProp.name : "").trim();
      var _ctx = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
      var effectiveProp = (_ctx && _ctx.propertyCode) ? String(_ctx.propertyCode).trim() : (_dirPropCode || _dirPropName || "");
      var dirProp = _dirPropCode || _dirPropName || "";
      try { logDevSms_(phone, "", "ISSUE_STAGE_PROP_PTR effective=[" + effectiveProp + "] ctx=[" + (_ctx && _ctx.propertyCode ? String(_ctx.propertyCode) : "") + "] dir=[" + dirProp + "]"); } catch (_) {}

      if (!effectiveProp) {
        reply_(replyAskPropertyMenu_(lang, baseVars));
        try {
          const ctxNow = ctxGet_(phone);
          ctxUpsert_(phone, {
            pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
            pendingExpected: "PROPERTY",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=PROPERTY src=ISSUE_STAGE_LOST_PTR"); } catch (_) {}
          try { wiSetWaitTenant_(phone, "PROPERTY"); } catch (_) {}
        } catch (_) {}
        return;
      }

      // Property exists — proceed to next needed field (UNIT if missing) or create ticket
      var _dirUnit = String(dalGetPendingUnit_(dir, dirRow) || "").trim();
      var _dirIssue = String(dalGetPendingIssue_(dir, dirRow) || "").trim();
      if (!_dirIssue && typeof sessionGet_ === "function") {
        try { var _s = sessionGet_(phone); if (_s && _s.draftIssue) _dirIssue = String(_s.draftIssue || "").trim(); } catch (_) {}
      }
      if (!_dirUnit) {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars || {}, { propertyName: _dirPropName || _dirPropCode }), meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
        try {
          ctxUpsert_(phone, {
            pendingWorkItemId: "",
            pendingExpected: "UNIT",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=UNIT src=ISSUE_STAGE_HAS_PROP"); } catch (_) {}
          try { wiSetWaitTenant_(phone, "UNIT"); } catch (_) {}
        } catch (_) {}
        return;
      }
      if (!_dirIssue) {
        reply_(replyAskPropertyMenu_(lang, baseVars));
        try {
          const ctxNow = ctxGet_(phone);
          ctxUpsert_(phone, {
            pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
            pendingExpected: "PROPERTY",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=PROPERTY src=ISSUE_STAGE_LOST_PTR"); } catch (_) {}
          try { wiSetWaitTenant_(phone, "PROPERTY"); } catch (_) {}
        } catch (_) {}
        return;
      }

      // property + unit + issue — create ticket via canonical path
      var _recov = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, {
        inboundKey: inboundKey,
        OPENAI_API_KEY: OPENAI_API_KEY,
        TWILIO_SID: TWILIO_SID,
        TWILIO_TOKEN: TWILIO_TOKEN,
        TWILIO_NUMBER: TWILIO_NUMBER,
        ONCALL_NUMBER: ONCALL_NUMBER,
        lang: lang,
        baseVars: baseVars,
        firstMediaUrl: (turnFacts.meta && turnFacts.meta.mediaUrls && turnFacts.meta.mediaUrls[0]) ? String(turnFacts.meta.mediaUrls[0]).trim() : "",
        mediaType: (mediaFacts && mediaFacts.mediaType) ? String(mediaFacts.mediaType || "").trim() : "",
        mediaCategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.category) ? String(mediaFacts.issueHints.category || "").trim() : "",
        mediaSubcategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.subcategory) ? String(mediaFacts.issueHints.subcategory || "").trim() : "",
        mediaUnitHint: (mediaFacts && mediaFacts.unitHint) ? String(mediaFacts.unitHint || "").trim() : ""
      });
      if (_recov && _recov.ok && _recov.multiIssuePending) {
        var _nextMi = String(_recov.nextStage || "").trim().toUpperCase();
        if (_nextMi === "UNIT") { var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (_og && _og.ok) replied = true; return; }
        if (_nextMi === "SCHEDULE" || _nextMi === "SCHEDULE_DRAFT_MULTI") {
          var _combined = (_recov.summaryMsg && String(_recov.summaryMsg).trim())
            ? String(_recov.summaryMsg).trim()
            : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
          var _ogComb = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { summaryText: _combined }), meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          if (!(_ogComb && _ogComb.ok)) replyNoHeader_(_combined);
          return;
        }
        return;
      }
      if (_recov && _recov.ok && _recov.loggedRow >= 2) {
        var _nextSt = String(_recov.nextStage || "").trim().toUpperCase();
        if (_nextSt === "") {
          if (!_recov.ackOwnedByPolicy) {
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_COMMON_AREA", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: String(_recov.ticketId || "") }), meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
          } else {
            try { logDevSms_(phone, "", "ACK_SUPPRESSED_BY_POLICY workItemId=" + (_recov.createdWi || "") + " rule=" + (_recov.policyRuleId || "")); } catch (_) {}
          }
          return;
        }
        if (_nextSt === "UNIT") { var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (_og && _og.ok) replied = true; return; }
        if (_nextSt === "SCHEDULE") {
          var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          return;
        }
        return;
      }
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_DRAFT_FINALIZE_FAILED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      return;
    }

    // Append to ticket message (locked)
    withWriteLock_("TICKET_APPEND_MSG_FROM_ISSUE", () => {
      const prevMsg = String(sheet.getRange(activeRow, COL.MSG).getValue() || "").trim();
      var nextMsg = prevMsg;
      if (issueText) nextMsg = prevMsg ? (prevMsg + " | " + issueText) : issueText;
      if (nextMsg !== prevMsg) sheet.getRange(activeRow, COL.MSG).setValue(nextMsg);

      sheet.getRange(activeRow, COL.LAST_UPDATE).setValue(new Date());

      var mediaUrls = (turnFacts && turnFacts.meta && Array.isArray(turnFacts.meta.mediaUrls)) ? turnFacts.meta.mediaUrls : [];
      if (activeRow >= 2 && mediaUrls.length > 0) {
        const abCol = 28;
        // Prefer turnFacts.meta.channel; fallback derive from From at write time so AB never shows MEDIA when we know channel
        var abChannel = (meta2 && meta2.channel) ? String(meta2.channel) : "";
        if (!abChannel && typeof safeParam_ === "function") {
          var _from = String(safeParam_(e, "From") || "").trim().toLowerCase();
          abChannel = (_from.indexOf("whatsapp:") === 0) ? "whatsapp" : "sms";
        }
        var existing = String(sheet.getRange(activeRow, abCol).getValue() || "").trim();
        var lines = existing ? existing.split("\n").filter(Boolean) : [];
        for (var u = 0; u < mediaUrls.length; u++) {
          var url = String(mediaUrls[u] || "").trim();
          if (!url) continue;
          if (existing.indexOf(url) === -1) {
            var line = new Date().toISOString() + " | " + (abChannel ? abChannel.toUpperCase() : "MEDIA") + " | " + url;
            lines.push(line);
          }
        }
        if (lines.length > 0) {
          var out = lines.slice(-10).join("\n");
          sheet.getRange(activeRow, abCol).setValue(out);
        }
      }
    });

    setStatus_(sheet, activeRow, "Waiting Tenant");

    // Emergency finalize check
    if (isEmergencyContext_(sheet, activeRow)) {
      if (typeof finishEmergencyIfReady_ === "function") {
        if (finishEmergencyIfReady_(sheet, dir, dirRow, activeRow, lang)) return;
      }
    }

    // Decide schedule vs detail
    const fullText = String(sheet.getRange(activeRow, COL.MSG).getValue() || "").trim();
    let isClear = issueIsClear_("", 0, fullText) || looksActionableIssue_(fullText);

    // ✅ SAFE: avoid ReferenceError (no direct OPENAI_API_KEY reference)
    if (!isClear) {
      try {
        const props = PropertiesService.getScriptProperties();
        const apiKey = String(props.getProperty("OPENAI_API_KEY") || "").trim();
        if (apiKey) {
          const ex = smartExtract_(apiKey, fullText);
          isClear =
            issueIsClear_(ex.issueSummary, ex.issueConfidence, fullText) ||
            looksActionableIssue_(fullText);
        }
      } catch (_) {}
    }

    if (isClear) {
      const schedStage = "SCHEDULE";

      // ✅ critical: Directory is source of truth for stage
      try {
        dalSetPendingStage_(dir, dirRow, schedStage, phone, "DIR_SET_STAGE_AFTER_ISSUE");
      } catch (_) {}

      // ✅ template-key only schedule prompt (no tenantMsg_, no dayLine) — Phase 2b: semantic intent
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };

      try {
        const ctxNow2 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow2 && ctxNow2.activeWorkItemId) ? String(ctxNow2.activeWorkItemId) : "",
          pendingExpected: "SCHEDULE",
          pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=SCHEDULE src=ISSUE_STAGE"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
      } catch (_) {}

      return;

    } else {

      // ✅ CRITICAL: persist stage so the next reply routes to DETAIL
      try {
        dalSetPendingStage_(dir, dirRow, "DETAIL", phone, "DIR_SET_STAGE_DETAIL_FROM_ISSUE");
      } catch (_) {}

      reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));

      try {
        const ctxNow3 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow3 && ctxNow3.activeWorkItemId) ? String(ctxNow3.activeWorkItemId) : "",
          pendingExpected: "DETAIL",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=DETAIL src=ISSUE_STAGE"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "DETAIL"); } catch (_) {}
      } catch (_) {}

      return;
    }
  }
  }

  // -------------------------
  // DETAIL (Propera Compass SAFE) — ctx-driven
  // - Always write to active row from Directory.PendingRow (col 7)
  // - If missing, fail-safe to PROPERTY (do NOT write to sheet)
  // - ✅ FIX: set Directory.PendingStage = "SCHEDULE" (NOT SCHEDULE_*)
  // - ✅ FIX: ctx.pendingExpected = "SCHEDULE" (NOT SCHEDULE_*)
  // - ✅ FIX: CTX-first stage read via effectiveStage seam
  // - ✅ FIX: template-key only schedule prompt (no tenantMsg_, no dayLine stacking)
  // -------------------------
  if (effectiveStage === "DETAIL") {
    const detail = String(bodyTrim || "").trim();

    if (!detail) {
      reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));

      // Expect DETAIL again
      try {
        const ctxNow0 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow0 && ctxNow0.activeWorkItemId) ? String(ctxNow0.activeWorkItemId) : "",
          pendingExpected: "DETAIL",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { wiSetWaitTenant_(phone, "DETAIL"); } catch (_) {}
      } catch (_) {}

      return;
    }

  // ✅ Clear DETAIL expectation on success (prevents loops)
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "DETAIL_RESOLVED"); } catch (_) {}

    // ── CROSS-STAGE FACTS (Compiler): save property/unit if tenant included them ──
    try {
      const now_d = new Date();

      // A) Save PROPERTY if tenant provided it and Directory is blank
      if (turnFacts && turnFacts.property && turnFacts.property.code) {
        const _propDetail = dalGetPendingProperty_(dir, dirRow);
        const dirPropCode_d = _propDetail.code;
        if (!dirPropCode_d) {
          dalWithLock_("DIR_SET_PROPERTY_FROM_DETAIL_STAGE", function () {
            dalSetPendingPropertyNoLock_(dir, dirRow, { code: String(turnFacts.property.code || "").trim(), name: String(turnFacts.property.name || "").trim() });
            dalSetLastUpdatedNoLock_(dir, dirRow);
            try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_PROPERTY_FROM_DETAIL_STAGE row=" + dirRow); } catch (_) {}
          });
          const pr_d = dalGetPendingRow_(dir, dirRow);
          if (pr_d >= 2) {
            try {
              withWriteLock_("TICKET_SET_PROPERTY_FROM_DETAIL_STAGE", () => {
                sheet.getRange(pr_d, COL.PROPERTY).setValue(String(turnFacts.property.name || "").trim());
              });
            } catch (_) {}
          }
          try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_PROPERTY_FROM_DETAIL code=[" + turnFacts.property.code + "]"); } catch (_) {}
        }
      }

      // B) Save UNIT if tenant provided it and Directory unit is blank
      if (turnFacts && turnFacts.unit) {
        const dirUnit_d = dalGetPendingUnit_(dir, dirRow);
        if (!dirUnit_d) {
          const u_d = normalizeUnit_(turnFacts.unit);
          dalSetPendingUnit_(dir, dirRow, u_d, phone, "DIR_SET_UNIT_FROM_DETAIL_STAGE");
          const pr_d2 = dalGetPendingRow_(dir, dirRow);
          if (pr_d2 >= 2) {
            try {
              withWriteLock_("TICKET_SET_UNIT_FROM_DETAIL_STAGE", () => {
                sheet.getRange(pr_d2, COL.UNIT).setValue(u_d);
              });
            } catch (_) {}
          }
          try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_UNIT_FROM_DETAIL unit=[" + u_d + "]"); } catch (_) {}
        }
      }

    } catch (_) {}

    const activeRow = dalGetPendingRow_(dir, dirRow);

    if (activeRow < 2) {
      reply_(replyAskPropertyMenu_(lang, baseVars));

      try {
        const ctxNow = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
          pendingExpected: "PROPERTY",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=PROPERTY src=DETAIL_STAGE_LOST_PTR"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "PROPERTY"); } catch (_) {}
      } catch (_) {}

      return;
    }

    // Append detail to ticket message (internal storage)
    withWriteLock_("TICKET_APPEND_DETAIL", () => {
      const prevMsg = String(sheet.getRange(activeRow, COL.MSG).getValue() || "").trim();
      const combined = prevMsg ? (prevMsg + " | Detail: " + detail) : ("Detail: " + detail);
      sheet.getRange(activeRow, COL.MSG).setValue(combined);
      sheet.getRange(activeRow, COL.LAST_UPDATE).setValue(new Date());
    });

    setStatus_(sheet, activeRow, "Waiting Tenant");

    // Emergency finalize check
    if (isEmergencyContext_(sheet, activeRow)) {
      if (typeof finishEmergencyIfReady_ === "function") {
        if (finishEmergencyIfReady_(sheet, dir, dirRow, activeRow, lang)) return;
      }
    }

    // ✅ IMPORTANT: unify schedule stage
    try {
      dalSetPendingStage_(dir, dirRow, "SCHEDULE", phone, "DIR_SET_STAGE_SCHEDULE_FROM_DETAIL");
    } catch (_) {}

    // ✅ template-key only schedule prompt (no tenantMsg_, no dayLine) — Phase 2b: semantic intent
    var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_SMS_CORE", stage: "DETAIL", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };

    try {
      const ctxNow2 = ctxGet_(phone);
      ctxUpsert_(phone, {
        pendingWorkItemId: (ctxNow2 && ctxNow2.activeWorkItemId) ? String(ctxNow2.activeWorkItemId) : "",
        pendingExpected: "SCHEDULE",
        pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
        lastIntent: "MAINT"
      });
      try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=SCHEDULE src=DETAIL_STAGE"); } catch (_) {}
      try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
    } catch (_) {}

    return;
  }



  // -------------------------
  // SCHEDULE stage — extracted sub-functions (verbatim logic, no behavior change)
  // -------------------------
  function handleScheduleAddIssue_(sheet, dir, dirRow, phone, rawTrim, lang, baseVars, dirStage, ctxExp, reAskScheduleFn) {
    // Failsafe: do not append schedule-like content as SCHEDULE_ADD
    if ((typeof isScheduleLike_ === "function") && isScheduleLike_(String(rawTrim || "").trim())) return false;
    // Failsafe: skip SCHEDULE_ADD append if last buffer item was just added (within 5s) from SCHEDULE (draftUpsert already appended)
    if (typeof getIssueBuffer_ === "function") {
      var buf = getIssueBuffer_(dir, dirRow);
      if (buf && buf.length > 0) {
        var last = buf[buf.length - 1];
        var lastStage = String(last && last.sourceStage ? last.sourceStage : "").trim();
        var lastCreated = 0;
        try { lastCreated = (last && last.createdAt) ? new Date(last.createdAt).getTime() : 0; } catch (_) {}
        if (lastStage === "SCHEDULE" && (Date.now() - lastCreated) <= 5000) return false;
      }
    }
    withWriteLock_("SCHEDULE_ADD_ISSUEBUF", function () {
      if (typeof appendIssueBufferItem_ === "function") appendIssueBufferItem_(dir, dirRow, rawTrim, "SCHEDULE_ADD");
    });
    reAskScheduleFn("ADDED_ISSUE_WAITING_SCHEDULE");
    return true;
  }

  function handleScheduleMultiBuffer_(sheet, dir, dirRow, phone, rawTrim, lang, baseVars, stageDay, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER) {
    if (!looksLikeWindowReply_(rawTrim, stageDay)) return false;
    const label = windowLabel_(rawTrim, stageDay);
    if (!label) return false;
    var multiBuf = (typeof getIssueBuffer_ === "function") ? getIssueBuffer_(dir, dirRow) : [];
    var _multiProp = dalGetPendingProperty_(dir, dirRow);
    var multiPropCode = _multiProp.code;
    var multiPropName = _multiProp.name;
    var multiUnit = dalGetPendingUnit_(dir, dirRow);
    if (multiBuf.length < 2 || !multiPropCode) return false;

    // Policy validation before creating visits/tickets
    var propCode = String(multiPropCode || "").trim().toUpperCase() || "GLOBAL";
    var sched = { label: label };
    if (typeof parsePreferredWindow_ === "function") {
      try {
        var d = parsePreferredWindow_(rawTrim, stageDay);
        if (d) {
          if (d.start && d.start instanceof Date) { sched.date = d.start; sched.startHour = d.start.getHours(); }
          if (d.end && d.end instanceof Date) { sched.date = sched.date || d.end; sched.endHour = d.end.getHours(); }
        }
      } catch (_) {}
    }
    var verdict = (typeof validateSchedPolicy_ === "function") ? validateSchedPolicy_(propCode, sched, new Date()) : { ok: true };
    if (!verdict.ok) {
      var _vk = String(verdict.key || "").trim();
      var _ogV = (typeof dispatchOutboundIntent_ === "function" && _vk) ? dispatchOutboundIntent_({ intentType: _vk, templateKey: _vk, recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, verdict.vars || {}), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogV && _ogV.ok)) { replyNoHeader_(renderTenantKey_(verdict.key, lang, Object.assign({}, baseVars, verdict.vars || {}))); }
      try { logDevSms_(phone, rawTrim, "SCHED_POLICY_DENY key=[" + verdict.key + "] prop=[" + propCode + "] multi=1"); } catch (_) {}
      try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
      try {
        var ctxNow = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
        var wiPick = ctxNow ? (String(ctxNow.pendingWorkItemId || "").trim() || String(ctxNow.activeWorkItemId || "").trim()) : "";
        if (typeof ctxUpsert_ === "function") ctxUpsert_(phone, { pendingWorkItemId: wiPick, pendingExpected: "SCHEDULE", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000) }, "SCHED_POLICY_REJECT_MULTI");
      } catch (_) {}
      return true;
    }
    var visitsSh = (typeof ensureVisitsSheet_ === "function") ? ensureVisitsSheet_() : null;
    var visitId = (typeof createVisit_ === "function" && visitsSh)
      ? createVisit_(visitsSh, multiPropCode, multiPropName, multiUnit, label, phone) : "";
    if (!visitId) visitId = "V_" + Date.now();
    try { logDevSms_(phone, "", "VISIT_CREATE visitId=" + visitId); } catch (_) {}
    var sp = PropertiesService.getScriptProperties();
    var creds = {
      OPENAI_API_KEY: sp.getProperty("OPENAI_API_KEY") || "",
      TWILIO_SID: TWILIO_SID || "",
      TWILIO_TOKEN: TWILIO_TOKEN || "",
      TWILIO_NUMBER: TWILIO_NUMBER || "",
      ONCALL_NUMBER: ONCALL_NUMBER || ""
    };
    var ticketIds = [];
    var msgRaw = "";
    withWriteLock_("VISIT_CHILD_TICKETS", () => {
      for (var idx = 0; idx < multiBuf.length; idx++) {
        var it = multiBuf[idx];
        msgRaw = (it && it.rawText) ? String(it.rawText).trim() : "";
        if (!msgRaw) continue;
        var childInboundKey = "VISIT:" + visitId + ":ISSUE:" + (idx + 1);
        var childLocType = "";
        if (typeof inferLocationTypeDeterministic_ === "function") {
          try {
            var childFast = inferLocationTypeDeterministic_(msgRaw);
            var childLt = childFast && childFast.locationType ? String(childFast.locationType).toUpperCase() : "";
            if (childLt === "UNIT" || childLt === "COMMON_AREA") childLocType = childLt;
          } catch (_) {}
        }
        var t = processTicket_(sheet, sp, creds, {
          from: phone,
          tenantPhone: phone,
          propertyName: multiPropName,
          unitFromText: multiUnit,
          messageRaw: msgRaw,
          createdByManager: false,
          inboundKey: childInboundKey,
          locationType: childLocType
        });
        var row = (t && t.rowIndex) ? t.rowIndex : (t && t.row) ? t.row : 0;
        if (row >= 2) {
          if (sheet.getLastColumn() < COL.VISIT_ID) { try { sheet.getRange(1, COL.VISIT_ID).setValue("VisitId"); } catch (_) {} }
          sheet.getRange(row, COL.VISIT_ID).setValue(visitId);
          var tid = (t && t.ticketId) ? String(t.ticketId).trim() : "";
          if (tid) ticketIds.push(tid);
          try { logDevSms_(phone, msgRaw.slice(0, 40), "CHILD_TICKET_CREATE i=" + (idx + 1) + " inbound=" + childInboundKey + " tid=" + tid + " row=" + row); } catch (_) {}
        }
      }
    });
    dalWithLock_("VISIT_CLEAR_DIR", function () {
      dalSetPendingIssueNoLock_(dir, dirRow, "");
      try { logDevSms_(phone, msgRaw, "ISSUE_WRITE site=[VISIT_CLEAR_DIR] val=[CLEAR_VISIT]"); } catch (_) {}
      dalSetPendingRowNoLock_(dir, dirRow, "");
      dalSetPendingStageNoLock_(dir, dirRow, "");
      if (typeof setIssueBuffer_ === "function") setIssueBuffer_(dir, dirRow, []);
      dalSetLastUpdatedNoLock_(dir, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE VISIT_CLEAR_DIR row=" + dirRow); } catch (_) {}
    });
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "VISIT_RESOLVED"); } catch (_) {}
    var _visitVars = Object.assign({}, baseVars, { visitId: visitId, ticketIds: ticketIds.join(", "), label: label });
    var _ogVisit = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({
      intentType: "VISIT_CONFIRM", recipientType: "TENANT", recipientRef: phone, lang: lang,
      channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER",
      vars: _visitVars, meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" }
    }) : { ok: false };
    if (!(_ogVisit && _ogVisit.ok)) {
      var _confirmMsg = (typeof renderTenantKey_ === "function") ? renderTenantKey_("VISIT_CONFIRM_MULTI", lang, _visitVars) : ("Visit " + visitId + " scheduled for " + label + ". Tickets: " + ticketIds.join(", "));
      replied = true;
      if (typeof sendRouterSms_ === "function") sendRouterSms_(phone, _confirmMsg, "VISIT_CONFIRM_MULTI"); else replyNoHeader_(_confirmMsg);
    } else { replied = true; }
    try { logDevSms_(phone, "", "VISIT_CONFIRM_SENT"); } catch (_) {}
    try {
      if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") {
        advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang);
      }
    } catch (_) {}
    return true;
  }

  function handleScheduleSingleTicket_(sheet, dir, dirRow, phone, activeRow, rawTrim, lang, baseVars, dayWord, turnFacts, sidSafe, now, signals) {
    var stageDay = "Today";
    try {
      if (typeof inferStageDayFromText_ === "function") {
        var inferred = inferStageDayFromText_(rawTrim, dayWord);
        if (inferred) stageDay = inferred;
      }
    } catch (_) {}
    if (!looksLikeWindowReply_(rawTrim, stageDay)) return false;
    const label = windowLabel_(rawTrim, stageDay);
    if (!label) {
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      return true;
    }

    // Policy validation (conservative: only enforces date/hours when parser provides them)
    var propObj = (typeof dalGetPendingProperty_ === "function") ? dalGetPendingProperty_(dir, dirRow) : {};
    var propCode = String(propObj && propObj.code ? propObj.code : "").trim().toUpperCase() || "GLOBAL";
    var sched = { label: label };
    var d = null;
    if (typeof inferStageDayFromText_ === "function" && typeof parsePreferredWindow_ === "function") {
      try {
        var inferred = inferStageDayFromText_(rawTrim, dayWord);
        if (inferred) {
          d = parsePreferredWindow_(rawTrim, inferred);
          if (d) {
            if (d.start && d.start instanceof Date) { sched.date = d.start; sched.startHour = d.start.getHours(); }
            if (d.end && d.end instanceof Date) { sched.date = sched.date || d.end; sched.endHour = d.end.getHours(); }
          }
        }
      } catch (_) {}
    }
    var verdict = (typeof validateSchedPolicy_ === "function") ? validateSchedPolicy_(propCode, sched, now) : { ok: true };
    if (!verdict.ok) {
      var _vk = String(verdict.key || "").trim();
      var _ogV = (typeof dispatchOutboundIntent_ === "function" && _vk) ? dispatchOutboundIntent_({ intentType: _vk, templateKey: _vk, recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, verdict.vars || {}), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogV && _ogV.ok)) { replyNoHeader_(renderTenantKey_(verdict.key, lang, Object.assign({}, baseVars, verdict.vars || {}))); }
      try { logDevSms_(phone, rawTrim, "SCHED_POLICY_DENY key=[" + verdict.key + "] prop=[" + propCode + "]"); } catch (_) {}
      try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
      try {
        var ctxNow = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
        var wiPick = ctxNow ? (String(ctxNow.pendingWorkItemId || "").trim() || String(ctxNow.activeWorkItemId || "").trim()) : "";
        if (typeof ctxUpsert_ === "function") ctxUpsert_(phone, { pendingWorkItemId: wiPick, pendingExpected: "SCHEDULE", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000) }, "SCHED_POLICY_REJECT");
      } catch (_) {}
      return true;
    }

    // ✅ TicketId lookup MUST be BEFORE we clear/advance anything
    const ticketId = String(sheet.getRange(activeRow, COL.TICKET_ID).getValue() || "").trim();
    // ✅ Issue summary for confirmation (ticket row message = issue/summary)
    var issueSummary = "";
    try {
      issueSummary = String(sheet.getRange(activeRow, COL.MSG).getValue() || "").trim();
      if (issueSummary && typeof normalizeIssueText_ === "function") {
        var norm = normalizeIssueText_(issueSummary);
        if (norm) issueSummary = String(norm).trim();
      }
    } catch (_) {}
    // ✅ Extra issues captured in buffer (if present) → "(+N more)"
    var moreCount = 0;
    try {
      if (typeof getIssueBuffer_ === "function" && dirRow > 0) {
        var buf = getIssueBuffer_(dir, dirRow) || [];
        if (Array.isArray(buf) && buf.length) moreCount = buf.length;
      }
    } catch (_) {}
    var issueLine = issueSummary;
    if (issueLine && moreCount > 0) issueLine = issueLine + " (+" + moreCount + " more)";
    // Capture WI BEFORE any ctx changes
    let doneWi = "";
    try {
      const ctxNow = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
      doneWi = String(ctxNow.pendingWorkItemId || ctxNow.activeWorkItemId || "").trim();
    } catch (_) {}
    withWriteLock_("SCHED_SET_LABEL", () => {
      sheet.getRange(activeRow, COL.PREF_WINDOW).setValue(label);
      sheet.getRange(activeRow, COL.LAST_UPDATE).setValue(now);
      // Write structured end datetime for lifecycle engine.
      // d is already the parsed result in scope — use d.end directly, do not re-parse.
      // clearContent() when end is null to prevent stale datetime from a previous schedule.
      try {
        if (d && d.end instanceof Date) {
          sheet.getRange(activeRow, COL.SCHEDULED_END_AT).setValue(d.end);
        } else {
          sheet.getRange(activeRow, COL.SCHEDULED_END_AT).clearContent();
        }
      } catch (_) {}
    });
    setStatus_(sheet, activeRow, "Scheduled");
    // ✅ WorkItem: no longer waiting on tenant
    if (doneWi) {
      try {
        workItemUpdate_(doneWi, { state: "ACTIVE_WORK", substate: "" });
        try { logDevSms_(phone, rawTrim, "WI_UPDATE done wi=[" + doneWi + "] state=ACTIVE_WORK"); } catch (_) {}
        // Lifecycle Phase 2: emit ACTIVE_WORK_ENTERED so engine can set follow-up timer
        if (typeof onWorkItemActiveWork_ === "function") {
          var propCode = String(sheet.getRange(activeRow, COL.PROPERTY).getValue() || "").trim().toUpperCase();
          onWorkItemActiveWork_(doneWi, propCode, d && d.end instanceof Date ? { scheduledEndAt: d.end } : {});
        }
      } catch (_) {}
    }
    try {
      logDevSms_(
        phone,
        rawTrim,
        "SCHED_CONFIRM row=" + activeRow +
          " tid=[" + ticketId + "]" +
          " label=[" + label + "]" +
          " stage=[SCHEDULE]"
      );
    } catch (_) {}
    // ✅ Phase 1: semantic intent CONFIRM_RECORDED_SCHEDULE; Outgate resolves template (default CONF_WINDOW_SET or vars.confirmKey from upstream tone)
    const _confirmKey = { urgent: "TICKET_CONFIRM_URGENT", postService: "TICKET_CONFIRM_POST_SERVICE", recurring: "TICKET_CONFIRM_RECURRING", frustrated: "TICKET_CONFIRM_FRUSTRATED" }[(signals && signals.tone) || ""] || "CONF_WINDOW_SET";
    var _confirmVars = Object.assign({}, baseVars, { label: label, ticketId: ticketId, issueSummary: issueLine });
    if (_confirmKey !== "CONF_WINDOW_SET") _confirmVars.confirmKey = _confirmKey;
    var _ogConfirm = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({
      intentType: "CONFIRM_RECORDED_SCHEDULE",
      recipientType: "TENANT",
      recipientRef: phone,
      lang: lang,
      channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS",
      deliveryPolicy: "NO_HEADER",
      vars: _confirmVars,
      meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" }
    }) : { ok: false };
    if (!(_ogConfirm && _ogConfirm.ok)) {
      var _outMsg = (typeof renderTenantKey_ === "function") ? renderTenantKey_(_confirmKey, lang, _confirmVars) : "";
      try { logDevSms_(phone, _outMsg, "DEBUG_CONF_WINDOW_SET_RENDER"); } catch (_) {}
      replied = true;
      if (typeof sendRouterSms_ === "function") sendRouterSms_(phone, _outMsg, "CONFIRM_RECORDED_SCHEDULE"); else replyNoHeader_(_outMsg);
    } else {
      replied = true;
    }
    // ✅ Clear schedule expectation on success
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "SCHEDULE_RESOLVED"); } catch (_) {}
    // ✅ Atomic advance/clear (your queue-drain)
    try {
      if (dirRow > 0) {
        const advanced = advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang);
        if (advanced) {
          try { logDevSms_(phone, "", "QUEUE_DRAIN_ADVANCED tid=[" + (advanced.ticketId || "") + "]"); } catch (_) {}
        }
      }
    } catch (qdErr) {
      try { logDevSms_(phone, "", "QUEUE_DRAIN_ERR " + (qdErr && qdErr.message ? qdErr.message : qdErr)); } catch (_) {}
    }
    return true;
  }

  // -------------------------
  // SCHEDULE (Propera Compass SAFE) — ctx-driven
  // - Single stage only: "SCHEDULE"
  // - Always uses Directory.PendingRow pointer
  // - Always sets LastUpdate
  // - clearDirPending_ must NOT clear PendingRow
  // ✅ FIXES:
  //   1) If Directory.PendingStage is blank, recover it from ctx.pendingExpected ("SCHEDULE")
  //   2) Parsing uses a neutral anchor ("Today")
  //   3) TicketId lookup MUST happen BEFORE any directory clear/advance
  //   4) After schedule confirmed, advance WI out of WAIT_TENANT (ACTIVE_WORK)
  //   5) De-dup re-ask schedule paths
  //   6) ✅ NO template stacking: use ASK_WINDOW_*_WITH_DAYHINT keys (not dayLine injection)
  // -------------------------
  if (String(effectiveStage || pendingStage || "").toUpperCase() === "SCHEDULE") {
    const now = new Date();
    const rawTrim = String(bodyTrim || "").trim();

    // Helper: compute dayWord once (used only to select template key)
    function dayWordNow_() {
      try { return String(scheduleDayWord_(new Date()) || "").trim(); } catch (_) { return ""; }
    }

    // Helper: render schedule ask without template stacking
    function renderAskWindow_(keyBase) {
      const dw = dayWordNow_();
      const key = dw ? (keyBase + "_WITH_DAYHINT") : keyBase;
      return renderTenantKey_(key, lang, Object.assign({}, baseVars, { dayWord: dw }));
    }

    // Helper: re-ask schedule + keep ctx expectation — Phase 2b: semantic intent
    function reAskSchedule_(reason) {
      var _dw = dayWordNow_();
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, _dw ? { dayWord: _dw } : {}), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };

      try {
        const ctxNow = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
        const wiPick =
          String(ctxNow.pendingWorkItemId || "").trim() ||
          String(ctxNow.activeWorkItemId || "").trim();

        ctxUpsert_(phone, {
          pendingWorkItemId: wiPick,
          pendingExpected: "SCHEDULE",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        }, "SCHEDULE_REASK_" + String(reason || ""));
        try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
      } catch (_) {}
    }

    // 1) New issue added while waiting for schedule
    if (mode === "TENANT" && dirRow > 0) {
      var dirStage = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();
      var ctxExp = "";
      try {
        var ctxSch = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
        if (ctxSch && ctxSch.pendingExpected) ctxExp = String(ctxSch.pendingExpected || "").trim().toUpperCase();
      } catch (_) {}
      var expectSchedule = (dirStage === "SCHEDULE") || (ctxExp === "SCHEDULE") || (String(ctxExp || "").indexOf("SCHEDULE") >= 0);
      var notScheduleLike = (typeof isScheduleLike_ === "function") ? !isScheduleLike_(rawTrim) : true;
      var actionable = (typeof looksActionableIssue_ === "function") && looksActionableIssue_(rawTrim);
      var notChitchat = (typeof isPureChitchat_ === "function") && !isPureChitchat_(rawTrim);
      var notNumericOnly = !/^\d{1,6}$/.test(String(rawTrim || "").replace(/\s/g, ""));
      if (expectSchedule && notScheduleLike && actionable && notChitchat && notNumericOnly && pendingRow >= 2 && !didAppendIssueThisTurn) {
        if (handleScheduleAddIssue_(sheet, dir, dirRow, phone, rawTrim, lang, baseVars, dirStage, ctxExp, reAskSchedule_)) return;
      }
    }

    // ✅ 0) Recover stage if it got wiped (Directory.PendingStage blank)
    try {
      if (dirRow > 0) {
        const stageCell = dalGetPendingStage_(dir, dirRow);
        if (!stageCell) {
          const ctxNowStage = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
          const exp = String(ctxNowStage.pendingExpected || "").trim().toUpperCase();

          if (exp === "SCHEDULE") {
            dalSetPendingStage_(dir, dirRow, "SCHEDULE", phone, "DIR_RECOVER_STAGE_SCHEDULE");
            try { logDevSms_(phone, rawTrim, "DIR_STAGE_RECOVERED stage=[SCHEDULE]"); } catch (_) {}
          }
        }
      }
    } catch (_) {}

    // ✅ Always use Directory.PendingRow pointer
    const activeRow = dalGetPendingRow_(dir, dirRow);

    // 2) Multi-issue buffer path (no active ticket row yet)
    if (activeRow < 2) {
      const stageDay = "Today";
      if (handleScheduleMultiBuffer_(sheet, dir, dirRow, phone, rawTrim, lang, baseVars, stageDay, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER)) return;
      reAskSchedule_("MISSING_PENDING_ROW");
      return;
    }

    // Never treat manager commands as schedule replies
    if (looksLikeManagerCommand_(rawTrim)) {
      reAskSchedule_("MANAGER_COMMAND");
      return;
    }

    // 3) Single ticket schedule confirm
    var dayWordSchedule = "";
    try { dayWordSchedule = String(scheduleDayWord_(new Date()) || "").trim(); } catch (_) {}
    if (handleScheduleSingleTicket_(sheet, dir, dirRow, phone, activeRow, rawTrim, lang, baseVars, dayWordSchedule, turnFacts, sidSafe, now, signals)) return;

    // Re-ask schedule and keep expected=SCHEDULE (do not drop to menu)
    reAskSchedule_("PARSE_FAIL");
    return;
  }

  // =========================================================
  // FINALIZE_DRAFT (deterministic finalize: draft complete, no ticket yet)
  // Creates ticket and advances to SCHEDULE using existing finalizeDraftAndCreateTicket_.
  // Pre-ticket: draft fields from Session; finalize overlays Session internally.
  // =========================================================
  if (effectiveStage === "FINALIZE_DRAFT") {
    try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_ENTER pendingRow=[" + pendingRow + "]"); } catch (_) {}

    var s = null;
    var _fdProp  = dalGetPendingProperty_(dir, dirRow);
    var propCode = _fdProp.code;
    var propName = _fdProp.name;
    var issue    = dalGetPendingIssue_(dir, dirRow);
    var unit     = dalGetPendingUnit_(dir, dirRow);

    var hasIssue = Boolean(issue) || (typeof getIssueBuffer_ === "function" && getIssueBuffer_(dir, dirRow) && getIssueBuffer_(dir, dirRow).length >= 1);
    if (pendingRow <= 0 && typeof sessionGet_ === "function") {
      s = sessionGet_(phone) || {};
      if (s.draftProperty && !propCode) propCode = String(s.draftProperty || "").trim();
      if (s.draftIssue) issue = String(s.draftIssue || "").trim();
      if (s.draftUnit && !unit) unit = String(s.draftUnit || "").trim();
      if (s.issueBuf && s.issueBuf.length >= 1) hasIssue = true;
      if (!propName && propCode && typeof getPropertyByCode_ === "function") {
        var p = getPropertyByCode_(propCode);
        if (p && p.name) propName = String(p.name || "").trim();
      }
    }

    if (!propCode || !hasIssue) {
      try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_MISSING_FIELDS propCode=[" + (propCode || "") + "] issue=[" + (issue ? "1" : "0") + "] hasIssue=[" + (hasIssue ? "1" : "0") + "]"); } catch (_) {}
      try { recomputeDraftExpected_(dir, dirRow, phone, s); } catch (_) {}
      var pendingUnitF = String(dalGetPendingUnit_(dir, dirRow) || "").trim();
      var canonUnitF   = String(dalGetUnit_(dir, dirRow) || "").trim();
      var hasUnitF     = Boolean(pendingUnitF || canonUnitF);
      var next = (s && s.expected) ? String(s.expected).toUpperCase().trim() : (!propCode ? "PROPERTY" : !hasIssue ? "ISSUE" : (hasUnitF ? "FINALIZE_DRAFT" : "UNIT"));
      if (next === "PROPERTY") {
        reply_(replyAskPropertyMenu_(lang, baseVars));
      } else if (next === "ISSUE") {
        const _issueAskKey = { urgent: "ASK_ISSUE_URGENT", postService: "ASK_ISSUE_POST_SERVICE", recurring: "ASK_ISSUE_RECURRING", frustrated: "ASK_ISSUE_FRUSTRATED" }[signals.tone] || "ASK_ISSUE_GENERIC";
        reply_(renderTenantKey_(_issueAskKey, lang, baseVars));
      } else if (next === "UNIT") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
      } else if (next === "FINALIZE_DRAFT") {
        // hasUnitF true: fall through to finalize (do not ask unit)
      } else {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      }
      if (next !== "FINALIZE_DRAFT") return;
    }

    const result = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, {
      inboundKey,
      lang: lang,
      baseVars: baseVars,
      locationText: bodyTrim,
      firstMediaUrl: (turnFacts.meta && turnFacts.meta.mediaUrls && turnFacts.meta.mediaUrls[0]) ? String(turnFacts.meta.mediaUrls[0]).trim() : "",
      mediaType: (mediaFacts && mediaFacts.mediaType) ? String(mediaFacts.mediaType || "").trim() : "",
      mediaCategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.category) ? String(mediaFacts.issueHints.category || "").trim() : "",
      mediaSubcategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.subcategory) ? String(mediaFacts.issueHints.subcategory || "").trim() : "",
      mediaUnitHint: (mediaFacts && mediaFacts.unitHint) ? String(mediaFacts.unitHint || "").trim() : ""
    });
    try {
      logDevSms_(phone, bodyTrim, "FINALIZE_RESULT ok=[" + (result && result.ok ? "1" : "0") + "] reason=[" + String((result && result.reason) || "") + "] multi=[" + (result && result.multiIssuePending ? "1" : "0") + "] ticketId=[" + String((result && result.ticketId) || "") + "]");
    } catch (_) {}
    if (result.ok && result.loggedRow >= 2) {
      try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_CREATED pendingRow=[" + result.loggedRow + "]"); } catch (_) {}
    }
    if (!result.ok) {
      try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_SKIP reason=[" + String(result.reason || "") + "]"); } catch (_) {}
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      try { recomputeDraftExpected_(dir, dirRow, phone, s); } catch (_) {}
      return;
    }
    if (result.multiIssuePending) {
      if (result.nextStage === "SCHEDULE" || result.nextStage === "SCHEDULE_DRAFT_MULTI") {
        var combined = (result.summaryMsg && String(result.summaryMsg).trim()) ? String(result.summaryMsg).trim() : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
        try { logDevSms_(phone, combined.slice(0, 120), "MULTI_COMBINED_OUT"); } catch (_) {}
        var _ogC2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { summaryText: combined }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogC2 && _ogC2.ok)) replyNoHeader_(combined);
        return;
      }
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      return;
    }

    if (result.nextStage === "") {
      if (!result.ackOwnedByPolicy) {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_COMMON_AREA", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: String(result.ticketId || "") }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
      } else {
        try { logDevSms_(phone, "", "ACK_SUPPRESSED_BY_POLICY workItemId=" + (result.createdWi || "") + " rule=" + (result.policyRuleId || "")); } catch (_) {}
      }
      return;
    }

    // Emergency: never ask for schedule; send emergency ack only
    if (result.nextStage === "EMERGENCY_DONE") {
      var eTid = String(result.ticketId || "").trim();
      try { logDevSms_(phone, "", "FINALIZE_DRAFT_EMERGENCY_DONE tid=" + eTid); } catch (_) {}
      var _ogEt = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_TENANT_ACK", templateKey: "EMERGENCY_TENANT_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: eTid }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogEt && _ogEt.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_TENANT_ACK", lang, Object.assign({}, baseVars, { ticketId: eTid })));
      return;
    }

    try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
    var unitLine = "";
    if (unit && String(unit).trim()) {
      unitLine = ", Apt " + String(unit).trim();
    }
    var issueShort = String(issue || "").trim().slice(0, 80);
    var vars = Object.assign({}, baseVars, {
      propertyName: propName || "",
      issueShort: issueShort,
      unitLine: unitLine,
      afterCreate: true
    });
    var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: vars, meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
    return;
  }

  // =========================================================
  // NEW_TICKET_FLOW (Propera Compass â€” Draft-First)
  // Only reaches here when ticketState.stateType === "NEW".
  // Draft accumulator already ran above (draftUpsertFromTurn_).
  // =========================================================
  if (ticketState.stateType === "NEW") {

    try { logDevSms_(phone, "MARK_F NEW_TICKET_FLOW bodyTrim=[" + String(bodyTrim||"") + "]", "MARK_F"); } catch (_) {}

    // --------------------------------------------------
    // Operational domain dispatch (Phase 1 – CLEANING)
    // If CLEANING is strongly selected, bypass maintenance ticket creation
    // and create a cleaning work item instead.
    // --------------------------------------------------
    var domainDispatchResult = null;
    try {
      domainDispatchResult = dispatchOperationalDomain_(domainDecision, {
        phone: phone,
        originPhone: originPhone,
        lang: lang,
        baseVars: baseVars,
        mode: mode,
        propertyCode: String(dir.getRange(dirRow, 2).getValue() || "").trim(),
        propertyName: String(dir.getRange(dirRow, 3).getValue() || "").trim(),
        pendingUnit: String(dalGetPendingUnit_(dir, dirRow) || "").trim(),
        bodyTrim: bodyTrim,
        mediaFacts: mediaFacts,
        turnFacts: turnFacts,
        channel: (turnFacts.meta && turnFacts.meta.channel) ? String(turnFacts.meta.channel || "").toUpperCase() : "SMS"
      });
    } catch (_) {}

    if (domainDispatchResult && domainDispatchResult.handled === true) {
      if (typeof clearMaintenanceDraftResidue_ === "function") clearMaintenanceDraftResidue_(dir, dirRow, phone);
      try {
        var _ogC = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "CLEANING_WORKITEM_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "CLEANING_DISPATCH", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogC && _ogC.ok)) replyNoHeader_(renderTenantKey_("CLEANING_WORKITEM_ACK", lang, baseVars));
      } catch (_) {}
      return;
    }

    const rawTrim = String(bodyTrim || "").trim();

    // â”€â”€ A) Guardrail â”€â”€
    if (isPureChitchat_(rawTrim) && !looksActionableIssue_(rawTrim)) {
      var _ogH3 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "SHOW_HELP", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "NEW_TICKET_FLOW", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogH3 && _ogH3.ok)) replyNoHeader_(renderTenantKey_("HELP_INTRO", lang, baseVars));
      return;
    }
    if (!looksActionableIssue_(rawTrim)) {
      var _ogP = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "PROMPT_SEND_MAINT_FORMAT", templateKey: "PROMPT_SEND_MAINT_FORMAT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "NEW_TICKET_FLOW", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogP && _ogP.ok)) replyNoHeader_(renderTenantKey_("PROMPT_SEND_MAINT_FORMAT", lang, baseVars));
      return;
    }

    // B) Clear stale draft fields before starting fresh
    if (dirRow > 0) {
      dalWithLock_("CLEAR_STALE_DRAFT", function () {
        dalSetPendingIssueNoLock_(dir, dirRow, "");
        try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[CLEAR_STALE_DRAFT] val=[CLEAR_NEW_FLOW]"); } catch (_) {}
        dalSetPendingUnitNoLock_(dir, dirRow, "");
        dalSetPendingStageNoLock_(dir, dirRow, "");
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(phone || "", "", "DAL_WRITE CLEAR_STALE_DRAFT row=" + dirRow); } catch (_) {}
      });
      // Re-run draft accumulator on the cleared state so THIS message fills the draft
      try { draftUpsertFromTurn_(dir, dirRow, turnFacts, bodyTrim, phone); } catch (_) {}
      try { logDevSms_(phone, bodyTrim, "STALE_DRAFT_CLEARED_AND_REFILLED"); } catch (_) {}
    }

    // â”€â”€ C) Emergency precheck (before property gate) â”€â”€
    var emergencyPre = (typeof evaluateEmergencySignal_ === "function") ? evaluateEmergencySignal_(rawTrim, { phone: phone }) : { isEmergency: false, emergencyType: "" };
    const propCodeNow = String(dir.getRange(dirRow, 2).getValue() || "").trim();

    if (mode === "TENANT" && !propCodeNow && emergencyPre.isEmergency) {
      var emType = String(emergencyPre.emergencyType || "").trim();
      try { logDevSms_(phone, rawTrim, "EMERGENCY_PREALERT emergencyType=[" + emType + "]"); } catch (_) {}
      try { logDevSms_(phone, "", "EMERGENCY_WAIT_LOCATION expected=PROPERTY emergencyType=[" + emType + "]"); } catch (_) {}
      if (dirRow > 0) {
        dalWithLock_("EMERG_PRECHECK_STORE", function () {
          var existingIssue = String(dir.getRange(dirRow, 5).getValue() || "").trim();
          if (!existingIssue && rawTrim) {
            dalSetPendingIssueNoLock_(dir, dirRow, rawTrim);
            try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[EMERG_PRECHECK_STORE] val=[" + rawTrim.slice(0, 40) + "]"); } catch (_) {}
          }
          dalSetPendingRowNoLock_(dir, dirRow, "");
          dalSetPendingStageNoLock_(dir, dirRow, "PROPERTY");
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE EMERG_PRECHECK_STORE row=" + dirRow); } catch (_) {}
        });
      }
      try {
        const mgrMsg = tenantMsgSafe_("EMERGENCY_PREALERT_UNKNOWN_PROPERTY", "en",
          Object.assign({}, baseVars, { phone, msg: rawTrim, emergencyKind: emType }),
          "EMERGENCY_PREALERT_UNKNOWN_PROPERTY");
        sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER, mgrMsg);
      } catch (_) {}
      try {
        ctxUpsert_(phone, {
          flowMode: "EMERGENCY", emergencyKind: emType,
          pendingWorkItemId: "",
          pendingExpected: "PROPERTY",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        }, "EMERG_PRECHECK_EXPECT_PROPERTY");
      } catch (_) {}
      try {
        const safety = tenantMsgSafe_("SAFETY_GAS_CO_FIRE", lang, baseVars, "SAFETY_GAS_CO_FIRE");
        replyNoHeader_(String(safety || "").trim() + "\n\n" + replyAskPropertyMenu_(lang, baseVars));
      } catch (_) { reply_(replyAskPropertyMenu_(lang, baseVars)); }
      return;
    }

    // â”€â”€ D) Decide what's still missing â”€â”€
    const nextMissing = draftDecideNextStage_(dir, dirRow);

    if (nextMissing !== "READY") {
      // Write stage BEFORE asking (crash-resilient)
      dalSetPendingStage_(dir, dirRow, nextMissing, phone, "NTF_SET_PENDING_STAGE");
      try {
        ctxUpsert_(phone, {
          pendingExpected:   nextMissing,
          pendingExpiresAt:  new Date(Date.now() + 10 * 60 * 1000),
          lastIntent:        "MAINT"
        }, "NTF_MISSING_" + nextMissing);
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=" + nextMissing + " src=NTF_DRAFT"); } catch (_) {}
      } catch (_) {}

      if (nextMissing === "PROPERTY")      reply_(replyAskPropertyMenu_(lang, baseVars));
      else if (nextMissing === "UNIT") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
      }
      else /* ISSUE */ {
        var _og2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og2 && _og2.ok) replied = true;
      }
      return;
    }

    // â”€â”€ E) READY â€” check tenant is not mid-conversation â”€â”€
    const preBusyRow   = dalGetPendingRow_(dir, dirRow);
    const preBusyStage = String(dalGetPendingStage_(dir, dirRow) || "").trim();
    const tenantIsBusy = !!(preBusyStage || preBusyRow > 0);

    // DUP60 content dedup
    const effectiveMessage = String(bodyRaw || "").trim();
    const dkeyRaw = [
      phone,
      propCodeNow,
      String(dalGetPendingUnit_(dir, dirRow) || "").toLowerCase(),
      String(dalGetPendingIssue_(dir, dirRow) || "").toLowerCase()
    ].join("|");
    const dkey = "DUP60_" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, dkeyRaw));
    if (cache.get(dkey)) {
      var _ogDup = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "DUPLICATE_REQUEST_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "NEW_TICKET_FLOW", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogDup && _ogDup.ok)) reply_(renderTenantKey_("DUPLICATE_REQUEST_ACK", lang, baseVars));
      return;
    }
    cache.put(dkey, "1", 60 * 60);

    // Clear old pointer before creating (skip if manager + tenant busy â€” queue instead)
    if (dirRow > 0 && !(mode === "MANAGER" && tenantIsBusy)) {
      withWriteLock_("NTF_CLEAR_PTR", () => {
        dirSet_(dir, dirRow, { pendingRow: "", pendingStage: "", now: new Date() });
      });
    }

    // â"€â"€ F) Create ticket â"€â"€
    const result = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, {
      inboundKey, OPENAI_API_KEY, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER,
      createdByManager: (mode === "MANAGER"), lang: lang, baseVars: baseVars, locationText: rawTrim,
      firstMediaUrl: (turnFacts.meta && turnFacts.meta.mediaUrls && turnFacts.meta.mediaUrls[0]) ? String(turnFacts.meta.mediaUrls[0]).trim() : "",
      mediaType: (mediaFacts && mediaFacts.mediaType) ? String(mediaFacts.mediaType || "").trim() : "",
      mediaCategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.category) ? String(mediaFacts.issueHints.category || "").trim() : "",
      mediaSubcategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.subcategory) ? String(mediaFacts.issueHints.subcategory || "").trim() : "",
      mediaUnitHint: (mediaFacts && mediaFacts.unitHint) ? String(mediaFacts.unitHint || "").trim() : ""
    });

    if (!result.ok) {
      if (result.reason === "ACTIVE_TICKET_EXISTS") {
        // Re-route to continuation handler â€" do NOT return
        try { logDevSms_(phone, bodyTrim, "NTF_BLOCKED_REROUTE stage=[" + effectiveStage + "]"); } catch (_) {}
      } else {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_DRAFT_FINALIZE_FAILED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        return;
      }
    }
    if (result.multiIssuePending) {
      if (result.nextStage === "UNIT") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
        return;
      }
      if (result.nextStage === "SCHEDULE" || result.nextStage === "SCHEDULE_DRAFT_MULTI") {
        var combined = (result.summaryMsg && String(result.summaryMsg).trim()) ? String(result.summaryMsg).trim() : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
        try { logDevSms_(phone, combined.slice(0, 120), "MULTI_COMBINED_OUT"); } catch (_) {}
        var _ogC3 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { summaryText: combined }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogC3 && _ogC3.ok)) replyNoHeader_(combined);
        return;
      }
      return;
    }

    if (!isStaffCapture) {
    const loggedRow = result.loggedRow || 0;
    const ticketId = result.ticketId || "";
    const createdWi = result.createdWi || "";
    const nextStage = result.nextStage || "";

    // â”€â”€ G) Queue branch â”€â”€
    if (mode === "MANAGER" && tenantIsBusy) {
      withWriteLock_("QUEUE_MARK", () => {
        sheet.getRange(loggedRow, COL.STATUS).setValue("Queued");
        sheet.getRange(loggedRow, COL.LAST_UPDATE).setValue(new Date());
      });
      if (createdWi) { try { workItemUpdate_(createdWi, { state: "QUEUED", substate: "" }); } catch (_) {} }
      const mgrNotifyPhone = originPhone || phone;
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, mgrNotifyPhone,
        tenantMsg_("MGR_TICKET_QUEUED_OK", "en", { ...baseVars, ticketId }));
      return;
    }

    // â”€â”€ H) Emergency override â”€â”€
    try {
      const pt = result.ticket || {};
      const c  = pt.classification || null;
      if (pt.ok && c && c.emergency) {
        if (dirRow > 0) {
          dalWithLock_("NTF_EMERGENCY_DIR", function () {
            dalSetPendingRowNoLock_(dir, dirRow, loggedRow);
            dalSetPendingStageNoLock_(dir, dirRow, "EMERGENCY_DONE");
            dalSetLastUpdatedNoLock_(dir, dirRow);
            try { logDevSms_(phone || "", "", "DAL_WRITE NTF_EMERGENCY_DIR row=" + dirRow); } catch (_) {}
          });
        }
        if (createdWi) { try { workItemUpdate_(createdWi, { state: "ACTIVE_WORK", substate: "EMERGENCY" }); } catch (_) {} }
        try {
          ctxUpsert_(phone, {
            activeWorkItemId: createdWi || "", pendingWorkItemId: createdWi || "",
            pendingExpected: "EMERGENCY_DONE",
            pendingExpiresAt: new Date(Date.now() + 60 * 60 * 1000), lastIntent: "MAINT"
          }, "NTF_EMERGENCY");
        } catch (_) {}
        const eTid = String(sheet.getRange(loggedRow, COL.TICKET_ID).getValue() || "").trim();
        var _ogEtN = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_TENANT_ACK", templateKey: "EMERGENCY_TENANT_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: eTid }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogEtN && _ogEtN.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_TENANT_ACK", lang, Object.assign({}, baseVars, { ticketId: eTid })));
        return;
      }
    } catch (_) {}

    // â”€â”€ I) AI enrichment (async) â”€â”€

    // â”€â”€ J) Ask next question â”€â”€
    if (nextStage === "UNIT") {
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (_og && _og.ok) replied = true;
      return;
    }
    if (nextStage === "") {
      if (!result.ackOwnedByPolicy) {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_COMMON_AREA", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: String(ticketId || "") }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
      } else {
        try { logDevSms_(phone, "", "ACK_SUPPRESSED_BY_POLICY workItemId=" + (createdWi || "") + " rule=" + (result.policyRuleId || "")); } catch (_) {}
      }
      return;
    }

    const dayLine = dayWord
      ? ("\n" + renderTenantKey_("ASK_WINDOW_DAYLINE_HINT", lang, Object.assign({}, baseVars, { dayWord })))
      : "";

    if (String(mode || "").toUpperCase() === "MANAGER") {
      const intro = renderTenantKey_("MGR_CREATED_TICKET_INTRO", lang, baseVars);
      const ask   = renderTenantKey_("ASK_WINDOW_SIMPLE", lang, Object.assign({}, baseVars, { dayLine }));
      var _mgrBody = String(intro || "").trim() + "\n\n" + String(ask || "").trim();
      var _ogMgr = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { managerIntro: _mgrBody }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogMgr && _ogMgr.ok)) replyNoHeader_(_mgrBody);
      return;
    }

    var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { dayLine: dayLine }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
    return;

    }

  } // closes if (ticketState.stateType === "NEW") / NEW_TICKET_FLOW

  // ===================================================================
  // If we reach here, we were mid-conversation but no stage handler caught it.
  // Compass fallback: use ctx.pendingExpected (deterministic), never create a new ticket here.
  // ✅ Single-stage SCHEDULE only (no SCHEDULE_* propagation)
  // ===================================================================
  try {
    const pr2 = dalGetPendingRow_(dir, dirRow);
    const ctx2 = ctxGet_(phone) || {};
    const exp2raw = String(ctx2.pendingExpected || "").trim().toUpperCase();

    // Normalize any legacy schedule expectations to "SCHEDULE"
    const exp2 = (exp2raw === "SCHEDULE" || exp2raw.indexOf("SCHEDULE_") === 0) ? "SCHEDULE" : exp2raw;

    const dayLine2 = dayWord
      ? ("\n(If you prefer, you can also say: “" + dayWord + " morning / afternoon / evening”.)")
      : "";

    if (pr2 > 1) {

      if (exp2 === "UNIT") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
        try {
          ctxUpsert_(phone, {
            pendingExpected: "UNIT",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=UNIT src=FALLBACK_CTX"); } catch (_) {}
        } catch (_) {}
        return;
      }

      if (exp2 === "DETAIL") {
        reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));
        try {
          ctxUpsert_(phone, {
            pendingExpected: "DETAIL",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=DETAIL src=FALLBACK_CTX"); } catch (_) {}
        } catch (_) {}
        return;
      }

      if (exp2 === "ISSUE") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
        try {
          ctxUpsert_(phone, {
            pendingExpected: "ISSUE",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=ISSUE src=FALLBACK_CTX"); } catch (_) {}
        } catch (_) {}
        return;
      }

      if (exp2 === "SCHEDULE") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, { dayLine: dayLine2 }), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        try {
          ctxUpsert_(phone, {
            pendingExpected: "SCHEDULE",
            pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=SCHEDULE src=FALLBACK_CTX"); } catch (_) {}
        } catch (_) {}
        return;
      }

      // Last resort: Directory stage (legacy support)
      const stage2raw = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();
      const stage2 = (stage2raw === "SCHEDULE" || stage2raw.indexOf("SCHEDULE_") === 0) ? "SCHEDULE" : stage2raw;

      if (stage2 === "UNIT") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
        try { ctxUpsert_(phone, { pendingExpected: "UNIT", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000), lastIntent: "MAINT" }); } catch (_) {}
        return;
      }

      if (stage2 === "DETAIL") {
        reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));
        try { ctxUpsert_(phone, { pendingExpected: "DETAIL", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000), lastIntent: "MAINT" }); } catch (_) {}
        return;
      }

      if (stage2 === "SCHEDULE") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, { dayLine: dayLine2 }), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        try { ctxUpsert_(phone, { pendingExpected: "SCHEDULE", pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000), lastIntent: "MAINT" }); } catch (_) {}
        return;
      }

      // Unknown but active ticket → safest schedule prompt, canonical expectation — Phase 2b: semantic intent
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: (typeof globalThis !== "undefined" && globalThis.__inboundChannel) ? globalThis.__inboundChannel : "SMS", deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, { dayLine: dayLine2 }), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      try { ctxUpsert_(phone, { pendingExpected: "SCHEDULE", pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000), lastIntent: "MAINT" }); } catch (_) {}
      return;

    } else {
      // No active pointer → safest prompt is property menu
      reply_(replyAskPropertyMenu_(lang, baseVars));
      try {
        ctxUpsert_(phone, { pendingExpected: "PROPERTY", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000), lastIntent: "MAINT" });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=PROPERTY src=FALLBACK_NO_PTR"); } catch (_) {}
      } catch (_) {}
      return;
    }

  } catch (_) {
    // Ultra-safe fallback
    reply_(replyAskPropertyMenu_(lang, baseVars));
    try { ctxUpsert_(phone, { pendingExpected: "PROPERTY", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000), lastIntent: "MAINT" }); } catch (_) {}
    return;
  }



  } catch (err) {
    hadError = true;
    try { if (globalThis.__chaos && globalThis.__chaos.enabled && typeof writeTimeline_ === "function") writeTimeline_("ERROR", { err: (typeof safeTrunc_ === "function" ? safeTrunc_(err && err.stack ? err.stack : err, 600) : String(err).slice(0, 600)) }, null); } catch (_) {}
    Logger.log("handleSmsCore_ error: " + err);
    return;

  } finally {

    // ⏱️ PERF: total runtime of handleSmsCore_
    try {
      logDevSms_(
        originPhone || "",
        bodyRaw || "",
        "PERF ms=" + (Date.now() - t0) + (sidKey ? (" sidKey=" + sidKey) : ""),
        ""
      );
    } catch (_) {}

    // ✅ Only cache SID if we did NOT crash
    if (!hadError && sidKey) {
      try {
        CacheService.getScriptCache().put(sidKey, "1", 60 * 60);
      } catch (_) {}
    }

    try {
      if (globalThis.__chaos && globalThis.__chaos.enabled) {
        var ctxForSnap = (typeof ctxGet_ === "function" && phone) ? ctxGet_(phone) : null;
        var snapDir = (typeof snapDir_ === "function" && dir && dirRow) ? snapDir_(dir, dirRow) : {};
        var snapCtx = (typeof snapCtx_ === "function") ? snapCtx_(ctxForSnap) : {};
        var snapDraft = (typeof snapDraft_ === "function" && dir && dirRow) ? snapDraft_(dir, dirRow) : {};
        var snapWi = (typeof snapWi_ === "function" && ctxForSnap && ctxForSnap.activeWorkItemId) ? snapWi_({ workItemId: ctxForSnap.activeWorkItemId }) : {};
        var snapObj = { dir: snapDir, ctx: snapCtx, draft: snapDraft, wi: snapWi };
        writeTimeline_("SNAP", { pendingExpected: (ctxForSnap && ctxForSnap.pendingExpected) || "", pendingStage: (snapDir && snapDir.pendingStage) || "" }, snapObj);
        writeTimeline_("TEST_END", { result: hadError ? "ERROR" : "OK" }, { result: hadError ? "ERROR" : "OK" });
      }
    } catch (_) {}

    // ✅ Flush buffered DevSms logs (single write)
    try {
      flushDevSmsLogs_();
    } catch (_) {}
  }
  } // ✅ closes handleSmsCore_

  //
  // END OF HANDLE SMS CORE
  //  


  // =========================================================
  // AI ENRICHMENT QUEUE (Compass: async, best-effort)
  // Sheet: AiQueue
  // Columns: CreatedAt, TicketId, PropertyCode, PropertyName, Unit, PhoneE164, Message, Status, Attempts, LastError, UpdatedAt
  // =========================================================

  const AI_QUEUE_SHEET = "AiQueue";

  function ensureAiQueueSheet_() {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(AI_QUEUE_SHEET);
    if (sh) return sh;

    return withWriteLock_("AIQ_CREATE", () => {
      let s2 = ss.getSheetByName(AI_QUEUE_SHEET);
      if (!s2) s2 = ss.insertSheet(AI_QUEUE_SHEET);
      if (s2.getLastRow() < 1) {
        s2.appendRow([
          "CreatedAt","TicketId","PropertyCode","PropertyName","Unit","PhoneE164","Message",
          "Status","Attempts","LastError","UpdatedAt"
        ]);
      }
      return s2;
    });
  }

  function enqueueAiEnrichment_(ticketId, propertyCode, propertyName, unit, phoneE164, messageRaw) {
    const sh = ensureAiQueueSheet_();
    const now = new Date();
    sh.appendRow([
      now,
      String(ticketId || "").trim(),
      String(propertyCode || "").trim(),
      String(propertyName || "").trim(),
      String(unit || "").trim(),
      String(phoneE164 || "").trim(),
      String(messageRaw || "").trim(),
      "PENDING",
      0,
      "",
      now
    ]);
  }

  // Install a 1-minute trigger for aiEnrichmentWorker()
  function installAiEnrichmentTrigger() {
    // idempotent-ish: delete existing triggers for this function
    const fn = "aiEnrichmentWorker";
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction && t.getHandlerFunction() === fn) {
        ScriptApp.deleteTrigger(t);
      }
    });
    ScriptApp.newTrigger(fn).timeBased().everyMinutes(1).create();
  }

  function aiEnrichmentWorker() {

    // ✅ Fragmentation safety tick (process 1 merged turn if due)
    try {
      const didFrag = processDueFragmentsWorker_();
      // If you want strictly 1 job/min total, uncomment:
      // if (didFrag) return;
    } catch (e) {
      try { logDevSms_("(system)", "", "FRAG_WORKER_ERR " + String(e && e.message ? e.message : e)); } catch (_) {}
    }

    // ... existing AI queue logic continues below ...

    const sh = ensureAiQueueSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return;

    const start = Math.max(2, lastRow - 49);
    const n = lastRow - start + 1;
    const vals = sh.getRange(start, 1, n, 11).getValues();

    for (let i = 0; i < vals.length; i++) {
      const row = start + i;

      const ticketId = String(vals[i][1] || "").trim();
      const propertyCode = String(vals[i][2] || "").trim();
      const propertyName = String(vals[i][3] || "").trim();
      const unit = String(vals[i][4] || "").trim();
      const phone = String(vals[i][5] || "").trim();
      const msg = String(vals[i][6] || "").trim();
      const status = String(vals[i][7] || "").trim();
      const attempts = Number(vals[i][8] || 0);

      if (status !== "PENDING") continue;

      withWriteLock_("AIQ_MARK_RUNNING", () => {
        sh.getRange(row, 8).setValue("RUNNING");
        sh.getRange(row, 9).setValue(attempts + 1);
        sh.getRange(row, 11).setValue(new Date());
      });

      try {
        const props = PropertiesService.getScriptProperties();
        const apiKey = String(props.getProperty("OPENAI_API_KEY") || "").trim();
        if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

        const extracted = smartExtract_(apiKey, msg) || {};

        try {
          applyTicketEnrichment_(ticketId, extracted);
        } catch (e2) {
          try { logDevSms_(phone, msg, "AI_ENRICH_APPLY_ERR " + String(e2 && e2.message ? e2.message : e2)); } catch (_) {}
        }

        withWriteLock_("AIQ_MARK_DONE", () => {
          sh.getRange(row, 8).setValue("DONE");
          sh.getRange(row, 10).setValue("");
          sh.getRange(row, 11).setValue(new Date());
        });

      } catch (err) {
        const em = String(err && err.message ? err.message : err);

        if (attempts + 1 >= 3) {
          withWriteLock_("AIQ_MARK_FAILED", () => {
            sh.getRange(row, 8).setValue("FAILED");
            sh.getRange(row, 10).setValue(em);
            sh.getRange(row, 11).setValue(new Date());
          });
        } else {
          withWriteLock_("AIQ_MARK_PENDING", () => {
            sh.getRange(row, 8).setValue("PENDING");
            sh.getRange(row, 10).setValue(em);
            sh.getRange(row, 11).setValue(new Date());
          });
        }

        try { logDevSms_(phone, msg, "AI_ENRICH_ERR " + em); } catch (_) {}
      }

      break;
    }
  }


  // =========================================================
  // FRAGMENT MERGE (Compass: Safety layer, pre-router)
  // Sheet: InboundFragments
  // Columns: PhoneE164, Status, FirstAt, LastAt, ProcessAfterAt, FirstSid, LastSid, Count, MergedText, UpdatedAt
  // Status: OPEN / CLOSED
  // =========================================================

  const FRAG_SHEET = "InboundFragments";
  const FRAG_MERGE_WINDOW_SEC = 12;   // tune later (10–20 sec is typical)

  function ensureFragSheet_() {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(FRAG_SHEET);
    if (sh) return sh;

    return withWriteLock_("FRAG_CREATE", () => {
      let s2 = ss.getSheetByName(FRAG_SHEET);
      if (!s2) s2 = ss.insertSheet(FRAG_SHEET);
      if (s2.getLastRow() < 1) {
        s2.appendRow([
          "PhoneE164","Status","FirstAt","LastAt","ProcessAfterAt",
          "FirstSid","LastSid","Count","MergedText","UpdatedAt"
        ]);
      }
      return s2;
    });
  }

  function isComplianceKeyword_(raw) {
    const t = String(raw || "").trim().toUpperCase();
    return (t === "STOP" || t === "START" || t === "HELP");
  }


  /**
  * Process at most 1 due fragment per tick.
  * Called by your existing 1-minute trigger worker (aiEnrichmentWorker).
  */
  function processDueFragmentsWorker_() {
    const sh = ensureFragSheet_();
    const now = new Date();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return false;

    // Scan last ~150 rows for due OPEN fragments
    const start = Math.max(2, lastRow - 149);
    const n = lastRow - start + 1;
    const vals = sh.getRange(start, 1, n, 10).getValues();

    for (let i = vals.length - 1; i >= 0; i--) {
      const row = start + i;

      const phone = String(vals[i][0] || "").trim();
      const status = String(vals[i][1] || "").trim();
      const processAfterAt = vals[i][4];
      const firstSid = String(vals[i][5] || "").trim();
      const mergedText = String(vals[i][8] || "").trim();

      if (status !== "OPEN") continue;
      if (!(processAfterAt instanceof Date)) continue;
      if (now.getTime() < processAfterAt.getTime()) continue;
      if (!phone || !mergedText) continue;

      // Mark CLOSED under lock and re-read ProcessAfterAt to prevent race
      let okToProcess = false;
      let phoneFinal = phone;
      let sidFinal = firstSid;
      let msgFinal = mergedText;

      withWriteLock_("FRAG_CLOSE", () => {
        const st = String(sh.getRange(row, 2).getValue() || "").trim();
        if (st !== "OPEN") return;

        const pa = sh.getRange(row, 5).getValue();
        if (!(pa instanceof Date)) return;
        if (now.getTime() < pa.getTime()) return; // window extended

        phoneFinal = String(sh.getRange(row, 1).getValue() || "").trim();
        sidFinal   = String(sh.getRange(row, 6).getValue() || "").trim(); // FirstSid
        msgFinal   = String(sh.getRange(row, 9).getValue() || "").trim();

        sh.getRange(row, 2).setValue("CLOSED");
        sh.getRange(row, 10).setValue(new Date());
        okToProcess = true;
      });

      if (!okToProcess) continue;
      if (!phoneFinal || !msgFinal) return true; // nothing else to do this tick

      // Feed ONE merged turn into your existing SMS router entrypoint.
      try {
        const ev = {
          parameter: {
            From: phoneFinal,
            Body: msgFinal,
            MessageSid: sidFinal,
            SmsMessageSid: sidFinal,
            To: "",
            NumMedia: "0",
            _source: "FRAG_MERGE"
          }
        };

        try { logDevSms_(phoneFinal, msgFinal, "FRAG_PROCESS_CALL sid=" + sidFinal); } catch (_) {}

        handleSmsRouter_(ev);

      } catch (e2) {
        try {
          logDevSms_(
            phoneFinal,
            msgFinal,
            "FRAG_PROCESS_ERR " + String(e2 && (e2.stack || e2.message) ? (e2.stack || e2.message) : e2)
          );
        } catch (_) {}
      }

      return true; // processed 1 fragment
    }

    return false;
  }




  /**
  * Returns:
  *  { buffered: true }  => caller should RETURN (do not run router now)
  *  { buffered: false } => caller should continue normal processing
  *
  * NOTE: This is Safety-only; no messaging here.
  */
  function fragmentGateBuffer_(phoneE164, bodyTrim, sid) {
    const msg = String(bodyTrim || "").trim();
    if (!msg) return { buffered: false };

    // Never delay compliance keywords
    if (isComplianceKeyword_(msg)) return { buffered: false };

    const sh = ensureFragSheet_();
    const now = new Date();

    // Adaptive merge window (Compass: Safety only, pre-router)
    let mergeSec = FRAG_MERGE_WINDOW_SEC;
    try {
      const ctx = ctxGet_(phoneE164);
      const exp = String((ctx && ctx.pendingExpected) || "").trim().toUpperCase();

      if (exp === "SCHEDULE" || exp.indexOf("SCHEDULE_") === 0) mergeSec = 5;
      else if (exp === "PROPERTY" || exp === "UNIT") mergeSec = 8;
      else if (ctx && (ctx.pendingWorkItemId || ctx.activeWorkItemId)) mergeSec = 8; // active conversation feels snappier
    } catch (_) {}

    const windowMs = mergeSec * 1000;

    withWriteLock_("FRAG_UPSERT", () => {
      const lastRow = sh.getLastRow();
      const start = Math.max(2, lastRow - 120); // scan last N (fast)
      const n = lastRow >= 2 ? (lastRow - start + 1) : 0;

      let bestRow = 0;

      if (n > 0) {
        const vals = sh.getRange(start, 1, n, 10).getValues();

        // Search newest -> oldest for this phone's OPEN row within window
        for (let i = vals.length - 1; i >= 0; i--) {
          const rPhone = String(vals[i][0] || "").trim();
          const rStatus = String(vals[i][1] || "").trim();
          const rLastAt = vals[i][3] instanceof Date ? vals[i][3].getTime() : 0;

          if (rPhone !== phoneE164) continue;
          if (rStatus !== "OPEN") continue;
          if (!rLastAt) continue;

          if ((now.getTime() - rLastAt) <= windowMs) {
            bestRow = start + i;
            break;
          } else {
            break; // older than window; can stop
          }
        }
      }

      const processAfterAt = new Date(now.getTime() + windowMs);

      if (bestRow > 0) {
        const prevMerged = String(sh.getRange(bestRow, 9).getValue() || "").trim();
        const merged = prevMerged ? (prevMerged + " | " + msg) : msg;

        const prevCount = parseInt(String(sh.getRange(bestRow, 8).getValue() || "0"), 10) || 0;

        sh.getRange(bestRow, 4).setValue(now);              // LastAt
        sh.getRange(bestRow, 5).setValue(processAfterAt);   // ProcessAfterAt
        sh.getRange(bestRow, 7).setValue(String(sid || ""));// LastSid
        sh.getRange(bestRow, 8).setValue(prevCount + 1);    // Count
        sh.getRange(bestRow, 9).setValue(merged);           // MergedText
        sh.getRange(bestRow, 10).setValue(now);             // UpdatedAt
        return;
      }

      // Create new OPEN row
      sh.appendRow([
        String(phoneE164 || "").trim(),
        "OPEN",
        now,          // FirstAt
        now,          // LastAt
        processAfterAt,
        String(sid || "").trim(), // FirstSid
        String(sid || "").trim(), // LastSid
        1,
        msg,
        now
      ]);
    });

    return { buffered: true };
  }




  /**
  * Apply enrichment to the ticket row.
  * Keep this best-effort and deterministic: if fields missing, do nothing.
  *
  * NOTE: I don’t know which exact columns you want to populate.
  * This implementation is safe: it only writes into NOTES if it exists.
  */
  function applyTicketEnrichment_(ticketId, extracted) {
    if (!ticketId) return;

    const sheet = SpreadsheetApp.getActive().getSheetByName("Sheet1");
    if (!sheet) return;

    // Find ticket row by TicketId
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const ids = sheet.getRange(2, COL.TICKET_ID, lastRow - 1, 1).getValues();
    let row = 0;
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || "").trim() === ticketId) { row = i + 2; break; }
    }
    if (!row) return;

    // Example: store a compact enrichment JSON in NOTES if you have it
    // If you don’t have COL.NOTES, leave this as a no-op or map it to your desired column.
    if (typeof COL.NOTES === "number" && COL.NOTES > 0) {
      const payload = {
        issueSummary: extracted.issueSummary || "",
        unit: extracted.unit || "",
        propertyHint: extracted.propertyHint || "",
        confidence: extracted.issueConfidence || extracted.confidence || "",
        nextQuestions: extracted.nextQuestions || extracted.nextQuestionsKeys || ""
      };
      withWriteLock_("TICKET_ENRICH_NOTES", () => {
        sheet.getRange(row, COL.NOTES).setValue(JSON.stringify(payload));
        sheet.getRange(row, COL.LAST_UPDATE).setValue(new Date());
      });
    }
  }
  


  function onTicketStatusEdit(e) {
    try {
      if (!e || !e.range) return;

      const sheet = e.range.getSheet();
      if (sheet.getName() !== "Sheet1") return;

      const row = e.range.getRow();
      const col = e.range.getColumn();

      // Only react when Status changes
      if (row < 2 || col !== COL.STATUS) return;

      const newStatus = String(e.range.getValue() || "").trim().toLowerCase();
      if (newStatus !== "cancelled" && newStatus !== "canceled") return;

      sendCancelReceiptForRow_(sheet, row);

    } catch (err) {
      try {
        logDevSms_("SYSTEM", "Cancel receipt error (ONEDIT): " + (err && err.stack ? err.stack : err), "CANCEL_RECEIPT_ERR");
      } catch (_) {}
      Logger.log("Cancel receipt error: " + err);
    }
  }



  function sendCreatedTexts() {
    const props = PropertiesService.getScriptProperties();
    const TWILIO_SID = props.getProperty("TWILIO_SID");
    const TWILIO_TOKEN = props.getProperty("TWILIO_TOKEN");
    const TWILIO_NUMBER = props.getProperty("TWILIO_NUMBER");

    const sheet = getSheet_(SHEET_NAME);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const n = lastRow - 1;

    const phoneVals   = sheet.getRange(2, COL.PHONE, n, 1).getValues();
    const ticketVals  = sheet.getRange(2, COL.TICKET_ID, n, 1).getValues();
    const statusVals  = sheet.getRange(2, COL.STATUS, n, 1).getValues();
    const sentVals    = sheet.getRange(2, COL.CREATED_MSG_SENT, n, 1).getValues();

    // ✅ NEW: read AG (CreatedByManager)
    const mgrVals     = sheet.getRange(2, COL.CREATED_BY_MANAGER, n, 1).getValues();

    const now = new Date();

    for (let i = 0; i < n; i++) {
      const rowIndex = i + 2; // ✅ ALWAYS define rowIndex FIRST inside loop

      const already = String(sentVals[i][0] || "").trim().toLowerCase() === "yes";
      if (already) continue;

      // ✅ Only send for tickets created by manager (AG = Yes)
      const createdByMgr = String(mgrVals[i][0] || "").trim().toLowerCase() === "yes";
      if (!createdByMgr) continue;

      const phone = normalizePhone_(phoneVals[i][0] || "");
      const ticketId = String(ticketVals[i][0] || "").trim();
      const status = String(statusVals[i][0] || "").trim();

      if (!phone || !ticketId) continue;

      // Optional: only send when ticket is truly "new-ish"
      if (status && !/^(new|open|waiting tenant|scheduled)$/i.test(status)) continue;


      const msg =
        "✅ Your maintenance request has been received.\n" +
        "(Ref " + ticketId + ")\n\n" +
        "For future maintenance requests, please text THIS number (the automated service line).";

      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, phone, msg);

      sheet.getRange(rowIndex, COL.CREATED_MSG_SENT).setValue("Yes");
      sheet.getRange(rowIndex, COL.CREATED_MSG_SENT_AT).setValue(now);
    }
  }

  function looksLikeGreetingOnly_(s) {
    const t = String(s || "").toLowerCase().trim();
    if (!t) return false;
    // keep tight: only block pure greetings
    return /^(hi|hello|hey|yo|sup|good (morning|afternoon|evening)|hola|bonjour|hii+|heyy+)[!.]*$/.test(t);
  }


  function sendCompletionTexts() {
    const props = PropertiesService.getScriptProperties();
    const TWILIO_SID = props.getProperty("TWILIO_SID");
    const TWILIO_TOKEN = props.getProperty("TWILIO_TOKEN");
    const TWILIO_NUMBER = props.getProperty("TWILIO_NUMBER");

    const sheet = getSheet_(SHEET_NAME);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const n = lastRow - 1;

    const phoneVals  = sheet.getRange(2, COL.PHONE, n, 1).getValues();
    const ticketVals = sheet.getRange(2, COL.TICKET_ID, n, 1).getValues();
    const statusVals = sheet.getRange(2, COL.STATUS, n, 1).getValues();
    const sentVals   = sheet.getRange(2, COL.COMPLETED_SENT, n, 1).getValues();

    const now = new Date();

    for (let i = 0; i < n; i++) {
      const row = i + 2;

      const alreadySent = String(sentVals[i][0] || "").toLowerCase() === "yes";
      if (alreadySent) continue;

      const phone = normalizePhone_(phoneVals[i][0]);
      const ticketId = String(ticketVals[i][0] || "").trim();
      const status = String(statusVals[i][0] || "").trim();

      if (!phone || !ticketId) continue;

      if (!/^(completed|complete|closed|resolved|done)$/i.test(status)) continue;

      const msg =
        "✅ Update: your maintenance request has been completed.\n" +
        "(Ref " + ticketId + ")\n\n" +
        "If the issue persists, reply to this text and we’ll reopen the ticket.";

      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, phone, msg);

      sheet.getRange(row, COL.COMPLETED_SENT).setValue("Yes");
      sheet.getRange(row, COL.COMPLETED_SENT_AT).setValue(now);
    }
  }


  function TEST_fakeTwilioPost() {
    const e = { 
      parameter: {
        From: "+19023382002",
        Body: "hi my tub is clogged",
        MessageSid: "TEST_" + new Date().getTime()
      }
    };

    const res = doPost(e);
    Logger.log(res.getContent());
  }

  // Water meter reminders: see WATER_ENGINE.gs (installWaterTriggers, waterDailyCheck, etc.)
  // Communications engine: see COMMUNICATION.gs (buildRecipients, queueCommunication, processQueuedCommunications)

  function createManagerTicket_(body, tenantPhone, managerPhone) {
    // DEPRECATED: do not create tickets outside processTicket_
    try { logDevSms_(managerPhone || "(mgr)", String(body||""), "DEPRECATED createManagerTicket_ called"); } catch (_) {}
    throw new Error("createManagerTicket_ is deprecated. Use manager flow -> handleSmsCore_ -> processTicket_.");
  }


  function sanitizeManagerText_(text) {
    let cleaned = String(text || "").trim();

    // Remove the "New ticket" prefix
    cleaned = cleaned.replace(/^new\s*ticket\b/i, "").trim();

    // Remove "from 123..." (10 or 11 digits, with or without +)
    cleaned = cleaned.replace(/\bfrom\b\s*\+?\d{10,11}\b/ig, "").trim();

    // Remove common polite / filler openers
    cleaned = cleaned.replace(
      /^(hi|hello|hey|good (morning|afternoon|evening)|how are you|if you have time today|when you get a chance)[\s,?.!-]*/i,
      ""
    ).trim();

    // Normalize whitespace
    cleaned = cleaned.replace(/\s+/g, " ").trim();

    return cleaned;
  }

  function emergencyFirstReply_(emergencyType) {
    const t = String(emergencyType || "").toLowerCase();

    // Tailored safety line (no 911)
    let safety = "If you’re not safe, leave the unit/area now.";

    if (t.includes("gas") || t.includes("co") || t.includes("smoke") || t.includes("fire")) {
      safety = "If you smell gas or see smoke/fire, move to a safe area now. Avoid switches/flames.";
    } else if (t.includes("flood") || t.includes("ceiling") || t.includes("water")) {
      safety = "If safe, shut off the nearest water valve. Avoid outlets/cords near water.";
    } else if (t.includes("electrical") || t.includes("sparks") || t.includes("outlet")) {
      safety = "If safe, turn off the breaker for that area. Do not use that outlet/switch.";
    }

    const type = emergencyType ? (" (" + emergencyType + ")") : "";

    return (
      "🚨 EMERGENCY" + type + "\n\n" +
      "We’ve contacted the building super(s) immediately.\n" +
      safety
    );
  }

  // Prevent sending the emergency acknowledgement multiple times
  function shouldSendEmergencyAck_(cache, ticketId) {
    const key = "EMER_ACK_" + String(ticketId || "");
    if (!ticketId) return true; // fallback
    if (cache.get(key)) return false;
    cache.put(key, "1", 60 * 60 * 6); // 6 hours (adjust if you want)
    return true;
  }

  function isYes_(v) {
    const s = String(v || "").trim().toLowerCase();
    return v === true || s === "yes" || s === "y" || s === "true" || s === "1";
  }

  /************************************
  * AMENITY RESERVATION ENGINE (PRODUCTION-LINE, COMPASS-BRIDGE)
  * - Command-first routing (no keyword-noise)
  * - TemplateKey-only messaging via amenityReplyKey_ -> renderTenantKey_ -> sendRouterSms_
  * - HOLD -> RESERVED -> ACTIVE -> EXPIRED lifecycle
  * - Access provider adapter (Seam + fallback) with idempotency
  * - Uses StartDateTime/EndDateTime when available (fallback Start/End)
  * - Uses BookingID as canonical id (fallback ResId)
  * - Uses withWriteLock_ for ALL writes
  *
  * REQUIRED EXISTING FUNCTIONS (from your core):
  * - withWriteLock_(tag, fn)
  * - getSheet_(name)
  * - renderTenantKey_(key, lang, vars)
  * - sendRouterSms_(to, msg, tag)
  * - ctxGet_(phone)
  * - ctxUpsert_(phone, patch)
  * - logDevSms_(from, body, note)  (optional but recommended)
  *
  * REQUIRED SHEETS:
  * - AMENITY_RES_SHEET_NAME (AmenityReservations)
  * - AMENITIES_SHEET_NAME   (Amenities)
  * - AMENITY_DIR_SHEET_NAME (AmenityDirectory)  (optional legacy support)
  ************************************/

  // ---------------------------------------------
  // ROUTER DETECTOR (command-first + sticky + explicit confirm)
  // Use this from your router if you want, but you already have router detectors.
  // ---------------------------------------------
  function looksLikeAmenityReservation_(e) {
    const p = (e && e.parameter) ? e.parameter : {};
    const bodyRaw = String(p.Body || "").trim();
    const s = bodyRaw.toLowerCase().trim();
    const from = String(p.From || "").trim();

    if (!from && !s) return false;

    // If confirming an existing hold, always route here
    if ((s === "yes" || s === "confirm" || s === "no") && from && getAmenityHoldCache_(from)) return true;

    // Explicit commands (no ambiguity)
    if (
      s === "help reservation" || s === "reservation help" || s === "help gameroom" ||
      s === "my reservations" || s.startsWith("my reservations") ||
      s.startsWith("cancel reservation") ||
      s.startsWith("change reservation") || s.startsWith("reschedule reservation")
    ) return true;

    // Sticky routing via cache OR AmenityDirectory stage OR ctx.pendingExpected
    if (from && getAmenityStageCache_(from)) return true;

    try {
      const ctx = ctxGet_(from);
      if (isAmenityExpected_(ctx)) return true;
    } catch (_) {}

    try {
      if (from) {
        const dir = getAmenityDir_(from);
        if (dir && String(dir.Stage || "").trim()) return true;
      }
    } catch (_) {}

    if (!s) return false;

    // Start intent (kept narrow; do NOT hijack random time strings)
    const mentionsAmenity =
      s.indexOf("gameroom") >= 0 || s.indexOf("game room") >= 0 || s.indexOf("game-room") >= 0 ||
      s.indexOf("terrace") >= 0 || s.indexOf("party") >= 0;

    const mentionsReserve =
      s.indexOf("reserve") >= 0 || s.indexOf("reservation") >= 0 || s.indexOf("book") >= 0 || s.indexOf("booking") >= 0;

    return (mentionsAmenity || mentionsReserve);
  }

  function isAmenityExpected_(ctx) {
    try {
      const exp = String((ctx && ctx.pendingExpected) || "").trim().toUpperCase();
      if (exp.indexOf("AMENITY_") !== 0) return false;

      const ex = (ctx && ctx.pendingExpiresAt) ? new Date(ctx.pendingExpiresAt) : null;
      if (ex && isFinite(ex.getTime()) && Date.now() > ex.getTime()) return false;

      return true;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------
  // STICKY CACHE HELPERS (legacy) - get/safeGet stay for router
  // ---------------------------------------------
  function getAmenityStageCache_(phone) {
    const cache = CacheService.getScriptCache();
    return cache.get("amenity_stage_" + normalizePhoneKey_(phone));
  }
  function safeGetAmenityStage_(phone) {
    try {
      const d = getAmenityDir_(phone);
      return String((d && d.Stage) ? d.Stage : "").trim();
    } catch (_) {
      return "";
    }
  }

  // ---------------------------------------------
  // PHONE NORMALIZER (shared)
  // ---------------------------------------------
  function normalizePhoneKey_(p) {
    const digits = String(p || "").replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : digits;
  }

  function parseMonthNameWindow_(s) {
    const now = new Date();
    const months = {
      jan:0,january:0, feb:1,february:1, mar:2,march:2, apr:3,april:3,
      may:4, jun:5,june:5, jul:6,july:6, aug:7,august:7,
      sep:8,september:8, oct:9,october:9, nov:10,november:10, dec:11,december:11
    };

    const re = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[\s,]+(\d{1,2})(?:[\s,]+(\d{4}))?[\s,]+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
    const m = String(s || "").match(re);
    if (!m) return null;

    const mon = months[m[1].toLowerCase()];
    const day = Number(m[2]);
    let year = m[3] ? Number(m[3]) : now.getFullYear();

    let h1 = Number(m[4]), min1 = m[5] ? Number(m[5]) : 0, ap1 = m[6] ? m[6].toLowerCase() : "";
    let h2 = Number(m[7]), min2 = m[8] ? Number(m[8]) : 0, ap2 = m[9] ? m[9].toLowerCase() : "";

    if (!ap1 && ap2) ap1 = ap2;
    if (ap1 && !ap2) ap2 = ap1;

    if (!ap1 && !ap2) {
      if (h1 >= 1 && h1 <= 9) ap1 = "pm";
      if (h2 >= 1 && h2 <= 9) ap2 = "pm";
    }

    const start = new Date(year, mon, day, to24_(h1, ap1), min1, 0, 0);
    const end   = new Date(year, mon, day, to24_(h2, ap2), min2, 0, 0);

    if (!m[3] && start.getTime() < now.getTime() - 6 * 60 * 60 * 1000) {
      start.setFullYear(year + 1);
      end.setFullYear(year + 1);
    }

    return { start: start, end: end, kind: "monthname" };
  }

  function to24_(h, ap) {
    let hh = Number(h);
    const a = String(ap || "").toLowerCase();
    if (a === "am") { if (hh === 12) hh = 0; }
    if (a === "pm") { if (hh !== 12) hh += 12; }
    return hh;
  }

  // ---------------------------------------------
  // DIRECTORY (legacy; optional) - getAmenityDir_ stays for router
  // ---------------------------------------------
  function getAmenityDir_(phone) {
    const sheet = getSheet_(AMENITY_DIR_SHEET_NAME);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { Phone: phone, Stage: "", AmenityKey: "", TempStart: "", TempEnd: "" };

    const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
    const idx = indexMap_(values[0].map(String));

    const kPhone = idx["Phone"];
    for (let r = 1; r < values.length; r++) {
      if (normalizePhoneKey_(values[r][kPhone]) === normalizePhoneKey_(phone)) {
        return {
          Phone: phone,
          Stage: String(values[r][idx["Stage"]] || "").trim(),
          AmenityKey: String(values[r][idx["AmenityKey"]] || "").trim(),
          TempStart: values[r][idx["TempStart"]],
          TempEnd: values[r][idx["TempEnd"]]
        };
      }
    }
    return { Phone: phone, Stage: "", AmenityKey: "", TempStart: "", TempEnd: "" };
  }

  // 1-based map (for range writes)
  function getHeaderMap_(sheet) {
    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const map = {};
    for (let i = 0; i < header.length; i++) {
      const k = String(header[i] || "").trim();
      if (k) map[k] = i + 1;
    }
    return map;
  }

  function findRowByValue_(sheet, colName, value) {
    const v = String(value || "").trim();
    if (!v) return 0;

    const map = getHeaderMap_(sheet);
    const col = map[String(colName || "").trim()];
    if (!col) return 0;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;

    const vals = sheet.getRange(2, col, lastRow - 1, 1).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || "").trim() === v) return i + 2;
    }
    return 0;
  }

  // ---------------------------------------------
  // HOLD CACHE (trio stays for router)
  // ---------------------------------------------
  function setAmenityHoldCache_(phone, obj) {
    const cache = CacheService.getScriptCache();
    cache.put("amenity_hold_" + normalizePhoneKey_(phone), JSON.stringify(obj || {}), AMENITY_HOLD_SECONDS);
  }
  function getAmenityHoldCache_(phone) {
    const cache = CacheService.getScriptCache();
    const raw = cache.get("amenity_hold_" + normalizePhoneKey_(phone));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }
  // ---------------------------------------------
  // LIFECYCLE PROCESSOR (bounded + safe)
  // - HOLD timeout -> CANCELLED
  // - RESERVED -> ACTIVE at start
  // - ACTIVE -> EXPIRED at end (revokes code)
  // - Notifications are template-key only
  // ---------------------------------------------
  const LIFECYCLE_CONFIG = {
    MAX_ROWS_PER_RUN: 25
  };

  function processAmenityLifecycle() {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return;

    try {
      const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return;

      const map = getHeaderMap_(sheet);
      if (!map["Status"] || !map["BookingID"] || !map["Phone"]) return;

      const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
      const now = Date.now();

      let processed = 0;

      for (let i = 0; i < data.length && processed < LIFECYCLE_CONFIG.MAX_ROWS_PER_RUN; i++) {
        const rowNum = i + 2;
        const row = data[i];

        const bookingId = String(row[map["BookingID"] - 1] || "").trim();
        const status = String(row[map["Status"] - 1] || "").trim().toUpperCase();
        const phone = String(row[map["Phone"] - 1] || "").trim();

        const startD = map["StartDateTime"] ? toDate_(row[map["StartDateTime"] - 1]) : (map["Start"] ? toDate_(row[map["Start"] - 1]) : null);
        const endD = map["EndDateTime"] ? toDate_(row[map["EndDateTime"] - 1]) : (map["End"] ? toDate_(row[map["End"] - 1]) : null);
        if (!bookingId || !startD || !endD) continue;

        const startMs = startD.getTime();
        const endMs = endD.getTime();

        // HOLD -> CANCELLED on expiry
        if (status === AMENITY_STATUS.HOLD && map["ExpiresAt"]) {
          const expD = toDate_(row[map["ExpiresAt"] - 1]);
          const expMs = expD ? expD.getTime() : NaN;
          if (isFinite(expMs) && now >= expMs) {
            withWriteLock_("AMEN_LIFE_HOLD_EXPIRE", () => {
              sheet.getRange(rowNum, map["Status"]).setValue(AMENITY_STATUS.CANCELLED);
              if (map["CancelledAt"]) sheet.getRange(rowNum, map["CancelledAt"]).setValue(new Date());
              if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
              if (map["CodeSource"]) sheet.getRange(rowNum, map["CodeSource"]).setValue("none");
            });
            processed++;
            continue;
          }
        }

        // RESERVED -> ACTIVE at start time (only if within window)
        if (status === AMENITY_STATUS.RESERVED) {
          if (now >= startMs && now < endMs) {
            withWriteLock_("AMEN_LIFE_ACTIVATE", () => {
              sheet.getRange(rowNum, map["Status"]).setValue(AMENITY_STATUS.ACTIVE);
              if (map["ActivatedAt"]) sheet.getRange(rowNum, map["ActivatedAt"]).setValue(new Date());
              if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
            });

            // Notify activation once
            if (map["NotifyActivatedAt"] && !row[map["NotifyActivatedAt"] - 1] && phone) {
              queueAmenityNotification_(bookingId, phone, "ACTIVATED");
              withWriteLock_("AMEN_LIFE_MARK_NOTIF_ACT", () => {
                sheet.getRange(rowNum, map["NotifyActivatedAt"]).setValue(new Date());
                if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
              });
            }

            processed++;
            continue;
          }
        }

        // ACTIVE -> EXPIRED at end time
        if (status === AMENITY_STATUS.ACTIVE) {
          if (now >= endMs) {
            // Revoke code (best effort)
            const seamCodeId = map["SeamCodeID"] ? String(row[map["SeamCodeID"] - 1] || "") : "";
            const codeSource = map["CodeSource"] ? String(row[map["CodeSource"] - 1] || "") : "";
            const revokedAt = map["CodeRevokedAt"] ? row[map["CodeRevokedAt"] - 1] : null;

            try {
              accessProviderRevokeAmenityCode_({
                bookingId: bookingId,
                seamCodeId: seamCodeId,
                source: codeSource,
                codeRevokedAt: revokedAt
              });
            } catch (_) {}

            withWriteLock_("AMEN_LIFE_EXPIRE", () => {
              sheet.getRange(rowNum, map["Status"]).setValue(AMENITY_STATUS.EXPIRED);
              if (map["ExpiredAt"]) sheet.getRange(rowNum, map["ExpiredAt"]).setValue(new Date());
              if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
            });

            // Notify end once
            if (map["NotifyEndedAt"] && !row[map["NotifyEndedAt"] - 1] && phone) {
              queueAmenityNotification_(bookingId, phone, "ENDED");
              withWriteLock_("AMEN_LIFE_MARK_NOTIF_END", () => {
                sheet.getRange(rowNum, map["NotifyEndedAt"]).setValue(new Date());
                if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
              });
            }

            processed++;
            continue;
          }
        }
      }
    } finally {
      try { lock.releaseLock(); } catch (_) {}
    }
  }

  // ---------------------------------------------
  // NOTIFICATIONS (template-key only)
  // ---------------------------------------------
  function queueAmenityNotification_(bookingId, phone, eventType) {
    const bid = String(bookingId || "").trim();
    const ph = String(phone || "").trim();
    if (!bid || !ph) return;

    // Determine lang from ctx
    let lang = "en";
    try { lang = amenityGetLang_(ctxGet_(ph)); } catch (_) {}

    const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
    const rowNum = findRowByValue_(sheet, "BookingID", bid);
    if (!rowNum) return;

    const map = getHeaderMap_(sheet);
    const data = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];

    const amenityKey = map["AmenityKey"] ? String(data[map["AmenityKey"] - 1] || "").trim() : "";
    const start = (map["StartDateTime"] ? toDate_(data[map["StartDateTime"] - 1]) : null) || (map["Start"] ? toDate_(data[map["Start"] - 1]) : null);
    const end = (map["EndDateTime"] ? toDate_(data[map["EndDateTime"] - 1]) : null) || (map["End"] ? toDate_(data[map["End"] - 1]) : null);

    const amenity = getAmenityConfig_(amenityKey);
    const label = amenity ? (String(amenity.AmenityName || "") + " (" + String(amenity.PropertyCode || "") + ")") : (amenityKey || "Amenity");

    const code =
      (map["AccessCode"] ? String(data[map["AccessCode"] - 1] || "").trim() : "") ||
      (map["AccessCodeSnapshot"] ? String(data[map["AccessCodeSnapshot"] - 1] || "").trim() : "") ||
      getAmenityAccessCode_(amenityKey);

    if (eventType === "ACTIVATED") {
      return amenityReplyKey_(ph, lang, "AMENITY_ACTIVE_NOW", {
        amenityLabel: label,
        window: (start && end) ? formatWindowLabel_(start, end) : "",
        code: code
      }, "AMENITY_ACTIVATED");
    }

    if (eventType === "ENDED") {
      return amenityReplyKey_(ph, lang, "AMENITY_ENDED", {
        amenityLabel: label
      }, "AMENITY_ENDED");
    }
  }

  /************************************
  * LEASING ENGINE — moved to LEASING_ENGINE.gs
  ************************************/


  /**
   * Send message via SMS or WhatsApp. Channel: channelOverride (e.g. from Outgate intent) → __inboundChannel → default SMS.
   * @param {string} to - Recipient phone E164
   * @param {string} text - Message body
   * @param {string} tag - Log tag (e.g. intentType)
   * @param {string} [channelOverride] - Optional "SMS" or "WA"; when provided (e.g. by ogDeliver_), used instead of globalThis.__inboundChannel for render/delivery alignment.
   */
  function sendRouterSms_(to, text, tag, channelOverride) {
    const msg = String(text || "").trim();

    dbg_("ROUTER_SMS_ENTER", { from: to, bodyRaw: msg, note: "sendRouterSms_ called", tag: tag || "" });

    if (!to || !msg) {
      dbg_("ROUTER_SMS_ABORT_EMPTY", { from: to, note: "missing to or msg" });
      return;
    }

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
      var ch = (channelOverride && String(channelOverride).trim().toUpperCase() === "WA") ? "WA" : "";
      if (!ch) ch = String(globalThis.__inboundChannel || "SMS").toUpperCase();
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



  function isGlobalResetCommand_(sLower) {
    const s = String(sLower || "")
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")   // remove punctuation/emojis safely
      .replace(/\s+/g, " ")        // collapse spaces
      .trim();

    return (
      s === "reset" ||
      s === "restart" ||
      s === "start over" ||
      s === "start again" ||
      s === "clear" ||
      s === "clear chat"
    );
  }


  function handleGlobalReset_(e) {
    const p = (e && e.parameter) ? e.parameter : {};
    const from = String(p.From || "").trim();
    if (!from) return;

    // 1) Clear AMENITY state
    try { endAmenityFlow_(from); } catch (_) {}

    // 2) Clear MAINTENANCE pending state (locked)
    try {
      const dir = getSheet_(DIRECTORY_SHEET_NAME);
      const phoneNorm = normalizePhone_(from);
      const dirRow = findDirectoryRowByPhone_(dir, phoneNorm);
      if (dirRow > 0) {
        dalWithLock_("RESET_CLEAR_DIR", function () {
          dalSetPendingStageNoLock_(dir, dirRow, "");
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(from || "", "", "DAL_WRITE RESET_CLEAR_DIR row=" + dirRow); } catch (_) {}
        });
      }
    } catch (err) {
      try { logDevSms_(from, "", "RESET_CLEAR_DIR_ERR " + String(err && err.stack ? err.stack : err)); } catch (_) {}
    }

    // 3) Send confirmation (router-safe, template-key, GSM-7)
    try {
      const out = tenantMsgSafe_(
        "TENANT_RESET_CONFIRM",
        "en",
        { brandName: BRAND.name, teamName: BRAND.team },
        "ERR_GENERIC_TRY_AGAIN"
      );
      sendRouterSms_(from, out, "ROUTER_GLOBAL_RESET");
    } catch (err) {
      try { logDevSms_(from, "", "RESET_SEND_ERR " + String(err && err.stack ? err.stack : err)); } catch (_) {}
    }
  }




  function looksLikeAckOnly_(text) {
    const raw = String(text || "").trim();
    if (!raw) return false;

    const s = raw.toLowerCase().trim();

    // Fast emoji-only acknowledgements
    if (/^[\s👍👌🙏✅🙂😊😀😅😂❤️💯🙌]+$/u.test(raw)) return true;

    // Normalize: keep letters/numbers/spaces only
    const t = s
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!t) return false;

    // -----------------------------
    // HARD LIMITS (prevents blocking real issues)
    // -----------------------------
    const words = t.split(" ").filter(Boolean);
    const charLen = t.length;

    // Only allow short acknowledgements
    if (words.length > 5) return false;
    if (charLen > 40) return false;

    // If they included ANY maintenance-ish keyword, do NOT treat as ack-only
    // (This is the safety net.)
    const ISSUE_HINTS = [
      "leak","leaking","water","flood","flooding","drip","dripping",
      "sink","toilet","tub","shower","clog","clogged","backed up",
      "broken","broke","not working","doesnt work","won't","wont",
      "no heat","heat","heater","hot water","ac","a/c","air",
      "smoke","fire","alarm","lock","door","key","mold","gas",
      "noise","sparks","electric","power","outlet","light"
    ];
    for (const k of ISSUE_HINTS) {
      if (t.includes(k)) return false;
    }

    // -----------------------------
    // ACK PATTERNS (variants + typos)
    // -----------------------------

    // Common short forms (exact words)
    const EXACT = new Set([
      "ok","okay","k","kk","kk.","ok.","okay.",
      "got it","gotcha","sounds good","all set",
      "cool","great","awesome","perfect","nice",
      "appreciate it","much appreciated","good","good thanks"
    ]);
    if (EXACT.has(t)) return true;

    // Thanks variations (regex covers most typos)
    // e.g. thanks / thx / tnx / thanx / thank u / thankyou / thks / tks / thnks
    if (
      /\b(thx|tnx|tks|thks|thanx|thnx|thnks)\b/.test(t) ||
      /\bthank(s|you)?\b/.test(t) ||
      /\bthank\s*u\b/.test(t) ||
      /\bty\b/.test(t)
    ) {
      // Still require it to be short and not contain other “content”
      if (words.length <= 4) return true;
    }

    // Quick “received/ok” confirmations
    if (/\b(ok|okay|got it|received|noted|understood)\b/.test(t) && words.length <= 4) return true;

    return false;
  }


  //
  //
  //* Assing Function - Auto Assing
  //
  // Assing Function - Auto Assing 
  //
  //


  function getSheetSafe_(name) {
    try {
      const ss = SpreadsheetApp.getActive();
      const sh = ss.getSheetByName(name);
      return sh || null;
    } catch (_) {
      return null;
    }
  }

  // Reads Staff tab (columns: StaffId, StaffName, Active) into a normalized list. No hardcoded names.
  function readStaff_() {
    var sh = getSheetSafe_("Staff");
    if (!sh) return [];
    var values = sh.getDataRange().getValues();
    if (!values || values.length < 2) return [];
    var headers = values[0].map(function (h) { return String(h || "").trim(); });
    var idx = {};
    headers.forEach(function (h, i) { if (h) idx[h] = i; });
    var iId = idx["StaffId"];
    var iName = idx["StaffName"];
    var iActive = idx["Active"];
    if (iId === undefined || iName === undefined) return [];
    var out = [];
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var id = String(row[iId] || "").trim();
      if (!id) continue;
      var name = String(row[iName] || "").trim();
      var activeRaw = iActive !== undefined ? row[iActive] : true;
      var active = activeRaw === true ||
        String(activeRaw || "").toLowerCase().trim() === "true" ||
        String(activeRaw || "").toLowerCase().trim() === "yes" ||
        String(activeRaw || "").trim() === "1";
      out.push({ id: id, name: name || id, active: active });
    }
    return out;
  }

  // Lookup staff by StaffId (for Sheet1 AssignedName). Returns { id, name } or null. Uses Staff tab only.
  function getStaffById_(staffId) {
    var id = String(staffId || "").trim();
    if (!id) return null;
    var list = readStaff_();
    for (var i = 0; i < list.length; i++) {
      if (list[i].active && String(list[i].id || "").trim() === id) return list[i];
    }
    return null;
  }

  // Reads Vendors tab into a normalized object list
  function readVendors_() {
    const sh = getSheetSafe_("Vendors");
    if (!sh) return [];

    const values = sh.getDataRange().getValues();
    if (!values || values.length < 2) return [];

    const headers = values[0].map(h => String(h || "").trim());
    const idx = {};
    headers.forEach((h, i) => { if (h) idx[h] = i; });

    // Required columns
    const iId = idx["VendorId"];
    const iName = idx["VendorName"];
    const iPhone = idx["PhoneE164"];
    const iActive = idx["Active"];

    if ([iId, iName, iPhone, iActive].some(v => v === undefined)) {
      // Missing required headers
      return [];
    }

    const out = [];
    for (let r = 1; r < values.length; r++) {
      const row = values[r];

      const id = String(row[iId] || "").trim();
      if (!id) continue;

      const name = String(row[iName] || "").trim();
      const phone = normalizePhoneE164_(String(row[iPhone] || "").trim());
      const activeRaw = row[iActive];

      const active =
        activeRaw === true ||
        String(activeRaw || "").toLowerCase().trim() === "true" ||
        String(activeRaw || "").toLowerCase().trim() === "yes" ||
        String(activeRaw || "").trim() === "1";

      out.push({
        id,
        name: name || id,
        phone,          // +1xxxxxxxxxx
        phoneDigits: normalizePhoneDigits_(phone), // 10/11 digits (for matching inbound)
        active
      });
    }
    return out;
  }

  function normalizePhoneE164_(phone) {
    const d = String(phone || "").replace(/[^\d]/g, "");
    if (!d) return "";
    // If 10 digits, assume US
    if (d.length === 10) return "+1" + d;
    // If 11 digits starting with 1
    if (d.length === 11 && d.startsWith("1")) return "+" + d;
    // Otherwise best effort
    return phone.startsWith("+") ? phone : ("+" + d);
  }

  // Lookup vendor by VendorId (for manager assignment)
  function getVendorById_(vendorId) {
    const id = String(vendorId || "").trim();
    if (!id) return null;

    const vendors = readVendors_();
    for (let i = 0; i < vendors.length; i++) {
      if (vendors[i].active && vendors[i].id === id) return vendors[i];
    }
    return null;
  }

  // Lookup vendor by inbound phone (for vendor SMS replies)
  function getVendorByPhone_(fromPhoneRaw) {
    const digits = normalizePhoneDigits_(fromPhoneRaw);
    if (!digits) return null;

    const vendors = readVendors_();
    for (let i = 0; i < vendors.length; i++) {
      if (!vendors[i].active) continue;
      if (vendors[i].phoneDigits && vendors[i].phoneDigits.endsWith(digits.slice(-10))) {
        return vendors[i];
      }
    }
    return null;
  }

  function notifyVendorForTicket_(creds, vendor, ctx) {
    try {
      const vPhone = String(vendor && vendor.phone ? vendor.phone : "").trim();
      const vId = String(vendor && vendor.id ? vendor.id : "").trim();
      const tId = String(ctx && ctx.ticketId ? ctx.ticketId : "").trim();

      // ------------------------------------------------
      // DISPATCH GUARD - prevent duplicate vendor SMS
      // ------------------------------------------------
      var sheet = ctx && ctx.sheet;
      var row = ctx && ctx.row;
      var dispatchMarker = "VDISP:" + vId;
      var notes = "";
      if (sheet && row) {
        notes = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
        if (notes.indexOf(dispatchMarker) !== -1) {
          logDevSms_(
            "",
            "",
            "VENDOR_DISPATCH_SKIPPED ticket=" + tId +
            " vendor=" + vId +
            " reason=already_dispatched"
          );
          return;
        }
      }

      // Always log start marker (even in DEV_MODE)
      logDevSms_(
        vPhone || "(missing phone)",
        "DBG_NOTIFY_VENDOR start ticket=" + tId + " vendor=" + vId,
        "DBG_NOTIFY_VENDOR"
      );

      if (!creds) {
        logDevSms_(vPhone || "(missing phone)", "DBG_NOTIFY_VENDOR missing creds", "DBG_NOTIFY_VENDOR");
        return;
      }
      if (!vPhone) {
        logDevSms_("(missing phone)", "DBG_NOTIFY_VENDOR vendor.phone is blank", "DBG_NOTIFY_VENDOR");
        return;
      }

      const sid = creds.TWILIO_SID;
      const token = creds.TWILIO_TOKEN;
      const fromNumber = creds.TWILIO_NUMBER;

      // Build message (safe + deterministic)
      const propertyDisplayName = String((ctx && ctx.property) || "").trim();
      const unit = String((ctx && ctx.unit) || "").trim();
      const category = String((ctx && ctx.category) || "").trim();
      const issueShort = String((ctx && ctx.msg) || "").trim();

      // Debug what we received
      logDevSms_(
        vPhone,
        "DBG_NOTIFY_VENDOR ctx.category=[" + category + "] ctx.msg.len=" + issueShort.length,
        "DBG_NOTIFY_VENDOR"
      );

      // ✅ Save last ticket for YES/NO shorthand
      try { setVendorLastTicket_(vendor, tId); } catch (_) {}

      var vendorLang = "en";
      var msg = buildVendorDispatchMsg_(vendorLang, {
        propertyName: propertyDisplayName,
        unit: unit,
        category: category,
        issue: issueShort,
        exampleWindow: "Tomorrow 8-10am",
        exampleReason: "Cannot make it"
      });

      sendRouterSms_(vPhone, msg, "VENDOR_DISPATCH_REQUEST");
      logDevSms_(
        vPhone,
        "",
        "VENDOR_DISPATCH_SENT ticket=" + tId + " vendor=" + String(vendor && (vendor.name || vendor.id) || "")
      );
      // mark dispatch so it cannot send twice
      if (sheet && row) {
        var newNotes = notes ? notes + " | " + dispatchMarker : dispatchMarker;
        sheet.getRange(row, COL.VENDOR_NOTES).setValue(newNotes);
      }
    } catch (e) {
      try { logDevSms_("(crash)", "notifyVendorForTicket_ crash: " + e, "DBG_NOTIFY_VENDOR"); } catch (_) {}
      Logger.log("notifyVendorForTicket_ crash: " + e);
    }
  }


  function testNotifyVendor_debug2() {
    const vendor = getVendorById_("VEND_PLUMB_01");
    notifyVendorForTicket_(
      { TWILIO_SID: "TEST", TWILIO_TOKEN: "TEST", TWILIO_NUMBER: "+10000000000" },
      vendor,
      { ticketId: "TEST-123", property: "The Grand at Penn", unit: "305", category: "Plumbing", msg: "Leak test" }
    );
    Logger.log("done debug2");
  }

  function assignTicketFromRow_(creds, sheet, row, opt) {
    opt = opt || {};
    const mode = opt.mode || "MANUAL"; // MANUAL | AUTO
    const assignedBy = opt.assignedBy || (mode === "AUTO" ? "AUTO" : "Manager");

    const assignedType = String(sheet.getRange(row, COL.ASSIGNED_TYPE).getValue() || "").trim(); // Vendor | Staff
    const assignedId   = String(sheet.getRange(row, COL.ASSIGNED_ID).getValue() || "").trim();
    if (!assignedType || !assignedId) return;

    const ticketId = String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim();
    const property = String(sheet.getRange(row, COL.PROPERTY).getValue() || "").trim();
    const unit     = String(sheet.getRange(row, COL.UNIT).getValue() || "").trim();

    // ✅ ONLY use Category (your AI handler sets this)
    const cat      = String(sheet.getRange(row, COL.CAT).getValue() || "").trim();

    const msg      = String(sheet.getRange(row, COL.MSG).getValue() || "").trim();

    const vendorStatusCell = sheet.getRange(row, COL.VENDOR_STATUS);
    const vendorStatusNow  = String(vendorStatusCell.getValue() || "").trim();

    // -------------------------
    // VENDOR ASSIGNMENT
    // -------------------------
    if (assignedType === "Vendor") {
      const vendor = getVendorById_(assignedId);
      if (!vendor) {
        vendorStatusCell.setNumberFormat("@");
        vendorStatusCell.setValue("VendorNotFound");
        return;
      }

      const assigneeName = String(vendor.name || assignedId).trim();

      // Write assignment fields
      sheet.getRange(row, COL.ASSIGNED_TO).setValue(assigneeName);     // legacy
      sheet.getRange(row, COL.ASSIGNED_NAME).setValue(assigneeName);
      sheet.getRange(row, COL.ASSIGNED_AT).setValue(new Date());
      sheet.getRange(row, COL.ASSIGNED_BY).setValue(assignedBy);

      // ✅ Send only once
      if (!vendorStatusNow) {
        vendorStatusCell.setNumberFormat("@");
        vendorStatusCell.setValue("Contacted");

        notifyVendorForTicket_(creds, vendor, {
          ticketId: ticketId,
          property: property,
          unit: unit,
          category: cat,   // ✅ will now show "Plumbing"
          msg: msg,
          sheet: sheet,
          row: row
        });

        // ▸ PATCH: WI → WAIT_VENDOR / ACCEPT (vendor was just contacted)
        try {
          var wiId = findWorkItemIdByTicketRow_(row);
          if (wiId) {
            wiTransition_(wiId, "WAIT_VENDOR", "ACCEPT", String(vendor.phone || ""), "WI_WAIT_VENDOR");
          }
        } catch (_) {}
      }
      return;
    }

    // -------------------------
    // STAFF ASSIGNMENT (NO SMS)
    // -------------------------
    if (assignedType === "Staff") {
      const staff = getStaffById_(assignedId);
      if (!staff) return;

      const assigneeName = String(staff.name || assignedId).trim();

      sheet.getRange(row, COL.ASSIGNED_TO).setValue(assigneeName);     // legacy
      sheet.getRange(row, COL.ASSIGNED_NAME).setValue(assigneeName);
      sheet.getRange(row, COL.ASSIGNED_AT).setValue(new Date());
      sheet.getRange(row, COL.ASSIGNED_BY).setValue(assignedBy);
      return;
    }
  }

  function getVendorByPhoneDigits_(digits10) {
    const want = String(digits10 || "").replace(/\D/g, "").slice(-10);
    if (!want) return null;

    // ✅ MUST use the same vendor source as getVendorById_
    const vendors = readVendors_(); // <-- this is key
    if (!vendors || !vendors.length) return null;

    for (let i = 0; i < vendors.length; i++) {
      const v = vendors[i];
      if (!v) continue;
      if (v.active === false) continue;

      const dA = String(v.phoneDigits || "").replace(/\D/g, "").slice(-10);
      const dB = String(v.phone || "").replace(/\D/g, "").slice(-10);

      if (dA === want || dB === want) return v;
    }
    return null;
  }



  function findTicketRowById_(sheet, ticketId) {
    const tid = String(ticketId || "").trim();
    if (!tid) return 0;

    const tf = sheet.getRange(1, COL.TICKET_ID, sheet.getLastRow(), 1)
      .createTextFinder(tid)
      .matchEntireCell(true)
      .findNext();

    return tf ? tf.getRow() : 0;
  }

  function handleVendorAcceptDecline_(vendor, sheet, bodyTrim, creds) {
    const text = String(bodyTrim || "").trim();
    if (!text) return false;

    const up = text.toUpperCase();
    const vLang = String(vendor && vendor.lang ? vendor.lang : "en").toLowerCase();

    // Helper: determine ticket id from explicit command or last ticket
    function resolveTicketId_(explicitTid) {
      const tid = String(explicitTid || "").trim();
      if (tid) return tid;
      return getVendorLastTicket_(vendor); // may be ""
    }

    // Helper: basic ticketId token check (keeps it simple + safe)
    function looksLikeTicketId_(tok) {
      const t = String(tok || "").trim();
      return (t.length >= 6 && t.indexOf("-") >= 0);
    }

    // -----------------------------
    // YES / NO shorthand
    // YES [ticketId] [availability...]
    // NO  [ticketId] [optional reason...]
    // -----------------------------
    let m = up.match(/^(YES|Y|NO|N)\b(?:\s+(.+))?$/i);
    if (m) {
      const head = String(m[1] || "").toUpperCase();
      const rest = String(m[2] || "").trim(); // everything after YES/NO

      // Optional ticketId as first token after YES/NO
      let explicitTid = "";
      let tailRaw = rest;

      if (rest) {
        const parts = rest.split(/\s+/);
        const first = parts[0];
        if (looksLikeTicketId_(first)) {
          explicitTid = first;
          tailRaw = rest.substring(first.length).trim();
        }
      }

      const ticketId = resolveTicketId_(explicitTid);

      if (!ticketId) {
        replyVendorKey_(creds, vendor.phone, "VENDOR_NEED_TICKET_ID", vLang, {});
        return true;
      }

      const row = findTicketRowById_(sheet, ticketId);
      if (row < 2) {
        replyVendorKey_(creds, vendor.phone, "VENDOR_TICKET_NOT_FOUND", vLang, { ticketId: ticketId });
        return true;
      }

      // NO / N => Decline (reason optional)
      if (head === "NO" || head === "N") {
        const reasonRaw = String(tailRaw || "").trim();

        sheet.getRange(row, COL.VENDOR_STATUS).setNumberFormat("@");
        sheet.getRange(row, COL.VENDOR_STATUS).setValue("Declined");

        sheet.getRange(row, COL.VENDOR_NOTES).setNumberFormat("@");
        const prevNotes = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
        const noteLine =
          "Declined by " + (vendor.name || "Vendor") +
          (reasonRaw ? (": " + reasonRaw) : "") +
          " @ " + new Date().toLocaleString();
        sheet.getRange(row, COL.VENDOR_NOTES).setValue(prevNotes ? (prevNotes + " | " + noteLine) : noteLine);

        replyVendorKey_(creds, vendor.phone, "VENDOR_DECLINE_RECORDED", vLang, { ticketId: ticketId });

        // ✅ Manager alert (decline)  (OPTIONAL: template this too later)
        notifyManagerVendorDecision_(
          creds,
          ticketId + " declined by " + (vendor.name || "Vendor") + (reasonRaw ? (" - " + reasonRaw) : "")
        );

        // ▸ PATCH: WI → WAIT_INTERNAL / DISPATCH (vendor declined, internal must reassign)
        try {
          var decWiId = findWorkItemIdByTicketRow_(row);
          if (decWiId) wiTransition_(decWiId, "WAIT_INTERNAL", "DISPATCH", String(vendor.phone || ""), "WI_VENDOR_HANDOFF");
        } catch (_) {}

        return true;
      }

      // YES / Y => Accept (availability required)
      const apptRaw = String(tailRaw || "").trim();

      if (!apptRaw) {
        replyVendorKey_(creds, vendor.phone, "VENDOR_ACCEPT_NEED_WINDOW", vLang, { ticketId: ticketId });

        // ▸ PATCH: WI → WAIT_VENDOR / AVAILABILITY (accepted but no window yet)
        try {
          var avWiId = findWorkItemIdByTicketRow_(row);
          if (avWiId) wiTransition_(avWiId, "WAIT_VENDOR", "AVAILABILITY", String(vendor.phone || ""), "WI_WAIT_VENDOR");
        } catch (_) {}

        return true; // ⚠️ no manager alert yet (no window)
      }

      sheet.getRange(row, COL.VENDOR_STATUS).setNumberFormat("@");
      sheet.getRange(row, COL.VENDOR_STATUS).setValue("Accepted");

      sheet.getRange(row, COL.VENDOR_APPT).setNumberFormat("@");
      sheet.getRange(row, COL.VENDOR_APPT).setValue(apptRaw);

      sheet.getRange(row, COL.VENDOR_NOTES).setNumberFormat("@");
      const prevNotes = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
      const noteLine = "Accepted by " + (vendor.name || "Vendor") + " @ " + new Date().toLocaleString();
      sheet.getRange(row, COL.VENDOR_NOTES).setValue(prevNotes ? (prevNotes + " | " + noteLine) : noteLine);

      sheet.getRange(row, COL.STATUS).setValue("Scheduled");

      replyVendorKey_(creds, vendor.phone, "VENDOR_ACCEPT_SCHEDULED", vLang, { appt: apptRaw, ticketId: ticketId });

      // ✅ Tenant confirmation (vendor accepted + window)
      notifyTenantVendorScheduled_(sheet, row, ticketId, (vendor.name || "Vendor"), apptRaw);

      // ▸ PATCH: WI → WAIT_INTERNAL / DISPATCH (vendor confirmed, ops takes over)
      try {
        var accWiId = findWorkItemIdByTicketRow_(row);
        if (accWiId) wiTransition_(accWiId, "WAIT_INTERNAL", "DISPATCH", String(vendor.phone || ""), "WI_VENDOR_HANDOFF");
      } catch (_) {}

      return true;
    }

    // -----------------------------
    // ACCEPT <ticketId> <appt...>
    // -----------------------------
    m = up.match(/^ACCEPT\s+(\S+)(?:\s+(.+))?$/i);
    if (m) {
      const ticketId = resolveTicketId_(m[1]);
      const apptRaw = String(text.replace(/^ACCEPT\s+\S+/i, "") || "").trim();

      const row = findTicketRowById_(sheet, ticketId);
      if (row < 2) {
        replyVendorKey_(creds, vendor.phone, "VENDOR_TICKET_NOT_FOUND", vLang, { ticketId: ticketId });
        return true;
      }

      if (!apptRaw) {
        replyVendorKey_(creds, vendor.phone, "VENDOR_ACCEPT_NEED_WINDOW_ACCEPT_CMD", vLang, { ticketId: ticketId });

        // ▸ PATCH: WI → WAIT_VENDOR / AVAILABILITY (accepted but no window)
        try {
          var av2WiId = findWorkItemIdByTicketRow_(row);
          if (av2WiId) wiTransition_(av2WiId, "WAIT_VENDOR", "AVAILABILITY", String(vendor.phone || ""), "WI_WAIT_VENDOR");
        } catch (_) {}

        return true; // ⚠️ no manager alert yet (no window)
      }

      sheet.getRange(row, COL.VENDOR_STATUS).setNumberFormat("@");
      sheet.getRange(row, COL.VENDOR_STATUS).setValue("Accepted");

      sheet.getRange(row, COL.VENDOR_APPT).setNumberFormat("@");
      sheet.getRange(row, COL.VENDOR_APPT).setValue(apptRaw);

      sheet.getRange(row, COL.VENDOR_NOTES).setNumberFormat("@");
      const prevNotes = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
      const noteLine = "Accepted by " + (vendor.name || "Vendor") + " @ " + new Date().toLocaleString();
      sheet.getRange(row, COL.VENDOR_NOTES).setValue(prevNotes ? (prevNotes + " | " + noteLine) : noteLine);

      sheet.getRange(row, COL.STATUS).setValue("Scheduled");

      replyVendorKey_(creds, vendor.phone, "VENDOR_ACCEPT_SCHEDULED", vLang, { appt: apptRaw, ticketId: ticketId });

      // ✅ Tenant confirmation (vendor accepted + window)
      notifyTenantVendorScheduled_(sheet, row, ticketId, (vendor.name || "Vendor"), apptRaw);

      // ▸ PATCH: WI → WAIT_INTERNAL / DISPATCH (vendor confirmed, ops takes over)
      try {
        var acc2WiId = findWorkItemIdByTicketRow_(row);
        if (acc2WiId) wiTransition_(acc2WiId, "WAIT_INTERNAL", "DISPATCH", String(vendor.phone || ""), "WI_VENDOR_HANDOFF");
      } catch (_) {}

      return true;
    }

    // -----------------------------
    // DECLINE <ticketId> <optional reason>
    // -----------------------------
    m = up.match(/^DECLINE\s+(\S+)(?:\s+(.+))?$/i);
    if (m) {
      const ticketId = resolveTicketId_(m[1]);
      const reasonRaw = String(text.replace(/^DECLINE\s+\S+/i, "") || "").trim();

      const row = findTicketRowById_(sheet, ticketId);
      if (row < 2) {
        replyVendorKey_(creds, vendor.phone, "VENDOR_TICKET_NOT_FOUND", vLang, { ticketId: ticketId });
        return true;
      }

      sheet.getRange(row, COL.VENDOR_STATUS).setNumberFormat("@");
      sheet.getRange(row, COL.VENDOR_STATUS).setValue("Declined");

      sheet.getRange(row, COL.VENDOR_NOTES).setNumberFormat("@");
      const prevNotes = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
      const noteLine =
        "Declined by " + (vendor.name || "Vendor") +
        (reasonRaw ? (": " + reasonRaw) : "") +
        " @ " + new Date().toLocaleString();
      sheet.getRange(row, COL.VENDOR_NOTES).setValue(prevNotes ? (prevNotes + " | " + noteLine) : noteLine);

      replyVendorKey_(creds, vendor.phone, "VENDOR_DECLINE_RECORDED", vLang, { ticketId: ticketId });

      // ✅ Manager alert (decline)
      notifyManagerVendorDecision_(
        creds,
        ticketId + " declined by " + (vendor.name || "Vendor") + (reasonRaw ? (" - " + reasonRaw) : "")
      );

      // ▸ PATCH: WI → WAIT_INTERNAL / DISPATCH (vendor declined, internal must reassign)
      try {
        var dec2WiId = findWorkItemIdByTicketRow_(row);
        if (dec2WiId) wiTransition_(dec2WiId, "WAIT_INTERNAL", "DISPATCH", String(vendor.phone || ""), "WI_VENDOR_HANDOFF");
      } catch (_) {}

      return true;
    }

    return false; // not a vendor command
  }




  function replyVendor_(creds, toPhone, text) {
    const msg = String(text || "").trim();
    if (!msg) return;

    // ✅ DO NOT log here. sendSms_ already logs (DEV_MODE or LIVE_ATTEMPT).
    sendSms_(
      creds && creds.TWILIO_SID,
      creds && creds.TWILIO_TOKEN,
      creds && creds.TWILIO_NUMBER,
      toPhone,
      msg
    );
  }


  function handleVendorAvailabilityOnly_(vendor, sheet, bodyTrim, creds) {
    const avail = extractVendorAvailabilityText_(bodyTrim);
    if (!avail) return false;

    const vendorId = String(vendor && vendor.id ? vendor.id : "").trim();
    if (!vendorId) return false;

    const rows = findActiveVendorTicketRows_(sheet, vendorId) || [];

    // 0 active assignments -> can't schedule anything
    if (!rows.length) {
      replyVendor_(creds, vendor.phone, tenantMsg_("VENDOR_CONFIRM_INSTRUCTIONS", "en", {
        brandName: BRAND.name,
        teamName: BRAND.team
      }));
      try { logDevSms_(vendor.phone, "VENDOR_AVAIL_ONLY no_active avail=[" + avail + "]", "VENDOR_AVAIL"); } catch (_) {}
      return true;
    }

    // 2+ active assignments -> require ticket id (no guessing)
    if (rows.length > 1) {
      const list = rows.slice(0, 5).map(r => {
        const tid = String(sheet.getRange(r, COL.TICKET_ID).getValue() || "").trim();
        return tid ? ("- " + tid) : ("- Row " + r);
      }).join("\n");

      replyVendor_(creds, vendor.phone, tenantMsg_("VENDOR_MULTI_PENDING_NEED_TID", "en", {
        availability: avail,
        ticketList: list
      }));

      try { logDevSms_(vendor.phone, "VENDOR_AVAIL_ONLY multi_active n=" + rows.length + " avail=[" + avail + "]", "VENDOR_AVAIL"); } catch (_) {}
      return true;
    }

    // Exactly 1 active assignment -> implicit YES
    try { logDevSms_(vendor.phone, "VENDOR_AVAIL_ONLY implicit_yes avail=[" + avail + "]", "VENDOR_AVAIL"); } catch (_) {}
    return !!handleVendorAcceptDecline_(vendor, sheet, "YES " + avail, creds);
  }

  function findActiveVendorTicketRows_(sheet, vendorId) {
    const sh = sheet || SpreadsheetApp.getActive().getSheetByName("Sheet1");
    const vid = String(vendorId || "").trim();
    if (!sh || !vid) return [];

    const last = sh.getLastRow();
    if (last < 2) return [];

    const aTypeCol = COL.ASSIGNED_TYPE;
    const aIdCol   = COL.ASSIGNED_ID;
    const vStatCol = COL.VENDOR_STATUS;

    // Minimal guards
    if (!aTypeCol || !aIdCol || !vStatCol) return [];

    const aType = sh.getRange(2, aTypeCol, last - 1, 1).getValues();
    const aId   = sh.getRange(2, aIdCol,   last - 1, 1).getValues();
    const vStat = sh.getRange(2, vStatCol, last - 1, 1).getValues();

    const out = [];
    for (let i = 0; i < last - 1; i++) {
      const type = String(aType[i][0] || "").trim().toLowerCase();
      const id   = String(aId[i][0]   || "").trim();
      const vs   = String(vStat[i][0] || "").trim().toLowerCase();

      // Active = assigned to this vendor + not finished
      // Adjust if your statuses differ
      const isAssigned = (type === "vendor" && id === vid);
      const isActive   = (vs === "" || vs === "contacted" || vs === "accepted" || vs === "scheduled");

      if (isAssigned && isActive) out.push(i + 2); // row index in sheet
    }

    // newest first (usually best)
    out.sort((r1, r2) => r2 - r1);
    return out;
  }


  function extractVendorAvailabilityText_(s) {
    const t = String(s || "").trim();
    if (!t) return "";

    const x = t.replace(/[–—]/g, "-").toLowerCase();

    const hasDay =
      /\b(today|tomorrow|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/.test(x);

    const hasPart = /\b(morning|afternoon|evening)\b/.test(x);

    const hasTime =
      // Range: 8-10am, 8:30-10, 8 - 10pm
      /\b\d{1,2}(:\d{2})?\s?(am|pm)?\s?-\s?\d{1,2}(:\d{2})?\s?(am|pm)?\b/.test(x) ||
      // With minutes: 10:30am
      /\b\d{1,2}:\d{2}\s?(am|pm)\b/.test(x) ||
      // ✅ NEW: Simple time: 2pm, 2 pm, 11am
      /\b\d{1,2}\s?(am|pm)\b/.test(x);

    return (hasDay && (hasTime || hasPart)) ? t : "";
  }


  function vendorLastTicketKey_(vendor) {
    const vid = String(vendor && vendor.id ? vendor.id : "").trim();
    return vid ? ("VENDOR_LAST_TICKET_" + vid) : "";
  }

  function setVendorLastTicket_(vendor, ticketId) {
    const key = vendorLastTicketKey_(vendor);
    const tid = String(ticketId || "").trim();
    if (!key || !tid) return;
    PropertiesService.getScriptProperties().setProperty(key, tid);
  }

  function getVendorLastTicket_(vendor) {
    const key = vendorLastTicketKey_(vendor);
    if (!key) return "";
    return String(PropertiesService.getScriptProperties().getProperty(key) || "").trim();
  }

  function notifyManagerVendorDecision_(creds, text) {
    const to = String(PropertiesService.getScriptProperties().getProperty("ONCALL_NUMBER") || "").trim();
    if (!to || !text) return;

    sendSms_(
      creds && creds.TWILIO_SID,
      creds && creds.TWILIO_TOKEN,
      creds && creds.TWILIO_NUMBER,
      to,
      String(text || "").trim(),
      "MANAGER_ALERT"
    );
  }

  // ===================================================================
  // ===== VENDOR → TENANT CONFIRMATION (Compass-aligned) ===============
  // Trigger: vendor sends YES <availability> for a dispatched ticket.
  // Location: vendor lane handler calls this after writing ticket fields.
  // ===================================================================
  function notifyTenantVendorScheduled_(sheet, row, ticketId, vendorName, apptRaw) {
    try {
      const toPhone = String(sheet.getRange(row, COL.PHONE).getValue() || "").trim();
      if (!toPhone) return;

      // Dedupe: if we already sent a tenant confirmation for this ticket, do nothing.
      // (We store a marker in VendorNotes to avoid adding new columns.)
      const notesCell = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "");
      if (notesCell && /TENANT_CONF_SENT/i.test(notesCell)) return;

      const ctx = ctxGet_(toPhone);
      const lang = String((ctx && ctx.lang) || "en").toLowerCase();

      const property = String(sheet.getRange(row, COL.PROPERTY).getValue() || "").trim();
      const unit = String(sheet.getRange(row, COL.UNIT).getValue() || "").trim();
      const category = String(sheet.getRange(row, COL.CAT_FINAL).getValue() || sheet.getRange(row, COL.CAT).getValue() || "").trim();

      const msg = renderTenantKey_(
        "TENANT_VENDOR_SCHEDULED",
        lang,
        {
          property: property,
          unit: unit,
          category: category,
          appt: String(apptRaw || "").trim(),
          vendorName: String(vendorName || "").trim(),
          ticketId: String(ticketId || "").trim()
        }
      );

      sendRouterSms_(toPhone, msg, "TENANT_VENDOR_SCHEDULED");

      // Mark sent (best-effort) so duplicate vendor YES replies don't spam the tenant.
      try {
        const stamp = "TENANT_CONF_SENT @ " + new Date().toLocaleString();
        const cur = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
        sheet.getRange(row, COL.VENDOR_NOTES).setNumberFormat("@");
        sheet.getRange(row, COL.VENDOR_NOTES).setValue(cur ? (cur + " | " + stamp) : stamp);
      } catch (_) {}
    } catch (err) {
      try { logDevSms_("", "", "TENANT_VENDOR_SCHEDULED_CRASH " + String(err && err.stack ? err.stack : err)); } catch (_) {}
    }
  }





  //
  //
  //  tesT FUNCTION ONLY

  //
  //
  //

  function createAssignTestTicket_() {
    const sheet = SpreadsheetApp.getActive().getSheetByName("Sheet1");
    if (!sheet) throw new Error("Sheet1 not found");

    const row = sheet.getLastRow() + 1;

    const tid = "TEST-ASSIGN-" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");

    sheet.getRange(row, COL.TS).setValue(new Date());
    sheet.getRange(row, COL.PHONE).setValue("+19999999999");
    sheet.getRange(row, COL.PROPERTY).setValue("The Grand at Penn");
    sheet.getRange(row, COL.UNIT).setValue("305");
    sheet.getRange(row, COL.MSG).setValue("Leak test for assignment");
    sheet.getRange(row, COL.CAT).setValue("Plumbing");
    sheet.getRange(row, COL.TICKET_ID).setValue(tid);
    sheet.getRange(row, COL.STATUS).setValue("TEST");

    // Clear assignment/vendor fields
    sheet.getRange(row, COL.ASSIGNED_TO).setValue("");
    sheet.getRange(row, COL.ASSIGNED_TYPE).setValue("");
    sheet.getRange(row, COL.ASSIGNED_ID).setValue("");
    sheet.getRange(row, COL.ASSIGNED_NAME).setValue("");
    sheet.getRange(row, COL.ASSIGNED_AT).setValue("");
    sheet.getRange(row, COL.ASSIGNED_BY).setValue("");
    sheet.getRange(row, COL.VENDOR_STATUS).setValue("");
    sheet.getRange(row, COL.VENDOR_APPT).setValue("");
    sheet.getRange(row, COL.VENDOR_NOTES).setValue("");

    Logger.log("Created test ticket row=" + row + " TicketID=" + tid);
    return { row, tid };
  }

  function deleteRow_(sheet, row) {
    if (!sheet || row < 2) return;
    sheet.deleteRow(row);
  }


  function runAssignVendorSandboxTest() {
    const sheet = SpreadsheetApp.getActive().getSheetByName("Sheet1");
    const t = createAssignTestTicket_();

    const vendorId = "VEND_PLUMB_01";
    const vendor = getVendorById_(vendorId);

    logDevSms_("+19999999999", "RUN_ASSIGN_TEST start " + t.tid, "DBG_ASSIGN_TEST");

    sheet.getRange(t.row, COL.ASSIGNED_TYPE).setValue("Vendor");
    sheet.getRange(t.row, COL.ASSIGNED_ID).setValue(vendorId);
    sheet.getRange(t.row, COL.VENDOR_STATUS).setValue("");

    const creds = { TWILIO_SID: "TEST", TWILIO_TOKEN: "TEST", TWILIO_NUMBER: "+10000000000" };
    assignTicketFromRow_(creds, sheet, t.row, { mode: "MANUAL", assignedBy: "SANDBOX_TEST" });

    const assignedName = String(sheet.getRange(t.row, COL.ASSIGNED_NAME).getValue() || "").trim();
    const vendorStatus = String(sheet.getRange(t.row, COL.VENDOR_STATUS).getValue() || "").trim();

    Logger.log("AssignedName=" + assignedName);
    Logger.log("VendorStatus=" + vendorStatus);
    Logger.log("Test TicketID=" + t.tid + " Row=" + t.row);

    if (vendor) {
      logDevSms_(String(vendor.phone || ""), "RUN_ASSIGN_TEST expected vendor notify " + t.tid, "DBG_ASSIGN_TEST");
    } else {
      logDevSms_("(no vendor)", "RUN_ASSIGN_TEST vendor not found " + vendorId, "DBG_ASSIGN_TEST");
    }

    // ✅ CRITICAL for runners: flush buffered DevSmsLog
    try { flushDevSmsLogs_(); } catch (_) {}
  }


  function assertColMapAligned_() {
    const vals = Object.keys(COL).map(k => COL[k]).filter(v => typeof v === "number");
    const max = Math.max.apply(null, vals);
    if (max !== MAX_COL) {
      throw new Error("COL map mismatch: MAX_COL=" + MAX_COL + " but max COL index=" + max);
    }
  }

  function runSchemaCheckOnce() {
    assertColMapAligned_();
    Logger.log("COL map aligned ✔");
  }

  function oneTest() {
    const props = PropertiesService.getScriptProperties();

    const twhsec = String(props.getProperty("TWILIO_WEBHOOK_SECRET") || "").trim();
    if (!twhsec) throw new Error("Missing Script Property: TWILIO_WEBHOOK_SECRET");

    const sid = "SM" + Utilities.getUuid().replace(/-/g, "").slice(0, 32);

    const fakeEvent = {
      parameter: {
        // ✅ must match validateTwilioWebhookGate_
        twhsec: twhsec,
        AccountSid: String(props.getProperty("TWILIO_SID") || TWILIO_SID || "").trim(),

        // Twilio-ish payload
        From: "+9084330005",
        Body: "tomorrow morning",
        MessageSid: sid,

        // optional
        _mode: "TENANT",
        _dryrun: "1"  // ✅ no Twilio outbound during emulator
      }
    };

    Logger.log("ONE_TEST start sid=" + sid);

    const resp = doPost(fakeEvent);

    // Best-effort response logging
    try {
      if (resp && typeof resp.getContent === "function") {
        Logger.log("ONE_TEST resp=" + resp.getContent());
      } else {
        Logger.log("ONE_TEST resp=" + JSON.stringify(resp));
      }
    } catch (_) {}

    Logger.log("ONE_TEST done sid=" + sid);
  }

  /**
  * Parameterized emulator: same entry path as Twilio (doPost), returns TwiML body.
  * Uses _dryrun=1 so no Twilio outbound; only works when SIM enabled and from in SIM_ALLOW_PHONES.
  * @param {string} from - E.164 From (e.g. "+9084330005")
  * @param {string} body - SMS body
  * @param {string} [mode] - _mode (default "TENANT")
  * @returns {string} TwiML XML string (or stringified response)
  */
  function emulateTwilioInbound_(from, body, mode) {
    const props = PropertiesService.getScriptProperties();

    const simSec = String(props.getProperty("SIM_WEBHOOK_SECRET") || "").trim();
    const twhsec = (simEnabled_() && simSec) ? simSec
      : String(props.getProperty("TWILIO_WEBHOOK_SECRET") || "").trim();

    const accountSid = String(props.getProperty("TWILIO_SID") || "").trim();
    const sid = "EMU_" + Utilities.getUuid().replace(/-/g, "").slice(0, 28);

    const fakeEvent = {
      parameter: {
        twhsec: twhsec,
        AccountSid: accountSid,
        From: String(from || "").trim(),
        Body: String(body || "").trim(),
        MessageSid: sid,
        _mode: String(mode || "TENANT"),
        _dryrun: "1"
      }
    };

    const resp = doPost(fakeEvent);
    try { if (resp && typeof resp.getContent === "function") return resp.getContent(); } catch (_) {}
    return typeof resp !== "undefined" ? JSON.stringify(resp) : "";
  }

  /**
  * Test dryrun: no Twilio outbound. Requires SIM_MODE=true and From in SIM_ALLOW_PHONES.
  * Use a phone from TEST_ALLOWLIST_ (e.g. +9084330005) and add it to SIM_ALLOW_PHONES.
  */
  function testDryRunNoTwilio_() {
    const phone = "+19084330005";
    const xml = emulateTwilioInbound_(phone, "sink clogged", "TENANT");
    Logger.log("testDryRunNoTwilio_ resp=" + xml);
  }

  /**
  * Server entry for sidebar emulator: runs inbound pipeline (dryrun), returns TwiML + optional message text.
  * @param {string} from - From phone (E.164)
  * @param {string} body - Message body
  * @param {string} [mode] - _mode (e.g. TENANT)
  * @returns {{ twiml: string, message?: string }}
  */
  function emulatorSend(from, body, mode) {
    try { flushDevSmsLogs_(); } catch (_) {}

    var twiml = "";
    try {
      twiml = emulateTwilioInbound_(from, body, mode);
    } catch (err) {
      try { logDevSms_(String(from || ""), String(body || ""), "EMU_CRASH", String(err && err.stack ? err.stack : err)); } catch (_) {}
      try { flushDevSmsLogs_(); } catch (_) {}
      return { twiml: "", message: "", error: String(err && err.message ? err.message : err) };
    }

    try { flushDevSmsLogs_(); } catch (_) {}

    var message;
    try {
      var m = (twiml || "").match(/<Message[^>]*>([\s\S]*?)<\/Message>/);
      if (m && m[1]) message = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
    } catch (_) {}

    return { twiml: twiml || "", message: message || "" };
  }



  /**
  * TEST RUNNER: simulate a fragmented inbound SMS burst (3-6 parts)
  * - Buffers each part through fragmentGateBuffer_ (same as doPost gate)
  * - Forces ProcessAfterAt to NOW so you don't wait for triggers
  * - Calls processDueFragmentsWorker_ until it processes 1 merged turn
  *
  * NOTE: Avoid STOP/START/HELP in parts (those bypass buffering).
  */
  function testRunFragmentBurst() {
    const phone = "+19089991113"; // <- change to any test number
    const parts = [
      "TOMORROW",
      "9-10AM",
      "",
      "" // optional extra fragments
    ];

    runFragmentBurst_(phone, parts);
  }

  /**
  * Core runner (call from other tests too)
  */
  function runFragmentBurst_(phoneE164, parts) {
    const from = phoneKey_(String(phoneE164 || "").trim());
    if (!from) throw new Error("Bad phoneE164: " + phoneE164);

    // 1) Buffer fragments (simulate rapid inbound)
    for (let i = 0; i < parts.length; i++) {
      const body = String(parts[i] || "").trim();
  if (!body) continue;
      const sid = "TEST_FRAG_" + new Date().getTime() + "_" + (i + 1);

      const r = fragmentGateBuffer_(from, body, sid);
      try { logDevSms_(from, body, "TEST_FRAG_PUSH i=" + (i + 1) + " buffered=" + String(!!(r && r.buffered))); } catch (_) {}
    }

    // 2) Force any OPEN fragment rows for this phone to be due NOW (so no waiting)
    forceFragmentsDueNowForPhone_(from);

    // 3) Process (calls handleSmsRouter_ via synthetic event)
    const did = processDueFragmentsWorker_();

    try { logDevSms_(from, parts.join(" | "), "TEST_FRAG_DONE processed=" + String(did)); } catch (_) {}

    // Flush logs if you want immediate visibility
    try { flushDevSmsLogs_(); } catch (_) {}
  }

  /**
  * Helper: set ProcessAfterAt=now for OPEN rows for this phone
  */
  function forceFragmentsDueNowForPhone_(phoneKey) {
    const sh = ensureFragSheet_();
    const now = new Date();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return;

    // Columns (1-indexed):
    // 1 PhoneE164, 2 Status, 5 ProcessAfterAt, 10 UpdatedAt
    for (let r = 2; r <= lastRow; r++) {
      const p = String(sh.getRange(r, 1).getValue() || "").trim();
      const st = String(sh.getRange(r, 2).getValue() || "").trim();
      if (p === phoneKey && st === "OPEN") {
        sh.getRange(r, 5).setValue(now);  // ProcessAfterAt
        sh.getRange(r, 10).setValue(now); // UpdatedAt
      }
    }
  }


  // =============================================================================
  // TEST HARNESS (batch SMS scenarios — no trailing underscore; run from editor)
  // =============================================================================

  var TEST_ALLOWLIST_ = ["+9084330005", "+9084330006", "+9084330007"];

  function makeFakeTwilioEvent(fromE164, body, mode) {
    mode = mode || "TENANT";
    const sid = "TEST_" + new Date().getTime() + "_" + Math.random().toString(36).slice(2, 10);
    return {
      parameter: {
        twhsec: (typeof TWILIO_WEBHOOK_SECRET !== "undefined") ? TWILIO_WEBHOOK_SECRET : "test_sec",
        AccountSid: (typeof TWILIO_SID !== "undefined") ? TWILIO_SID : "test_sid",
        From: String(fromE164 || "").trim(),
        Body: String(body || "").trim(),
        MessageSid: sid,
        _mode: String(mode)
      }
    };
  }

  function snapshotState(phoneE164) {
    const phone = (typeof normalizePhone_ === "function") ? normalizePhone_(phoneE164) : String(phoneE164 || "").trim();
    const out = { directoryRow: {}, ctx: {}, workItem: null, recentDevLogs: [] };
    const N = 80;

    try {
      const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
      const dir = ss.getSheetByName(DIRECTORY_SHEET_NAME);
      if (dir && typeof findDirectoryRowByPhone_ === "function") {
        const dirRow = findDirectoryRowByPhone_(dir, phone);
        if (dirRow > 0) {
          const rowVals = dir.getRange(dirRow, 1, dirRow, 10).getValues()[0];
          out.directoryRow = {
            Phone: String(rowVals[0] || "").trim(),
            PropertyCode: String(rowVals[1] || "").trim(),
            PropertyName: String(rowVals[2] || "").trim(),
            LastUpdated: rowVals[3] || "",
            PendingIssue: String(rowVals[4] || "").trim(),
            Unit: String(rowVals[5] || "").trim(),
            PendingRow: parseInt(rowVals[6] || "0", 10) || 0,
            PendingStage: String(rowVals[7] || "").trim(),
            ActiveTicketKey: String(rowVals[8] || "").trim()
          };
        }
      }
    } catch (_) {}

    try {
      out.ctx = (typeof ctxGet_ === "function") ? ctxGet_(phone) : {};
    } catch (_) {}

    if (out.ctx && out.ctx.activeWorkItemId) {
      try {
        out.workItem = (typeof workItemGetById_ === "function") ? workItemGetById_(out.ctx.activeWorkItemId) : null;
      } catch (_) {}
    }

    try {
      const logSh = SpreadsheetApp.openById(LOG_SHEET_ID).getSheetByName("DevSmsLog");
      if (logSh && logSh.getLastRow() >= 2) {
        const digits = String(phoneE164 || phone || "").replace(/\D/g, "").slice(-10);
        const lastRow = logSh.getLastRow();
        const startRow = Math.max(2, lastRow - N + 1);
        const rows = logSh.getRange(startRow, 1, lastRow, 5).getValues();
        for (let i = rows.length - 1; i >= 0; i--) {
          const toCol = String(rows[i][1] || "").replace(/\D/g, "").slice(-10);
          if (toCol && toCol === digits) {
            out.recentDevLogs.unshift({ ts: rows[i][0], to: rows[i][1], msg: rows[i][2], status: rows[i][3], extra: rows[i][4] });
          }
        }
        if (out.recentDevLogs.length > N) out.recentDevLogs = out.recentDevLogs.slice(-N);
      }
    } catch (_) {}

    return out;
  }

  function buildTestReport(results) {
    const lines = [];
    lines.push("========== BATCH TEST REPORT " + new Date().toISOString() + " ==========");
    if (!results || !results.length) {
      lines.push("(no results)");
      return lines.join("\n");
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push("");
      lines.push("--- Case " + (i + 1) + ": " + (r.name || "Unnamed") + " ---");
      lines.push("Input: From=" + (r.from || "") + " Body=" + (r.body || ""));
      const markers = (r.logMarkers || []).slice(-20);
      if (markers.length) {
        lines.push("Markers: " + markers.join(" | "));
      }
      if (r.snapshot) {
        if (r.snapshot.directoryRow && Object.keys(r.snapshot.directoryRow).length) {
          lines.push("Dir: " + JSON.stringify(r.snapshot.directoryRow));
        }
        if (r.snapshot.ctx && Object.keys(r.snapshot.ctx).length) {
          lines.push("Ctx: " + JSON.stringify(r.snapshot.ctx));
        }
        if (r.snapshot.workItem) {
          lines.push("WI: " + JSON.stringify(r.snapshot.workItem));
        }
        if (r.snapshot.recentDevLogs && r.snapshot.recentDevLogs.length) {
          const lastLogs = r.snapshot.recentDevLogs.slice(-8);
          lastLogs.forEach(function (log) {
            lines.push("  Log: " + (log.status || "") + " " + (log.msg ? String(log.msg).slice(0, 40) : ""));
          });
        }
      }
    }
    lines.push("");
    lines.push("========== END REPORT ==========");
    return lines.join("\n");
  }

  function resetTestState(phoneE164) {
    const phone = (typeof normalizePhone_ === "function") ? normalizePhone_(phoneE164) : String(phoneE164 || "").trim();
    const allowed = TEST_ALLOWLIST_.some(function (p) {
      const n = (typeof normalizePhone_ === "function") ? normalizePhone_(p) : p;
      return n === phone || String(p || "").replace(/\D/g, "").slice(-10) === String(phone || "").replace(/\D/g, "").slice(-10);
    });
    if (!allowed) return false;
    try {
      const dir = getSheet_(DIRECTORY_SHEET_NAME);
      const dirRow = (typeof findDirectoryRowByPhone_ === "function") ? findDirectoryRowByPhone_(dir, phone) : 0;
      if (dirRow > 0) {
        dalWithLock_("TEST_RESET_DIR", function () {
          dalSetPendingIssueNoLock_(dir, dirRow, "");
          try { logDevSms_(phone, "", "ISSUE_WRITE site=[TEST_RESET_DIR] val=[CLEAR_TEST]"); } catch (_) {}
          dalSetPendingUnitNoLock_(dir, dirRow, "");
          dalSetPendingRowNoLock_(dir, dirRow, 0);
          dalSetPendingStageNoLock_(dir, dirRow, "");
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE TEST_RESET_DIR row=" + dirRow); } catch (_) {}
        });
      }
      if (typeof ctxUpsert_ === "function") {
        ctxUpsert_(phone, { pendingExpected: "" }, "TEST_RESET");
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function runBatchTests() {
    const RESET_BEFORE = true;
    const testPhone = "+9084330005";
    const allowed = TEST_ALLOWLIST_.some(function (p) {
      const n = (typeof normalizePhone_ === "function") ? normalizePhone_(p) : p;
      const ph = (typeof normalizePhone_ === "function") ? normalizePhone_(testPhone) : testPhone;
      return n === ph || String(p || "").replace(/\D/g, "").slice(-10) === String(ph || "").replace(/\D/g, "").slice(-10);
    });
    if (!allowed) {
      Logger.log("runBatchTests: abort — phone " + testPhone + " not in TEST_ALLOWLIST_");
      return "ABORT: phone not in allowlist";
    }
    if (RESET_BEFORE) {
      resetTestState(testPhone);
    }

    const cases = [
      { name: "NEW issue only", from: "+9084330005", body: "sink is leaking", mode: "TENANT" },
      { name: "PROPERTY answer", from: "+9084330005", body: "the grand at penn", mode: "TENANT" },
      { name: "UNIT answer", from: "+9084330005", body: "201", mode: "TENANT" },
      { name: "SCHEDULE answer", from: "+9084330005", body: "tomorrow morning", mode: "TENANT" },
      { name: "Greeting (no ticket)", from: "+9084330005", body: "hey", mode: "TENANT" }
    ];

    const results = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const ev = makeFakeTwilioEvent(c.from, c.body, c.mode);
      try {
        handleSmsRouter_(ev);
      } catch (err) {
        try { logDevSms_(c.from, c.body, "BATCH_TEST_ERR " + String(err && err.message ? err.message : err)); } catch (_) {}
      }
      try { flushDevSmsLogs_(); } catch (_) {}
      const snap = snapshotState(c.from);
      const markers = (snap.recentDevLogs || []).map(function (l) { return l.status; }).filter(Boolean);
      results.push({ name: c.name, from: c.from, body: c.body, snapshot: snap, logMarkers: markers });
    }

    const report = buildTestReport(results);
    Logger.log(report);
    return report;
  }

  function pickServerText(resp) {
    if (!resp) return "";
    if (typeof resp === "string") return resp;
    if (resp.message) return resp.message;
    if (resp.twiml) {
      // Extract from XML if needed
      const m = (resp.twiml || "").match(/<Message[^>]*>([\s\S]*?)<\/Message>/);
      return m && m[1] ? m[1].trim() : "";
    }
    return "";
  }

  function emuPing() {
    console.log("EMU_PING hit " + new Date().toISOString());
    return "pong " + new Date().toISOString();
  }

  