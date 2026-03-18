// ===================================================================
// PROPERA — SENSOR SIGNAL HANDLER
// Module: SensorGateway  |  Version: Compass-Aligned v2
// ===================================================================
//
// MODEL 0 (Smart Unit) TEST CHECKLIST:
// ─────────────────────────────────────
// 1) EDITOR TEST (no secret required):
//    - Run testSensorLeak(), testSensorTempLow(), testSensorNoise()
//    - Check Apps Script Executions log for SENSOR_IN, SENSOR_TICKET_CREATE_OK
//    - Open the SensorLog sheet and confirm a row was written
//    - Run the same test twice within 180s: confirm SENSOR_DEDUPE_DROP fires
//      and NO second ticket is created
//
// 2) WEBAPP TEST (requires deployed URL + secret):
//    curl -X POST "https://script.google.com/macros/s/YOUR_DEPLOY_ID/exec" \
//      -H "Content-Type: application/json" \
//      -d '{"sensorType":"LEAK","sensorId":"kitchen_sink","propertyCode":"GRAND","unitId":"101","value":"WET","secret":"YOUR_SECRET"}'
//    Expect HTTP 200 "OK", ticket in WorkItems, row in SensorLog.
//
// 3) DEDUPE TEST:
//    - POST identical payload twice within the TTL window (180s for LEAK)
//    - Second call must log SENSOR_DEDUPE_DROP; NO new ticket created
//
// 4) COURTESY SMS TEST (NOISE, safe mode):
//    - Set Script Property SENSOR_TEST_MODE = "1"
//    - Run testSensorNoise(): courtesy SMS is logged but NOT sent via Twilio
//
// WIRING INTO doPost (ONE TINY PATCH — add after AppSheet ownership block):
//
//   // ---- Sensor webhook gate ----
//   if (data && data.sensorType) {
//     try { handleSensorWebhook_(data); } catch (err) {
//       try { logDevSms_("(sensor)", "", "SENSOR_HANDLER_CRASH err=" + String(err && err.message ? err.message : err)); } catch (_) {}
//     }
//     return OK;
//   }
//
// TEMPLATES SHEET — add these rows (Key | EN text):
//   SENSOR_LEAK_ALERT       | WATER LEAK DETECTED at {{sensorId}} in unit {{unitId}} ({{propertyCode}}). Sensor: {{value}}. Logged {{timestamp}}.
//   SENSOR_TEMP_LOW_ALERT   | FREEZE RISK: temperature at {{sensorId}} dropped to {{value}}F in unit {{unitId}} ({{propertyCode}}). Logged {{timestamp}}.
//   SENSOR_TEMP_HIGH_ALERT  | High temp alert: {{value}}F at {{sensorId}} in unit {{unitId}} ({{propertyCode}}). Logged {{timestamp}}.
//   SENSOR_NOISE_TICKET     | Noise threshold exceeded at {{sensorId}} in unit {{unitId}} ({{propertyCode}}). Level: {{value}}. Courtesy SMS sent. Logged {{timestamp}}.
//   SENSOR_NOISE_COURTESY   | Hi - we noticed elevated noise in your unit. Please keep volume at a respectful level for your neighbors. Thank you.
//   SENSOR_MOTION_ALERT     | Unexpected motion at {{sensorId}} in unit {{unitId}} ({{propertyCode}}) during vacancy window. Logged {{timestamp}}.
//   SENSOR_LOCK_EVENT       | Lock access event at {{sensorId}} in unit {{unitId}} ({{propertyCode}}): {{value}}. Logged {{timestamp}}.
//
// ===================================================================

// ---- Config key ----
var SENSOR_WEBHOOK_SECRET_KEY = "SENSOR_WEBHOOK_SECRET";

// ---- Allowed sensor types (allowlist) ----
var SENSOR_ALLOWED_TYPES_ = ["LEAK", "TEMP_LOW", "TEMP_HIGH", "NOISE", "MOTION", "LOCK"];

// ===================================================================
// SENSOR DEFINITIONS
// Each entry maps: sensorType -> { urgency, category, templateKey }
// No hardcoded user-facing strings. All text lives in the Templates sheet.
// ===================================================================
var SENSOR_DEFINITIONS_ = {

  LEAK: {
    urgency:     "URGENT",
    category:    "Plumbing",
    templateKey: "SENSOR_LEAK_ALERT"
  },

  TEMP_LOW: {
    urgency:     "URGENT",
    category:    "HVAC",
    templateKey: "SENSOR_TEMP_LOW_ALERT"
  },

  TEMP_HIGH: {
    urgency:     "NORMAL",
    category:    "HVAC",
    templateKey: "SENSOR_TEMP_HIGH_ALERT"
  },

  NOISE: {
    urgency:     "NORMAL",
    category:    "Noise",
    templateKey: "SENSOR_NOISE_TICKET",
    courtesyKey: "SENSOR_NOISE_COURTESY"   // separate key for tenant courtesy SMS
  },

  MOTION: {
    urgency:     "NORMAL",
    category:    "Security",
    templateKey: "SENSOR_MOTION_ALERT"
  },

  LOCK: {
    urgency:     "NORMAL",
    category:    "Access",
    templateKey: "SENSOR_LOCK_EVENT"
  }

};

// ===================================================================
// DEDUPE HELPERS
// Single place to control spam protection for all sensor signal types.
// Add a new type here; handleSensorWebhook_ needs no changes.
// ===================================================================

/**
 * sensorDedupeKey_(data)
 * Returns a stable CacheService key for a sensor event.
 * Keyed on type + property + unit + sensorId.
 * Value/reading is intentionally excluded: a sensor that keeps reading
 * "WET" should not create a new ticket on every ping.
 */
function sensorDedupeKey_(data) {
  return [
    "SENSOR_DEDUPE",
    String(data.sensorType   || "").trim().toUpperCase(),
    String(data.propertyCode || "").trim().toUpperCase(),
    String(data.unitId       || "").trim(),
    String(data.sensorId     || "").trim()
  ].join("|").slice(0, 240);
}

/**
 * sensorDedupeTtlSeconds_(sensorType)
 * Returns the CacheService TTL (seconds) for a given sensor type.
 * Within this window, duplicate signals are dropped with SENSOR_DEDUPE_DROP.
 */
function sensorDedupeTtlSeconds_(sensorType) {
  var TTL = {
    LEAK:      180,
    TEMP_LOW:  300,
    TEMP_HIGH: 300,
    NOISE:     300,
    MOTION:     60,
    LOCK:       30
  };
  var t = String(sensorType || "").trim().toUpperCase();
  return TTL[t] || 120;
}

/**
 * sensorCourtesyDedupeKey_(propertyCode, unitId)
 * Separate dedupe key for the noise courtesy SMS.
 * Prevents sending the same courtesy message more than once per 30 minutes
 * to a given unit, independently of the ticket dedupe window.
 */
function sensorCourtesyDedupeKey_(propertyCode, unitId) {
  return ("SENSOR_COURTESY|" +
    String(propertyCode || "").trim().toUpperCase() + "|" +
    String(unitId || "").trim()
  ).slice(0, 240);
}

// ===================================================================
// MAIN ENTRY POINT
// Called from doPost JSON gate when data.sensorType is present.
// Wrapped in a crash shield at the call site in doPost.
// ===================================================================
function handleSensorWebhook_(data) {

  // ----------------------------------------------------------------
  // 1. AUTHENTICATE
  // If SENSOR_WEBHOOK_SECRET is configured, the incoming request must
  // supply the matching value. Absent secret = reject.
  // ----------------------------------------------------------------
  var expectedSecret = "";
  try {
    expectedSecret = String(
      PropertiesService.getScriptProperties().getProperty(SENSOR_WEBHOOK_SECRET_KEY) || ""
    ).trim();
  } catch (_) {}

  var incomingSecret = String(data.secret || "").trim();

  if (expectedSecret && incomingSecret !== expectedSecret) {
    try {
      logDevSms_("(sensor)", "", "SENSOR_AUTH_FAIL type=" + String(data.sensorType || ""));
    } catch (_) {}
    return;
  }

  // ----------------------------------------------------------------
  // 2. VALIDATE + NORMALIZE REQUIRED FIELDS
  // Trim, upper-case, and length-cap all inputs.
  // ----------------------------------------------------------------
  var sensorType   = String(data.sensorType   || "").trim().toUpperCase().slice(0, 32);
  var propertyCode = String(data.propertyCode || "").trim().toUpperCase().slice(0, 32);
  var unitId       = String(data.unitId       || "").trim().slice(0, 32);
  var sensorId     = String(data.sensorId     || "sensor").trim().slice(0, 64);
  var value        = String(data.value        || "").trim().slice(0, 64);
  var timestamp    = new Date().toISOString();

  if (!sensorType || !propertyCode) {
    try {
      logDevSms_("(sensor)", "",
        "SENSOR_VALIDATION_FAIL reason=missing_fields type=" + sensorType + " prop=" + propertyCode);
    } catch (_) {}
    return;
  }

  // ----------------------------------------------------------------
  // 3. ALLOWLIST CHECK — reject unknown types
  // ----------------------------------------------------------------
  var isKnownType = false;
  for (var ai = 0; ai < SENSOR_ALLOWED_TYPES_.length; ai++) {
    if (SENSOR_ALLOWED_TYPES_[ai] === sensorType) { isKnownType = true; break; }
  }
  if (!isKnownType) {
    try {
      logDevSms_("(sensor)", "",
        "SENSOR_UNKNOWN_TYPE type=" + sensorType + " prop=" + propertyCode);
    } catch (_) {}
    return;
  }

  // ----------------------------------------------------------------
  // 4. PROPERTY VALIDATION
  // Confirm propertyCode is in the active property list.
  // If getActiveProperties_ is not available, skip this gate (soft fail).
  // ----------------------------------------------------------------
  if (typeof getActiveProperties_ === "function") {
    var propList = [];
    try { propList = getActiveProperties_() || []; } catch (_) {}
    var propFound = false;
    for (var pi = 0; pi < propList.length; pi++) {
      if (String(propList[pi].code || "").trim().toUpperCase() === propertyCode) {
        propFound = true;
        break;
      }
    }
    if (!propFound) {
      try {
        logDevSms_("(sensor)", "",
          "SENSOR_BAD_PROPERTY prop=" + propertyCode + " type=" + sensorType);
      } catch (_) {}
      return;
    }
  }

  // ----------------------------------------------------------------
  // 5. SENSOR DEFINITION LOOKUP
  // ----------------------------------------------------------------
  var def = SENSOR_DEFINITIONS_[sensorType];
  if (!def) {
    try {
      logDevSms_("(sensor)", "",
        "SENSOR_UNKNOWN_TYPE type=" + sensorType + " reason=no_definition");
    } catch (_) {}
    return;
  }

  // ----------------------------------------------------------------
  // 6. DEDUPE / DEBOUNCE  (must happen before any logging or side effects)
  // AUTH -> VALIDATE -> DEDUPE -> LOG -> ACTION
  // Check CacheService before doing any work. If a matching signal
  // came in recently, drop it with a structured log and return.
  // Fail open on cache errors (better a rare dup than a missed alert).
  // ----------------------------------------------------------------
  var dedupeKey = sensorDedupeKey_({
    sensorType:   sensorType,
    propertyCode: propertyCode,
    unitId:       unitId,
    sensorId:     sensorId
  });
  var dedupeTtl = sensorDedupeTtlSeconds_(sensorType);
  var cache = CacheService.getScriptCache();

  try {
    if (cache.get(dedupeKey)) {
      try {
        logDevSms_("(sensor)", "",
          "SENSOR_DEDUPE_DROP key=" + dedupeKey + " ttlSec=" + dedupeTtl + " type=" + sensorType);
      } catch (_) {}
      return;
    }
    cache.put(dedupeKey, "1", dedupeTtl);
  } catch (_) {
    try {
      logDevSms_("(sensor)", "",
        "SENSOR_DEDUPE_CACHE_ERR type=" + sensorType + " (allowing through)");
    } catch (_) {}
  }

  // ----------------------------------------------------------------
  // 7. LOG INCOMING SIGNAL (after dedupe — only real signals get logged)
  // ----------------------------------------------------------------
  try {
    logDevSms_("(sensor)", "",
      "SENSOR_IN type=" + sensorType +
      " prop=" + propertyCode +
      " unit=" + unitId +
      " sensorId=" + sensorId +
      " urgency=" + def.urgency
    );
  } catch (_) {}

  // ----------------------------------------------------------------
  // 8. BUILD ISSUE TEXT VIA CENTRALIZED TEMPLATE RENDERER
  // renderTenantKey_ produces GSM-7 safe text; no hardcoded strings.
  // ----------------------------------------------------------------
  var templateVars = {
    propertyCode: propertyCode,
    unitId:       unitId,
    sensorId:     sensorId,
    value:        value,
    timestamp:    timestamp
  };

  var issueText = "";
  try {
    issueText = renderTenantKey_(def.templateKey, "en", templateVars);
  } catch (renderErr) {
    // Render failed — build a machine-format internal string.
    // This is NOT tenant-facing prose; it is a structured key=value
    // string that operators read in the ticket log, not sent via SMS.
    issueText = "[SENSOR]" +
      " type=" + sensorType +
      " sensorId=" + sensorId +
      " unit=" + unitId +
      " prop=" + propertyCode +
      " value=" + value;
    try {
      logDevSms_("(sensor)", "",
        "SENSOR_RENDER_FAIL key=" + def.templateKey +
        " err=" + String(renderErr && renderErr.message ? renderErr.message : renderErr));
    } catch (_) {}
  }

  // ----------------------------------------------------------------
  // 9. WRITE AUDIT LOG (locked)
  // withWriteLock_ is the Compass-standard lock helper.
  // getSheet_ uses LOG_SHEET_ID — safe in webapp context.
  // ----------------------------------------------------------------
  try {
    sensorLogWrite_({
      sensorType:   sensorType,
      sensorId:     sensorId,
      propertyCode: propertyCode,
      unitId:       unitId,
      value:        value
    }, issueText, def.urgency);
  } catch (_) {}

  // ----------------------------------------------------------------
  // 10. BUILD CANONICAL PIPELINE PAYLOAD
  // Payload shape matches what portalPmCreateTicketFromForm_ expects.
  // Synthetic phoneE164 is SENSOR-namespaced to avoid Directory collisions.
  // source="SENSOR" and sensorType/sensorId are passed for downstream audit.
  // ----------------------------------------------------------------
  var syntheticPhone = "SENSOR:" + sensorType + ":" + propertyCode + ":" + Date.now();

  var payload = {
    phoneE164:       syntheticPhone,
    property:        propertyCode,
    unit:            unitId,
    message:         issueText,
    urgency:         def.urgency || "NORMAL",
    category:        def.category || "",
    preferredWindow: def.urgency === "URGENT" ? "ASAP" : "",
    source:          "SENSOR",
    sensorType:      sensorType,
    sensorId:        sensorId,
    rawValue:        value,
    timestamp:       timestamp
  };

  // ----------------------------------------------------------------
  // 11. ROUTE THROUGH COMPASS PIPELINE (one brain, one pipeline)
  // portalPmCreateTicketFromForm_ runs the full path:
  // parse -> assign -> WorkItem -> dispatch. No shortcuts.
  // ----------------------------------------------------------------
  var result = null;
  try {
    result = portalPmCreateTicketFromForm_(payload);
  } catch (pipelineErr) {
    try {
      logDevSms_("(sensor)", "",
        "SENSOR_TICKET_CREATE_FAIL type=" + sensorType +
        " err=" + String(pipelineErr && pipelineErr.message ? pipelineErr.message : pipelineErr));
    } catch (_) {}
    return;
  }

  // ----------------------------------------------------------------
  // 12. LOG PIPELINE OUTCOME
  // ----------------------------------------------------------------
  try {
    if (result && result.ticketId) {
      logDevSms_("(sensor)", "",
        "SENSOR_TICKET_CREATE_OK ticketId=" + result.ticketId +
        " wi=" + (result.workItemId || "") +
        " type=" + sensorType +
        " prop=" + propertyCode +
        " unit=" + unitId
      );
    } else {
      logDevSms_("(sensor)", "",
        "SENSOR_TICKET_CREATE_FAIL type=" + sensorType + " reason=pipeline_returned_null");
    }
  } catch (_) {}

  // ----------------------------------------------------------------
  // 13. NOISE COURTESY SMS
  // Template-keyed, opt-out checked, separately deduped (30-min window).
  // Uses sendRouterSms_ (Compass approved outbound path, channel-aware).
  // Only fires if tenantPhone is a valid normalized number.
  // ----------------------------------------------------------------
  if (sensorType === "NOISE" && def.courtesyKey) {

    var rawTenantPhone = String(data.tenantPhone || "").trim();
    var tenantPhone    = (typeof normalizePhone_ === "function")
      ? normalizePhone_(rawTenantPhone)
      : rawTenantPhone;

    if (!tenantPhone) {
      try {
        logDevSms_("(sensor)", "",
          "SENSOR_COURTESY_SKIP reason=no_tenant_phone prop=" + propertyCode + " unit=" + unitId);
      } catch (_) {}

    } else if (typeof isSmsOptedOut_ === "function" && isSmsOptedOut_(tenantPhone)) {
      try {
        logDevSms_("(sensor)", "",
          "SENSOR_COURTESY_SKIP reason=opted_out phone=" + tenantPhone);
      } catch (_) {}

    } else {
      // Courtesy-level dedupe: once per 30 minutes per unit (1800s)
      var courtesyKey = sensorCourtesyDedupeKey_(propertyCode, unitId);
      var courtesyHit = false;
      try { courtesyHit = !!(cache.get(courtesyKey)); } catch (_) {}

      if (courtesyHit) {
        try {
          logDevSms_("(sensor)", "",
            "SENSOR_COURTESY_SKIP reason=dedupe_30min prop=" + propertyCode + " unit=" + unitId);
        } catch (_) {}

      } else {
        // Render via centralized renderer — no hardcoded SMS body allowed.
        // If render fails, skip the send entirely and log the failure.
        // A missing courtesy SMS is safer than an uncontrolled hardcoded one.
        var courtesyMsg = "";
        var courtesyRenderOk = false;
        try {
          courtesyMsg = renderTenantKey_(def.courtesyKey, "en", templateVars);
          courtesyRenderOk = !!(courtesyMsg);
        } catch (renderErr) {
          try {
            logDevSms_("(sensor)", "",
              "SENSOR_COURTESY_RENDER_FAIL key=" + def.courtesyKey +
              " err=" + String(renderErr && renderErr.message ? renderErr.message : renderErr));
          } catch (_) {}
        }

        if (!courtesyRenderOk) {
          // Render failed — skip send entirely. A skipped courtesy SMS is safer
          // than sending an uncontrolled hardcoded string.
          try {
            logDevSms_("(sensor)", "",
              "SENSOR_COURTESY_SKIP reason=render_failed prop=" + propertyCode + " unit=" + unitId);
          } catch (_) {}
        } else {
          // Render succeeded — send via approved outbound path.
          // SENSOR_TEST_MODE=1 suppresses real Twilio sends during testing.
          var testMode = false;
          try {
            testMode = String(
              PropertiesService.getScriptProperties().getProperty("SENSOR_TEST_MODE") || ""
            ).trim() === "1";
          } catch (_) {}

          if (testMode) {
            try {
              logDevSms_(tenantPhone, courtesyMsg,
                "SENSOR_COURTESY_SENT_TESTMODE prop=" + propertyCode + " unit=" + unitId);
            } catch (_) {}
          } else {
            try {
              sendRouterSms_(tenantPhone, courtesyMsg, "SENSOR_NOISE_COURTESY");
              try {
                logDevSms_(tenantPhone, courtesyMsg,
                  "SENSOR_COURTESY_SENT prop=" + propertyCode + " unit=" + unitId);
              } catch (_) {}
            } catch (smsErr) {
              try {
                logDevSms_(tenantPhone, "",
                  "SENSOR_COURTESY_FAIL err=" + String(smsErr && smsErr.message ? smsErr.message : smsErr));
              } catch (_) {}
            }
          }

          try { cache.put(courtesyKey, "1", 1800); } catch (_) {}
        } // end courtesyRenderOk
      }
    }
  }

  return result;
}

// ===================================================================
// SENSOR LOG WRITER
// Writes to SensorLog sheet on every sensor event for full audit trail.
// Uses withWriteLock_ to prevent concurrent append collisions.
// Uses getSheet_ (backed by LOG_SHEET_ID) — never SpreadsheetApp.getActive().
// ===================================================================
function sensorLogWrite_(rawData, issueText, urgency) {
  withWriteLock_("SENSOR_LOG_WRITE", function () {
    var sh;
    try {
      sh = getSheet_("SensorLog");
    } catch (_) {
      // Sheet not yet created — bootstrap it inside the lock
      var logId = String(
        PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID") || ""
      ).trim();
      if (!logId) return; // no spreadsheet configured — skip silently
      var ss = SpreadsheetApp.openById(logId);
      sh = ss.insertSheet("SensorLog");
      sh.getRange(1, 1, 1, 9).setValues([[
        "Timestamp", "SensorType", "SensorId", "PropertyCode",
        "UnitId", "Value", "Urgency", "IssueText", "RawPayload"
      ]]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, 9)
        .setBackground("#05080F")
        .setFontColor("#00F5D4")
        .setFontWeight("bold");
      sh.setColumnWidth(1, 160);
      sh.setColumnWidth(8, 300);
      sh.setColumnWidth(9, 200);
    }

    sh.appendRow([
      new Date(),
      String(rawData.sensorType   || "").trim(),
      String(rawData.sensorId     || "").trim(),
      String(rawData.propertyCode || "").trim(),
      String(rawData.unitId       || "").trim(),
      String(rawData.value        || "").trim(),
      String(urgency              || "").trim(),
      String(issueText            || "").slice(0, 200),
      JSON.stringify(rawData).slice(0, 300)
    ]);
  });
}

// ===================================================================
// TEST HARNESS
// Run from the Apps Script editor. Secret gate is bypassed when
// SENSOR_WEBHOOK_SECRET is blank (standard for local dev).
// Set Script Property SENSOR_TEST_MODE = "1" to suppress real SMS.
// ===================================================================

function testSensorLeak() {
  var payload = {
    sensorType:   "LEAK",
    sensorId:     "kitchen_sink",
    propertyCode: "GRAND",   // <- replace with your real property code
    unitId:       "101",     // <- replace with your real unit
    value:        "WET",
    secret:       ""         // blank bypasses auth when property is not set
  };
  Logger.log("TEST_SENSOR_LEAK start");
  var result = handleSensorWebhook_(payload);
  Logger.log("TEST_SENSOR_LEAK done result=" + JSON.stringify(result));
}

function testSensorTempLow() {
  var payload = {
    sensorType:   "TEMP_LOW",
    sensorId:     "living_room",
    propertyCode: "GRAND",
    unitId:       "101",
    value:        "54",
    secret:       ""
  };
  Logger.log("TEST_SENSOR_TEMP_LOW start");
  var result = handleSensorWebhook_(payload);
  Logger.log("TEST_SENSOR_TEMP_LOW done result=" + JSON.stringify(result));
}

function testSensorNoise() {
  var payload = {
    sensorType:   "NOISE",
    sensorId:     "living_room",
    propertyCode: "GRAND",
    unitId:       "101",
    value:        "85",
    tenantPhone:  "+19085550001",  // <- replace with a real test number
    secret:       ""
  };
  Logger.log("TEST_SENSOR_NOISE start");
  var result = handleSensorWebhook_(payload);
  Logger.log("TEST_SENSOR_NOISE done result=" + JSON.stringify(result));
}

function testSensorDedupe() {
  // Fires the same payload twice. Second call must log SENSOR_DEDUPE_DROP.
  var payload = {
    sensorType:   "LEAK",
    sensorId:     "dedupe_test_sensor",
    propertyCode: "GRAND",
    unitId:       "999",
    value:        "WET",
    secret:       ""
  };
  Logger.log("TEST_DEDUPE pass 1 (expect SENSOR_IN + SENSOR_TICKET_CREATE_OK)");
  handleSensorWebhook_(payload);
  Logger.log("TEST_DEDUPE pass 2 (expect SENSOR_DEDUPE_DROP, no ticket)");
  handleSensorWebhook_(payload);
  Logger.log("TEST_DEDUPE done — check DevSmsLog for SENSOR_DEDUPE_DROP");
}
