/**
 * STAFF_RESOLVER.gs — Propera Compass
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
 *   Contacts          — ContactID, PhoneE164, Name, PreferredLang
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

    for (var i = 0; i < sData.length; i++) {
      if (srSafeStr_(sData[i][sMap["StaffId"] - 1]) !== staffId) continue;
      if (!srToBool_(sData[i][sMap["Active"] - 1])) return null;
      if (contactCol) {
        contactId = srSafeStr_(sData[i][contactCol - 1]);
      } else {
        contactId = "";
      }
      staffName = srSafeStr_(sData[i][sMap["StaffName"] - 1]);
      break;
    }

    if (!staffName && !contactId) return null;
    if (!contactId) return { staffId: staffId, staffName: staffName, phoneE164: "", lang: "en" };

    var cSh   = srGetSheet_(SR_CONTACTS_SHEET_);
    var cLast = cSh.getLastRow();
    if (cLast < 2) return { staffId: staffId, staffName: staffName, phoneE164: "", lang: "en" };

    var cMap  = srHeaderMap_(cSh);
    var cData = cSh.getRange(2, 1, cLast - 1, cSh.getLastColumn()).getValues();

    for (var j = 0; j < cData.length; j++) {
      if (srSafeStr_(cData[j][cMap["ContactID"] - 1]) !== contactId) continue;
      return {
        staffId:   staffId,
        staffName: staffName || srSafeStr_(cData[j][cMap["Name"] - 1]),
        phoneE164: srSafeStr_(cData[j][cMap["PhoneE164"] - 1]),
        lang:      srSafeStr_(cData[j][cMap["PreferredLang"] - 1]) || "en"
      };
    }

    return { staffId: staffId, staffName: staffName, phoneE164: "", lang: "en" };
  } catch (e) {
    srLog_("SR_LOAD_CONTACT_ERR staffId=[" + staffId + "] err=[" + String(e && e.message ? e.message : e) + "]");
    return null;
  }
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
