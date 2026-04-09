/**
 * PROPERTY_SCHEDULE_ENGINE.gs — Propera Layer 9 (Property + Schedule)
 *
 * OWNS:
 *   - Execution sheet/ss caches (read-only handle cache per webhook)
 *   - Property resolution (free text, variants, Levenshtein, menus)
 *   - PropertyPolicy (ppGet), schedule validation, finalize/schedule tenant outcomes
 *   - Ticket log pipeline entry (processTicket_) — deterministic sheet writes only
 *   - smartExtract_ and location/unit inference helpers
 *
 * DOES NOT OWN (never add these here):
 *   - COL / global sheet constants (live in PROPERA MAIN.gs)
 *   - Template rendering or Twilio send (MESSAGING_ENGINE.gs)
 *   - Gateway/router/core orchestration
 *
 * ENTRY POINTS:
 *   - processTicket_() — append ticket row from normalized payload
 *   - smartExtract_() — OpenAI structured extraction for maintenance triage
 *   - resolvePropertyFromFreeText_() — match tenant text to active property
 *
 * DEPENDENCIES (reads from):
 *   - PROPERA MAIN.gs — COL, SHEET_NAME, props, getSheet_, normalizePhone_, etc.
 *   - TICKET_FINALIZE_ENGINE / DIRECTORY_SESSION_DAL / AI_MEDIA_TRANSPORT as invoked
 *
 * FUTURE MIGRATION NOTE:
 *   - Becomes property-resolution + scheduling microservice; sheet I/O replaced via DAL
 *
 * SECTIONS IN THIS FILE:
 *   1. Sheet handle cache
 *   2. Active properties + property text resolution
 *   3. PropertyPolicy + schedule finalize helpers
 *   4. Ticket pipeline + smart extract + location/unit inference
 */


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

  /**
   * Short operator-style property list for asks (no numbered IVR menu).
   * Uses same property order as buildPropertyMenuLines_ / getActiveProperties_.
   * @returns {{ line: string, labels: string[] }}
   */
  function buildPropertyConversationalOptions_() {
    var out = { line: "", labels: [] };
    try {
      if (typeof getActiveProperties_ !== "function") return out;
      var propsList = getActiveProperties_();
      if (!propsList || !propsList.length) return out;
      var labels = [];
      for (var i = 0; i < propsList.length; i++) {
        var p = propsList[i] || {};
        var code = String(p.code || "").trim();
        var name = String(p.name || "").trim();
        var shortLabel = code;
        if (name) {
          var stripped = name.replace(/^the\s+grand\s+at\s+/i, "").trim();
          if (stripped) shortLabel = stripped;
          else shortLabel = code;
        }
        if (shortLabel) labels.push(String(shortLabel));
      }
      out.labels = labels;
      if (!labels.length) return out;
      if (labels.length === 1) {
        out.line = labels[0];
        return out;
      }
      if (labels.length === 2) {
        out.line = labels[0] + " or " + labels[1];
        return out;
      }
      out.line = labels.slice(0, -1).join(", ") + ", or " + labels[labels.length - 1];
      return out;
    } catch (_) {
      return out;
    }
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
   * PropertyPolicy lookup: match Property + PolicyKey, coerce Value by Type column.
   */
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

  /** JS getDay(): 0=Sun, 6=Sat. Honors SCHED_SAT_ALLOWED / SCHED_SUN_ALLOWED + GLOBAL; legacy SCHED_ALLOW_WEEKENDS = both days. */
  function validateSchedWeekendAllowed_(propCode, jsDay) {
    var legacy = !!ppGet_(propCode, "SCHED_ALLOW_WEEKENDS", false);
    if (legacy) return true;
    if (jsDay === 6) return !!ppGet_(propCode, "SCHED_SAT_ALLOWED", false);
    if (jsDay === 0) return !!ppGet_(propCode, "SCHED_SUN_ALLOWED", false);
    return true;
  }

  /** Validate schedule against PropertyPolicy. sched: { date?, startHour?, endHour? }. Returns {ok:true} or {ok:false, key, vars}. */
  function validateSchedPolicy_(propCode, sched, now) {
    var earliest = ppGet_(propCode, "SCHED_EARLIEST_HOUR", 9);
    var latest   = ppGet_(propCode, "SCHED_LATEST_HOUR", 18);
    var allowWkndLegacy = !!ppGet_(propCode, "SCHED_ALLOW_WEEKENDS", false);
    var satAllowedPol = !!ppGet_(propCode, "SCHED_SAT_ALLOWED", false);
    var sunAllowedPol = !!ppGet_(propCode, "SCHED_SUN_ALLOWED", false);
    var leadHrs  = ppGet_(propCode, "SCHED_MIN_LEAD_HOURS", 12);
    var maxDays  = ppGet_(propCode, "SCHED_MAX_DAYS_OUT", 14);

    var vars = {
      earliestHour: earliest,
      latestHour: latest,
      allowWeekends: allowWkndLegacy,
      schedSatAllowed: satAllowedPol,
      schedSunAllowed: sunAllowedPol,
      minLeadHours: leadHrs,
      maxDaysOut: maxDays
    };

    var targetDate = (sched && sched.date) ? new Date(sched.date) : null;
    var latestEff = latest;
    if (targetDate && !isNaN(targetDate.getTime())) {
      var day = targetDate.getDay();
      var isWknd = (day === 0 || day === 6);
      if (isWknd && !validateSchedWeekendAllowed_(propCode, day)) {
        return { ok: false, key: "SCHED_REJECT_WEEKEND", vars: vars };
      }

      if (day === 6) {
        var satCap = Number(ppGet_(propCode, "SCHED_SAT_LATEST_HOUR", NaN));
        if (isFinite(satCap)) latestEff = Math.min(Number(latest), satCap);
      }

      var deltaMs = targetDate.getTime() - now.getTime();
      if (deltaMs < leadHrs * 3600 * 1000) return { ok: false, key: "SCHED_REJECT_TOO_SOON", vars: vars };
      if (deltaMs > maxDays * 86400 * 1000) return { ok: false, key: "SCHED_REJECT_TOO_FAR", vars: vars };
    }

    var hStart = (sched && isFinite(Number(sched.startHour))) ? Number(sched.startHour) : null;
    var hEnd   = (sched && isFinite(Number(sched.endHour))) ? Number(sched.endHour) : null;

    if (hStart != null && hStart < earliest) return { ok: false, key: "SCHED_REJECT_HOURS", vars: vars };
    if (hEnd != null && hEnd > latestEff) return { ok: false, key: "SCHED_REJECT_HOURS", vars: vars };

    return { ok: true };
  }

  /**
   * Revalidate a stored/captured preferred window (label or raw) against PropertyPolicy before commit.
   * Uses parsePreferredWindowShared_ + validateSchedPolicy_. Logs SCHED_POLICY_RECHECK_* for tests.
   * @returns {{ok:boolean, verdict:object, label:string}}
   */
  function schedPolicyRecheckWindowFromText_(phone, propCode, windowText, now) {
    var raw = String(windowText || "").trim();
    var out = { ok: true, verdict: { ok: true }, label: raw };
    if (!raw) return out;
    var when = (now instanceof Date && isFinite(now.getTime())) ? now : new Date();
    try {
      logDevSms_(phone || "", "", "SCHED_POLICY_RECHECK_START label=[" + raw.slice(0, 100) + "]");
    } catch (_) {}
    var stageDay = "Today";
    try {
      if (typeof inferStageDayFromText_ === "function") {
        var inf = inferStageDayFromText_(raw);
        if (inf) stageDay = inf;
      }
    } catch (_) {}
    var sched = { label: raw };
    var d = null;
    try {
      if (typeof parsePreferredWindowShared_ === "function") {
        d = parsePreferredWindowShared_(raw, stageDay);
        if (!d || (!d.start && !d.end && !(d.label && String(d.label).trim()))) {
          d = parsePreferredWindowShared_(raw, null);
        }
      }
    } catch (_) {}
    if (d) {
      if (d.start instanceof Date && isFinite(d.start.getTime())) {
        sched.date = d.start;
        sched.startHour = d.start.getHours();
      }
      if (d.end instanceof Date && isFinite(d.end.getTime())) {
        sched.date = sched.date || d.end;
        sched.endHour = d.end.getHours();
      }
      if (d.label) out.label = String(d.label || "").trim() || out.label;
    }
    var p = String(propCode || "").trim().toUpperCase() || "GLOBAL";
    var verdict = { ok: true };
    try {
      verdict = (typeof validateSchedPolicy_ === "function") ? validateSchedPolicy_(p, sched, when) : { ok: true };
    } catch (ve) {
      try {
        logDevSms_(phone || "", "", "SCHED_POLICY_RECHECK_VALIDATE_ERR prop=[" + p + "] err=[" + String(ve && ve.message ? ve.message : ve).slice(0, 200) + "]");
      } catch (_) {}
      verdict = { ok: true };
    }
    out.verdict = verdict;
    out.ok = !!(verdict && verdict.ok);
    if (out.ok) {
      try { logDevSms_(phone || "", "", "SCHED_POLICY_RECHECK_PASS policy=[PropertyPolicy] prop=[" + p + "]"); } catch (_) {}
    } else {
      try {
        var vk = String((verdict && verdict.key) || "").trim();
        var vars = (verdict && verdict.vars) ? verdict.vars : {};
        var allowed = "earliestHour=" + String(vars.earliestHour != null ? vars.earliestHour : "") +
          " latestHour=" + String(vars.latestHour != null ? vars.latestHour : "") +
          " minLeadHrs=" + String(vars.minLeadHours != null ? vars.minLeadHours : "") +
          " maxDays=" + String(vars.maxDaysOut != null ? vars.maxDaysOut : "") +
          " wkndLegacy=" + String(vars.allowWeekends ? 1 : 0) +
          " sat=" + String(vars.schedSatAllowed ? 1 : 0) +
          " sun=" + String(vars.schedSunAllowed ? 1 : 0);
        logDevSms_(phone || "", "", "SCHED_POLICY_RECHECK_BLOCK reason=[" + vk + "] allowed=[" + allowed + "]");
      } catch (le) {
        try {
          logDevSms_(phone || "", "", "SCHED_POLICY_RECHECK_BLOCK_LOG_ERR err=[" + String(le && le.message ? le.message : le).slice(0, 120) + "]");
        } catch (_) {}
      }
    }
    return out;
  }

  /**
   * Schedule fast-path tenant text: same contract as other tenant outbound — dispatchTenantIntent_ (explicit target + Outgate only).
   * @returns {boolean} true if Outgate dispatch succeeded
   */
  function scheduleFastPathSendToTenant_(e, phone, bodyTrim, text, tag, channel, langOpt) {
    try {
      if (typeof allowOptOutBypass_ === "function") allowOptOutBypass_(phone, 10);
    } catch (_) {}
    var msg = String(text || "").trim();
    if (!msg || !phone) return false;
    var ch = String(channel || "SMS").trim().toUpperCase();
    if (ch !== "WA" && ch !== "TELEGRAM") ch = "SMS";
    var L = String(langOpt != null && String(langOpt).trim() ? langOpt : "en").toLowerCase();
    var intent = {
      intentType: "CORE_TEXT_FASTPATH",
      recipientType: "TENANT",
      recipientRef: phone,
      channel: ch,
      lang: L,
      deliveryPolicy: "NO_HEADER",
      preRenderedBody: msg,
      vars: {},
      meta: { source: "SCHEDULE_FASTPATH_TENANT", stage: "SCHEDULE", flow: String(tag || "SCHEDULE_FASTPATH") }
    };
    try {
      var _d = (typeof dispatchTenantIntent_ === "function") ? dispatchTenantIntent_(e, phone, bodyTrim, intent) : { ok: false };
      return !!(_d && _d.ok);
    } catch (_) {
      return false;
    }
  }

  /**
   * Tenant messaging after finalize when multiple real tickets were created (split commit).
   * @returns {boolean} true if this handled all post-finalize messaging (caller should return).
   */
  function emitSplitFinalizeDraftTenantMessages_(e, phone, bodyTrim, sheet, dir, dirRow, lang, baseVars, result, issue, unit, propName, outboundChannel, fastReplyCtx) {
    if (!result || !result.splitTicketCommit || !(result.splitCount >= 2)) return false;
    var ch = String(outboundChannel || "SMS").trim().toUpperCase();
    if (ch !== "WA" && ch !== "TELEGRAM") ch = "SMS";
    var scheduleLabelSplit = "";
    try {
      var _lr = Number(result.loggedRow) || 0;
      if (_lr >= 2 && sheet && typeof COL !== "undefined" && COL.PREF_WINDOW) {
        scheduleLabelSplit = String(sheet.getRange(_lr, COL.PREF_WINDOW).getValue() || "").trim();
        if (scheduleLabelSplit && typeof parsePreferredWindowShared_ === "function") {
          var _pws = parsePreferredWindowShared_(scheduleLabelSplit, null);
          if (_pws && _pws.label) scheduleLabelSplit = String(_pws.label || "").trim();
        }
      }
    } catch (_) {}
    var tids = Array.isArray(result.ticketIds) ? result.ticketIds.filter(function (x) { return String(x || "").trim(); }) : [];
    var ticketId1 = String(tids[0] || "").trim();
    var ticketId2 = String(tids[1] || "").trim();
    var ticketIdsJoined = tids.join(", ");
    var ticketIdsLines = tids.map(function (t) { return "Ticket ID: " + String(t || "").trim(); }).filter(function (line) { return line.length > 12; }).join("\n");
    var splitVars = Object.assign({}, baseVars || {}, {
      count: String(result.splitCount),
      issueCount: String(result.splitCount),
      itemCount: String(result.splitCount),
      itemsText: String(result.itemsText || ""),
      ticketIds: ticketIdsJoined,
      ticketId: ticketId1,
      ticketId1: ticketId1,
      ticketId2: ticketId2,
      secondTicketId: ticketId2,
      ticketIdsLine: ticketIdsLines,
      ticketIdsLines: ticketIdsLines,
      label: scheduleLabelSplit,
      scheduleLabel: scheduleLabelSplit,
      preferredWindow: scheduleLabelSplit,
      scheduleWindow: scheduleLabelSplit,
      when: scheduleLabelSplit,
      window: scheduleLabelSplit,
      issuesSummary: String(result.itemsText || "").trim(),
      issueSummary: String(result.itemsText || "").trim()
    });

    // Phase 8 — deterministic outbound composition for known multi-event combo.
    // Kill switch: CIG_COMPOSE_ENABLED (default true; set to 0/false/off/no to disable).
    var composeEnabled = true;
    try {
      var _cpProps = PropertiesService.getScriptProperties();
      var _kill = String((_cpProps && typeof _cpProps.getProperty === "function") ? _cpProps.getProperty("CIG_COMPOSE_ENABLED") : "").trim().toLowerCase();
      if (_kill === "0" || _kill === "false" || _kill === "off" || _kill === "no") composeEnabled = false;
    } catch (_) {}
    var suppressScheduleAck = !!(fastReplyCtx && fastReplyCtx.sent && String(fastReplyCtx.type || "") === "SCHEDULE_RECORDED_ACK");

    function scheduledEndOk_() {
      try {
        if (!(result && result.loggedRow != null && sheet && typeof COL !== "undefined" && COL)) return false;
        var lr = Number(result.loggedRow) || 0;
        if (lr < 2) return false;
        var _schedCol = (typeof COL.SCHEDULED_END_AT !== "undefined" && COL.SCHEDULED_END_AT) ? Number(COL.SCHEDULED_END_AT) : 0;
        if (!_schedCol) return false;
        var scheduledEndVal = sheet.getRange(lr, _schedCol).getValue();
        return (scheduledEndVal instanceof Date && isFinite(scheduledEndVal.getTime()));
      } catch (_) { return false; }
    }

    // Detect whether we are in the "CONFIRM_RECORDED_SCHEDULE" happy path.
    var wouldConfirmRecordedSchedule = composeEnabled && (result.nextStage === "SCHEDULE") && !suppressScheduleAck && scheduledEndOk_() && scheduleLabelSplit;
    if (!wouldConfirmRecordedSchedule) {
      var _ogSp = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({
        intentType: "MULTI_SPLIT_TICKETS_CREATED",
        recipientType: "TENANT",
        recipientRef: phone,
        lang: lang,
        channel: ch,
        deliveryPolicy: "NO_HEADER",
        vars: splitVars,
        meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" }
      }) : { ok: false };
      if (!(_ogSp && _ogSp.ok) && typeof renderTenantKey_ === "function") {
        var fbMsg = renderTenantKey_("MULTI_CREATED_CONFIRM", lang, splitVars);
        if (fbMsg && e && typeof scheduleFastPathSendToTenant_ === "function") {
          scheduleFastPathSendToTenant_(e, phone, bodyTrim, fbMsg, "MULTI_SPLIT_FB", ch, lang);
        } else if (fbMsg && typeof replyNoHeader_ === "function") {
          replyNoHeader_(fbMsg);
        }
      }
    }

    try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
    if (result.nextStage === "SCHEDULE") {
      // If we are composing, suppress the individual CONFIRM_RECORDED_SCHEDULE intent emission.
      if (wouldConfirmRecordedSchedule) {
        var n = Number(result.splitCount) || 2;
        var composedRes = properaComposeDeterministic_([
          { intentType: "MULTI_SPLIT_TICKETS_CREATED", vars: { count: String(n), scheduleLabel: String(scheduleLabelSplit || "").trim() } },
          { intentType: "CONFIRM_RECORDED_SCHEDULE", vars: { scheduleLabel: String(scheduleLabelSplit || "").trim() } }
        ]);
        var polishRes = (!composedRes || !composedRes.matched) && (typeof properaComposeAiPolish_ === "function")
          ? properaComposeAiPolish_([
              { intentType: "MULTI_SPLIT_TICKETS_CREATED", vars: { count: String(n), scheduleLabel: String(scheduleLabelSplit || "").trim() } },
              { intentType: "CONFIRM_RECORDED_SCHEDULE", vars: { scheduleLabel: String(scheduleLabelSplit || "").trim() } }
            ], { schedule: String(scheduleLabelSplit || "").trim(), count: n })
          : null;
        var composed =
          composedRes && composedRes.matched && composedRes.composed
            ? String(composedRes.composed || "")
            : (polishRes && polishRes.matched && polishRes.composed)
              ? String(polishRes.composed || "")
              : ("We've created " + n + " requests and recorded your preferred window for " + String(scheduleLabelSplit || "").trim() + ". We'll be in touch.");
        if (typeof dispatchOutboundIntent_ === "function") {
          dispatchOutboundIntent_({
            intentType: "CORE_TEXT_REPLY",
            templateKey: "CORE_TEXT_REPLY",
            recipientType: "TENANT",
            recipientRef: phone,
            lang: lang,
            channel: ch,
            deliveryPolicy: "NO_HEADER",
            preRenderedBody: composed,
            vars: {},
            meta: { source: "CIG_COMPOSE", stage: "MULTI_SPLIT+CONFIRM", flow: "MAINTENANCE_INTAKE" }
          });
        } else if (typeof replyNoHeader_ === "function") {
          replyNoHeader_(composed);
        }
        finalizeDraftScheduleConfirmOrAskTenant_(phone, sheet, dir, dirRow, lang, baseVars, result, String(result.itemsText || issue || ""), unit, propName, ch, fastReplyCtx, { suppressRecordedSchedule: true });
      } else {
        finalizeDraftScheduleConfirmOrAskTenant_(phone, sheet, dir, dirRow, lang, baseVars, result, String(result.itemsText || issue || ""), unit, propName, ch, fastReplyCtx);
      }
    } else if (result.nextStage === "EMERGENCY_DONE") {
      var eTid = String(result.ticketId || "").trim();
      var _ogE = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_TENANT_ACK", templateKey: "EMERGENCY_TENANT_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: ch, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: eTid }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogE && _ogE.ok) && typeof renderTenantKey_ === "function") {
        var emMsg = renderTenantKey_("EMERGENCY_TENANT_ACK", lang, Object.assign({}, baseVars, { ticketId: eTid }));
        if (emMsg && e && typeof scheduleFastPathSendToTenant_ === "function") {
          scheduleFastPathSendToTenant_(e, phone, bodyTrim, emMsg, "MULTI_SPLIT_EMER_FB", ch, lang);
        } else if (emMsg && typeof replyNoHeader_ === "function") {
          replyNoHeader_(emMsg);
        }
      }
    }
    try { logDevSms_(phone, "", "MULTI_ISSUE_OUTBOUND_SENT count=" + String(result.splitCount)); } catch (_) {}
    return true;
  }

  /**
   * After finalizeDraftAndCreateTicket_ succeeds with nextStage SCHEDULE: if PreferredWindow / ScheduledEndAt
   * already capture a usable window, send CONFIRM_RECORDED_SCHEDULE; otherwise ASK_SCHEDULE.
   * Shared by handleSmsCore_ FINALIZE_DRAFT and applyFinalizeDraftResultOutcomesForRouter_ (router fast path).
   */
  function finalizeDraftScheduleConfirmOrAskTenant_(phone, sheet, dir, dirRow, lang, baseVars, result, issue, unit, propName, outboundChannel, fastReplyCtx, cigComposeOpts) {
    var ch = String(outboundChannel || "SMS").trim().toUpperCase();
    if (ch !== "WA" && ch !== "TELEGRAM") ch = "SMS";
    var suppressRecordedSchedule = !!(cigComposeOpts && cigComposeOpts.suppressRecordedSchedule);
    /** Core passes replyNoHeader from buildCoreReplyFns_; else sendRouterSms_ so dev TwiML outbox still fills. */
    var _schedOutFallback_ = function (text, tag) {
      var t = String(text || "").trim();
      if (!t) return;
      var tg = String(tag || "FINALIZE_SCHED_FB").trim() || "FINALIZE_SCHED_FB";
      try {
        if (cigComposeOpts && typeof cigComposeOpts.replyNoHeader === "function") {
          cigComposeOpts.replyNoHeader(t);
          return;
        }
      } catch (_) {}
      try {
        if (typeof sendRouterSms_ === "function") {
          sendRouterSms_(phone, t, tg, ch, { fromOutgate: true });
        }
      } catch (_) {}
    };
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

    try {
      if (result && result.nextStage === "SCHEDULE" && result.loggedRow != null) {
        var loggedRow = Number(result.loggedRow) || 0;
        if (loggedRow >= 2 && sheet && typeof COL !== "undefined" && COL.PREF_WINDOW) {
          var preferredWindowRaw = String(sheet.getRange(loggedRow, COL.PREF_WINDOW).getValue() || "").trim();
          var _schedCol = (typeof COL.SCHEDULED_END_AT !== "undefined" && COL.SCHEDULED_END_AT) ? Number(COL.SCHEDULED_END_AT) : 0;
          var scheduledEndVal = (_schedCol > 0) ? sheet.getRange(loggedRow, _schedCol).getValue() : null;
          var hasValidSchedule = (scheduledEndVal instanceof Date && isFinite(scheduledEndVal.getTime()));
          var scheduleLabel = "";

          if (!hasValidSchedule && preferredWindowRaw && typeof parsePreferredWindowShared_ === "function") {
            try {
              var _pp = parsePreferredWindowShared_(preferredWindowRaw, null);
              if (_pp) {
                var _lbl = _pp.label ? String(_pp.label || "").trim() : "";
                var _endOk = _pp.end instanceof Date && isFinite(_pp.end.getTime());
                var _startOk = _pp.start instanceof Date && isFinite(_pp.start.getTime());
                if (_endOk || _startOk || (_lbl && _lbl.length >= 2)) {
                  hasValidSchedule = true;
                  scheduleLabel = _lbl || preferredWindowRaw;
                }
              }
            } catch (_) {}
          }

          scheduleLabel = scheduleLabel || preferredWindowRaw;
          if (hasValidSchedule && scheduleLabel) {
            var propCodeF = "GLOBAL";
            try {
              if (typeof COL !== "undefined" && COL.PROPERTY && loggedRow >= 2) {
                propCodeF = String(sheet.getRange(loggedRow, COL.PROPERTY).getValue() || "").trim().toUpperCase() || "GLOBAL";
              }
            } catch (_) {}
            if (typeof schedPolicyRecheckWindowFromText_ === "function") {
              var prf = schedPolicyRecheckWindowFromText_(phone, propCodeF, scheduleLabel || preferredWindowRaw, new Date());
              if (prf && !prf.ok) {
                var vkf = String(prf.verdict && prf.verdict.key ? prf.verdict.key : "").trim() || "SCHED_REJECT_WEEKEND";
                var vvf = (prf.verdict && prf.verdict.vars) ? prf.verdict.vars : {};
                try { logDevSms_(phone, "", "SCHED_POLICY_RECHECK_REPLY sent=1 path=[post_finalize_confirm] key=" + vkf); } catch (_) {}
                try {
                  withWriteLock_("SCHED_POLICY_CLEAR_PREF", function () {
                    sheet.getRange(loggedRow, COL.PREF_WINDOW).clearContent();
                    if (_schedCol > 0) sheet.getRange(loggedRow, _schedCol).clearContent();
                    sheet.getRange(loggedRow, COL.LAST_UPDATE).setValue(new Date());
                  });
                } catch (_) {}
                try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
                try {
                  if (typeof ctxUpsert_ === "function") {
                    ctxUpsert_(phone, { pendingExpected: "SCHEDULE", pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000), lastIntent: "MAINT" }, "SCHED_POLICY_POST_FINALIZE_BLOCK");
                  }
                } catch (_) {}
                var _ogSchedRe = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: vkf, templateKey: vkf, recipientType: "TENANT", recipientRef: phone, lang: lang, channel: ch, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, vvf), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
                if (!(_ogSchedRe && _ogSchedRe.ok)) {
                  try {
                    _schedOutFallback_(renderTenantKey_(vkf, lang, Object.assign({}, baseVars, vvf)), "SCHED_POLICY_POST_FINALIZE_FB");
                  } catch (_) {}
                  try { logDevSms_(phone, "", "FINALIZE_SCHED_FALLBACK path=[post_finalize_policy] key=" + String(vkf || "")); } catch (_) {}
                }
                return;
              }
            }
            var ticketId = String(result.ticketId || "").trim();
            var _confirmVars = Object.assign({}, baseVars, {
              label: scheduleLabel,
              scheduleLabel: scheduleLabel,
              ticketId: ticketId,
              issueSummary: issueShort,
              issuesSummary: issueShort,
              preferredWindow: scheduleLabel,
              scheduleWindow: scheduleLabel,
              when: scheduleLabel,
              window: scheduleLabel
            });
            var _suppressScheduleAck = !!(fastReplyCtx && fastReplyCtx.sent && String(fastReplyCtx.type || "") === "SCHEDULE_RECORDED_ACK");
            if (_suppressScheduleAck || suppressRecordedSchedule) {
              try { logDevSms_(phone, "", "FAST_REPLY_DUP_SUPPRESS bucket=[SCHEDULE_RECORDED_ACK] source=[" + String(fastReplyCtx.source || "") + "] branch=[CONFIRM_RECORDED_SCHEDULE]"); } catch (_) {}
            } else {
              try { logDevSms_(phone, "", "FAST_REPLY_DUP_ALLOW bucket=[SCHEDULE_RECORDED_ACK] branch=[CONFIRM_RECORDED_SCHEDULE]"); } catch (_) {}
              var _ogConf = (typeof dispatchOutboundIntent_ === "function")
                ? dispatchOutboundIntent_({ intentType: "CONFIRM_RECORDED_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: ch, deliveryPolicy: "NO_HEADER", vars: _confirmVars, meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } })
                : { ok: false };
              if (!(_ogConf && _ogConf.ok)) {
                try {
                  var _fbConf = (typeof renderTenantKey_ === "function") ? renderTenantKey_("CONF_WINDOW_SET", lang, _confirmVars) : "";
                  _schedOutFallback_(_fbConf, "CONFIRM_RECORDED_SCHEDULE_FB");
                } catch (_) {}
                try { logDevSms_(phone, "", "FINALIZE_SCHED_FALLBACK path=[CONFIRM_RECORDED_SCHEDULE]"); } catch (_) {}
              }
            }

            try { if (typeof ctxUpsert_ === "function") ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "SCHEDULE_RESOLVED"); } catch (_) {}
            try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
            try { logDevSms_(phone, "", "FINALIZE_SCHED_OUT confirm=1 label=[" + String(scheduleLabel).slice(0, 80) + "]"); } catch (_) {}
            return;
          }
        }
      }
    } catch (_) {}

    try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
    try { logDevSms_(phone, "", "FAST_REPLY_DUP_ALLOW bucket=[ASK_NEXT_SLOT] branch=[TICKET_CREATED_ASK_SCHEDULE]"); } catch (_) {}
    var _ogAskSched = (typeof dispatchOutboundIntent_ === "function")
      ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: ch, deliveryPolicy: "NO_HEADER", vars: vars, meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } })
      : { ok: false };
    if (!(_ogAskSched && _ogAskSched.ok)) {
      try {
        var _fbAsk = (typeof renderTenantKey_ === "function") ? renderTenantKey_("ASK_WINDOW_SIMPLE", lang, vars) : "";
        _schedOutFallback_(_fbAsk, "TICKET_CREATED_ASK_SCHEDULE_FB");
      } catch (_) {}
      try { logDevSms_(phone, "", "FINALIZE_SCHED_FALLBACK path=[TICKET_CREATED_ASK_SCHEDULE]"); } catch (_) {}
    }
  }

  /**
   * Post-finalize tenant outcomes for Phase 3 router UNIT→FINALIZE_DRAFT fast path.
   * Mirrors handleSmsCore_ FINALIZE_DRAFT handling after finalizeDraftAndCreateTicket_ returns (same intents / meta).
   * Uses scheduleFastPathSendToTenant_ where template dispatch fails (same dispatchTenantIntent_ contract as core; no direct SMS bypass).
   */
  function applyFinalizeDraftResultOutcomesForRouter_(e, phone, bodyTrim, sheet, dir, dirRow, lang, baseVars, result, preIssue, preUnit, prePropName, outboundChannel, fastReplyCtx) {
    var s = null;
    try { s = (typeof sessionGet_ === "function") ? sessionGet_(phone) : null; } catch (_) {}
    var unit = preUnit;
    var issue = preIssue;
    var propName = prePropName;
    var ch = String(outboundChannel || "SMS").trim().toUpperCase();
    if (ch !== "WA" && ch !== "TELEGRAM") ch = "SMS";

    if (!result || !result.ok) {
      try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_SKIP reason=[" + String((result && result.reason) || "") + "]"); } catch (_) {}
      try { logDevSms_(phone, "", "FAST_REPLY_DUP_ALLOW bucket=[ASK_NEXT_SLOT] branch=[FINALIZE_DRAFT_FAIL_PROMPT]"); } catch (_) {}
      var _ogBad = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: ch, deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      try { recomputeDraftExpected_(dir, dirRow, phone, s); } catch (_) {}
      return;
    }

    if (emitSplitFinalizeDraftTenantMessages_(e, phone, bodyTrim, sheet, dir, dirRow, lang, baseVars, result, issue, unit, propName, ch, fastReplyCtx)) return;

    if (result.multiIssuePending) {
      if (result.nextStage === "SCHEDULE" || result.nextStage === "SCHEDULE_DRAFT_MULTI") {
        var combined = (result.summaryMsg && String(result.summaryMsg).trim()) ? String(result.summaryMsg).trim() : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
        try { logDevSms_(phone, combined.slice(0, 120), "MULTI_COMBINED_OUT"); } catch (_) {}
        var _ogC2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: ch, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { summaryText: combined }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogC2 && _ogC2.ok)) scheduleFastPathSendToTenant_(e, phone, bodyTrim, combined, "MULTI_COMBINED_OUT_FB", ch, lang);
        return;
      }
      (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: ch, deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      return;
    }

    if (result.nextStage === "") {
      if (!result.ackOwnedByPolicy) {
        var _suppressCreateAck = !!(fastReplyCtx && fastReplyCtx.sent && String(fastReplyCtx.type || "") === "TICKET_CREATE_ACK");
        if (_suppressCreateAck) {
          try { logDevSms_(phone, "", "FAST_REPLY_DUP_SUPPRESS bucket=[TICKET_CREATE_ACK] source=[" + String(fastReplyCtx.source || "") + "] branch=[TICKET_CREATED_COMMON_AREA]"); } catch (_) {}
        } else {
          try { logDevSms_(phone, "", "FAST_REPLY_DUP_ALLOW bucket=[TICKET_CREATE_ACK] branch=[TICKET_CREATED_COMMON_AREA]"); } catch (_) {}
          (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_COMMON_AREA", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: ch, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: String(result.ticketId || "") }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        }
        try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
      } else {
        try { logDevSms_(phone, "", "ACK_SUPPRESSED_BY_POLICY workItemId=" + (result.createdWi || "") + " rule=" + (result.policyRuleId || "")); } catch (_) {}
      }
      return;
    }

    if (result.nextStage === "EMERGENCY_DONE") {
      var eTid = String(result.ticketId || "").trim();
      try { logDevSms_(phone, "", "FINALIZE_DRAFT_EMERGENCY_DONE tid=" + eTid); } catch (_) {}
      var _ogEt = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_TENANT_ACK", templateKey: "EMERGENCY_TENANT_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: ch, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: eTid }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogEt && _ogEt.ok)) scheduleFastPathSendToTenant_(e, phone, bodyTrim, renderTenantKey_("EMERGENCY_TENANT_ACK", lang, Object.assign({}, baseVars, { ticketId: eTid })), "FAST_CONT_EMERGENCY_ACK_FB", ch, lang);
      return;
    }

    finalizeDraftScheduleConfirmOrAskTenant_(phone, sheet, dir, dirRow, lang, baseVars, result, issue, unit, propName, ch, fastReplyCtx);
  }

  /**
   * Single-ticket SCHEDULE confirm/deny/re-ask — shared by handleSmsCore_ SCHEDULE stage and router Phase 3 fast path.
   * @param {Object} e Inbound envelope (explicit outbound target / dedupe).
   * @returns {null|{handled:boolean,fallbackSms:boolean}} null = not handled (caller continues); handled=true = stop. fallbackSms=true = tenant outbound not delivered after attempted Outgate paths (name retained for logs; no SMS bypass).
   */
  function handleScheduleSingleTicket_(e, sheet, dir, dirRow, phone, activeRow, rawTrim, lang, baseVars, dayWord, now, signals, outboundChannelHint, fastReplyCtx) {
    var ch = "SMS";
    try {
      if (typeof outboundChannelHint !== "undefined" && outboundChannelHint != null && String(outboundChannelHint).trim()) {
        ch = String(outboundChannelHint).trim().toUpperCase();
      } else if (typeof _channel !== "undefined") {
        ch = String(_channel).trim().toUpperCase();
      }
      if (ch !== "WA" && ch !== "TELEGRAM") ch = "SMS";
    } catch (_) { ch = "SMS"; }
    var stageDay = "Today";
    try {
      if (typeof inferStageDayFromText_ === "function") {
        var inferred0 = inferStageDayFromText_(rawTrim, dayWord);
        if (inferred0) stageDay = inferred0;
      }
    } catch (_) {}
    if (!looksLikeWindowReply_(rawTrim, stageDay)) return null;
    const label = windowLabel_(rawTrim, stageDay);
    if (!label) {
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: ch, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_INBOUND_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      var fbAsk = !(_og && _og.ok);
      if (fbAsk) {
        var askBody = (typeof renderTenantKey_ === "function") ? renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars) : "";
        if (askBody) {
          var _askOk = scheduleFastPathSendToTenant_(e, phone, rawTrim, askBody, "TICKET_CREATED_ASK_SCHEDULE_FB", ch, lang);
          fbAsk = !_askOk;
        }
      }
      return { handled: true, fallbackSms: fbAsk };
    }

    var propObj = (typeof dalGetPendingProperty_ === "function") ? dalGetPendingProperty_(dir, dirRow) : {};
    var propCode = String(propObj && propObj.code ? propObj.code : "").trim().toUpperCase() || "GLOBAL";
    var sched = { label: label };
    var d = null;
    if (typeof inferStageDayFromText_ === "function" && typeof parsePreferredWindowShared_ === "function") {
      try {
        var inferred = inferStageDayFromText_(rawTrim, dayWord);
        if (inferred) {
          d = parsePreferredWindowShared_(rawTrim, inferred);
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
      var _ogV = (typeof dispatchOutboundIntent_ === "function" && _vk) ? dispatchOutboundIntent_({ intentType: _vk, templateKey: _vk, recipientType: "TENANT", recipientRef: phone, lang: lang, channel: ch, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, verdict.vars || {}), meta: { source: "HANDLE_INBOUND_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      var fbPol = !(_ogV && _ogV.ok);
      if (fbPol) {
        var _polMsg = (typeof renderTenantKey_ === "function") ? renderTenantKey_(verdict.key, lang, Object.assign({}, baseVars, verdict.vars || {})) : "";
        var _polOk = scheduleFastPathSendToTenant_(e, phone, rawTrim, _polMsg, "SCHED_POLICY_DENY", ch, lang);
        fbPol = !_polOk;
      }
      try { logDevSms_(phone, rawTrim, "SCHED_POLICY_DENY key=[" + verdict.key + "] prop=[" + propCode + "]"); } catch (_) {}
      try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
      try {
        var ctxNow = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
        var wiPick = ctxNow ? (String(ctxNow.pendingWorkItemId || "").trim() || String(ctxNow.activeWorkItemId || "").trim()) : "";
        if (typeof ctxUpsert_ === "function") ctxUpsert_(phone, { pendingWorkItemId: wiPick, pendingExpected: "SCHEDULE", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000) }, "SCHED_POLICY_REJECT");
      } catch (_) {}
      return { handled: true, fallbackSms: fbPol };
    }

    // Durable split identity from created tickets.
    var splitIntakeGroupKey = "";
    try {
      if (typeof COL !== "undefined" && COL.SERVICE_NOTES && activeRow && activeRow >= 2) {
        var snRawActive = String(sheet.getRange(activeRow, COL.SERVICE_NOTES).getValue() || "").trim();
        if (snRawActive) {
          var snObjActive = null;
          try { snObjActive = JSON.parse(snRawActive); } catch (_) {}
          if (snObjActive && snObjActive.intakeGroupKey) splitIntakeGroupKey = String(snObjActive.intakeGroupKey || "").trim();
        }
      }
    } catch (_) {}

    var rowsToSched = [];
    if (splitIntakeGroupKey) {
      try {
        var lastRow = sheet.getLastRow();
        if (lastRow >= 2 && typeof COL !== "undefined" && COL.SERVICE_NOTES) {
          var snVals = sheet.getRange(2, COL.SERVICE_NOTES, lastRow - 1, 1).getValues();
          for (var rsi = 0; rsi < snVals.length; rsi++) {
            var row = rsi + 2;
            var snCell = snVals[rsi] && snVals[rsi][0] != null ? String(snVals[rsi][0] || "").trim() : "";
            if (!snCell) continue;
            // Fast substring gate before JSON parse.
            if (snCell.indexOf(splitIntakeGroupKey) === -1) continue;
            var snObj = null;
            try { snObj = JSON.parse(snCell); } catch (_) {}
            if (snObj && String(snObj.intakeGroupKey || "").trim() === splitIntakeGroupKey) rowsToSched.push(row);
          }
        }
      } catch (_) {}
    }

    // Fallback: legacy phone-scoped cache (optimization only).
    if (!rowsToSched.length) {
      var splitRowsParsed = [];
      try {
        var ssRaw0 = String(CacheService.getScriptCache().get("SPLIT_BUNDLE_ROWS_" + String(phone)) || "").trim();
        if (ssRaw0) {
          var _pr0 = JSON.parse(ssRaw0);
          if (Array.isArray(_pr0)) splitRowsParsed = _pr0;
        }
      } catch (_) {}
      for (var _rsi = 0; _rsi < splitRowsParsed.length; _rsi++) {
        var _rr = parseInt(String(splitRowsParsed[_rsi]), 10) || 0;
        if (_rr >= 2) rowsToSched.push(_rr);
      }
    }

    if (!rowsToSched.length) rowsToSched = [activeRow];

    var primaryRow = rowsToSched[0] || activeRow;
    const ticketId = String(sheet.getRange(primaryRow, COL.TICKET_ID).getValue() || "").trim();
    var issueSummary = "";
    try {
      issueSummary = String(sheet.getRange(primaryRow, COL.MSG).getValue() || "").trim();
      if (issueSummary && typeof normalizeIssueText_ === "function") {
        var norm = normalizeIssueText_(issueSummary);
        if (norm) issueSummary = String(norm).trim();
      }
    } catch (_) {}
    var moreCount = 0;
    try {
      if (typeof getIssueBuffer_ === "function" && dirRow > 0) {
        var buf = getIssueBuffer_(dir, dirRow) || [];
        if (Array.isArray(buf) && buf.length) moreCount = buf.length;
      }
    } catch (_) {}
    var issueLine = issueSummary;
    if (rowsToSched.length >= 2) {
      issueLine = String(rowsToSched.length) + " maintenance requests";
    } else if (issueLine && moreCount > 0) {
      issueLine = issueLine + " (+" + moreCount + " more)";
    }
    var ticketIdsJoined = ticketId;
    try {
      if (rowsToSched.length >= 2) {
        var tidParts = [];
        for (var _tj = 0; _tj < rowsToSched.length; _tj++) {
          var tr = rowsToSched[_tj];
          if (tr >= 2) tidParts.push(String(sheet.getRange(tr, COL.TICKET_ID).getValue() || "").trim());
        }
        ticketIdsJoined = tidParts.filter(Boolean).join(", ");
      }
    } catch (_) {}
    withWriteLock_("SCHED_SET_LABEL", () => {
      if (splitIntakeGroupKey && rowsToSched.length >= 2) {
        try { logDevSms_(phone, rawTrim, "SPLIT_GROUP_SCHEDULE_APPLY groupKey=[" + splitIntakeGroupKey.slice(0, 12) + "] rows=" + rowsToSched.join(",") + " label=[" + String(label || "") + "]"); } catch (_) {}
      }
      for (var _rj = 0; _rj < rowsToSched.length; _rj++) {
        var rRow = rowsToSched[_rj];
        if (!rRow || rRow < 2) continue;
        sheet.getRange(rRow, COL.PREF_WINDOW).setValue(label);
        sheet.getRange(rRow, COL.LAST_UPDATE).setValue(now);
        try {
          if (d && d.end instanceof Date) {
            sheet.getRange(rRow, COL.SCHEDULED_END_AT).setValue(d.end);
          } else {
            sheet.getRange(rRow, COL.SCHEDULED_END_AT).clearContent();
          }
        } catch (_) {}
      }
    });
    for (var _rk = 0; _rk < rowsToSched.length; _rk++) {
      var rSt = rowsToSched[_rk];
      if (rSt >= 2) setStatus_(sheet, rSt, "Scheduled");
    }
    for (var _rw = 0; _rw < rowsToSched.length; _rw++) {
      var rW = rowsToSched[_rw];
      if (!rW || rW < 2) continue;
      var wiIdR = "";
      try { wiIdR = (typeof findWorkItemIdByTicketRow_ === "function") ? findWorkItemIdByTicketRow_(rW) : ""; } catch (_) {}
      if (wiIdR) {
        try {
          workItemUpdate_(wiIdR, { state: "ACTIVE_WORK", substate: "" });
          try { logDevSms_(phone, rawTrim, "WI_UPDATE_SPLIT row=" + rW + " wi=[" + wiIdR + "] state=ACTIVE_WORK"); } catch (_) {}
          if (typeof onWorkItemActiveWork_ === "function") {
            var propCodeRow = String(sheet.getRange(rW, COL.PROPERTY).getValue() || "").trim().toUpperCase();
            onWorkItemActiveWork_(wiIdR, propCodeRow, d && d.end instanceof Date ? { scheduledEndAt: d.end } : {});
          }
        } catch (_) {}
      }
    }
    try {
      logDevSms_(
        phone,
        rawTrim,
        "SCHED_CONFIRM rows=" + rowsToSched.join(",") +
          " tid=[" + ticketIdsJoined + "]" +
          " label=[" + label + "]" +
          " stage=[SCHEDULE]" +
          (rowsToSched.length >= 2 ? " split_bundle=1" : "")
      );
    } catch (_) {}
    const _confirmKey = { urgent: "TICKET_CONFIRM_URGENT", postService: "TICKET_CONFIRM_POST_SERVICE", recurring: "TICKET_CONFIRM_RECURRING", frustrated: "TICKET_CONFIRM_FRUSTRATED" }[(signals && signals.tone) || ""] || "CONF_WINDOW_SET";
    var _confirmVars = Object.assign({}, baseVars, {
      label: label,
      scheduleLabel: label,
      ticketId: ticketIdsJoined,
      issueSummary: issueLine,
      issuesSummary: issueLine,
      preferredWindow: label,
      scheduleWindow: label,
      when: label,
      window: label
    });
    if (_confirmKey !== "CONF_WINDOW_SET") _confirmVars.confirmKey = _confirmKey;
    var _ogConfirm = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({
      intentType: "CONFIRM_RECORDED_SCHEDULE",
      recipientType: "TENANT",
      recipientRef: phone,
      lang: lang,
      channel: ch,
      deliveryPolicy: "NO_HEADER",
      vars: _confirmVars,
      meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" }
    }) : { ok: false };
    var fbConf = !(_ogConfirm && _ogConfirm.ok);
    if (fbConf) {
      var _outMsg = (typeof renderTenantKey_ === "function") ? renderTenantKey_(_confirmKey, lang, _confirmVars) : "";
      try { logDevSms_(phone, _outMsg, "DEBUG_CONF_WINDOW_SET_RENDER"); } catch (_) {}
      var _confOk = scheduleFastPathSendToTenant_(e, phone, rawTrim, _outMsg, "CONFIRM_RECORDED_SCHEDULE", ch, lang);
      fbConf = !_confOk;
    }
    try { CacheService.getScriptCache().remove("SPLIT_BUNDLE_ROWS_" + String(phone)); } catch (_) {}
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "SCHEDULE_RESOLVED"); } catch (_) {}
    try {
      if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") {
        const advanced = advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang);
        if (advanced) {
          try { logDevSms_(phone, "", "QUEUE_DRAIN_ADVANCED tid=[" + (advanced.ticketId || "") + "]"); } catch (_) {}
        }
      }
    } catch (qdErr) {
      try { logDevSms_(phone, "", "QUEUE_DRAIN_ERR " + (qdErr && qdErr.message ? qdErr.message : qdErr)); } catch (_) {}
    }
    return { handled: true, fallbackSms: fbConf };
  }
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
      firstMediaContentType,
      firstMediaSource,
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

      // Propera Compass — Drive-backed inbound attachment (Phase 1). No raw inbound URL fallback (avoids token URLs / unsupported types).
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
          var _declMime = String(firstMediaContentType != null ? firstMediaContentType : "").trim();
          var _srcMedia = String(firstMediaSource != null ? firstMediaSource : "").trim().toLowerCase();
          var saveRes = (typeof saveInboundAttachmentToDrive_ === "function")
            ? saveInboundAttachmentToDrive_(String(firstMediaUrl).trim(), mf, {
                ticketId: safeTicketId || "UNFILED",
                unit: unitForName,
                contextHint: contextHint,
                declaredMime: _declMime,
                mediaSource: _srcMedia
              })
            : { ok: false, err: "no_helper" };
          if (saveRes && saveRes.ok && saveRes.webUrl) {
            attVal = String(saveRes.webUrl || "").trim();
          } else {
            try {
              if (typeof logDevSms_ === "function") {
                logDevSms_(from, "", "ATTACH_SAVE_ROW_SKIP reason=[" + String((saveRes && saveRes.err) || "unknown") + "] (no raw URL fallback)");
              }
            } catch (_) {}
          }
        } catch (_) {
          try {
            if (typeof logDevSms_ === "function") {
              logDevSms_(from, "", "ATTACH_SAVE_ROW_SKIP reason=[exception] (no raw URL fallback)");
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
      if (typeof dispatchOutboundIntent_ === "function") {
        dispatchOutboundIntent_({
          intentType: "CORE_TEXT_REPLY",
          recipientType: "TENANT",
          recipientRef: ONCALL_NUMBER,
          channel: "SMS",
          lang: "en",
          deliveryPolicy: "DIRECT_SEND",
          preRenderedBody: summary,
          vars: {},
          meta: { source: "processTicket_", stage: "ESCALATION", flow: "ONCALL_NOTIFY" }
        });
      }
      try { logDevSms_(from, "", "EMERGENCY_ONCALL_SMS_SENT to=" + String(ONCALL_NUMBER || "").slice(-4)); } catch (_) {}
      if (escCol) {
        withWriteLock_("TICKET_ESCALATE", () => {
          sheet.getRange(rowIndex, escCol).setValue("Yes");
        });
      }
    }

    if (!classification.emergency && classification.urgency === "Urgent" && ONCALL_NUMBER && !alreadyEscalated) {
      if (typeof dispatchOutboundIntent_ === "function") {
        dispatchOutboundIntent_({
          intentType: "CORE_TEXT_REPLY",
          recipientType: "TENANT",
          recipientRef: ONCALL_NUMBER,
          channel: "SMS",
          lang: "en",
          deliveryPolicy: "DIRECT_SEND",
          preRenderedBody: summary,
          vars: {},
          meta: { source: "processTicket_", stage: "ESCALATION", flow: "ONCALL_NOTIFY" }
        });
      }
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

  /**
   * Detect UNIT + COMMON_AREA problem spans in one message (e.g. in-unit sink + hallway light).
   * Uses same clause splits as location + issue multi-split. When mixed, product policy threads as UNIT
   * and carries common-area text in ticket detail (single-ticket path until split-ticket is enabled).
   */
  function inferLocationMixedScope_(rawText) {
    var out = { isMixed: false, commonAreaSpans: [], unitSpans: [] };
    var t = String(rawText || "").trim();
    if (!t) return out;
    t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    function classifyFrag_(frag) {
      if (typeof properaInferCanonicalLocationPack_ === "function") {
        var pk = properaInferCanonicalLocationPack_(frag, "");
        if (typeof properaLocationIsCommonLikePack_ === "function" && properaLocationIsCommonLikePack_(pk)) {
          return "COMMON_AREA";
        }
        if (pk && String(pk.locationType || "").toUpperCase() === "UNIT") return "UNIT";
        return "";
      }
      var rr = inferLocationTypeOnClause_(frag);
      if (rr && rr.ok && rr.locationType === "COMMON_AREA") return "COMMON_AREA";
      if (rr && rr.ok && rr.locationType === "UNIT") return "UNIT";
      return "";
    }
    try {
      var commonSpans = [];
      var unitSpans = [];
      var ci, parts, pj, p, r;
      // Merged ticket body from mergedIssueFromBuffer_: primary line + "\n\nAdditional items:\n- …"
      // Classify ONLY head + bullet lines. Running clause split on the full string mis-classifies the blob
      // (e.g. as one COMMON span) and duplicates content when we append "Common area (also reported):".
      var addM = /\n\nAdditional items:\s*\n/i.exec(t);
      if (!addM) addM = /\nAdditional items:\s*\n/i.exec(t);
      if (addM) {
        var headPart = t.slice(0, addM.index).trim();
        var tailPart = t.slice(addM.index + addM[0].length);
        if (headPart.length >= 4) {
          r = classifyFrag_(headPart);
          if (r === "COMMON_AREA") commonSpans.push(headPart);
          else if (r === "UNIT") unitSpans.push(headPart);
        }
        var bLines = tailPart.split(/\n/);
        for (var bi = 0; bi < bLines.length; bi++) {
          var line = String(bLines[bi] || "").replace(/^\s*-\s*/, "").trim();
          if (line.length < 4) continue;
          r = classifyFrag_(line);
          if (r === "COMMON_AREA" && commonSpans.indexOf(line) === -1) commonSpans.push(line);
          else if (r === "UNIT" && unitSpans.indexOf(line) === -1) unitSpans.push(line);
        }
        out.commonAreaSpans = commonSpans;
        out.unitSpans = unitSpans;
        out.isMixed = commonSpans.length >= 1 && unitSpans.length >= 1;
        return out;
      }
      var clauses = (typeof inferLocationTypeClauses_ === "function") ? inferLocationTypeClauses_(t) : [t];
      if (!clauses || clauses.length === 0) clauses = [t];
      for (ci = 0; ci < clauses.length; ci++) {
        var c = String(clauses[ci] || "").trim();
        if (!c) continue;
        parts = (typeof maybeSplitProblemClauseIntoMultiSubclauses_ === "function")
          ? maybeSplitProblemClauseIntoMultiSubclauses_(c)
          : [c];
        for (pj = 0; pj < parts.length; pj++) {
          p = String(parts[pj] || "").trim();
          if (p.length < 4) continue;
          r = classifyFrag_(p);
          if (r === "COMMON_AREA") commonSpans.push(p);
          else if (r === "UNIT") unitSpans.push(p);
        }
      }
      out.commonAreaSpans = commonSpans;
      out.unitSpans = unitSpans;
      out.isMixed = commonSpans.length >= 1 && unitSpans.length >= 1;
    } catch (_) {}
    return out;
  }

  /****************************
  * Deterministic location type classifier (UNIT vs COMMON_AREA).
  * Helper-level AI fallback is forbidden; opener is interpretation authority.
  ****************************/
  function inferLocationType_(apiKey, rawText, phone) {
    const t = String(rawText || "").trim();

    var fast = (typeof inferLocationTypeDeterministic_ === "function") ? inferLocationTypeDeterministic_(t) : null;
    if (fast && fast.ok === true && fast.locationType && Number(fast.confidence) >= 0.70) {
      try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "LOC_TYPE_FAST decided=" + String(fast.locationType)); } catch (_) {}
      return fast;
    }

    return { ok: true, locationType: "UNIT", confidence: 0.5, reason: "deterministic_default_no_ai_fallback" };
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

      // Guard: do not treat time window numbers as units.
      // Examples to reject: "from 10-12pm", "10-12pm", "at 10pm", "from 10 am".
      // This prevents schedule windows from being misparsed as apartment/unit numbers.
      try {
        const uEsc = String(num).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (
          new RegExp("\\b(?:from|at|in|for)\\s*" + uEsc + "\\s*(?:-|–)\\s*\\d{1,2}\\s*(?:am|pm)\\b", "i").test(t) ||
          new RegExp("\\b" + uEsc + "\\s*(?:-|–)\\s*\\d{1,2}\\s*(?:am|pm)\\b", "i").test(t) ||
          new RegExp("\\b(?:from|at|in|for)\\s*" + uEsc + "\\s*(?:am|pm)\\b", "i").test(t) ||
          new RegExp("\\b" + uEsc + "\\s*(?:am|pm)\\b", "i").test(t) ||
          new RegExp("\\b" + uEsc + "\\b.{0,10}\\b(?:am|pm)\\b", "i").test(t)
        ) {
          return "";
        }
      } catch (_) {}

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


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (post-split restore)
// Property + schedule + AI queue
// ─────────────────────────────────────────────────────────────────



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



  function parsePreferredWindow_(text, stageDay) {
    return parsePreferredWindowShared_(text, stageDay);
  }





  function scheduleDayWord_(now) {
    const d = now || new Date();

    // After-hours/weekends => tomorrow
    if (isAfterHours_(d)) return "Tomorrow";

    const CUTOFF_HOUR = 16; // ✅ 4 PM
    return (d.getHours() >= CUTOFF_HOUR) ? "Tomorrow" : "Today";
  }



  function windowLabel_(text, stageDay) {
    const parsed = parsePreferredWindow_(text, stageDay);
    return parsed ? parsed.label : "";
  }


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (dependency wave 2)
// AI queue + queued row
// ─────────────────────────────────────────────────────────────────



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
