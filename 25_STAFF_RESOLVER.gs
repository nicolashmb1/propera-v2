/**
 * STAFF_RESOLVER.gs — Propera Compass
 *
 * Cohesive group: STAFF RUNTIME ENGINE (Pack C)
 * Ownership:
 * - Staff responsibility resolution and assignment policy.
 * - No staff free-text lifecycle command parsing in this file.
 *
 * Phase 1: Staff Directory + Responsibility Resolver
 * Revision 2 — integration-aligned
 *
 * Changes from Rev 1:
 *   [FIX-1] Resolver output passed INTO workItemCreate_() — no post-creation sheet writes
 *   [FIX-2] srWriteWorkItemOwner_() removed — workItemCreate_() is the single write path
 *   [FIX-3] policyLogEventRow_() reused for assignment logging — no parallel log path
 *   [FIX-4] Property normalized through getPropertyIdByCode_() / getActiveProperties_()
 *   [FIX-5] adminInitStaffResolverSheets_() validates existing headers, fails loudly on mismatch
 *
 * Sheets owned by this module:
 *   StaffAssignments  — who does what role, at which property, in which domain
 *   RoutingRules      — for a given property+domain, which role handles it first
 *
 * Sheets consumed (read-only):
 *   Staff             — StaffId, StaffName, ContactId, Active
 *   Contacts          — ContactID, PhoneE164, Name, PreferredLang, PreferredChannel(optional)
 *   Properties        — PropertyID, PropertyCode (via getActiveProperties_)
 *
 * Public API:
 *   resolveResponsibleParty_(ctx)        — returns responsibility object or null
 *   srBuildWorkItemOwnerPatch_(ctx)       — returns patch object for workItemCreate_()
 *   srLogAssignmentEvent_(wiId, result)   — logs decision to PolicyEventLog
 *   adminInitStaffResolverSheets_()       — one-time sheet + seed setup
 */

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

var SR_STAFF_SHEET_         = "Staff";
var SR_CONTACTS_SHEET_      = "Contacts";
var SR_ASSIGNMENTS_SHEET_   = "StaffAssignments";
var SR_ROUTING_RULES_SHEET_ = "RoutingRules";

var SR_DOMAINS_ = {
  MAINTENANCE:       "MAINTENANCE",
  CLEANING:          "CLEANING",
  LEASING:           "LEASING",
  AMENITIES:         "AMENITIES",
  TURNOVER:          "TURNOVER",
  COMMUNICATIONS:    "COMMUNICATIONS",
  RULES_ENFORCEMENT: "RULES_ENFORCEMENT",
  GENERAL:           "GENERAL"
};

// Role fallback order when no routing rule matches
var SR_ROLE_FALLBACK_ORDER_ = ["SUPER", "MAINTENANCE", "PM", "OWNER"];

// ─────────────────────────────────────────────
// REQUIRED HEADERS — used for FIX-5 validation
// ─────────────────────────────────────────────

var SR_ASSIGNMENTS_HEADERS_ = [
  "AssignmentId", "StaffId", "PropertyId", "PropertyCode",
  "RoleType", "Domain", "Priority", "IsPrimary",
  "HoursJson", "EscalatesToStaffId", "Active", "UpdatedAt"
];

var SR_ROUTING_RULES_HEADERS_ = [
  "RuleId", "Enabled", "ScopeProperty", "Domain",
  "PreferredRole", "FallbackRole", "AfterHoursRole", "EscalationRole",
  "Notes", "UpdatedAt"
];

// ─────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────

function srGetSheet_(name) {
  if (typeof getSheet_ === "function") {
    try { return getSheet_(name); } catch (_) {}
  }
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error("SR: sheet not found: " + name);
  return sh;
}

function srGetOrCreateSheet_(name, headers) {
  if (typeof getOrCreateSheet_ === "function") {
    try { getOrCreateSheet_(name, headers); return srGetSheet_(name); } catch (_) {}
  }
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}

function srHeaderMap_(sheet) {
  if (typeof getHeaderMap_ === "function") {
    try { return getHeaderMap_(sheet); } catch (_) {}
  }
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var raw = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < raw.length; i++) {
    var h = String(raw[i] || "").trim();
    if (h) map[h] = i + 1;
  }
  return map;
}

function srSafeStr_(v) { return String(v == null ? "" : v).trim(); }

function srToBool_(v) {
  var s = srSafeStr_(v).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function srLog_(msg) {
  try {
    if (typeof logDevSms_ === "function") logDevSms_("(sr)", "", String(msg || ""));
    else Logger.log("[SR] " + String(msg || ""));
  } catch (_) {}
}

// ─────────────────────────────────────────────
// FIX-4: PROPERTY NORMALIZATION
// Uses existing Compass helpers — no ad-hoc matching.
// ─────────────────────────────────────────────

function srNormalizeProperty_(input) {
  var raw = srSafeStr_(input).toUpperCase();
  if (!raw) return null;

  // Preferred: getActiveProperties_ (in-memory cached)
  if (typeof getActiveProperties_ === "function") {
    try {
      var list = getActiveProperties_() || [];
      for (var i = 0; i < list.length; i++) {
        var p   = list[i];
        var pid  = srSafeStr_(p.propertyId).toUpperCase();
        var code = srSafeStr_(p.code).toUpperCase();
        if (pid === raw || code === raw) return { propertyId: pid, propertyCode: code };
      }
    } catch (_) {}
  }

  // Fallback: getPropertyByNameOrCode_
  if (typeof getPropertyByNameOrCode_ === "function") {
    try {
      var res = getPropertyByNameOrCode_(input);
      if (res && res.propertyId) {
        return {
          propertyId:  srSafeStr_(res.propertyId).toUpperCase(),
          propertyCode: srSafeStr_(res.code || res.propertyCode || "").toUpperCase()
        };
      }
    } catch (_) {}
  }

  // Last resort: getPropertyIdByCode_
  if (typeof getPropertyIdByCode_ === "function") {
    try {
      var pid2 = getPropertyIdByCode_(input);
      if (pid2) return { propertyId: srSafeStr_(pid2).toUpperCase(), propertyCode: raw };
    } catch (_) {}
  }

  return null;
}

// ─────────────────────────────────────────────
// AFTER-HOURS CHECK
// ─────────────────────────────────────────────

/**
 * Returns true if now is outside the HoursJson window.
 * HoursJson: { "start": 8, "end": 20, "days": [1,2,3,4,5] }
 * days: 1=Mon..7=Sun (ISO weekday). Defaults to 8-20 Mon-Fri.
 */
function srIsAfterHours_(hoursJson, now) {
  var when  = now instanceof Date ? now : new Date();
  var hours = { start: 8, end: 20, days: [1, 2, 3, 4, 5] };

  if (hoursJson) {
    try {
      var p = typeof hoursJson === "object" ? hoursJson : JSON.parse(String(hoursJson));
      if (p && typeof p === "object") {
        if (typeof p.start === "number") hours.start = p.start;
        if (typeof p.end   === "number") hours.end   = p.end;
        if (Array.isArray(p.days))       hours.days  = p.days;
      }
    } catch (_) {}
  }

  try {
    var tz  = Session.getScriptTimeZone ? Session.getScriptTimeZone() : "Etc/GMT";
    var h   = Number(Utilities.formatDate(when, tz, "H"));
    var dow = Number(Utilities.formatDate(when, tz, "u"));
    if (!isFinite(h))   h   = when.getHours();
    if (!isFinite(dow)) { var d = when.getDay(); dow = d === 0 ? 7 : d; }
    return !(hours.days.indexOf(dow) >= 0 && h >= hours.start && h < hours.end);
  } catch (_) { return false; }
}

// ─────────────────────────────────────────────
// DATA LOADERS (cached)
// ─────────────────────────────────────────────

function srLoadAssignments_() {
  var key = "sr_assignments_v2";
  try { var c = CacheService.getScriptCache().get(key); if (c) return JSON.parse(c); } catch (_) {}

  var sh      = srGetSheet_(SR_ASSIGNMENTS_SHEET_);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  var map  = srHeaderMap_(sh);
  var data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var out  = [];

  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!srToBool_(r[map["Active"] - 1])) continue;
    out.push({
      assignmentId: srSafeStr_(r[map["AssignmentId"]       - 1]),
      staffId:      srSafeStr_(r[map["StaffId"]            - 1]),
      propertyId:   srSafeStr_(r[map["PropertyId"]         - 1]).toUpperCase(),
      propertyCode: srSafeStr_(r[map["PropertyCode"]       - 1]).toUpperCase(),
      roleType:     srSafeStr_(r[map["RoleType"]           - 1]).toUpperCase(),
      domain:       srSafeStr_(r[map["Domain"]             - 1]).toUpperCase(),
      priority:     parseInt(srSafeStr_(r[map["Priority"]  - 1]), 10) || 99,
      isPrimary:    srToBool_(r[map["IsPrimary"]           - 1]),
      hoursJson:    srSafeStr_(r[map["HoursJson"]          - 1]),
      escalatesTo:  srSafeStr_(r[map["EscalatesToStaffId"] - 1])
    });
  }

  try { CacheService.getScriptCache().put(key, JSON.stringify(out), 60); } catch (_) {}
  return out;
}

function srLoadRoutingRules_() {
  var key = "sr_routing_rules_v2";
  try { var c = CacheService.getScriptCache().get(key); if (c) return JSON.parse(c); } catch (_) {}

  var sh      = srGetSheet_(SR_ROUTING_RULES_SHEET_);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  var map  = srHeaderMap_(sh);
  var data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var out  = [];

  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!srToBool_(r[map["Enabled"] - 1])) continue;
    out.push({
      ruleId:         srSafeStr_(r[map["RuleId"]         - 1]),
      scopeProperty:  srSafeStr_(r[map["ScopeProperty"]  - 1]).toUpperCase(),
      domain:         srSafeStr_(r[map["Domain"]         - 1]).toUpperCase(),
      preferredRole:  srSafeStr_(r[map["PreferredRole"]  - 1]).toUpperCase(),
      fallbackRole:   srSafeStr_(r[map["FallbackRole"]   - 1]).toUpperCase(),
      afterHoursRole: srSafeStr_(r[map["AfterHoursRole"] - 1]).toUpperCase(),
      escalationRole: srSafeStr_(r[map["EscalationRole"] - 1]).toUpperCase()
    });
  }

  try { CacheService.getScriptCache().put(key, JSON.stringify(out), 120); } catch (_) {}
  return out;
}

/**
 * Load staff name + phone + lang by StaffId.
 * Joins Staff.ContactId -> Contacts.
 */
function srLoadStaffContact_(staffId) {
  if (!staffId) return null;
  try {
    var staffSh   = srGetSheet_(SR_STAFF_SHEET_);
    var staffLast = staffSh.getLastRow();
    if (staffLast < 2) return null;

    var sMap  = srHeaderMap_(staffSh);
    var sData = staffSh.getRange(2, 1, staffLast - 1, staffSh.getLastColumn()).getValues();
    var contactId = "";
    var staffName = "";
    var contactCol = sMap["ContactId"];
    var staffPreferredChannel = "";
    var staffPreferredChannelCol = sMap["PreferredChannel"] || sMap["preferred_channel"] || sMap["Preferred Channel"];

    for (var i = 0; i < sData.length; i++) {
      if (srSafeStr_(sData[i][sMap["StaffId"] - 1]) !== staffId) continue;
      if (!srToBool_(sData[i][sMap["Active"] - 1])) return null;
      if (contactCol) {
        contactId = srSafeStr_(sData[i][contactCol - 1]);
      } else {
        contactId = "";
      }
      staffName = srSafeStr_(sData[i][sMap["StaffName"] - 1]);
      if (staffPreferredChannelCol) staffPreferredChannel = srSafeStr_(sData[i][staffPreferredChannelCol - 1]).toUpperCase();
      break;
    }

    if (!staffName && !contactId) return null;
    if (!contactId) return { staffId: staffId, staffName: staffName, phoneE164: "", lang: "en", telegramChatId: "", preferredChannel: staffPreferredChannel };

    var cSh   = srGetSheet_(SR_CONTACTS_SHEET_);
    var cLast = cSh.getLastRow();
    if (cLast < 2) return { staffId: staffId, staffName: staffName, phoneE164: "", lang: "en", telegramChatId: "", preferredChannel: staffPreferredChannel };

    var cMap  = srHeaderMap_(cSh);
    var cData = cSh.getRange(2, 1, cLast - 1, cSh.getLastColumn()).getValues();
    var tgCol = (typeof contactsTelegramIdColumnIndexFromMap_ === "function") ? contactsTelegramIdColumnIndexFromMap_(cMap) : -1;
    var cPreferredChannelCol = cMap["PreferredChannel"] || cMap["preferred_channel"] || cMap["Preferred Channel"] || 0;

    for (var j = 0; j < cData.length; j++) {
      if (srSafeStr_(cData[j][cMap["ContactID"] - 1]) !== contactId) continue;
      var tgRaw = (tgCol >= 0) ? cData[j][tgCol] : "";
      var tgDigits = (typeof normalizeTelegramUserIdDigits_ === "function")
        ? normalizeTelegramUserIdDigits_(String(tgRaw != null ? tgRaw : ""))
        : String(tgRaw != null ? tgRaw : "").replace(/\D/g, "");
      var phoneVal = srSafeStr_(cData[j][cMap["PhoneE164"] - 1]);
      var tgFromPhoneE164 = "";
      var contactPreferredChannel = "";
      if (cPreferredChannelCol) contactPreferredChannel = srSafeStr_(cData[j][cPreferredChannelCol - 1]).toUpperCase();
      if (phoneVal && /^TG:/i.test(phoneVal)) {
        tgFromPhoneE164 = String(phoneVal.replace(/^TG:\s*/i, "").replace(/\D/g, "") || "");
      }
      var preferredChannel = staffPreferredChannel || contactPreferredChannel || "";
      return {
        staffId:   staffId,
        staffName: staffName || srSafeStr_(cData[j][cMap["Name"] - 1]),
        phoneE164: phoneVal,
        lang:      srSafeStr_(cData[j][cMap["PreferredLang"] - 1]) || "en",
        telegramChatId: (tgDigits || tgFromPhoneE164 || ""),
        preferredChannel: preferredChannel
      };
    }

    return { staffId: staffId, staffName: staffName, phoneE164: "", lang: "en", telegramChatId: "", preferredChannel: staffPreferredChannel };
  } catch (e) {
    srLog_("SR_LOAD_CONTACT_ERR staffId=[" + staffId + "] err=[" + String(e && e.message ? e.message : e) + "]");
    return null;
  }
}

/**
 * When outbound recipientRef is the inbound actor key (TG:…, whatsapp:…, E.164) instead of StaffId,
 * synthesize a minimal Staff sheet row shape so Outgate can deliver on the same channel.
 * Does not grant routing privileges — transport resolution only.
 */
function srResolveStaffOutboundFromActorRef_(actorRef) {
  var ref = String(actorRef || "").trim();
  if (!ref) return null;
  if (/^TG:/i.test(ref)) {
    var digits = ref.replace(/^TG:\s*/i, "").replace(/\D/g, "");
    if (!digits) return null;
    return {
      staffId: ref,
      staffName: "",
      phoneE164: ref,
      lang: "en",
      telegramChatId: digits,
      preferredChannel: "TELEGRAM"
    };
  }
  if (/^whatsapp:/i.test(ref)) {
    var wk = typeof phoneKey_ === "function" ? phoneKey_(ref) : ref;
    return {
      staffId: ref,
      staffName: "",
      phoneE164: wk || ref,
      lang: "en",
      telegramChatId: "",
      preferredChannel: "WA"
    };
  }
  var norm = typeof phoneKey_ === "function" ? phoneKey_(ref) : ref;
  if (norm && /^\+?\d{10,15}$/.test(String(norm).replace(/\s/g, ""))) {
    return {
      staffId: ref,
      staffName: "",
      phoneE164: String(norm).trim(),
      lang: "en",
      telegramChatId: "",
      preferredChannel: "SMS"
    };
  }
  return null;
}

// ─────────────────────────────────────────────
// ROUTING RULE MATCHER
// ─────────────────────────────────────────────

function srMatchRoutingRule_(propertyId, propertyCode, domain, rules) {
  var pid  = srSafeStr_(propertyId).toUpperCase();
  var code = srSafeStr_(propertyCode).toUpperCase();
  var dom  = srSafeStr_(domain).toUpperCase();
  var exact = null, global = null;

  for (var i = 0; i < rules.length; i++) {
    var r  = rules[i];
    var sp = r.scopeProperty;
    if (r.domain !== dom && r.domain !== "*") continue;
    if (sp === pid || sp === code) { if (!exact)  exact  = r; }
    else if (sp === "GLOBAL" || sp === "*")  { if (!global) global = r; }
  }

  return exact || global || null;
}

// ─────────────────────────────────────────────
// ASSIGNMENT FINDER
// ─────────────────────────────────────────────

function srFindAssignment_(propertyId, propertyCode, domain, roleType, afterHours, assignments) {
  var pid  = srSafeStr_(propertyId).toUpperCase();
  var code = srSafeStr_(propertyCode).toUpperCase();
  var dom  = srSafeStr_(domain).toUpperCase();
  var role = srSafeStr_(roleType).toUpperCase();
  var now  = new Date();
  var preferredMatches = [];
  var fallbackHourMatches = [];

  for (var i = 0; i < assignments.length; i++) {
    var a = assignments[i];
    var propMatch = (a.propertyId === pid || a.propertyCode === code || a.propertyId === "GLOBAL");
    if (!propMatch) continue;
    if (a.domain !== dom && a.domain !== "GENERAL") continue;
    if (a.roleType !== role) continue;
    if (afterHours && a.hoursJson && srIsAfterHours_(a.hoursJson, now)) {
      fallbackHourMatches.push(a);
    } else {
      preferredMatches.push(a);
    }
  }

  if (preferredMatches.length) {
    preferredMatches.sort(function (a, b) {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return a.priority - b.priority;
    });
    return preferredMatches[0];
  }

  if (!fallbackHourMatches.length) return null;

  fallbackHourMatches.sort(function (a, b) {
    if (a.isPrimary && !b.isPrimary) return -1;
    if (!a.isPrimary && b.isPrimary) return 1;
    return a.priority - b.priority;
  });

  return fallbackHourMatches[0];
}

// ─────────────────────────────────────────────
// KEEP-IN-LOOP BUILDER
// Conservative: PM-role only, owner not auto-included
// ─────────────────────────────────────────────

function srBuildKeepInLoop_(propertyId, propertyCode, resolvedStaffId, assignments) {
  var pid  = srSafeStr_(propertyId).toUpperCase();
  var code = srSafeStr_(propertyCode).toUpperCase();
  var loop = [];
  var seen = {};
  seen[srSafeStr_(resolvedStaffId)] = true;

  for (var i = 0; i < assignments.length; i++) {
    var a = assignments[i];
    if (a.roleType !== "PM") continue;
    var propMatch = (a.propertyId === pid || a.propertyCode === code || a.propertyId === "GLOBAL");
    if (!propMatch || seen[a.staffId]) continue;
    seen[a.staffId] = true;
    loop.push(a.staffId);
  }

  return loop;
}

// ─────────────────────────────────────────────
// MAIN RESOLVER
// ─────────────────────────────────────────────

/**
 * resolveResponsibleParty_(ctx)
 *
 * ctx: {
 *   propertyId:  string  — PropertyID or PropertyCode (required)
 *   domain:      string  — one of SR_DOMAINS_ keys (required)
 *   afterHours:  boolean — optional; auto-detected from current time if omitted
 *   workItemId:  string  — optional, for logging only
 * }
 *
 * Returns: {
 *   staffId, staffName, phoneE164, lang,
 *   roleType, domain, propertyId, propertyCode,
 *   reason, matchedRuleId, escalatesTo, keepInLoop, afterHours
 * }
 * Returns null if no responsible party found.
 */
function resolveResponsibleParty_(ctx) {
  try {
    var rawInput   = srSafeStr_((ctx && ctx.propertyId) || "");
    var domain     = srSafeStr_((ctx && ctx.domain)     || "").toUpperCase();
    var workItemId = srSafeStr_((ctx && ctx.workItemId) || "");

    if (!rawInput) {
      srLog_("SR_RESOLVE_ERR reason=[MISSING_PROPERTY] wi=[" + workItemId + "]");
      return null;
    }
    if (!domain || !SR_DOMAINS_[domain]) {
      srLog_("SR_RESOLVE_ERR reason=[INVALID_DOMAIN] domain=[" + domain + "] wi=[" + workItemId + "]");
      return null;
    }

    // FIX-4: canonical normalization
    var prop = srNormalizeProperty_(rawInput);
    if (!prop) {
      srLog_("SR_RESOLVE_ERR reason=[UNKNOWN_PROPERTY] input=[" + rawInput + "] wi=[" + workItemId + "]");
      return null;
    }

    var afterHours = (ctx && typeof ctx.afterHours === "boolean")
      ? ctx.afterHours
      : srIsAfterHours_(null, new Date());

    var assignments  = srLoadAssignments_();
    var routingRules = srLoadRoutingRules_();

    var rule          = srMatchRoutingRule_(prop.propertyId, prop.propertyCode, domain, routingRules);
    var matchedRuleId = rule ? rule.ruleId : "NONE";

    // Build role sequence
    var roleSeq = [];
    if (rule) {
      var primary = afterHours ? (rule.afterHoursRole || rule.preferredRole) : rule.preferredRole;
      if (primary)              roleSeq.push(primary);
      if (rule.fallbackRole)    roleSeq.push(rule.fallbackRole);
      if (rule.escalationRole)  roleSeq.push(rule.escalationRole);
    } else {
      roleSeq = SR_ROLE_FALLBACK_ORDER_.slice();
    }

    // Deduplicate
    var seen = {}, uniqueRoles = [];
    for (var ri = 0; ri < roleSeq.length; ri++) {
      var rr = roleSeq[ri];
      if (rr && !seen[rr]) { seen[rr] = true; uniqueRoles.push(rr); }
    }

    // Find best assignment
    var resolved = null, resolvedRole = "", reason = "";

    for (var i = 0; i < uniqueRoles.length; i++) {
      var tryRole = uniqueRoles[i];
      var found   = srFindAssignment_(prop.propertyId, prop.propertyCode, domain, tryRole, afterHours, assignments);
      if (found) {
        resolved     = found;
        resolvedRole = tryRole;
        reason       = (i === 0)
          ? (rule ? "ROUTING_RULE_PRIMARY" : "DEFAULT_FALLBACK_PRIMARY")
          : "FALLBACK_ROLE_" + tryRole;
        break;
      }
    }

    if (!resolved) {
      srLog_("SR_RESOLVE_NO_MATCH prop=[" + prop.propertyId + "] domain=[" + domain + "] afterHours=[" + afterHours + "] wi=[" + workItemId + "]");
      return null;
    }

    var contact    = srLoadStaffContact_(resolved.staffId);
    var keepInLoop = srBuildKeepInLoop_(prop.propertyId, prop.propertyCode, resolved.staffId, assignments);

    var result = {
      staffId:       resolved.staffId,
      staffName:     contact ? contact.staffName : resolved.staffId,
      phoneE164:     contact ? contact.phoneE164 : "",
      lang:          contact ? contact.lang      : "en",
      roleType:      resolvedRole,
      domain:        domain,
      propertyId:    prop.propertyId,
      propertyCode:  prop.propertyCode,
      reason:        reason,
      matchedRuleId: matchedRuleId,
      escalatesTo:   resolved.escalatesTo || "",
      keepInLoop:    keepInLoop,
      afterHours:    afterHours
    };

    srLog_(
      "SR_RESOLVED prop=[" + prop.propertyId + "] domain=[" + domain + "]" +
      " role=[" + resolvedRole + "] staff=[" + result.staffName + "]" +
      " reason=[" + reason + "] rule=[" + matchedRuleId + "] wi=[" + workItemId + "]"
    );

    return result;

  } catch (e) {
    srLog_("SR_RESOLVE_ERR err=[" + String(e && e.message ? e.message : e) + "] wi=[" + srSafeStr_(ctx && ctx.workItemId) + "]");
    return null;
  }
}

// ─────────────────────────────────────────────
// FIX-1 + FIX-2: PRE-CREATION PATCH BUILDER
// Resolver fires BEFORE workItemCreate_().
// No post-creation sheet writes anywhere in this file.
// ─────────────────────────────────────────────

/**
 * srBuildWorkItemOwnerPatch_(ctx)
 *
 * Call BEFORE workItemCreate_(). Spread the returned patch into the create object.
 * Returns {} on failure — workItemCreate_() writes empty strings, which is safe.
 *
 * Usage:
 *
 *   var ownerPatch = srBuildWorkItemOwnerPatch_({
 *     propertyId: propId,
 *     domain:     "MAINTENANCE"
 *   });
 *
 *   var wiId = workItemCreate_({
 *     type:             "MAINTENANCE_REQUEST",
 *     phoneE164:        phone,
 *     propertyId:       propId,
 *     metadataJson:     JSON.stringify(meta),
 *     ownerType:        ownerPatch.ownerType        || "",
 *     ownerId:          ownerPatch.ownerId           || "",
 *     assignedByPolicy: ownerPatch.assignedByPolicy  || "",
 *     assignedAt:       ownerPatch.assignedAt        || ""
 *   });
 *
 *   // Log the decision after create (workItemId now known)
 *   if (ownerPatch._resolverResult) {
 *     srLogAssignmentEvent_(wiId, ownerPatch._resolverResult);
 *   }
 */
function srBuildWorkItemOwnerPatch_(ctx) {
  var result = resolveResponsibleParty_(ctx);
  if (!result) return {};

  return {
    ownerType:        "STAFF",
    ownerId:          result.staffId,
    assignedByPolicy: "STAFF_RESOLVER",
    assignedAt:       new Date(),
    _resolverResult:  result   // not written to sheet — passed to srLogAssignmentEvent_ only
  };
}

// ─────────────────────────────────────────────
// FIX-3: POLICY EVENT LOG
// Reuses policyLogEventRow_() — no parallel log path.
// ─────────────────────────────────────────────

/**
 * srLogAssignmentEvent_(workItemId, resolverResult)
 *
 * Call after workItemCreate_() returns the new workItemId.
 * Uses policyLogEventRow_() so assignment decisions appear in PolicyEventLog
 * alongside all other policy events.
 */
function srLogAssignmentEvent_(workItemId, resolverResult) {
  try {
    if (typeof policyLogEventRow_ !== "function") return;
    if (!resolverResult) return;

    policyLogEventRow_(
      "WORKITEM_ASSIGNED",
      String(resolverResult.propertyId    || ""),
      String(workItemId                   || ""),
      String(resolverResult.matchedRuleId || "NONE"),
      "RESOLVED",
      {
        domain:     resolverResult.domain,
        roleType:   resolverResult.roleType,
        afterHours: resolverResult.afterHours,
        reason:     resolverResult.reason
      },
      {
        staffId:     resolverResult.staffId,
        staffName:   resolverResult.staffName,
        escalatesTo: resolverResult.escalatesTo,
        keepInLoop:  resolverResult.keepInLoop
      },
      "SR:" + String(workItemId || ""),
      "STAFF_RESOLVER",
      resolverResult.reason
    );
  } catch (e) {
    srLog_("SR_LOG_EVENT_ERR wi=[" + String(workItemId || "") + "] err=[" + String(e && e.message ? e.message : e) + "]");
  }
}

// ─────────────────────────────────────────────
// CACHE INVALIDATION
// ─────────────────────────────────────────────

function srInvalidateCache_() {
  try {
    CacheService.getScriptCache().removeAll(["sr_assignments_v2", "sr_routing_rules_v2"]);
    srLog_("SR_CACHE_INVALIDATED");
  } catch (_) {}
}

// ─────────────────────────────────────────────
// FIX-5: ADMIN INIT WITH HEADER VALIDATION
// ─────────────────────────────────────────────

/**
 * Validates existing sheet headers against required list.
 * Throws loudly on mismatch — fail at init, not silently at runtime.
 */
function srValidateHeaders_(sheet, requiredHeaders, sheetName) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) throw new Error("SR_HEADER_VALIDATE: [" + sheetName + "] has no columns");

  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return srSafeStr_(h);
  });

  var missing = requiredHeaders.filter(function (h) {
    return existing.indexOf(h) < 0;
  });

  if (missing.length > 0) {
    throw new Error(
      "SR_HEADER_VALIDATE: [" + sheetName + "] missing: " + missing.join(", ") +
      " | found: " + existing.filter(Boolean).join(", ")
    );
  }
}

/**
 * adminInitStaffResolverSheets_()
 *
 * One-time setup — run from Apps Script editor.
 *   1. Creates StaffAssignments (or validates headers if it exists)
 *   2. Creates RoutingRules (or validates headers if it exists)
 *   3. Adds ContactId column to Staff if missing
 *   4. Seeds 6 default RoutingRules rows if sheet is empty
 *
 * Safe to re-run. Will not overwrite existing data.
 * Not used on hot path.
 */
function adminInitStaffResolverSheets_() {
  withWriteLock_("SR_ADMIN_INIT", function () {

    // 1. StaffAssignments
    var asSh = srGetOrCreateSheet_(SR_ASSIGNMENTS_SHEET_, SR_ASSIGNMENTS_HEADERS_);
    if (asSh.getLastRow() >= 1) srValidateHeaders_(asSh, SR_ASSIGNMENTS_HEADERS_, SR_ASSIGNMENTS_SHEET_);
    srLog_("SR_ADMIN_INIT sheet=[StaffAssignments] ok");

    // 2. RoutingRules
    var rrSh = srGetOrCreateSheet_(SR_ROUTING_RULES_SHEET_, SR_ROUTING_RULES_HEADERS_);
    if (rrSh.getLastRow() >= 1) srValidateHeaders_(rrSh, SR_ROUTING_RULES_HEADERS_, SR_ROUTING_RULES_SHEET_);
    srLog_("SR_ADMIN_INIT sheet=[RoutingRules] ok");

    // 3. Extend Staff with ContactId if missing
    try {
      var staffSh  = srGetSheet_(SR_STAFF_SHEET_);
      var staffMap = srHeaderMap_(staffSh);
      if (!staffMap["ContactId"]) {
        staffSh.getRange(1, staffSh.getLastColumn() + 1).setValue("ContactId");
        srLog_("SR_ADMIN_INIT added ContactId to Staff");
      }
    } catch (e) {
      srLog_("SR_ADMIN_INIT staff_extend_err=[" + String(e && e.message ? e.message : e) + "]");
    }

    // 4. Seed default RoutingRules if empty
    if (rrSh.getLastRow() < 2) {
      var now  = new Date();
      var seed = [
        ["RR-001", true, "GLOBAL", "MAINTENANCE",       "SUPER",   "PM",    "PM",    "PM",    "Maintenance → Super first, PM fallback",   now],
        ["RR-002", true, "GLOBAL", "CLEANING",          "JANITOR", "SUPER", "SUPER", "PM",    "Cleaning → Janitor first, Super fallback", now],
        ["RR-003", true, "GLOBAL", "LEASING",           "LEASING", "PM",    "PM",    "PM",    "Leasing → Leasing agent first",            now],
        ["RR-004", true, "GLOBAL", "RULES_ENFORCEMENT", "SUPER",   "PM",    "PM",    "PM",    "Rules enforcement → Super first",          now],
        ["RR-005", true, "GLOBAL", "AMENITIES",         "SUPER",   "PM",    "PM",    "PM",    "Amenity issues → Super first",             now],
        ["RR-006", true, "GLOBAL", "GENERAL",           "PM",      "PM",    "PM",    "OWNER", "General/unclassified → PM",                now]
      ];
      rrSh.getRange(2, 1, seed.length, seed[0].length).setValues(seed);
      srLog_("SR_ADMIN_INIT seeded " + seed.length + " RoutingRules");
    }

  });

  srLog_("SR_ADMIN_INIT complete");
}

// ─────────────────────────────────────────────
// TEST / DIAGNOSTIC
// ─────────────────────────────────────────────

/**
 * srTestResolve_(propertyId, domain)
 * Read-only diagnostic. Run from editor to verify resolver.
 * Example: srTestResolve_("PENN", "MAINTENANCE")
 */
function srTestResolve_(propertyId, domain) {
  var result = resolveResponsibleParty_({
    propertyId: propertyId || "PENN",
    domain:     domain     || "MAINTENANCE",
    workItemId: "TEST_DRY_RUN"
  });
  try { Logger.log(JSON.stringify(result, null, 2)); } catch (_) {}
  return result;
}

// ============================================================================
// PACK C ADDITIONS (moved from STAFF_LIFECYCLE_COMMAND_RESOLVER.gs)
// ============================================================================

/**
 * Normalize Telegram actor id for Contacts.PhoneE164 matching.
 * Store in sheet as TG:<telegram_user_id> (digits only after prefix). Inbound From uses same shape.
 * @param {string} raw - e.g. "TG:123456789" or "tg: 123456789"
 * @returns {string} Canonical "TG:<digits>" or "" if not a TG actor
 */
function normalizeTelegramActorKeyForStaff_(raw) {
  var s = String(raw || "").trim();
  if (!/^TG:/i.test(s)) return "";
  var id = s.replace(/^TG:\s*/i, "").replace(/\D/g, "");
  if (!id) return "";
  return "TG:" + id;
}

/** Digits-only Telegram user id for comparison (accepts "123", "TG:123", pasted values). */
function normalizeTelegramUserIdDigits_(raw) {
  var s = String(raw || "").trim();
  if (!s) return "";
  if (/^TG:/i.test(s)) s = s.replace(/^TG:\s*/i, "");
  return s.replace(/\D/g, "");
}

/**
 * Telegram ID matcher tolerant to a leading "1" prefix in stored sheet values.
 * Example: inbound "7108534136" should match stored "17108534136".
 */
function telegramUserIdEqualsLoose_(aRaw, bRaw) {
  var a = normalizeTelegramUserIdDigits_(aRaw);
  var b = normalizeTelegramUserIdDigits_(bRaw);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length > 1 && a.charAt(0) === "1" && a.slice(1) === b) return true;
  if (b.length > 1 && b.charAt(0) === "1" && b.slice(1) === a) return true;
  return false;
}

/**
 * 0-based column index for Contacts.TelegramID (optional column at end of sheet).
 * Header names tried: TelegramID, TelegramId, telegram_id, Telegram ID.
 */
function contactsTelegramIdColumnIndexFromMap_(cMap) {
  if (!cMap || typeof cMap !== "object") return -1;
  var keys = ["TelegramID", "TelegramId", "telegram_id", "Telegram ID", "telegramID"];
  for (var k = 0; k < keys.length; k++) {
    var col = cMap[keys[k]];
    if (col != null && col >= 1) return col - 1;
  }
  return -1;
}

/**
 * Returns true if phone belongs to staff (canonical: Staff + Contacts). Only contacts linked via Staff.ContactId.
 * Supports E.164 in PhoneE164; Telegram inbound via Contacts.PhoneE164 = TG:userId and/or optional Contacts.TelegramID (numeric id).
 * Tenant Telegram senders must not use TG:userId in PhoneE164 on Staff-linked Contacts rows or they will hit the staff front door.
 */
function isStaffSender_(phone) {
  if (!phone) return false;
  var raw = String(phone).trim();
  var inboundTg = normalizeTelegramActorKeyForStaff_(raw);
  var inboundTgDigits = inboundTg ? inboundTg.replace(/^TG:/i, "") : "";
  var normalized = inboundTg
    ? ""
    : (typeof normalizePhone_ === "function" ? normalizePhone_(raw) : raw);
  if (!inboundTg && !normalized) return false;
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
    var tgIdCol = contactsTelegramIdColumnIndexFromMap_(cMap);
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
      var tgCell = tgIdCol >= 0 ? String(cData[i][tgIdCol] != null ? cData[i][tgIdCol] : "").trim() : "";
      if (inboundTg) {
        var cellTg = normalizeTelegramActorKeyForStaff_(p);
        if (cellTg && cellTg === inboundTg) return true;
        if (tgCell && telegramUserIdEqualsLoose_(tgCell, inboundTgDigits)) return true;
        continue;
      }
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
  var raw = String(phone).trim();
  var inboundTg = normalizeTelegramActorKeyForStaff_(raw);
  var normalized = inboundTg
    ? ""
    : (typeof normalizePhone_ === "function" ? normalizePhone_(raw) : raw);
  if (!inboundTg && !normalized) return null;
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
    var tgIdCol = contactsTelegramIdColumnIndexFromMap_(cMap);
    var inboundTgDigits = inboundTg ? inboundTg.replace(/^TG:/i, "") : "";
    var cNumRows = cLast - 1;
    if (cNumRows < 1) return null;
    var cData = contactsSh.getRange(2, 1, cNumRows, contactsSh.getLastColumn()).getValues();
    var contactId = null;
    for (var i = 0; i < cData.length; i++) {
      var p = String(cData[i][phoneCol] != null ? cData[i][phoneCol] : "").trim();
      var tgCell = tgIdCol >= 0 ? String(cData[i][tgIdCol] != null ? cData[i][tgIdCol] : "").trim() : "";
      if (inboundTg) {
        var cellTg = normalizeTelegramActorKeyForStaff_(p);
        if (cellTg && cellTg === inboundTg) {
          contactId = String(cData[i][contactIdCol] || "").trim();
          break;
        }
        if (tgCell && telegramUserIdEqualsLoose_(tgCell, inboundTgDigits)) {
          contactId = String(cData[i][contactIdCol] || "").trim();
          break;
        }
        continue;
      }
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

function lifecycleExtractUnitFromBody_(body) {
  var t = String(body || "").trim();
  var m = t.match(/^([0-9]+[a-z]?)\b/i) ||
          t.match(/\b(?:unit|apt|#|no\.?)\s*[:\s]*([a-z0-9\-]+)/i) ||
          t.match(/\b([0-9]+[a-z]?)\s+(?:[a-z]{2,5}\s+)?/i) ||
          t.match(/\b([0-9]+[a-z]?)\s+/i) ||
          t.match(/\b([0-9]+[a-z]?)\s*$/i);
  return m ? String(m[1] || "").trim() : "";
}

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

function lifecycleExtractPropertyHintFromBody_(body) {
  var t = String(body || "").trim();
  var known = lifecycleKnownPropertyCodes_();
  var code, m, re;
  re = /\b([A-Za-z]{2,10})\s+[0-9]/g;
  while ((m = re.exec(t)) !== null) {
    code = String(m[1] || "").trim().toUpperCase();
    if (known[code]) return lifecyclePropertyCodeFromHint_(code) || code;
  }
  re = /\b([0-9]+[a-z]?)\s+([A-Za-z]{2,10})\b/gi;
  while ((m = re.exec(t)) !== null) {
    code = String(m[2] || "").trim().toUpperCase();
    if (known[code]) return lifecyclePropertyCodeFromHint_(code) || code;
  }
  re = /\b([A-Za-z]{2,10})\b/g;
  while ((m = re.exec(t)) !== null) {
    code = String(m[1] || "").trim().toUpperCase();
    if (known[code]) return lifecyclePropertyCodeFromHint_(code) || code;
  }
  return "";
}

function lifecycleExtractWorkItemIdHintFromBody_(body) {
  var t = String(body || "").trim();
  var wiPrefix = t.match(/\b(WI_[a-zA-Z0-9]+)\b/i);
  if (wiPrefix) return String(wiPrefix[1] || "").trim();
  var suffix = t.match(/\b([a-zA-Z0-9]{8,})\b/);
  return suffix ? String(suffix[1] || "").trim() : "";
}

var STAFF_RESOLVER_SCORE_THRESHOLD_ = 0.3;
var STAFF_RESOLVER_SCORE_MARGIN_ = 0.2;

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

var STAFF_RESOLVER_MAX_SUGGESTED_PROMPTS_ = 5;

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

  if (/\bsink\b/.test(t)) addOnce(fixtures, "SINK");
  if (/\b(fridge|refrigerator)\b/.test(t)) addOnce(fixtures, "REFRIGERATOR");
  if (/\btoilet\b/.test(t)) addOnce(fixtures, "TOILET");
  if (/\b(tub|bathtub)\b/.test(t)) addOnce(fixtures, "BATHTUB");
  if (/\bshower\b/.test(t)) addOnce(fixtures, "SHOWER");
  if (/\boutlet\b/.test(t)) addOnce(fixtures, "OUTLET");
  if (/\bwasher\b/.test(t)) addOnce(fixtures, "WASHER");
  if (/\bdryer\b/.test(t)) addOnce(fixtures, "DRYER");
  if (/\bstove|oven\b/.test(t)) addOnce(fixtures, "STOVE");

  if (/\bclogged\b/.test(t)) addOnce(modifiers, "CLOGGED");
  if (/\bleak(s|ing)?\b/.test(t)) addOnce(modifiers, "LEAKING");
  if (/\bnot working\b/.test(t)) addOnce(modifiers, "NOT_WORKING");
  if (/\bno (hot )?water\b/.test(t)) addOnce(modifiers, "NO_WATER");
  if (/\b(no heat|heat(ing)? isn'?t working)\b/.test(t)) addOnce(modifiers, "NO_HEAT");

  return { fixtures: fixtures, modifiers: modifiers };
}

function lifecycleResolveTargetWiForStaff_(phone, bodyTrim) {
  var body = String(bodyTrim || "").trim();
  var staffId = lifecycleResolveStaffIdByPhone_(phone);
  if (!staffId) return { wiId: "", reason: "CLARIFICATION" };

  var openWis = lifecycleListOpenWisForOwner_(staffId);
  if (openWis.length === 0) return { wiId: "", reason: "CLARIFICATION" };
  if (openWis.length === 1) return { wiId: openWis[0].workItemId, reason: "OWNER_MATCH" };

  var wiIdHint = lifecycleExtractWorkItemIdHintFromBody_(body);
  if (wiIdHint) {
    var hintUpper = String(wiIdHint).toUpperCase();
    var byId = openWis.filter(function (w) {
      var id = String(w.workItemId || "").toUpperCase();
      return id === hintUpper || id.indexOf(hintUpper) >= 0 || id.lastIndexOf(hintUpper) === id.length - hintUpper.length;
    });
    if (byId.length === 1) return { wiId: byId[0].workItemId, reason: "WI_ID_MATCH" };
  }

  var unitFromBody = lifecycleExtractUnitFromBody_(body);
  var propertyHint = lifecycleExtractPropertyHintFromBody_(body);

  var candidates = openWis;

  if (propertyHint) {
    candidates = candidates.filter(function (w) {
      return String(w.propertyId || "").toUpperCase() === propertyHint;
    });
  }

  if (unitFromBody) {
    var unitNorm = String(unitFromBody).toLowerCase().replace(/\s/g, "");
    candidates = candidates.filter(function (w) {
      return String(w.unitId || "").toLowerCase().replace(/\s/g, "") === unitNorm;
    });
  }

  if (candidates.length === 1) {
    return { wiId: candidates[0].workItemId, reason: propertyHint ? "PROPERTY_UNIT_MATCH" : "UNIT_MATCH" };
  }
  if (candidates.length > 1) {
    var scored = scoreCandidatesByIssueHints_(candidates, body);
    if (scored.best) {
      return { wiId: scored.best.workItemId, reason: "ISSUE_HINT_MATCH" };
    }
    var prompts = buildSuggestedPromptsForCandidates_(candidates);
    if (prompts.length === 1) {
      return { wiId: candidates[0].workItemId, reason: "SINGLE_PROMPT_AUTO_PICK" };
    }
    return {
      wiId: "",
      reason: "CLARIFICATION_MULTI_MATCH",
      suggestedPrompts: prompts
    };
  }

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

  var ctx = typeof ctxGet_ === "function" ? ctxGet_(phone) : null;
  var wiId = ctx ? (String(ctx.pendingWorkItemId || "").trim() || String(ctx.activeWorkItemId || "").trim()) : "";
  if (wiId && typeof workItemGetById_ === "function") {
    var wi = workItemGetById_(wiId);
    if (wi && String(wi.status || "").toUpperCase() !== "COMPLETED") return { wiId: wiId, reason: "CTX" };
  }
  return { wiId: "", reason: "CLARIFICATION" };
}

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

function staffEscapeRe_(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function staffExtractScheduleRemainderFromTarget_(bodyTrim, unitFromBody, propertyHint) {
  var remainder = String(bodyTrim || "").trim();
  if (!remainder) return "";

  if (propertyHint) {
    var reP0 = new RegExp("^\\s*" + staffEscapeRe_(propertyHint) + "\\b\\s*", "i");
    remainder = remainder.replace(reP0, "");
  }

  if (unitFromBody) {
    var u = staffEscapeRe_(unitFromBody);
    remainder = remainder.replace(new RegExp("^\\s*(?:unit|apt)\\s*[:\\s]*" + u + "\\b\\s*", "i"), "");
    remainder = remainder.replace(new RegExp("^\\s*#\\s*" + u + "\\b\\s*", "i"), "");
    remainder = remainder.replace(new RegExp("^\\s*no\\.?\\s*" + u + "\\b\\s*", "i"), "");
    remainder = remainder.replace(new RegExp("^\\s*" + u + "\\b\\s*", "i"), "");
  }

  if (propertyHint) {
    var reP1 = new RegExp("^\\s*" + staffEscapeRe_(propertyHint) + "\\b\\s*", "i");
    remainder = remainder.replace(reP1, "");
  }

  remainder = remainder.replace(/^[\\s,:;\\-]+/, "").trim();
  return remainder;
}

function staffHandleLifecycleCommand_(phone, rawText, replyChannel, telegramReplyChatId) {
  if (!phone) return false;
  var body = String(rawText || "").trim();
  var _staffReplyCh = "SMS";
  try {
    _staffReplyCh = String(replyChannel || "SMS").trim().toUpperCase();
    if (_staffReplyCh !== "WA" && _staffReplyCh !== "TELEGRAM") _staffReplyCh = "SMS";
  } catch (_) { _staffReplyCh = "SMS"; }
  var _tgOutChat = String(telegramReplyChatId != null ? telegramReplyChatId : "").trim();
  try {
    logDevSms_(String(phone || ""), body.slice(0, 120), "STAFF_LIFECYCLE_ENTER", "ch=" + _staffReplyCh + " tgChat=" + (_tgOutChat ? "1" : "0"));
  } catch (_) {}
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
      dispatchOutboundIntent_(lifecycleOutboundIntent_(staffId, phone, "STAFF_CLARIFICATION", "STAFF_CLARIFICATION", clarifyVars, "REPLY_SAME_CHANNEL", resolved.reason || "STAFF_TARGET_UNRESOLVED", _staffReplyCh, _tgOutChat));
    }
    return true;
  }

  var wiForSchedule = typeof workItemGetById_ === "function" ? workItemGetById_(wiId) : null;
  if (typeof parsePreferredWindowShared_ === "function") {
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
          scheduleParsed = parsePreferredWindowShared_(scheduleRemainder, null);
        } catch (_) {}

        if (scheduleParsed && scheduleParsed.end instanceof Date && isFinite(scheduleParsed.end.getTime())) {
          var currentScheduleEndAt = null;
          var currentScheduleLabel = "";
          try {
            if (wiForSchedule && typeof lifecycleResolveTicketRowForSync_ === "function" && typeof getLogSheet_ === "function" && typeof COL !== "undefined") {
              var _resolvedT = lifecycleResolveTicketRowForSync_(wiForSchedule);
              var _ticketRow = (_resolvedT && typeof _resolvedT.row === "number") ? _resolvedT.row : 0;
              var _sheet = getLogSheet_();
              if (_sheet && _ticketRow >= 2 && COL.SCHEDULED_END_AT) {
                var _rawEnd = _sheet.getRange(_ticketRow, COL.SCHEDULED_END_AT).getValue();
                if (_rawEnd instanceof Date && isFinite(_rawEnd.getTime())) currentScheduleEndAt = _rawEnd;
                else if (_rawEnd) {
                  var _parsedEnd = new Date(_rawEnd);
                  if (_parsedEnd instanceof Date && isFinite(_parsedEnd.getTime())) currentScheduleEndAt = _parsedEnd;
                }
              }
              if (_sheet && _ticketRow >= 2 && COL.PREF_WINDOW) {
                currentScheduleLabel = String(_sheet.getRange(_ticketRow, COL.PREF_WINDOW).getValue() || "").trim();
              }
            }
          } catch (_) {}

          var sameWindow = false;
          if (currentScheduleEndAt instanceof Date && isFinite(currentScheduleEndAt.getTime())) {
            sameWindow = Math.abs(currentScheduleEndAt.getTime() - scheduleParsed.end.getTime()) < 60000;
          }

          if (sameWindow) {
            if (typeof dispatchOutboundIntent_ === "function") {
              dispatchOutboundIntent_(
                lifecycleOutboundIntent_(
                  staffId,
                  phone,
                  "STAFF_SCHEDULE_ACK",
                  "STAFF_SCHEDULE_ACK",
                  {
                    scheduleLabel: String(currentScheduleLabel || scheduleParsed.label || "").trim(),
                    scheduleStatus: "ALREADY_SET"
                  },
                  "REPLY_SAME_CHANNEL",
                  "STAFF_SCHEDULE_ALREADY_SET",
                  _staffReplyCh,
                  _tgOutChat
                )
              );
            }
            try { lifecycleLog_("STAFF_SCHEDULE_DUPLICATE_WINDOW", String((wiForSchedule && wiForSchedule.propertyId) || "GLOBAL").trim().toUpperCase() || "GLOBAL", wiId, Object.assign(getActorFacts_({ actorType: "STAFF", actorId: phone, reasonCode: "STAFF_SCHEDULE_ALREADY_SET", rawText: body.slice(0, 500) }), { scheduleLabel: String(currentScheduleLabel || scheduleParsed.label || "").trim() })); } catch (_) {}
            return true;
          }

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
              dispatchOutboundIntent_(
                lifecycleOutboundIntent_(
                  staffId,
                  phone,
                  "STAFF_SCHEDULE_ACK",
                  "STAFF_SCHEDULE_ACK",
                  {
                    scheduleLabel: String(scheduleSignal && scheduleSignal.scheduleLabel ? scheduleSignal.scheduleLabel : "").trim(),
                    scheduleStatus: currentScheduleEndAt ? "UPDATED" : "SET"
                  },
                  "REPLY_SAME_CHANNEL",
                  currentScheduleEndAt ? "STAFF_SCHEDULE_UPDATED" : "STAFF_SCHEDULE_SET",
                  _staffReplyCh,
                  _tgOutChat
                )
              );
            } else {
              var clarifyVarsReject2 = { reasonCode: resultSchedule };
              if (resultSchedule === "REJECTED") clarifyVarsReject2.transitionRejected = true;
              dispatchOutboundIntent_(lifecycleOutboundIntent_(staffId, phone, "STAFF_CLARIFICATION", "STAFF_CLARIFICATION", clarifyVarsReject2, "REPLY_SAME_CHANNEL", resultSchedule === "REJECTED" ? "STAFF_TRANSITION_REJECTED" : "STAFF_HOLD_OR_REJECT", _staffReplyCh, _tgOutChat));
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
        dispatchOutboundIntent_(lifecycleOutboundIntent_(staffId, phone, "STAFF_UPDATE_ACK", "STAFF_UPDATE_ACK", { outcome: outcome }, "REPLY_SAME_CHANNEL", "STAFF_UPDATE", _staffReplyCh, _tgOutChat));
      } else {
        var clarifyVarsReject = { reasonCode: result };
        if (result === "REJECTED") clarifyVarsReject.transitionRejected = true;
        dispatchOutboundIntent_(lifecycleOutboundIntent_(staffId, phone, "STAFF_CLARIFICATION", "STAFF_CLARIFICATION", clarifyVarsReject, "REPLY_SAME_CHANNEL", result === "REJECTED" ? "STAFF_TRANSITION_REJECTED" : "STAFF_HOLD_OR_REJECT", _staffReplyCh, _tgOutChat));
      }
    }
    return true;
  }
  lifecycleLog_("STAFF_UPDATE_UNRESOLVED", "", wiId, { rawText: body.slice(0, 500), actorType: "STAFF", actorId: phone });
  if (typeof dispatchOutboundIntent_ === "function") {
    dispatchOutboundIntent_(lifecycleOutboundIntent_(staffId, phone, "STAFF_CLARIFICATION", "STAFF_CLARIFICATION", {}, "REPLY_SAME_CHANNEL", "STAFF_CLARIFY", _staffReplyCh, _tgOutChat));
  }
  return true;
}


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (post-split restore)
// getStaffById_
// ─────────────────────────────────────────────────────────────────




// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (dependency wave 2)
// readStaff_ (before getStaffById_)
// ─────────────────────────────────────────────────────────────────


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


  function getStaffById_(staffId) {
    var id = String(staffId || "").trim();
    if (!id) return null;
    var list = readStaff_();
    for (var i = 0; i < list.length; i++) {
      if (list[i].active && String(list[i].id || "").trim() === id) return list[i];
    }
    return null;
  }
