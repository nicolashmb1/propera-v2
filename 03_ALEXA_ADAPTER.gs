// ===================================================================
// PROPERA — ALEXA VOICE ADAPTER (THIN / PACKAGE-IN ONLY)
// ===================================================================
//
// NORTH-STAR RULE:
// - Adapter is transport-only.
// - It does NOT open the package.
// - It does NOT run business logic.
// - It does NOT decide maintenance flow, scheduling, ticket logic, or SMS logic.
// - It only:
//     1) validates / normalizes inbound Alexa payload
//     2) resolves linked actor
//     3) enqueues canonical signal package
//     4) returns a fast Alexa acknowledgment
//
// Downstream:
//   Alexa package -> AlexaQueue -> processAlexaQueue_() -> handleInboundCore_(e)
//   -> shared brain -> shared outgate
//
// ===================================================================

// ---- Sheet names ----
var ALEXA_DEVICES_SHEET_ = "AlexaDevices";
var ALEXA_QUEUE_SHEET_   = "AlexaQueue";

// ---- Secret key in Script Properties ----
var ALEXA_WEBHOOK_SECRET_KEY_ = "ALEXA_WEBHOOK_SECRET";

// ---- Alexa messages (adapter-only) ----
var ALEXA_MSG_LAUNCH_   = "How can I help you today?";
var ALEXA_MSG_RECEIPT_  = "Hi. We received your request. Our team will follow up with any other instructions by text.";
var ALEXA_MSG_FALLBACK_ = "Sorry, I did not catch that. Please tell me your request again.";

// ===================================================================
// MAIN ENTRY
// Called from doPost when data.alexaRequest === true
// ===================================================================
function handleAlexaWebhook_(data) {
  try {
    if (!data || typeof data !== "object") {
      throw new Error("ALEXA_INVALID_PAYLOAD");
    }

    // ---- auth ----
    var expectedSecret = String(
      PropertiesService.getScriptProperties().getProperty(ALEXA_WEBHOOK_SECRET_KEY_) || ""
    ).trim();
    var gotSecret = String(data.secret || "").trim();

    if (!expectedSecret || gotSecret !== expectedSecret) {
      throw new Error("ALEXA_SECRET_INVALID");
    }

    // ---- normalize ----
    var signal = alexaNormalizeSignal_(data);
    if (!signal) throw new Error("ALEXA_NORMALIZE_FAILED");

    logAlexaEvent_("ALEXA_REQUEST", {
      intentName: signal.intentName,
      rawText: signal.rawText,
      sessionId: signal.sessionId,
      alexaUserId: signal.alexaUserId,
      deviceId: signal.deviceId
    });

    // ---- resolve actor ----
    var actor = alexaResolveActor_(signal.alexaUserId, signal.deviceId);
    if (!actor || !actor.phone) {
      logAlexaEvent_("ALEXA_DEVICE_NOT_LINKED", {
        alexaUserId: signal.alexaUserId,
        deviceId: signal.deviceId
      });
      return alexaWrapSpeech_("This Alexa device is not linked to a Propera account.", true);
    }

    logAlexaEvent_("ALEXA_ACTOR_RESOLVED", {
      phone: actor.phone,
      propertyCode: actor.propertyCode,
      unitId: actor.unitId
    });

    // ---- launch / empty / fallback ----
    if (signal.intentName === "LaunchRequest") {
      return alexaWrapSpeech_(ALEXA_MSG_LAUNCH_, false);
    }

    if (!signal.rawText) {
      return alexaWrapSpeech_(ALEXA_MSG_FALLBACK_, false);
    }

    // ---- package only: enqueue canonical signal ----
    var requestId = String(signal.requestId || "").trim() || Utilities.getUuid();

    var payload = {
      requestId: requestId,
      source: "ALEXA",
      phone: actor.phone,
      propertyCode: actor.propertyCode || "",
      unitId: actor.unitId || "",
      rawText: signal.rawText,
      locale: signal.locale || "en-US",
      alexaUserId: signal.alexaUserId || "",
      deviceId: signal.deviceId || "",
      sessionId: signal.sessionId || "",
      receivedAt: new Date().toISOString()
    };

    var enqueued = alexaEnqueuePackage_(payload);

    logAlexaEvent_("ALEXA_ENQUEUED", {
      requestId: requestId,
      enqueued: enqueued
    });

    if (typeof flushDevSmsLogs_ === "function") {
      try { flushDevSmsLogs_(); } catch (_) {}
    }

    // Delivery receipt only. No business conclusion here.
    return alexaWrapSpeech_(ALEXA_MSG_RECEIPT_, true);

  } catch (err) {
    logAlexaEvent_("ALEXA_ERROR", {
      message: (err && err.message) ? err.message : String(err)
    });
    try {
      if (typeof flushDevSmsLogs_ === "function") flushDevSmsLogs_();
    } catch (_) {}
    return alexaBuildErrorResponse_("Propera could not process the request.");
  }
}

// ===================================================================
// QUEUE WRITE
// Columns: RequestId | PayloadJson | CreatedAt
// ===================================================================
function alexaEnqueuePackage_(payload) {
  if (!payload || typeof payload !== "object") return false;

  try {
    var ss = alexaQueueSpreadsheet_();
    if (!ss) throw new Error("NO_SPREADSHEET");

    var sh = ss.getSheetByName(ALEXA_QUEUE_SHEET_);
    if (!sh) {
      sh = ss.insertSheet(ALEXA_QUEUE_SHEET_);
      sh.getRange(1, 1, 1, 3).setValues([["RequestId", "PayloadJson", "CreatedAt"]]);
      sh.getRange(1, 1, 1, 3).setFontWeight("bold");
    }

    var nextRow = sh.getLastRow() + 1;
    sh.getRange(nextRow, 1, 1, 3).setValues([
      [
        String(payload.requestId || Utilities.getUuid()),
        JSON.stringify(payload),
        new Date().toISOString()
      ]
    ]);

    // POC trigger: one-time deferred worker
    try {
      ScriptApp.newTrigger("processAlexaQueue_").timeBased().after(30000).create();
    } catch (_) {}

    return true;
  } catch (e) {
    logAlexaEvent_("ALEXA_QUEUE_ERROR", {
      error: (e && e.message) ? e.message : String(e)
    });
    return false;
  }
}

// ===================================================================
// QUEUE WORKER
// Adapter does not open the package.
// Worker hands the package to the SAME brain entry as SMS.
// ===================================================================
function processAlexaQueue_() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);

    var ss = alexaQueueSpreadsheet_();
    if (!ss) throw new Error("NO_SPREADSHEET");

    var sh = ss.getSheetByName(ALEXA_QUEUE_SHEET_);
    if (!sh || sh.getLastRow() < 2) return;

    if (typeof handleInboundCore_ !== "function") {
      throw new Error("handleInboundCore__missing");
    }

    while (sh.getLastRow() >= 2) {
      var row = sh.getRange(2, 1, 1, 3).getValues()[0];
      var requestId = String(row[0] || "").trim();
      var payloadJson = String(row[1] || "").trim();

      // remove queue row first so retries do not duplicate if brain succeeds slowly
      sh.deleteRow(2);

      var payload = null;
      try {
        payload = JSON.parse(payloadJson);
      } catch (e) {
        logAlexaEvent_("ALEXA_DOWNSTREAM_ERROR", {
          requestId: requestId,
          reason: "invalid_json"
        });
        continue;
      }

      if (!payload || !payload.phone || !payload.rawText) {
        logAlexaEvent_("ALEXA_DOWNSTREAM_ERROR", {
          requestId: requestId,
          reason: "missing_payload_fields"
        });
        continue;
      }

      try {
        var phoneE164 = (typeof normalizePhone_ === "function")
          ? normalizePhone_(String(payload.phone || "").trim())
          : String(payload.phone || "").trim();

        if (!phoneE164) {
          throw new Error("PHONE_NORMALIZE_FAILED");
        }

        // Canonical body handoff into the existing SMS brain
        var bodyForBrain = [
          String(payload.propertyCode || "").trim(),
          payload.unitId ? ("unit " + String(payload.unitId).trim()) : "",
          String(payload.rawText || "").trim()
        ].filter(Boolean).join(" ");

        var e = {
          parameter: {
            From: phoneE164,
            Body: bodyForBrain,
            _phoneE164: phoneE164,
            _allowInternal: "1"
          }
        };

        // Temporary bridge until Outgate becomes fully canonical/carrier-driven
        try { globalThis.__inboundChannel = "SMS"; } catch (_) {}

        logAlexaEvent_("ALEXA_DOWNSTREAM_BEGIN", {
          requestId: requestId,
          phone: phoneE164,
          body: bodyForBrain
        });

        handleInboundCore_(e);

        logAlexaEvent_("ALEXA_DOWNSTREAM_DONE", {
          requestId: requestId
        });

      } catch (e) {
        logAlexaEvent_("ALEXA_DOWNSTREAM_ERROR", {
          requestId: requestId,
          error: (e && e.message) ? e.message : String(e)
        });
      }

      try {
        if (typeof flushDevSmsLogs_ === "function") flushDevSmsLogs_();
      } catch (_) {}
    }

  } catch (err) {
    logAlexaEvent_("ALEXA_DOWNSTREAM_ERROR", {
      error: (err && err.message) ? err.message : String(err)
    });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ===================================================================
// NORMALIZER
// Supports pre-normalized relay payload (recommended).
// ===================================================================
function alexaNormalizeSignal_(data) {
  try {
    var rawText = String(data.rawText || "").trim();
    var intentName = String(data.intentName || "").trim() || "CaptureIntent";
    var sessionId = String(data.sessionId || "").trim();
    var alexaUserId = String(data.alexaUserId || "").trim();
    var deviceId = String(data.deviceId || "").trim();
    var locale = String(data.locale || "en-US").trim();
    var requestId = String(data.requestId || "").trim();

    if (!alexaUserId && !sessionId) return null;

    return {
      channel: "ALEXA",
      source: "ALEXA",
      rawText: rawText,
      intentName: intentName,
      sessionId: sessionId,
      alexaUserId: alexaUserId,
      deviceId: deviceId,
      locale: locale,
      requestId: requestId,
      timestamp: new Date().toISOString()
    };
  } catch (_) {
    return null;
  }
}

// ===================================================================
// ACTOR RESOLVER
// AlexaDevices columns:
// AlexaUserId | DeviceId | PhoneE164 | PropertyCode | UnitId | Active | LinkedAt
// ===================================================================
function alexaResolveActor_(userId, deviceId) {
  userId = String(userId || "").trim();
  deviceId = String(deviceId || "").trim();
  if (!userId && !deviceId) return null;

  try {
    var ss = alexaQueueSpreadsheet_();
    if (!ss) return null;
    var sh = ss.getSheetByName(ALEXA_DEVICES_SHEET_);
    if (!sh || sh.getLastRow() < 2) return null;

    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var idx = {};
    for (var i = 0; i < headers.length; i++) idx[String(headers[i]).trim()] = i;

    var numRows = sh.getLastRow() - 1;
    if (numRows < 1) return null;
    var rows = sh.getRange(2, 1, numRows, sh.getLastColumn()).getValues();
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];

      var rowUserId   = String((idx["AlexaUserId"] != null ? row[idx["AlexaUserId"]] : "") || "").trim();
      var rowDeviceId = String((idx["DeviceId"]   != null ? row[idx["DeviceId"]]   : "") || "").trim();
      var active      = String((idx["Active"]     != null ? row[idx["Active"]]     : "TRUE") || "TRUE").trim().toUpperCase();

      if (active !== "TRUE") continue;

      var matchUser = !rowUserId || rowUserId === userId;
      var matchDev  = !rowDeviceId || rowDeviceId === deviceId;

      if (matchUser && matchDev) {
        return {
          phone: String((idx["PhoneE164"] != null ? row[idx["PhoneE164"]] : "") || "").trim(),
          propertyCode: String((idx["PropertyCode"] != null ? row[idx["PropertyCode"]] : "") || "").trim().toUpperCase(),
          unitId: String((idx["UnitId"] != null ? row[idx["UnitId"]] : "") || "").trim()
        };
      }
    }
  } catch (err) {
    logAlexaEvent_("ALEXA_RESOLVE_ERROR", {
      error: (err && err.message) ? err.message : String(err)
    });
  }

  return null;
}

// ===================================================================
// SPREADSHEET RESOLVER
// ===================================================================
function alexaQueueSpreadsheet_() {
  try {
    if (typeof LOG_SHEET_ID !== "undefined" && LOG_SHEET_ID) {
      return SpreadsheetApp.openById(LOG_SHEET_ID);
    }
  } catch (_) {}
  try {
    return SpreadsheetApp.getActive();
  } catch (_) {}
  return null;
}

// ===================================================================
// LOGGING
// ===================================================================
function logAlexaEvent_(type, payload) {
  try {
    var msg = (typeof payload === "string")
      ? payload
      : JSON.stringify(payload || {});
    if (typeof logDevSms_ === "function") {
      logDevSms_("(alexa)", msg, type);
    } else {
      Logger.log(type + " " + msg);
    }
  } catch (_) {}
}

// ===================================================================
// ALEXA RESPONSE HELPERS
// ===================================================================
function alexaWrapSpeech_(text, shouldEndSession) {
  return {
    version: "1.0",
    response: {
      outputSpeech: {
        type: "PlainText",
        text: String(text || "").trim() || "Propera processed the request."
      },
      shouldEndSession: shouldEndSession !== false
    }
  };
}

function alexaBuildErrorResponse_(msg) {
  return alexaWrapSpeech_(
    String(msg || "").trim() || "Propera could not process the request.",
    true
  );
}
