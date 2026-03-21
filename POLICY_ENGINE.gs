/**
 * PolicyEngine v1 (Compass-aligned, deterministic)
 * Event scope: WORKITEM_CREATED
 */

var POLICY_RULES_SHEET_ = "PolicyRules";
var POLICY_TIMERS_SHEET_ = "PolicyTimers";
var POLICY_EVENT_LOG_SHEET_ = "PolicyEventLog";
var POLICY_ENGINE_INIT_DONE_ = false;
var POLICY_RULES_CACHE_TTL_SEC_ = 120;
var POLICY_IDEM_CACHE_TTL_SEC_ = 21600;
var POLICY_RULES_CACHE_KEY_PREFIX_ = "policy_rules_";
var POLICY_IDEM_CACHE_KEY_PREFIX_ = "policy_idem_";

var POLICY_ALLOWED_WHEN_KEYS_V1_ = {
  stateIn: true,
  afterHours: true,
  hasVendor: true,
  hasSchedule: true,
  minutesSinceCreatedGte: true,
  minutesSinceCreatedLte: true,
  propIn: true,
  catIn: true
};

var POLICY_ALLOWED_ACTION_TYPES_V1_ = {
  APPLY_OWNERSHIP_ACTION: true,
  SEND_TENANT: true,
  SEND_MANAGER: true,
  SEND_VENDOR: true,
  SET_TIMER: true,
  SET_WORKITEM_STATE: true,
  ASSIGN_VENDOR_BY_POLICY: true
};

function policyNowIso_(d) {
  try { return (d instanceof Date ? d : new Date()).toISOString(); } catch (_) { return ""; }
}

function policyLocalHourDow_(d) {
  var when = (d instanceof Date) ? d : new Date();
  try {
    var tz = Session.getScriptTimeZone ? Session.getScriptTimeZone() : "Etc/GMT";
    var hour = Number(Utilities.formatDate(when, tz, "H"));
    var dowIso = Number(Utilities.formatDate(when, tz, "u")); // 1..7 (Mon..Sun)
    if (!isFinite(hour)) hour = when.getHours();
    if (!isFinite(dowIso)) {
      var jsDow = when.getDay(); // 0..6 Sun..Sat
      dowIso = (jsDow === 0) ? 7 : jsDow;
    }
    return { hour: hour, dowIso: dowIso };
  } catch (_) {
    var jsDow2 = when.getDay();
    return { hour: when.getHours(), dowIso: (jsDow2 === 0) ? 7 : jsDow2 };
  }
}

function policyToBool_(v, fallback) {
  if (v === true || v === false) return v;
  var s = String(v == null ? "" : v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return !!fallback;
}

function policySafeJsonParse_(raw, fallbackObj, noteTag) {
  if (raw == null || raw === "") return fallbackObj;
  if (typeof raw === "object") return raw;
  try {
    var o = JSON.parse(String(raw));
    return (o && typeof o === "object") ? o : fallbackObj;
  } catch (e) {
    try { logDevSms_("", "", "POLICY_JSON_PARSE_FAIL tag=[" + String(noteTag || "") + "]"); } catch (_) {}
    return fallbackObj;
  }
}

function policyGetOrCreateSheet_(name, headers) {
  var sh = (typeof getActiveSheetByNameCached_ === "function") ? getActiveSheetByNameCached_(name) : null;
  if (sh) return sh;
  if (typeof getOrCreateSheet_ === "function") {
    getOrCreateSheet_(name, headers || []);
    var sh2 = (typeof getActiveSheetByNameCached_ === "function") ? getActiveSheetByNameCached_(name) : null;
    return sh2 || SpreadsheetApp.getActive().getSheetByName(name);
  }
  var ss = SpreadsheetApp.getActive();
  var created = ss.getSheetByName(name) || ss.insertSheet(name);
  if (created.getLastRow() < 1 && headers && headers.length) created.getRange(1, 1, 1, headers.length).setValues([headers]);
  return created;
}

/**
 * Call from admin/init only; not used on hot path. Use adminInitPolicySheets_() to create and seed policy sheets.
 */
function seedPolicyEngineSheets_() {
  if (POLICY_ENGINE_INIT_DONE_) return;
  withWriteLock_("POLICY_ENGINE_SEED_SHEETS", function () {
    policyGetOrCreateSheet_(POLICY_RULES_SHEET_, [
      "RuleId", "Enabled", "Priority", "ScopeProperty", "EventType", "WhenJson", "ThenJson", "CooldownMin", "IdempotencyKey", "Notes", "UpdatedAt"
    ]);
    policyGetOrCreateSheet_(POLICY_TIMERS_SHEET_, [
      "TimerId", "Enabled", "WorkItemId", "Prop", "EventType", "RunAt", "PayloadJson", "IdempotencyKey", "Status", "Attempts", "LastError", "CreatedAt", "UpdatedAt"
    ]);
    policyGetOrCreateSheet_(POLICY_EVENT_LOG_SHEET_, [
      "Timestamp", "EventType", "Prop", "WorkItemId", "RuleId", "Decision", "FactsJson", "PlanJson", "IdempotencyKey", "Actor", "Notes"
    ]);
  });

  policySeedDefaultRulesIfEmpty_();
  POLICY_ENGINE_INIT_DONE_ = true;
}

function policyTemplateKeyExists_(templateKey) {
  try {
    if (!templateKey) return false;
    if (typeof getTemplateMapCached_ !== "function") return false;
    var map = getTemplateMapCached_();
    return !!(map && map.byKey && map.byKey[String(templateKey).trim()]);
  } catch (_) {
    return false;
  }
}

function policyActionExistsInActionPolicy_(actionName) {
  try {
    var act = String(actionName || "").trim().toUpperCase();
    if (!act) return false;
    if (!POLICY_ALLOWED_ACTION_TYPES_V1_ || !POLICY_ALLOWED_ACTION_TYPES_V1_.APPLY_OWNERSHIP_ACTION) return false;
    if (["ADD_NOTE", "TRIAGE_INHOUSE", "TRIAGE_VENDOR", "REQUEST_TENANT_INFO", "REQUEST_SCHEDULE", "MARK_DONE"].indexOf(act) < 0) return false;
    var sh = (typeof getActiveSheetByNameCached_ === "function") ? getActiveSheetByNameCached_("ActionPolicy") : null;
    if (!sh) return false;
    var r = (typeof findRowByValue_ === "function") ? findRowByValue_(sh, "Action", act) : 0;
    return !!r;
  } catch (_) {
    return false;
  }
}

function policySeedDefaultRulesIfEmpty_() {
  try {
    var sh = (typeof getActiveSheetByNameCached_ === "function") ? getActiveSheetByNameCached_(POLICY_RULES_SHEET_) : null;
    if (!sh) sh = SpreadsheetApp.getActive().getSheetByName(POLICY_RULES_SHEET_);
    if (!sh) return;
    if (sh.getLastRow() > 1) return;

    var rows = [];
    var now = new Date();

    var afterHoursKey = "TENANT_AFTER_HOURS_ACK";
    if (policyTemplateKeyExists_(afterHoursKey)) {
      rows.push([
        "R-001",
        true,
        10,
        "GLOBAL",
        "WORKITEM_CREATED",
        JSON.stringify({ afterHours: true }),
        JSON.stringify({ actions: [{ type: "SEND_TENANT", templateKey: afterHoursKey }] }),
        "",
        "R-001:WORKITEM_CREATED",
        "Seeded v1 example",
        now
      ]);
    } else {
      try { logDevSms_("", "", "SEED_SKIPPED_MISSING_TEMPLATE_OR_ACTION rule=R-001 missingTemplateKey=[" + afterHoursKey + "]"); } catch (_) {}
    }

    var actionName = "TRIAGE_INHOUSE";
    if (policyActionExistsInActionPolicy_(actionName)) {
      rows.push([
        "R-002",
        true,
        20,
        "GLOBAL",
        "WORKITEM_CREATED",
        JSON.stringify({ afterHours: false }),
        JSON.stringify({ actions: [{ type: "APPLY_OWNERSHIP_ACTION", actionName: actionName }] }),
        "",
        "R-002:WORKITEM_CREATED",
        "Seeded v1 example",
        now
      ]);
    } else {
      try { logDevSms_("", "", "SEED_SKIPPED_MISSING_TEMPLATE_OR_ACTION rule=R-002 missingAction=[" + actionName + "]"); } catch (_) {}
    }

    if (!rows.length) return;
    withWriteLock_("POLICY_SEED_RULES", function () {
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    });
  } catch (e) {
    try { logDevSms_("", "", "POLICY_SEED_ERR " + String(e && e.message ? e.message : e)); } catch (_) {}
  }
}

function policyLogEventRow_(eventType, propCode, workItemId, ruleId, decision, facts, plan, idempotencyKey, actor, notes) {
  try {
    var sh = (typeof getActiveSheetByNameCached_ === "function") ? getActiveSheetByNameCached_(POLICY_EVENT_LOG_SHEET_) : null;
    if (!sh) return;
    var row = [[
      new Date(),
      String(eventType || ""),
      String(propCode || ""),
      String(workItemId || ""),
      String(ruleId || ""),
      String(decision || ""),
      JSON.stringify(facts || {}),
      JSON.stringify(plan || {}),
      String(idempotencyKey || ""),
      String(actor || "POLICY_ENGINE"),
      String(notes || "")
    ]];
    sh.getRange(sh.getLastRow() + 1, 1, 1, row[0].length).setValues(row);
  } catch (_) {}
}

function policyHasIdempotencyKey_(idempotencyKey) {
  var idem = String(idempotencyKey || "").trim();
  if (!idem) return false;
  try {
    var cache = CacheService.getScriptCache();
    var key = POLICY_IDEM_CACHE_KEY_PREFIX_ + idem;
    var v = cache.get(key);
    if (v != null && v !== "") return true;
  } catch (_) {}
  try {
    var sh = (typeof getActiveSheetByNameCached_ === "function") ? getActiveSheetByNameCached_(POLICY_EVENT_LOG_SHEET_) : null;
    if (!sh || sh.getLastRow() < 2) return false;
    var map = (typeof getHeaderMap_ === "function") ? getHeaderMap_(sh) : {};
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    var colIdem = (map["IdempotencyKey"] || 9) - 1;
    var colDecision = (map["Decision"] || 6) - 1;
    for (var i = 0; i < rows.length; i++) {
      var rowIdem = String(rows[i][colIdem] || "").trim();
      if (rowIdem !== idem) continue;
      var decision = String(rows[i][colDecision] || "").trim().toUpperCase();
      if (decision === "EXEC_START" || decision === "EXECUTED") return true;
    }
  } catch (_) {}
  return false;
}

function policyReserveIdempotencyKey_(idempotencyKey) {
  var idem = String(idempotencyKey || "").trim();
  if (!idem) return;
  try {
    var cache = CacheService.getScriptCache();
    cache.put(POLICY_IDEM_CACHE_KEY_PREFIX_ + idem, "1", POLICY_IDEM_CACHE_TTL_SEC_);
  } catch (_) {}
}

function buildPolicyFacts_(eventType, ctx, workItem, propCode, now) {
  var when = (now instanceof Date) ? now : new Date();
  var p = String(propCode || (workItem && workItem.propertyId) || "").trim().toUpperCase();
  var wi = workItem || {};
  var meta = policySafeJsonParse_(wi.metadataJson, {}, "buildPolicyFacts_metadataJson");
  var createdAt = wi.createdAt ? new Date(wi.createdAt) : null;
  var minutesSinceCreated = null;

  if (createdAt && !isNaN(createdAt.getTime())) {
    minutesSinceCreated = Math.max(0, Math.floor((when.getTime() - createdAt.getTime()) / 60000));
  }

  var earliest = Number(ppGet_(p, "SCHED_EARLIEST_HOUR", 9));
  var latest = Number(ppGet_(p, "SCHED_LATEST_HOUR", 18));
  var allowWeekendsLegacy = !!ppGet_(p, "SCHED_ALLOW_WEEKENDS", false);
  if (!isFinite(earliest)) earliest = 9;
  if (!isFinite(latest)) latest = 18;

  var t = policyLocalHourDow_(when);
  var hour = Number(t.hour);
  var dowIso = Number(t.dowIso);
  var isSat = (dowIso === 6);
  var isSun = (dowIso === 7);
  var isWeekend = isSat || isSun;
  var weekendOk = true;
  if (isWeekend) {
    if (allowWeekendsLegacy) weekendOk = true;
    else if (isSat) weekendOk = !!ppGet_(p, "SCHED_SAT_ALLOWED", false);
    else if (isSun) weekendOk = !!ppGet_(p, "SCHED_SUN_ALLOWED", false);
  }
  var latestEff = latest;
  if (isSat) {
    var satCap = Number(ppGet_(p, "SCHED_SAT_LATEST_HOUR", NaN));
    if (isFinite(satCap)) latestEff = Math.min(latest, satCap);
  }
  var afterHours = (hour < earliest || hour > latestEff || (isWeekend && !weekendOk));

  // Effective row for Sheet1 reads: prefer TicketKey lookup (runtime only); else legacy TicketRow + log
  var ticketSheet = (typeof getLogSheet_ === "function") ? getLogSheet_() : null;
  if (!ticketSheet && typeof getSheetSafe_ === "function") ticketSheet = getSheetSafe_("Sheet1");
  if (!ticketSheet && typeof SpreadsheetApp !== "undefined") {
    var ss = typeof LOG_SHEET_ID !== "undefined" ? SpreadsheetApp.openById(LOG_SHEET_ID) : SpreadsheetApp.getActive();
    ticketSheet = ss ? ss.getSheetByName("Sheet1") : null;
  }
  var effectiveTicketRow = 0;
  if (wi.ticketKey && String(wi.ticketKey).trim() && typeof findTicketRowByTicketKey_ === "function" && ticketSheet) {
    try {
      effectiveTicketRow = Number(findTicketRowByTicketKey_(ticketSheet, wi.ticketKey)) || 0;
    } catch (_) {}
  }
  if (effectiveTicketRow < 2 && wi.ticketRow != null && wi.ticketRow !== "") {
    effectiveTicketRow = Number(wi.ticketRow) || 0;
    if (effectiveTicketRow >= 2 && typeof logDevSms_ === "function") {
      try { logDevSms_(wi.phoneE164 || "", "", "WI_LEGACY_ROW_FALLBACK_USED wiId=" + String(wi.workItemId || "") + " context=policy_buildPolicyFacts_"); } catch (_) {}
    }
  }

  var category = "";
  // Prefer category passed from ticket creation (authoritative classification) so policy matches correct type (e.g. Electrical not HVAC)
  if (wi.categoryFromTicket && String(wi.categoryFromTicket).trim()) {
    category = String(wi.categoryFromTicket).trim().toLowerCase();
  } else {
    if (effectiveTicketRow >= 2 && typeof COL !== "undefined" && COL.CAT) {
      try {
        if (ticketSheet && ticketSheet.getLastRow() >= effectiveTicketRow) {
          var catVal = ticketSheet.getRange(effectiveTicketRow, COL.CAT).getValue();
          category = String(catVal || "").trim().toLowerCase();
        }
      } catch (_) {}
    }
  }

  // hasSchedule: prefer in-memory WI/meta/context; only fall back to ticket row PREF_WINDOW if missing
  var hasSchedule = !!(wi.sched || meta.sched || meta.schedule || wi.hasSchedule === true || meta.hasSchedule === true || (ctx && ctx.hasSchedule === true) || (meta.prefWindow && String(meta.prefWindow).trim()) || "");
  if (!hasSchedule && effectiveTicketRow >= 2 && typeof COL !== "undefined" && COL.PREF_WINDOW) {
    try {
      if (ticketSheet && ticketSheet.getLastRow() >= effectiveTicketRow) {
        var prefWindowVal = String(ticketSheet.getRange(effectiveTicketRow, COL.PREF_WINDOW).getValue() || "").trim();
        hasSchedule = prefWindowVal.length > 0;
      }
    } catch (_) {}
  }

  var facts = {
    eventType: String(eventType || "").trim().toUpperCase(),
    propCode: p,
    workItemId: String(wi.workItemId || "").trim(),
    workItemState: String(wi.state || "").trim().toUpperCase(),
    ownerType: String(wi.ownerType || "").trim(),
    ownerId: String(wi.ownerId || "").trim(),
    hasVendor: !!(wi.vendorId || meta.vendorId || meta.vendor || ""),
    hasSchedule: hasSchedule,
    minutesSinceCreated: minutesSinceCreated,
    afterHours: !!afterHours,
    nowIso: policyNowIso_(when),
    category: category
  };
  return facts;
}

function loadPolicyRules_(propCode, eventType) {
  var p = String(propCode || "").trim().toUpperCase();
  var ev = String(eventType || "").trim().toUpperCase();
  var cacheKey = POLICY_RULES_CACHE_KEY_PREFIX_ + p + "_" + ev + "_v1";
  try {
    var cache = CacheService.getScriptCache();
    var raw = cache.get(cacheKey);
    if (raw != null && raw !== "") {
      var parsed = policySafeJsonParse_(raw, null, "loadPolicyRules_cache");
      if (Array.isArray(parsed) && parsed.length >= 0) return parsed;
    }
  } catch (_) {}

  var sh = (typeof getActiveSheetByNameCached_ === "function") ? getActiveSheetByNameCached_(POLICY_RULES_SHEET_) : null;
  if (!sh || sh.getLastRow() < 2) return [];

  var map = (typeof getHeaderMap_ === "function") ? getHeaderMap_(sh) : {};
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var enabled = policyToBool_(r[(map["Enabled"] || 2) - 1], false);
    var scope = String(r[(map["ScopeProperty"] || 4) - 1] || "").trim().toUpperCase();
    var rowEvent = String(r[(map["EventType"] || 5) - 1] || "").trim().toUpperCase();
    if (!enabled) continue;
    if (rowEvent !== ev) continue;
    if (!(scope === p || scope === "GLOBAL")) continue;

    var whenObj = policySafeJsonParse_(r[(map["WhenJson"] || 6) - 1], {}, "rule_when_" + i);
    var thenObj = policySafeJsonParse_(r[(map["ThenJson"] || 7) - 1], {}, "rule_then_" + i);
    out.push({
      ruleId: String(r[(map["RuleId"] || 1) - 1] || "").trim() || ("ROW_" + (i + 2)),
      enabled: enabled,
      priority: Number(r[(map["Priority"] || 3) - 1]) || 999999,
      scopeProperty: scope || "GLOBAL",
      eventType: rowEvent,
      whenObj: whenObj,
      thenObj: thenObj,
      cooldownMin: Number(r[(map["CooldownMin"] || 8) - 1]) || 0,
      idempotencyKeyBase: String(r[(map["IdempotencyKey"] || 9) - 1] || "").trim(),
      notes: String(r[(map["Notes"] || 10) - 1] || "").trim()
    });
  }

  out.sort(function (a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return String(a.ruleId).localeCompare(String(b.ruleId));
  });
  try {
    var cache2 = CacheService.getScriptCache();
    cache2.put(cacheKey, JSON.stringify(out), POLICY_RULES_CACHE_TTL_SEC_);
  } catch (_) {}
  return out;
}

function matchRule_(facts, whenObj) {
  var w = (whenObj && typeof whenObj === "object") ? whenObj : {};
  var keys = Object.keys(w);

  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!POLICY_ALLOWED_WHEN_KEYS_V1_[k]) {
      try { logDevSms_("", "", "RULE_SKIP_UNKNOWN_KEYS key=[" + k + "]"); } catch (_) {}
      return false;
    }
  }

  if (Array.isArray(w.stateIn)) {
    var states = w.stateIn.map(function (x) { return String(x || "").trim().toUpperCase(); });
    if (states.indexOf(String(facts.workItemState || "").toUpperCase()) < 0) return false;
  }
  if (w.afterHours !== undefined && !!facts.afterHours !== !!w.afterHours) return false;
  if (w.hasVendor !== undefined && !!facts.hasVendor !== !!w.hasVendor) return false;
  if (w.hasSchedule !== undefined && !!facts.hasSchedule !== !!w.hasSchedule) return false;

  if (w.minutesSinceCreatedGte !== undefined) {
    if (facts.minutesSinceCreated == null) return false;
    if (Number(facts.minutesSinceCreated) < Number(w.minutesSinceCreatedGte)) return false;
  }
  if (w.minutesSinceCreatedLte !== undefined) {
    if (facts.minutesSinceCreated == null) return false;
    if (Number(facts.minutesSinceCreated) > Number(w.minutesSinceCreatedLte)) return false;
  }
  if (Array.isArray(w.propIn)) {
    var props = w.propIn.map(function (x) { return String(x || "").trim().toUpperCase(); });
    if (props.indexOf(String(facts.propCode || "").toUpperCase()) < 0) return false;
  }
  if (Array.isArray(w.catIn)) {
    var cats = w.catIn.map(function (x) { return String(x || "").trim().toLowerCase(); });
    var factCat = String(facts.category || "").trim().toLowerCase();
    if (!factCat || cats.indexOf(factCat) < 0) return false;
  }
  return true;
}

function policyEvaluate_(eventType, ctx, workItem, propCode, now) {
  var when = (now instanceof Date) ? now : new Date();
  var p = String(propCode || (workItem && workItem.propertyId) || "").trim().toUpperCase();
  var ev = String(eventType || "").trim().toUpperCase();
  var facts = buildPolicyFacts_(ev, ctx || {}, workItem || {}, p, when);

  var enabled = policyToBool_(ppGet_(p, "POLICY_ENGINE_ENABLED", ppGet_("GLOBAL", "POLICY_ENGINE_ENABLED", false)), false);
  if (!enabled) {
    try { logDevSms_("", "", "POLICY_EVAL_DISABLED event=[" + ev + "] prop=[" + p + "] facts=" + JSON.stringify(facts).slice(0, 600)); } catch (_) {}
    return null;
  }

  var rules = loadPolicyRules_(p, ev);
  if (!rules.length) {
    try { logDevSms_("", "", "POLICY_EVAL_NO_RULES event=[" + ev + "] prop=[" + p + "] facts=" + JSON.stringify(facts).slice(0, 600)); } catch (_) {}
    return null;
  }

  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    var matched = matchRule_(facts, rule.whenObj || {});
    if (!matched) continue;

    var thenObj = (rule.thenObj && typeof rule.thenObj === "object") ? rule.thenObj : {};
    var rawActions = Array.isArray(thenObj.actions) ? thenObj.actions : [];
    var actions = [];
    for (var j = 0; j < rawActions.length; j++) {
      var a = rawActions[j] || {};
      var t = String(a.type || "").trim().toUpperCase();
      if (!POLICY_ALLOWED_ACTION_TYPES_V1_[t]) {
        try { logDevSms_("", "", "POLICY_ACTION_SKIP_UNKNOWN_TYPE rule=[" + rule.ruleId + "] type=[" + t + "]"); } catch (_) {}
        continue;
      }
      a.type = t;
      actions.push(a);
    }

    var idem = rule.idempotencyKeyBase || (String(rule.ruleId) + ":" + ev + ":" + String(facts.workItemId || ""));
    var plan = {
      ruleId: rule.ruleId,
      actions: actions,
      updates: Array.isArray(thenObj.updates) ? thenObj.updates : [],
      idempotencyKey: idem,
      trace: {
        eventType: ev,
        propCode: p,
        ruleId: rule.ruleId,
        facts: facts,
        matchedAtIso: policyNowIso_(when)
      }
    };
    try { logDevSms_("", "", "POLICY_EVAL_MATCH event=[" + ev + "] prop=[" + p + "] rule=[" + rule.ruleId + "] plan=" + JSON.stringify(plan).slice(0, 700)); } catch (_) {}
    return plan;
  }

  try { logDevSms_("", "", "POLICY_EVAL_NO_MATCH event=[" + ev + "] prop=[" + p + "] facts=" + JSON.stringify(facts).slice(0, 600)); } catch (_) {}
  return null;
}

function policyResolveTargetPhone_(action, ctx, workItem) {
  var t = String((action && action.type) || "").toUpperCase();
  var data = (action && action.data && typeof action.data === "object") ? action.data : {};
  if (t === "SEND_TENANT") return String((workItem && workItem.phoneE164) || (ctx && ctx.phoneE164) || "").trim();
  return String(data.phoneE164 || data.phone || (action && action.phoneE164) || "").trim();
}

/**
 * Sends message via template key. Returns true if send was performed, false if skipped (missing to/template, empty render).
 */
function policySendByTemplateAction_(action, ctx, workItem) {
  var t = String((action && action.type) || "").toUpperCase();
  var templateKey = String((action && action.templateKey) || "").trim();
  var to = normalizePhone_(policyResolveTargetPhone_(action, ctx, workItem));
  var lang = String((ctx && ctx.lang) || "en").trim().toLowerCase();
  var data = (action && action.data && typeof action.data === "object") ? action.data : {};

  if (!templateKey || !to) {
    try { logDevSms_("", "", "POLICY_SEND_SKIP type=[" + t + "] reason=[MISSING_TO_OR_TEMPLATE]"); } catch (_) {}
    return false;
  }

  var msg = String(renderTenantKey_(templateKey, lang, data) || "").trim();
  if (!msg) {
    try { logDevSms_(to, "", "POLICY_TEMPLATE_MISSING key=[" + templateKey + "] type=[" + t + "]"); } catch (_) {}
    try { logDevSms_(to, "", "POLICY_SEND_SKIP type=[" + t + "] reason=[EMPTY_RENDER] key=[" + templateKey + "]"); } catch (_) {}
    return false;
  }

  try {
    sendRouterSms_(to, msg, "POLICY_" + t);
    return true;
  } catch (_) {
    return false;
  }
}

function policyInsertTimer_(action, plan, workItem, propCode, now) {
  var sh = (typeof getActiveSheetByNameCached_ === "function") ? getActiveSheetByNameCached_(POLICY_TIMERS_SHEET_) : null;
  if (!sh) return;
  var mins = Number(action.minutesFromNow);
  if (!isFinite(mins) || mins < 0) mins = 0;
  var runAt = new Date((now instanceof Date ? now : new Date()).getTime() + mins * 60000);
  var timerId = "PTMR_" + Utilities.getUuid().slice(0, 8);
  var payload = Object.assign({}, (action.payload && typeof action.payload === "object") ? action.payload : {}, {
    timerType: String(action.timerType || "").trim()
  });

  sh.appendRow([
    timerId,
    true,
    String((workItem && workItem.workItemId) || "").trim(),
    String(propCode || "").trim(),
    "TIMER_DUE",
    runAt,
    JSON.stringify(payload),
    String((plan && plan.idempotencyKey) || "").trim(),
    "PENDING",
    0,
    "",
    new Date(),
    new Date()
  ]);
}

function executePolicyPlan_(plan, ctx, workItem, propCode, now) {
  var defaultResult = { executed: false, ackOwned: false, ackSent: false, ruleId: (plan && plan.ruleId) ? String(plan.ruleId) : "" };
  if (!plan || !Array.isArray(plan.actions) || !plan.actions.length) return defaultResult;
  var ev = (plan.trace && plan.trace.eventType) ? String(plan.trace.eventType) : "";
  var p = String(propCode || "").trim().toUpperCase();
  var wi = workItem || {};
  var when = (now instanceof Date) ? now : new Date();
  var ackOwned = false;
  var ackSent = false;

  try {
    for (var i = 0; i < plan.actions.length; i++) {
      var action = plan.actions[i] || {};
      var type = String(action.type || "").trim().toUpperCase();

      if (type === "SEND_TENANT") {
        ackOwned = true;
        if (policySendByTemplateAction_(action, ctx || {}, wi || {})) ackSent = true;
      } else if (type === "APPLY_OWNERSHIP_ACTION") {
        var actionName = String(action.actionName || "").trim().toUpperCase();
        if (!actionName) {
          try { logDevSms_("", "", "POLICY_ACTION_SKIP type=[APPLY_OWNERSHIP_ACTION] reason=[MISSING_ACTION_NAME]"); } catch (_) {}
          continue;
        }
        if (typeof applyOwnershipAction_ !== "function") {
          try { logDevSms_("", "", "POLICY_ACTION_SKIP type=[APPLY_OWNERSHIP_ACTION] reason=[MISSING_HELPER]"); } catch (_) {}
          continue;
        }
        applyOwnershipAction_(wi, {
          action: actionName,
          ticketRow: wi.ticketRow || "",
          ticketId: "",
          tenantPhone: String((wi && wi.phoneE164) || (ctx && ctx.phoneE164) || "").trim(),
          actor: "POLICY_ENGINE",
          actorId: "POLICY_ENGINE",
          note: String((action.payload && action.payload.note) || "").trim(),
          templateKey: String((action.payload && action.payload.templateKey) || "").trim(),
          templateVars: (action.payload && action.payload.templateVars) || {}
        });
      } else if (type === "SEND_MANAGER" || type === "SEND_VENDOR") {
        policySendByTemplateAction_(action, ctx || {}, wi || {});
      } else if (type === "SET_TIMER") {
        withWriteLock_("POLICY_SET_TIMER", function () {
          policyInsertTimer_(action, plan, wi, p, when);
        });
      } else if (type === "ASSIGN_VENDOR_BY_POLICY") {
        var policyKey = String(action.policyKey || "HVAC_VENDOR_ID").trim() || "HVAC_VENDOR_ID";
        var vendorId = String(ppGet_(p, policyKey, "") || "").trim();
        if (!vendorId) {
          try { logDevSms_(String((ctx && ctx.phoneE164) || wi.phoneE164 || ""), "", "POLICY_VENDOR_NO_VENDORID prop=[" + p + "] policyKey=[" + policyKey + "]"); } catch (_) {}
          continue;
        }
        if (typeof withWriteLock_ !== "function" || typeof assignTicketFromRow_ !== "function") {
          try { logDevSms_("", "", "POLICY_VENDOR_ASSIGN_SKIP reason=[MISSING_HELPER]"); } catch (_) {}
          continue;
        }
        if (typeof COL === "undefined" || !COL.ASSIGNED_TYPE || !COL.ASSIGNED_ID || !COL.VENDOR_STATUS) {
          try { logDevSms_("", "", "POLICY_VENDOR_ASSIGN_SKIP reason=[COL_MISSING]"); } catch (_) {}
          continue;
        }
        withWriteLock_("POLICY_VENDOR_ASSIGN", function () {
          var sheet = (typeof getLogSheet_ === "function") ? getLogSheet_() : null;
          if (!sheet && typeof getSheetSafe_ === "function") sheet = getSheetSafe_("Sheet1");
          if (!sheet && typeof SpreadsheetApp !== "undefined") {
            try {
              var ss = typeof LOG_SHEET_ID !== "undefined" ? SpreadsheetApp.openById(LOG_SHEET_ID) : SpreadsheetApp.getActive();
              if (ss) sheet = ss.getSheetByName("Sheet1");
            } catch (_) {}
          }
          if (!sheet) {
            try { logDevSms_("", "", "POLICY_VENDOR_BAD_ROW reason=[NO_SHEET]"); } catch (_) {}
            return;
          }
          var row = 0;
          if (wi.ticketKey && String(wi.ticketKey).trim() && typeof findTicketRowByTicketKey_ === "function") {
            try { row = Number(findTicketRowByTicketKey_(sheet, wi.ticketKey)) || 0; } catch (_) {}
          }
          if (row < 2 && wi.ticketRow != null && wi.ticketRow !== "") {
            row = Number(wi.ticketRow) || 0;
            if (row >= 2 && typeof logDevSms_ === "function") {
              try { logDevSms_(wi.phoneE164 || "", "", "WI_LEGACY_ROW_FALLBACK_USED wiId=" + String(wi.workItemId || "") + " context=policy_vendor_assign"); } catch (_) {}
            }
          }
          if (row < 2) {
            try { logDevSms_(String((ctx && ctx.phoneE164) || wi.phoneE164 || ""), "", "POLICY_VENDOR_BAD_ROW row=[" + row + "] wi=[" + String(wi.workItemId || "") + "]"); } catch (_) {}
            return;
          }
          if (sheet.getLastRow() < row) {
            try { logDevSms_("", "", "POLICY_VENDOR_BAD_ROW reason=[ROW_BEYOND_SHEET] row=[" + row + "]"); } catch (_) {}
            return;
          }
          var assignedType = String(sheet.getRange(row, COL.ASSIGNED_TYPE).getValue() || "").trim();
          var assignedId   = String(sheet.getRange(row, COL.ASSIGNED_ID).getValue() || "").trim();
          var vendorStatus = String(sheet.getRange(row, COL.VENDOR_STATUS).getValue() || "").trim();
          if (assignedType.toLowerCase() === "vendor" && assignedId === vendorId && vendorStatus) {
            try { logDevSms_(String((ctx && ctx.phoneE164) || wi.phoneE164 || ""), "", "POLICY_VENDOR_ALREADY_ASSIGNED row=[" + row + "] vendorId=[" + vendorId + "] status=[" + vendorStatus + "]"); } catch (_) {}
            return;
          }
          try { logDevSms_(String((ctx && ctx.phoneE164) || wi.phoneE164 || ""), "", "POLICY_VENDOR_ASSIGN_START row=[" + row + "] vendorId=[" + vendorId + "]"); } catch (_) {}
          sheet.getRange(row, COL.ASSIGNED_TYPE).setValue("Vendor");
          sheet.getRange(row, COL.ASSIGNED_ID).setValue(vendorId);
          var creds = {
            TWILIO_SID: typeof TWILIO_SID !== "undefined" ? TWILIO_SID : "",
            TWILIO_TOKEN: typeof TWILIO_TOKEN !== "undefined" ? TWILIO_TOKEN : "",
            TWILIO_NUMBER: typeof TWILIO_NUMBER !== "undefined" ? TWILIO_NUMBER : ""
          };
          try {
            assignTicketFromRow_(creds, sheet, row, { mode: "AUTO", assignedBy: "POLICY" });
          } catch (assignErr) {
            try { logDevSms_("", "", "POLICY_VENDOR_ASSIGN_ERR row=[" + row + "] err=[" + String(assignErr && assignErr.message ? assignErr.message : assignErr) + "]"); } catch (_) {}
            return;
          }
          var statusAfter = String(sheet.getRange(row, COL.VENDOR_STATUS).getValue() || "").trim();
          try { logDevSms_(String((ctx && ctx.phoneE164) || wi.phoneE164 || ""), "", "POLICY_VENDOR_ASSIGN_DONE row=[" + row + "] vendorId=[" + vendorId + "] status=[" + statusAfter + "]"); } catch (_) {}
        });
      } else if (type === "SET_WORKITEM_STATE") {
        var ns = String(action.newState || "").trim();
        if (!ns) {
          try { logDevSms_("", "", "POLICY_ACTION_SKIP type=[SET_WORKITEM_STATE] reason=[MISSING_STATE]"); } catch (_) {}
          continue;
        }
        if (typeof wiTransition_ === "function") {
          wiTransition_(String(wi.workItemId || ""), ns, String(action.substate || ""), String((ctx && ctx.phoneE164) || wi.phoneE164 || ""), "POLICY_SET_STATE");
        } else {
          try { logDevSms_("", "", "POLICY_ACTION_SKIP type=[SET_WORKITEM_STATE] reason=[UNSUPPORTED_NO_HELPER]"); } catch (_) {}
        }
      }
    }

    withWriteLock_("POLICY_EVENT_LOG_EXEC", function () {
      policyLogEventRow_(
        ev,
        p,
        String(wi.workItemId || ""),
        String(plan.ruleId || ""),
        "EXECUTED",
        (plan.trace && plan.trace.facts) || {},
        plan,
        String(plan.idempotencyKey || ""),
        "POLICY_ENGINE",
        "executePolicyPlan_"
      );
    });

    try {
      logDevSms_(
        String((ctx && ctx.phoneE164) || wi.phoneE164 || ""),
        "",
        "POLICY_EXEC_OK event=[" + ev + "] prop=[" + p + "] wi=[" + String(wi.workItemId || "") + "] rule=[" + String(plan.ruleId || "") + "] idem=[" + String(plan.idempotencyKey || "") + "]"
      );
    } catch (_) {}
    return { executed: true, ackOwned: ackOwned, ackSent: ackSent, ruleId: String(plan.ruleId || "") };
  } catch (e) {
    try {
      logDevSms_(
        String((ctx && ctx.phoneE164) || wi.phoneE164 || ""),
        "",
        "POLICY_EXEC_ERR event=[" + ev + "] prop=[" + p + "] wi=[" + String(wi.workItemId || "") + "] err=[" + String(e && e.message ? e.message : e) + "]"
      );
    } catch (_) {}
  }
  return defaultResult;
}

function maybePolicyRun_(eventType, ctx, workItem, propCode) {
  var noAck = { ackOwned: false, ackSent: false, ruleId: "" };
  var now = new Date();
  try {
    var plan = policyEvaluate_(eventType, ctx || {}, workItem || {}, propCode || "", now);
    if (!plan) return noAck;

    var ev = String(eventType || "").trim().toUpperCase();
    var p = String(propCode || (workItem && workItem.propertyId) || "").trim().toUpperCase();
    var wiId = String((workItem && workItem.workItemId) || "").trim();
    var facts = (plan.trace && plan.trace.facts) || {};
    var idem = String(plan.idempotencyKey || "").trim();

    // Dry run gate: build facts + match + log trace, but do NOT execute or reserve idempotency
    var dryRun = policyToBool_(ppGet_(p, "POLICY_ENGINE_DRY_RUN", ppGet_("GLOBAL", "POLICY_ENGINE_DRY_RUN", false)), false);
    if (dryRun) {
      try {
        logDevSms_(
          String((ctx && ctx.phoneE164) || (workItem && workItem.phoneE164) || ""),
          "",
          "POLICY_DRYRUN event=" + ev + " rule=" + String(plan.ruleId || "") + " workItemId=" + wiId + " plan=" + (JSON.stringify(plan).slice(0, 500))
        );
      } catch (_) {}
      withWriteLock_("POLICY_EVENT_LOG_DRYRUN", function () {
        policyLogEventRow_(
          ev,
          p,
          wiId,
          String(plan.ruleId || ""),
          "DRYRUN_WOULD_EXECUTE",
          facts,
          plan,
          idem,
          "POLICY_ENGINE",
          "dry run"
        );
      });
      return { ackOwned: false, ackSent: false, dryRun: true, ruleId: String(plan.ruleId || "") };
    }

    if (idem) {
      if (policyHasIdempotencyKey_(idem)) {
        try { logDevSms_(String((ctx && ctx.phoneE164) || (workItem && workItem.phoneE164) || ""), "", "POLICY_IDEMPOTENT_SKIP event=[" + ev + "] wi=[" + wiId + "] idem=[" + idem + "]"); } catch (_) {}
        return noAck;
      }
      policyReserveIdempotencyKey_(idem);
    }

    var execResult = executePolicyPlan_(plan, ctx || {}, workItem || {}, propCode || "", now);
    return (execResult && typeof execResult === "object")
      ? { ackOwned: !!execResult.ackOwned, ackSent: !!execResult.ackSent, ruleId: String(execResult.ruleId || "") }
      : noAck;
  } catch (e) {
    try {
      logDevSms_(
        String((ctx && ctx.phoneE164) || (workItem && workItem.phoneE164) || ""),
        "",
        "POLICY_RUN_ERR event=[" + String(eventType || "") + "] prop=[" + String(propCode || "") + "] err=[" + String(e && e.message ? e.message : e) + "]"
      );
    } catch (_) {}
    return noAck;
  }
}

function testPolicyEngineDryRun_() {
  var now = new Date();
  var ctx = { phoneE164: "+10000000000", lang: "en" };
  var wi = {
    workItemId: "WI_DRYRUN",
    state: "STAFF_TRIAGE",
    phoneE164: "+10000000000",
    propertyId: "GLOBAL",
    metadataJson: "{}",
    createdAt: new Date(now.getTime() - 30 * 60000)
  };
  var plan = policyEvaluate_("WORKITEM_CREATED", ctx, wi, "GLOBAL", now);
  try { logDevSms_(ctx.phoneE164, "", "POLICY_DRYRUN_PLAN " + JSON.stringify(plan || {}).slice(0, 1000)); } catch (_) {}
  return plan;
}

/**
 * Admin-only: create PolicyRules, PolicyTimers, PolicyEventLog sheets and seed default rules if empty.
 * Call once per spreadsheet to initialize policy engine; not used on request hot path.
 */
function adminInitPolicySheets_() {
  seedPolicyEngineSheets_();
}

/**
 * adminPrintEffectivePolicy_(propCode)
 * Prints effective policy values for rollout checks.
 */
function adminPrintEffectivePolicy_(propCode) {
  var p = String(propCode || "").trim().toUpperCase();
  if (!p) throw new Error("adminPrintEffectivePolicy_: propCode required");

  var keys = [
    "POLICY_ENGINE_ENABLED",
    "POLICY_ENGINE_DRY_RUN",
    "ASSIGN_DEFAULT_OWNER",
    "SCHED_EARLIEST_HOUR",
    "SCHED_LATEST_HOUR",
    "SCHED_ALLOW_WEEKENDS",
    "SCHED_MIN_LEAD_HOURS",
    "SCHED_MAX_DAYS_OUT"
  ];

  var now = new Date();
  var out = [];
  out.push("Effective Policy @ " + policyNowIso_(now));
  out.push("Property = " + p);
  out.push("--------------------------------");

  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var fallback =
      (k === "POLICY_ENGINE_ENABLED") ? false :
      (k === "POLICY_ENGINE_DRY_RUN") ? false :
      (k === "ASSIGN_DEFAULT_OWNER") ? "QUEUE_TRIAGE" :
      (k === "SCHED_EARLIEST_HOUR") ? 9 :
      (k === "SCHED_LATEST_HOUR") ? 18 :
      (k === "SCHED_ALLOW_WEEKENDS") ? false :
      (k === "SCHED_MIN_LEAD_HOURS") ? 12 :
      (k === "SCHED_MAX_DAYS_OUT") ? 14 :
      "";
    var v = ppGet_(p, k, fallback);
    out.push(k + " = " + String(v));
  }

  var txt = out.join("\n");
  try { Logger.log(txt); } catch (_) {}
  return txt;
}
