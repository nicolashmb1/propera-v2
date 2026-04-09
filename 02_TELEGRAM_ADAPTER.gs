/**
 * TELEGRAM_ADAPTER — Channel adapter for Telegram Bot webhooks.
 *
 * Compass doctrine:
 * - Authenticate + normalize Telegram payload
 * - Fast-ack: dedupe by update_id, enqueue canonical signal, return 200 JSON after optional bounded queue drain (Phase 5)
 * - Queue worker (timer + webhook) hands off to shared brain via handleInboundRouter_
 * - Outbound flows via dispatchOutboundIntent_ with intent.channel = "TELEGRAM" (future extension)
 *
 * This file intentionally contains only adapter logic; it must not implement routing, lifecycle, or resolver behavior.
 */

var TELEGRAM_ACCEPTED_SHEET_ = "TelegramAccepted";
var TELEGRAM_QUEUE_SHEET_   = "TelegramQueue";

/**
 * Entry point for Telegram webhook (called from doPost router).
 * Fast-ack: parse, dedupe, enqueue, return OK. No synchronous handleInboundRouter_.
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

    // Serialize accept+enqueue so we never mark TelegramAccepted without a queued row (retry then hits DEDUPE and loses the message).
    // Concurrent duplicate webhooks: first wins enqueue+accept; second sees DEDUPE inside lock.
    var enqueued = false;
    var lockAccept = LockService.getScriptLock();
    var gotAcceptLock = false;
    try {
      lockAccept.waitLock(20000);
      gotAcceptLock = true;
    } catch (_) {
      if (typeof debugLogToSheet_ === "function") {
        try { debugLogToSheet_("TELEGRAM_WEBHOOK_LOCK_TIMEOUT", "update_id=" + updateId, "phase=accept_enqueue"); } catch (_) {}
      }
      return OK;
    }
    try {
      if (updateId && telegramAcceptedUpdateId_(updateId)) {
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_DEDUPE_HIT", "update_id=" + updateId, ""); } catch (_) {}
        }
        return OK;
      }

      enqueued = telegramEnqueuePackage_(updateId, raw);
      if (typeof debugLogToSheet_ === "function") {
        try { debugLogToSheet_("TELEGRAM_ENQUEUED", "update_id=" + updateId, "enqueued=" + enqueued); } catch (_) {}
      }
      if (!enqueued) {
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_ENQUEUE_FAIL", "update_id=" + updateId, ""); } catch (_) {}
        }
      } else if (updateId) {
        telegramRecordAccepted_(updateId);
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_ACCEPTED", "update_id=" + updateId, ""); } catch (_) {}
        }
      }
    } finally {
      if (gotAcceptLock) {
        try { lockAccept.releaseLock(); } catch (_) {}
      }
    }

    // Phase 5: bounded drain in-webhook so most messages run without waiting for the minute trigger (lock + TG_PROC dedupe unchanged).
    if (enqueued) {
      try {
        var cfg = telegramWebhookQueueDrainConfig_();
        if (cfg.enabled && typeof processTelegramQueue_ === "function") {
          processTelegramQueue_({
            maxRows: cfg.maxRows,
            maxMillis: cfg.maxMs,
            source: "webhook"
          });
        }
      } catch (drainErr) {
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_WEBHOOK_DRAIN_ERR", "update_id=" + updateId, String(drainErr && drainErr.message ? drainErr.message : drainErr).slice(0, 200)); } catch (_) {}
        }
      }
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
 * Script properties (optional) for Phase 5 webhook-time queue drain:
 * - TELEGRAM_WEBHOOK_QUEUE_DRAIN — "0" to disable synchronous drain after enqueue (fast HTTP ack only; rely on minute trigger). Default "1".
 * - TELEGRAM_WEBHOOK_QUEUE_MAX_ROWS — max rows to process per webhook execution (default 25). 0 = unlimited (not recommended).
 * - TELEGRAM_WEBHOOK_QUEUE_MAX_MS — time budget ms (default 45000). 0 = no time limit (not recommended for webhook).
 */
function telegramWebhookQueueDrainConfig_() {
  var out = { enabled: true, maxRows: 25, maxMs: 45000 };
  try {
    var pr = PropertiesService.getScriptProperties();
    var d = String(pr.getProperty("TELEGRAM_WEBHOOK_QUEUE_DRAIN") || "1").trim();
    out.enabled = d !== "0" && d.toLowerCase() !== "false" && d.toLowerCase() !== "no";
    var mr = pr.getProperty("TELEGRAM_WEBHOOK_QUEUE_MAX_ROWS");
    var mm = pr.getProperty("TELEGRAM_WEBHOOK_QUEUE_MAX_MS");
    if (mr != null && String(mr).trim() !== "") {
      var n = parseInt(String(mr).trim(), 10);
      if (!isNaN(n) && n > 0) out.maxRows = n;
    }
    if (mm != null && String(mm).trim() !== "") {
      var m = parseInt(String(mm).trim(), 10);
      if (!isNaN(m) && m > 0) out.maxMs = m;
    }
  } catch (_) {}
  return out;
}

/**
 * One-time installer for the standing Telegram queue worker trigger.
 * Creates exactly one recurring trigger for processTelegramQueue_ (every minute).
 * Phase 5: webhook also drains the queue with a bounded budget; the minute trigger clears backlog if the webhook timed out.
 */
function installTelegramQueueWorkerTrigger() {
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
function removeTelegramQueueWorkerTriggers() {
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
 * Queue worker: reads TelegramQueue, builds canonical syntheticE, calls handleInboundRouter_.
 * Same shared brain path as before; no Telegram-specific interpretation.
 * @param {Object} [opt] - Optional limits (Phase 5). maxRows>0 caps rows per run; maxMillis>0 caps wall time. Omitted = drain until empty (time-driven worker).
 * @param {number} [opt.maxRows] - Stop after this many processed rows (0 = unlimited).
 * @param {number} [opt.maxMillis] - Stop after this many milliseconds (0 = unlimited).
 * @param {string} [opt.source] - Log tag: "webhook" | "timer" | etc.
 */
function processTelegramQueue_(opt) {
  opt = opt || {};
  var maxRows = opt.maxRows != null ? Number(opt.maxRows) : 0;
  if (isNaN(maxRows) || maxRows < 0) maxRows = 0;
  var maxMillis = opt.maxMillis != null ? Number(opt.maxMillis) : 0;
  if (isNaN(maxMillis) || maxMillis < 0) maxMillis = 0;
  var source = String(opt.source || "timer").trim() || "timer";
  var t0 = Date.now();
  var processed = 0;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(8000);
  } catch (_) {
    if (typeof debugLogToSheet_ === "function") {
      try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_LOCK_FAIL", "", "source=" + source); } catch (_) {}
    }
    return;
  }

  try {
    // Keep timer worker quiet unless it actually processes rows.
    // Webhook/manual runs still log start for observability.
    if (source !== "timer") {
      try {
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_START", "", "source=" + source + " maxRows=" + String(maxRows) + " maxMs=" + String(maxMillis)); } catch (_) {}
        }
      } catch (_) {}
    }

    var ss = telegramQueueSpreadsheet_();
    if (!ss) {
      try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_EARLY_EXIT", "", "reason=NO_SS"); } catch (_) {}
      return;
    }

    var sh = ss.getSheetByName(TELEGRAM_QUEUE_SHEET_);
    if (!sh || sh.getLastRow() < 2) {
      // Do not spam logs for expected empty timer ticks.
      if (source !== "timer") {
        try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_EARLY_EXIT", "", "reason=NO_QUEUE_ROWS"); } catch (_) {}
      }
      return;
    }

    if (typeof handleInboundRouter_ !== "function") {
      try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_EARLY_EXIT", "", "reason=NO_HANDLE_INBOUND_ROUTER"); } catch (_) {}
      return;
    }
    var _cache = null;
    try { _cache = CacheService.getScriptCache(); } catch (_) {}

    while (sh.getLastRow() >= 2) {
      if (maxRows > 0 && processed >= maxRows) {
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_QUEUE_ROW_BUDGET_STOP", "", "source=" + source + " processed=" + String(processed)); } catch (_) {}
        }
        break;
      }
      if (maxMillis > 0 && (Date.now() - t0) >= maxMillis) {
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_QUEUE_TIME_BUDGET_STOP", "", "source=" + source + " ms=" + String(Date.now() - t0)); } catch (_) {}
        }
        break;
      }
      var row = sh.getRange(2, 1, 2, 3).getValues()[0];
      var updateId = String(row[0] || "").trim();
      var payloadJson = String(row[1] || "").trim();

      sh.deleteRow(2);
      processed++;

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

      try {
        if (typeof globalThis !== "undefined") globalThis.__bodyOverride = "";
      } catch (_) {}

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
          try {
            var _tSnippet = String(text || "").replace(/\s+/g, " ").trim().slice(0, 60);
            debugLogToSheet_(
              "TELEGRAM_QUEUE_WORKER_CONSUME",
              "update_id=" + updateId,
              "actorId=" + String(actorId || "") + " text=[" + _tSnippet + "]"
            );
          } catch (_) {}
        }
      } catch (_) {}

      var media = [];
      try {
        media = telegramCollectNormalizedMediaFromMessage_(msg);
      } catch (_mg) {}

      if ((!text || !String(text).trim()) && media.length) {
        try {
          if (typeof globalThis !== "undefined") globalThis.__bodyOverride = "ATTACHMENT_ONLY";
        } catch (_) {}
      }

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

      var chatId = (msg.chat && msg.chat.id != null) ? String(msg.chat.id) : userId;

      // Channel/chat id are threaded explicitly on synthetic event parameters.

      var mediaJsonStr = media.length ? JSON.stringify(media) : "";
      // Canonical media truth for channel-neutral flow:
      // - `media[]` (built above) is the authoritative media list.
      // - `_mediaJson` is the bridge into the shared router/core where it is re-hydrated and becomes `normalized.media`.
      // - `NumMedia` is legacy compatibility only; Telegram no longer emits it (core reads canonical from `_mediaJson`).
      var syntheticE = {
        parameter: {
          _mode: "",
          _internal: "",
          _channel: "TELEGRAM",
          _phoneE164: actorId,
          _telegramChatId: chatId,
          // Stable per Telegram update for core dedupe (avoid SID:SMS:NOSID:* for TG turns).
          _telegramUpdateId: updateId != null ? String(updateId) : "",
          From: actorId,
          Body: text || "",
          _mediaJson: mediaJsonStr
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
            if (typeof debugLogToSheet_ === "function") {
              try { debugLogToSheet_("TELEGRAM_QUEUE_TG_PROC_SKIP", "update_id=" + updateId, "reason=cache_hit"); } catch (_) {}
            }
            continue;
          }
        }

        handleInboundRouter_(syntheticE);

        if (typeof debugLogToSheet_ === "function") {
          try {
            var _blen = (typeof text === "string" ? text.length : 0);
            var _t2 = String(text || "").replace(/\s+/g, " ").trim().slice(0, 40);
            debugLogToSheet_(
              "TELEGRAM_ROUTER_DISPATCHED",
              "update_id=" + updateId,
              "lane=router_owned bodyLen=" + String(_blen) + " body=[" + _t2 + "]"
            );
          } catch (_) {}
        }

        if (_cache && updateId) {
          try { _cache.put("TG_PROC_" + updateId, "1", 600); } catch (_) {}
        }
      } catch (err) {
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_QUEUE_ROUTER_ERROR", "update_id=" + updateId, (err && err.message ? err.message : String(err)).slice(0, 200)); } catch (_) {}
        }
      }
    }
    if (processed > 0) {
      try {
        if (typeof debugLogToSheet_ === "function") {
          try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_DONE", "", "source=" + source + " processed=" + String(processed)); } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (err) {
    if (typeof debugLogToSheet_ === "function") {
      try { debugLogToSheet_("TELEGRAM_QUEUE_WORKER_ERROR", "", (err && err.message ? err.message : String(err)).slice(0, 200)); } catch (_) {}
    }
  } finally {
    try { lock.releaseLock(); } catch (_) {}
    // Queue worker executions do not run doPost(), so ensure DevSmsLog is flushed.
    try { if (typeof flushDevSmsLogs_ === "function") flushDevSmsLogs_(); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// TELEGRAM BOT API — getFile → file_path, deterministic MIME, canonical media[]
// Token appears only in URLs; never log full download URL.
// ---------------------------------------------------------------------------

/**
 * @param {string} filePath - path fragment from getFile (e.g. photos/file_0.jpg)
 * @returns {string} lower-case extension without dot, or ""
 */
function telegramExtensionFromFilePath_(filePath) {
  var fp = String(filePath || "").trim();
  var i = fp.lastIndexOf(".");
  if (i < 0) return "";
  return fp.slice(i + 1).toLowerCase();
}

/**
 * Map file_path extension to canonical MIME when Telegram omits or sends octet-stream.
 */
function telegramMimeFromFilePath_(filePath) {
  var ext = telegramExtensionFromFilePath_(filePath);
  if (!ext) return "";
  var map = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    jpe: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    pdf: "application/pdf",
    heic: "image/heic",
    heif: "image/heif",
    gif: "image/gif"
  };
  return map[ext] || "";
}

/**
 * Normalize Telegram-reported mime_type; empty if missing or unusable (including octet-stream).
 */
function telegramSanitizeTelegramMimeHint_(mimeRaw) {
  var m = String(mimeRaw || "").trim().toLowerCase().split(";")[0];
  if (!m || m === "application/octet-stream") return "";
  if (m === "image/jpg" || m === "image/pjpeg" || m === "image/jfif") return "image/jpeg";
  return m;
}

/**
 * Priority: Telegram mime (if not octet-stream) → extension on file_path → known map.
 * @returns {string} canonical content type, or "" if cannot resolve
 */
function telegramResolveDeclaredContentType_(mimeFromTelegram, filePath) {
  var a = telegramSanitizeTelegramMimeHint_(mimeFromTelegram);
  if (a) return a;
  return telegramMimeFromFilePath_(filePath);
}

var TELEGRAM_INBOUND_MEDIA_MIME_ALLOW_ = {
  "image/jpeg": 1,
  "image/jpg": 1,
  "image/png": 1,
  "image/webp": 1,
  "image/heic": 1,
  "image/heif": 1,
  "image/gif": 1,
  "application/pdf": 1
};

function telegramNormalizeAllowlistedMime_(ct) {
  var c = String(ct || "").trim().toLowerCase().split(";")[0];
  if (c === "image/jpg" || c === "image/pjpeg" || c === "image/jfif") c = "image/jpeg";
  return c;
}

/**
 * Single getFile call; builds bot file URL. Never logs token-bearing URL.
 * @returns {{ ok: boolean, url: string, filePath: string, err: string }}
 */
function telegramGetFileResolved_(fileId) {
  var fid = String(fileId || "").trim();
  if (!fid) return { ok: false, url: "", filePath: "", err: "no_file_id" };
  var token = "";
  try {
    token = PropertiesService.getScriptProperties().getProperty("TELEGRAM_BOT_TOKEN");
  } catch (_) {}
  if (!token || !String(token).trim()) return { ok: false, url: "", filePath: "", err: "no_token" };
  var tok = String(token).trim();
  var apiUrl = "https://api.telegram.org/bot" + tok + "/getFile?file_id=" + encodeURIComponent(fid);
  try {
    var resp = UrlFetchApp.fetch(apiUrl, { muteHttpExceptions: true });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) return { ok: false, url: "", filePath: "", err: "http_" + String(code) };
    var parsed = JSON.parse(resp.getContentText() || "{}");
    var fp = parsed && parsed.result && parsed.result.file_path ? String(parsed.result.file_path).trim() : "";
    if (!fp) return { ok: false, url: "", filePath: "", err: "no_file_path" };
    return {
      ok: true,
      url: "https://api.telegram.org/file/bot" + tok + "/" + fp,
      filePath: fp,
      err: ""
    };
  } catch (e) {
    return { ok: false, url: "", filePath: "", err: "fetch_err" };
  }
}

/**
 * @param {string} fileId
 * @param {string} mimeHintFromMessage - document.mime_type or "image/jpeg" for photos
 */
function telegramTryAppendNormalizedMedia_(mediaArr, fileId, mimeHintFromMessage) {
  mediaArr = mediaArr || [];
  var resolved = telegramGetFileResolved_(fileId);
  if (!resolved.ok || !resolved.url) {
    if (typeof debugLogToSheet_ === "function") {
      try {
        debugLogToSheet_("TELEGRAM_MEDIA_GETFILE_FAIL", String(resolved.err || ""), "fid=" + (fileId ? "1" : "0"));
      } catch (_) {}
    }
    return;
  }
  var ct = telegramResolveDeclaredContentType_(mimeHintFromMessage, resolved.filePath);
  ct = telegramNormalizeAllowlistedMime_(ct);
  if (!ct || ct === "application/octet-stream") {
    if (typeof debugLogToSheet_ === "function") {
      try {
        debugLogToSheet_("TELEGRAM_MEDIA_DROP", "reason=cannot_resolve_mime", "path=" + String(resolved.filePath || "").slice(0, 120));
      } catch (_) {}
    }
    return;
  }
  if (!TELEGRAM_INBOUND_MEDIA_MIME_ALLOW_[ct]) {
    if (typeof debugLogToSheet_ === "function") {
      try {
        debugLogToSheet_("TELEGRAM_MEDIA_DROP", "reason=unsupported_mime", "mime=" + ct.slice(0, 80));
      } catch (_) {}
    }
    return;
  }
  mediaArr.push({
    url: resolved.url,
    contentType: ct,
    mimeType: ct,
    source: "telegram"
  });
}

/**
 * Build canonical media[] for one Telegram message (photo largest, document when allowlisted).
 * @param {Object} msg - Telegram message object
 * @returns {Array<{url:string,contentType:string,mimeType:string,source:string}>}
 */
function telegramCollectNormalizedMediaFromMessage_(msg) {
  var out = [];
  if (!msg || typeof msg !== "object") return out;
  try {
    if (msg.photo && msg.photo.length > 0) {
      var largest = msg.photo[msg.photo.length - 1];
      var fid = largest && largest.file_id ? String(largest.file_id).trim() : "";
      if (fid) telegramTryAppendNormalizedMedia_(out, fid, "image/jpeg");
    }
    if (msg.document && msg.document.file_id) {
      var fidDoc = String(msg.document.file_id).trim();
      var docMime = msg.document.mime_type != null ? String(msg.document.mime_type) : "";
      if (fidDoc) telegramTryAppendNormalizedMedia_(out, fidDoc, docMime);
    }
  } catch (_) {}
  return out;
}

/**
 * @param {string} fileId - Telegram file_id
 * @returns {string} Direct file URL for UrlFetchApp, or ""
 */
function telegramGetFileDownloadUrl_(fileId) {
  var r = telegramGetFileResolved_(fileId);
  return r && r.ok && r.url ? r.url : "";
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
    var errStr = String(err && err.message ? err.message : err);
    // Never log full bot URL / token (UrlFetch errors often embed the request URL).
    errStr = errStr.replace(/bot[a-zA-Z0-9:_-]{10,}\//gi, "bot…/");
    if (typeof logDevSms_ === "function") try { logDevSms_(chatId, msg, "TELEGRAM_SEND_ERR", errStr); } catch (_) {}
  }
}
