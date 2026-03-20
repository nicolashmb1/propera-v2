/**
 * TELEGRAM_ADAPTER — Channel adapter for Telegram Bot webhooks.
 *
 * Compass doctrine:
 * - Authenticate + normalize Telegram payload
 * - Fast-ack: dedupe by update_id, enqueue canonical signal, return 200 JSON immediately
 * - Queue worker hands off to shared brain via handleSmsRouter_
 * - Outbound flows via dispatchOutboundIntent_ with intent.channel = "TELEGRAM" (future extension)
 *
 * This file intentionally contains only adapter logic; it must not implement routing, lifecycle, or resolver behavior.
 */

var TELEGRAM_ACCEPTED_SHEET_ = "TelegramAccepted";
var TELEGRAM_QUEUE_SHEET_   = "TelegramQueue";

/**
 * Entry point for Telegram webhook (called from doPost router).
 * Fast-ack: parse, dedupe, enqueue, return OK. No synchronous handleSmsRouter_.
 * @param {Object} e - Apps Script event, with JSON body in e.postData.contents
 * @returns {GoogleAppsScript.Content.TextOutput} JSON { ok: boolean }
 */
function telegramWebhook_(e) {
  var OK = ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);

  try {
    if (typeof debugLogToSheet_ === "function") {
      try { debugLogToSheet_("TELEGRAM_WEBHOOK_ENTER", "", ""); } catch (_) {}
    }
    if (!e || !e.postData || !e.postData.contents) {
      if (typeof debugLogToSheet_ === "function") {
        try { debugLogToSheet_("TELEGRAM_WEBHOOK_EXIT", "no payload", ""); } catch (_) {}
      }
      return OK;
    }

    var raw = String(e.postData.contents || "");
    var payload;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      return OK;
    }

    var msg = payload && (payload.message || payload.edited_message);
    if (!msg || !msg.from) return OK;

    var from = msg.from;
    var userId = String(from.id || "").trim();
    if (!userId) return OK;

    var updateId = payload.update_id != null ? String(payload.update_id) : "";
    var eventId = String(payload.update_id != null ? payload.update_id : (msg.message_id || ""));

    if (typeof debugLogToSheet_ === "function") {
      try { debugLogToSheet_("TELEGRAM_PARSE_OK", "update_id=" + updateId, "actorId=TG:" + userId); } catch (_) {}
    }

    // Dedupe: if we already accepted this update_id recently, return OK immediately (stop retries)
    if (updateId && telegramAcceptedUpdateId_(updateId)) {
      if (typeof debugLogToSheet_ === "function") {
        try { debugLogToSheet_("TELEGRAM_DEDUPE_HIT", "update_id=" + updateId, ""); } catch (_) {}
      }
      return OK;
    }

    if (updateId) {
      telegramRecordAccepted_(updateId);
    }
    if (typeof debugLogToSheet_ === "function") {
      try { debugLogToSheet_("TELEGRAM_ACCEPTED", "update_id=" + updateId, ""); } catch (_) {}
    }

    // Enqueue raw payload for deferred processing; worker will normalize and call handleSmsRouter_
    var enqueued = telegramEnqueuePackage_(updateId, raw);
    if (typeof debugLogToSheet_ === "function") {
      try { debugLogToSheet_("TELEGRAM_ENQUEUED", "update_id=" + updateId, "enqueued=" + enqueued); } catch (_) {}
    }

    if (typeof debugLogToSheet_ === "function") {
      try { debugLogToSheet_("TELEGRAM_RETURN_OK_FAST", "update_id=" + updateId, ""); } catch (_) {}
    }
    return OK;
  } catch (err) {
    var errMsg = (err && err.message ? err.message : String(err)).slice(0, 300);
    if (typeof debugLogToSheet_ === "function") {
      try { debugLogToSheet_("TELEGRAM_WEBHOOK_ERROR", errMsg, ""); } catch (_) {}
    }
    try {
      if (typeof dbg_ === "function") {
        dbg_("TELEGRAM_WEBHOOK_ERR", { error: String(err && err.stack ? err.stack : err) });
      }
    } catch (_) {}
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ---------------------------------------------------------------------------
// Dedupe: TelegramAccepted sheet (UpdateId | CreatedAt)
// ---------------------------------------------------------------------------
function telegramQueueSpreadsheet_() {
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

function telegramAcceptedUpdateId_(updateId) {
  if (!updateId) return false;
  try {
    var ss = telegramQueueSpreadsheet_();
    if (!ss) return false;
    var sh = ss.getSheetByName(TELEGRAM_ACCEPTED_SHEET_);
    if (!sh || sh.getLastRow() < 2) return false;
    var lastRow = Math.min(sh.getLastRow(), 2000);
    var vals = sh.getRange(2, 1, lastRow, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim() === String(updateId).trim()) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function telegramRecordAccepted_(updateId) {
  if (!updateId) return;
  try {
    var ss = telegramQueueSpreadsheet_();
    if (!ss) return;
    var sh = ss.getSheetByName(TELEGRAM_ACCEPTED_SHEET_);
    if (!sh) {
      sh = ss.insertSheet(TELEGRAM_ACCEPTED_SHEET_);
      sh.getRange(1, 1, 1, 2).setValues([["UpdateId", "CreatedAt"]]);
      sh.getRange(1, 1, 1, 2).setFontWeight("bold");
    }
    sh.appendRow([String(updateId), new Date().toISOString()]);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Queue: TelegramQueue sheet (UpdateId | PayloadJson | CreatedAt)
// ---------------------------------------------------------------------------
function telegramEnqueuePackage_(updateId, payloadJson) {
  if (payloadJson == null || String(payloadJson).trim() === "") return false;
  try {
    var ss = telegramQueueSpreadsheet_();
    if (!ss) return false;

    var sh = ss.getSheetByName(TELEGRAM_QUEUE_SHEET_);
    if (!sh) {
      sh = ss.insertSheet(TELEGRAM_QUEUE_SHEET_);
      sh.getRange(1, 1, 1, 3).setValues([["UpdateId", "PayloadJson", "CreatedAt"]]);
      sh.getRange(1, 1, 1, 3).setFontWeight("bold");
    }

    sh.appendRow([
      String(updateId || ""),
      String(payloadJson),
      new Date().toISOString()
    ]);

    return true;
  } catch (_) {
    return false;
  }
}

/**
 * One-time installer for the standing Telegram queue worker trigger.
 * Creates exactly one recurring trigger for processTelegramQueue_ (every minute).
 */
function installTelegramQueueWorkerTrigger_() {
  try {
    var triggers = [];
    try { triggers = ScriptApp.getProjectTriggers() || []; } catch (_) { triggers = []; }
    for (var i = 0; i < triggers.length; i++) {
      try {
        var fn = triggers[i] && typeof triggers[i].getHandlerFunction === "function" ? triggers[i].getHandlerFunction() : "";
        if (fn === "processTelegramQueue_") {
          try { debugLogToSheet_("TELEGRAM_WORKER_TRIGGER_EXISTS", "", ""); } catch (_) {}
          return;
        }
      } catch (_) {}
    }

    ScriptApp.newTrigger("processTelegramQueue_").timeBased().everyMinutes(1).create();
    try { debugLogToSheet_("TELEGRAM_WORKER_TRIGGER_CREATED", "", ""); } catch (_) {}
  } catch (err) {
    try { debugLogToSheet_("TELEGRAM_WORKER_TRIGGER_CREATE_ERR", "", "err=" + String(err && err.message ? err.message : err)); } catch (_) {}
  }
}

/**
 * Cleanup helper to remove all processTelegramQueue_ worker triggers.
 * Not called automatically from runtime.
 */
function removeTelegramQueueWorkerTriggers_() {
  var removed = 0;
  try {
    var triggers = [];
    try { triggers = ScriptApp.getProjectTriggers() || []; } catch (_) { triggers = []; }
    for (var i = 0; i < triggers.length; i++) {
      try {
        var t = triggers[i];
        var fn = t && typeof t.getHandlerFunction === "function" ? t.getHandlerFunction() : "";
        if (fn === "processTelegramQueue_") {
          ScriptApp.deleteTrigger(t);
          removed++;
        }
      } catch (_) {}
    }
  } finally {
    try { debugLogToSheet_("TELEGRAM_WORKER_TRIGGER_REMOVED", "count=" + String(removed), ""); } catch (_) {}
  }
}

/**
 * Queue worker: reads TelegramQueue, builds canonical syntheticE, calls handleSmsRouter_.
 * Same shared brain path as before; no Telegram-specific interpretation.
 */
function processTelegramQueue_() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(8000);
  } catch (_) {
    if (typeof debugLogToSheet_ === "function") {
      try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_LOCK_FAIL", "", ""); } catch (_) {}
    }
    return;
  }

  try {
    try {
      if (typeof debugLogToSheet_ === "function") {
        try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_START", "", ""); } catch (_) {}
      }
    } catch (_) {}

    var ss = telegramQueueSpreadsheet_();
    if (!ss) {
      try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_EARLY_EXIT", "", "reason=NO_SS"); } catch (_) {}
      return;
    }

    var sh = ss.getSheetByName(TELEGRAM_QUEUE_SHEET_);
    if (!sh || sh.getLastRow() < 2) {
      try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_EARLY_EXIT", "", "reason=NO_QUEUE_ROWS"); } catch (_) {}
      return;
    }

    if (typeof handleSmsRouter_ !== "function") {
      try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_EARLY_EXIT", "", "reason=NO_HANDLE_SMS_ROUTER"); } catch (_) {}
      return;
    }
    var _cache = null;
    try { _cache = CacheService.getScriptCache(); } catch (_) {}

    while (sh.getLastRow() >= 2) {
      var row = sh.getRange(2, 1, 2, 3).getValues()[0];
      var updateId = String(row[0] || "").trim();
      var payloadJson = String(row[1] || "").trim();

      sh.deleteRow(2);

      var payload = null;
      try {
        payload = JSON.parse(payloadJson);
      } catch (_) {
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_QUEUE_PARSE_FAIL", "update_id=" + updateId, ""); } catch (_) {}
        }
        continue;
      }

      var msg = payload && (payload.message || payload.edited_message);
      if (!msg || !msg.from) continue;

      var from = msg.from;
      var userId = String(from.id || "").trim();
      if (!userId) continue;

      var actorId = "TG:" + userId;
      var text = "";
      if (typeof msg.text === "string") text = msg.text;
      else if (typeof msg.caption === "string") text = msg.caption;

      // Fix 4: Telegram control commands — do not enter brain/draft flow; ack and skip.
      var cmd = (typeof text === "string" ? text : "").trim().toLowerCase();
      if (cmd === "/start" || cmd === "/help") {
        try {
          var chatId = (msg.chat && msg.chat.id != null) ? msg.chat.id : from.id;
          sendTelegramMessage_(String(chatId), "Hi! You can send a maintenance request here. Example: \"Apt 502 Penn, my sink is clogged\".");
        } catch (_) {}
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_CMD_ACK", "update_id=" + updateId, "cmd=" + cmd); } catch (_) {}
        }
        continue;
      }

      try {
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_CONSUME", "update_id=" + updateId, ""); } catch (_) {}
        }
      } catch (_) {}

      var media = [];
      var inbound = normalizeInboundEvent_("telegram", {
        actorType: "unknown",
        actorId: actorId,
        body: text || "",
        eventId: String(payload.update_id != null ? payload.update_id : (msg.message_id || "")),
        channel: "telegram",
        media: media,
        meta: {
          telegramPayload: payload,
          chatId: msg.chat && msg.chat.id,
          fromId: from.id,
          username: from.username || "",
          firstName: from.first_name || "",
          lastName: from.last_name || ""
        }
      });

      var decision = decideLane_(inbound);
      var lane = String((decision && decision.lane) || "tenantLane");
      var chatId = (msg.chat && msg.chat.id != null) ? String(msg.chat.id) : userId;

      // Fix 1–2: Persist channel and reply target so outgate can reply via Telegram, not SMS.
      if (typeof globalThis !== "undefined") {
        globalThis.__inboundChannel = "TELEGRAM";
        globalThis.__telegramChatId = chatId;
        globalThis.__inboundEventEid = updateId ? ("TG_UPDATE:" + updateId) : "";
      }

      var syntheticE = {
        parameter: {
          _mode: lane === "managerLane" ? "MANAGER" :
                 lane === "vendorLane"  ? "VENDOR"  :
                 lane === "systemLane"  ? "SYSTEM"  : "TENANT",
          _internal: "",
          _channel: "TELEGRAM",
          _phoneE164: actorId,
          _telegramChatId: chatId,
          From: actorId,
          Body: text || "",
          NumMedia: "0"
        },
        postData: { type: "application/json", contents: payloadJson }
      };

      try {
        // TelegramQueue can contain duplicate rows for the same update_id (webhook retry race).
        // Prevent processing the same update twice so only one tenant reply is emitted.
        if (_cache && updateId) {
          var _procKey = "TG_PROC_" + updateId;
          var already = _cache.get(_procKey);
          if (already === "1") {
            if (typeof logDevSms_ === "function") {
              try { logDevSms_("", "skip=" + updateId, "OUTBOUND_SUPPRESSED_DUPLICATE source=processTelegramQueue_ reason=TG_PROC_CACHE_HIT"); } catch (_) {}
            }
            continue;
          }
        }

        handleSmsRouter_(syntheticE);

        if (_cache && updateId) {
          try { _cache.put("TG_PROC_" + updateId, "1", 600); } catch (_) {}
        }
      } catch (err) {
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_QUEUE_ROUTER_ERROR", "update_id=" + updateId, (err && err.message ? err.message : String(err)).slice(0, 200)); } catch (_) {}
        }
      }
    }
  } catch (err) {
    if (typeof debugLogToSheet_ === "function") {
      try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_ERROR", "", (err && err.message ? err.message : String(err)).slice(0, 200)); } catch (_) {}
    }
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// OUTBOUND — Send message via Telegram Bot API (used by Outgate when channel=TELEGRAM)
// ---------------------------------------------------------------------------

/**
 * Send one text message to a Telegram chat. Used by Outgate ogDeliver_ when channel is TELEGRAM.
 * Script property: TELEGRAM_BOT_TOKEN (Bot token from @BotFather).
 * @param {string} chatId - Telegram chat_id (e.g. from msg.chat.id)
 * @param {string} text - Message body
 * @param {string} [tag] - Optional log tag (e.g. intentType)
 */
function sendTelegramMessage_(chatId, text, tag) {
  if (!chatId || !String(chatId).trim()) return;
  var msg = String(text || "").trim();
  if (!msg) return;
  var token = null;
  try {
    token = PropertiesService.getScriptProperties().getProperty("TELEGRAM_BOT_TOKEN");
  } catch (_) {}
  if (!token || !String(token).trim()) {
    if (typeof logDevSms_ === "function") try { logDevSms_(chatId, msg, "TELEGRAM_SEND_SKIP", "TELEGRAM_BOT_TOKEN not set"); } catch (_) {}
    return;
  }
  var url = "https://api.telegram.org/bot" + String(token).trim() + "/sendMessage";
  var payload = { chat_id: String(chatId).trim(), text: msg };
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (typeof logDevSms_ === "function") {
      try { logDevSms_(chatId, msg, "OUT_TG tag=[" + String(tag || "TELEGRAM") + "] code=" + code, body || ""); } catch (_) {}
    }
  } catch (err) {
    if (typeof logDevSms_ === "function") try { logDevSms_(chatId, msg, "TELEGRAM_SEND_ERR", String(err && err.message ? err.message : err)); } catch (_) {}
  }
}
