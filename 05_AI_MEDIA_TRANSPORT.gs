/**
 * AI_MEDIA_TRANSPORT.gs — Propera AI & Media Transport
 *
 * OWNS:
 *   - OpenAI chat/vision JSON transport, cooldown/backoff, hash helpers
 *   - HTTPS/Twilio media fetch (data URLs and blobs), inbound routing
 *   - Canonical media parse from webhook events, image signal adapter, Drive attachment save
 *
 * DOES NOT OWN (never add these here):
 *   - Staff vision job queues / enrichment workers -> STAFF_CAPTURE_ENGINE.gs (future)
 *   - Resolver, lifecycle, outbound policy decisions
 *
 * ENTRY POINTS:
 *   - openaiChatJson_(), openaiVisionJson_(), fetchInboundMediaAsDataUrl_(), imageSignalAdapter_(), parseCanonicalMediaArrayFromEvent_()
 *
 * DEPENDENCIES:
 *   - ScriptProperties, CacheService, UrlFetchApp, DriveApp for attachment save
 *
 * FUTURE MIGRATION NOTE:
 *   - Stateless AI fetch + media ingress workers behind a queue; Drive paths become object storage
 *
 * SECTIONS IN THIS FILE:
 *   1. OpenAI transport + cooldown — chat and vision API calls
 *   2. Media fetch (Twilio + HTTPS) — blobs and data URLs
 *   3. Canonical media + image signal — parse events, vision prompts, attachment persistence
 */


// ─────────────────────────────────────────────────────────────────
// OPENAI TRANSPORT + MEDIA FETCH (C1 hard-cut)
// ─────────────────────────────────────────────────────────────────

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

/**
 * Non-Twilio HTTPS image fetch (e.g. Telegram bot file URL). Never log full URL (may contain bot token).
 */
function fetchGenericHttpsMediaAsDataUrl_(mediaUrl, hintedMime) {
  var url = String(mediaUrl || "").trim();
  if (!url) {
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_GENERIC_FAIL reason=no_url"); } catch (_) {}
    return "";
  }
  var res = null;
  try {
    res = UrlFetchApp.fetch(url, { method: "get", muteHttpExceptions: true });
  } catch (err) {
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_GENERIC_FAIL reason=fetch_err"); } catch (_) {}
    return "";
  }
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_GENERIC_FAIL code=" + code); } catch (_) {}
    return "";
  }
  var blob = res.getBlob();
  var mime = (blob && blob.getContentType()) ? String(blob.getContentType()).trim().toLowerCase().split(";")[0] : "";
  if (!mime) mime = "image/jpeg";
  var allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"];
  var hint = String(hintedMime || "").trim().toLowerCase().split(";")[0];
  if (hint === "image/jfif") hint = "image/jpeg";
  if (hint === "image/jpg" || hint === "image/pjpeg") hint = "image/jpeg";
  if (mime === "image/jpg" || mime === "image/pjpeg" || mime === "image/jfif") mime = "image/jpeg";
  // Use adapter-declared type when HTTP Content-Type is wrong (e.g. Telegram file URLs -> octet-stream). No URL sniffing.
  if (allowed.indexOf(mime) === -1) {
    if (hint && allowed.indexOf(hint) >= 0) mime = hint;
  }
  if (allowed.indexOf(mime) === -1) {
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_GENERIC_FAIL reason=unsupported_type type=" + mime); } catch (_) {}
    return "";
  }
  var base64 = "";
  try {
    base64 = Utilities.base64Encode(blob.getBytes());
  } catch (_) {
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_GENERIC_FAIL reason=base64_err"); } catch (_) {}
    return "";
  }
  try { if (typeof logDevSms_ === "function") logDevSms_("", "", "MEDIA_FETCH_GENERIC_OK type=" + mime); } catch (_) {}
  return "data:" + mime + ";base64," + base64;
}

/** HTTPS media blob for Drive persistence; uses declared MIME when HTTP type is octet-stream or missing. */
function fetchGenericHttpsMediaBlob_(mediaUrl, declaredMime) {
  var url = String(mediaUrl || "").trim();
  if (!url) {
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_FAIL reason=[no_url] transport=https"); } catch (_) {}
    return { ok: false, err: "no_url" };
  }
  var res = null;
  try {
    res = UrlFetchApp.fetch(url, { method: "get", muteHttpExceptions: true });
  } catch (e) {
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_FAIL reason=[fetch_err] transport=https"); } catch (_) {}
    return { ok: false, err: "fetch_err" };
  }
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_FAIL reason=[http_" + code + "] transport=https"); } catch (_) {}
    return { ok: false, err: "http_" + code };
  }
  var blob = null;
  var mime = "";
  try {
    blob = res.getBlob();
    mime = (blob && blob.getContentType()) ? String(blob.getContentType()).trim().toLowerCase().split(";")[0] : "";
  } catch (_) {}
  var allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"];
  var hint = String(declaredMime || "").trim().toLowerCase().split(";")[0];
  if (hint === "image/jfif" || hint === "image/jpg" || hint === "image/pjpeg") hint = "image/jpeg";
  if (mime === "image/jpg" || mime === "image/pjpeg" || mime === "image/jfif") mime = "image/jpeg";
  if (allowed.indexOf(mime) === -1) {
    if (hint && allowed.indexOf(hint) >= 0) mime = hint;
  }
  if (allowed.indexOf(mime) === -1) {
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_FAIL reason=[unsupported_type] type=" + mime + " transport=https"); } catch (_) {}
    return { ok: false, err: "unsupported_type" };
  }
  try {
    if (blob && mime && typeof blob.setContentType === "function") blob.setContentType(mime);
  } catch (_) {}
  try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_OK type=[" + mime + "] transport=https"); } catch (_) {}
  return { ok: true, blob: blob, mime: mime };
}

/** Route blob fetch: Twilio Basic auth vs plain HTTPS (Telegram bot file URL, etc.). */
function fetchInboundMediaBlob_(mediaUrl, source, declaredMime) {
  var url = String(mediaUrl || "").trim();
  if (!url) {
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_FAIL reason=[no_url]"); } catch (_) {}
    return { ok: false, err: "no_url" };
  }
  var src = String(source || "").toLowerCase();
  var host = "";
  try {
    var mh = url.match(/^https?:\/\/([^\/]+)/i);
    host = mh && mh[1] ? String(mh[1]).toLowerCase() : "";
  } catch (_) {}
  var twilioHost = (host.indexOf("twilio.com") >= 0) || src === "twilio";
  if (twilioHost) return fetchTwilioMediaBlob_(url);
  return fetchGenericHttpsMediaBlob_(url, declaredMime);
}

/** Route fetch by transport: Twilio Basic auth vs plain HTTPS (Telegram file URLs, public CDN). */
function fetchInboundMediaAsDataUrl_(mediaUrl, source, hintedMime) {
  var url = String(mediaUrl || "").trim();
  if (!url) return "";
  var src = String(source || "").toLowerCase();
  var host = "";
  try {
    var m = url.match(/^https?:\/\/([^\/]+)/i);
    host = m && m[1] ? String(m[1]).toLowerCase() : "";
  } catch (_) {}
  var twilioHost = (host.indexOf("twilio.com") >= 0) || src === "twilio";
  if (twilioHost) return fetchTwilioMediaAsDataUrl_(url);
  return fetchGenericHttpsMediaAsDataUrl_(url, hintedMime);
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


// ─────────────────────────────────────────────────────────────────
// MEDIA SIGNAL ADAPTER (C2 hard-cut)
// ─────────────────────────────────────────────────────────────────

// =============================================================================
// Propera Compass - Image Signal Adapter (Phase 1)
// Shared media/image adapter for tenant SMS/WhatsApp, staff # screenshot, synthetic body.
// Channel-neutral inbound media: canonical JSON in e.parameter._mediaJson (preferred),
// with legacy Twilio NumMedia / MediaUrl* as fallback (normalized once via ensureCanonicalMediaJsonOnParameters_).
// =============================================================================

/**
 * Parse canonical media array from webhook event. Order: _mediaJson (adapter) then Twilio fields.
 * Each item: { url, contentType?, mimeType?, source? } - source is twilio | telegram | whatsapp | unknown.
 */
function parseCanonicalMediaArrayFromEvent_(e) {
  var out = [];
  try {
    var p = (e && e.parameter) ? e.parameter : {};
    var j = String(p._mediaJson || "").trim();
    if (j) {
      var parsed = JSON.parse(j);
      if (Array.isArray(parsed)) {
        for (var i = 0; i < parsed.length; i++) {
          var m = parsed[i];
          if (!m || typeof m !== "object") continue;
          var url = String(m.url || "").trim();
          if (!url) continue;
          var ct = String(m.contentType || m.mimeType || "").trim();
          var src = String(m.source || "").trim().toLowerCase();
          if (!src) src = "unknown";
          var ctNorm = ct.toLowerCase().split(";")[0];
          if (ctNorm === "application/octet-stream") {
            try { if (typeof logDevSms_ === "function") logDevSms_("", "", "CANON_MEDIA_SKIP reason=octet_stream source=" + src); } catch (_) {}
            continue;
          }
          if (!ctNorm && (src === "telegram" || src === "whatsapp")) {
            try { if (typeof logDevSms_ === "function") logDevSms_("", "", "CANON_MEDIA_SKIP reason=missing_declared_type source=" + src); } catch (_) {}
            continue;
          }
          out.push({ url: url, contentType: ct, mimeType: ct, source: src });
        }
        if (out.length) return out;
      }
    }
    var n = parseInt(String(p.NumMedia || "0"), 10) || 0;
    for (var k = 0; k < n; k++) {
      var u = String(p["MediaUrl" + k] || "").trim();
      if (!u) continue;
      var typ = String(p["MediaContentType" + k] || "").trim();
      out.push({ url: u, contentType: typ, mimeType: typ, source: "twilio" });
    }
  } catch (_) {}
  return out;
}

/**
 * If _mediaJson is absent but Twilio-style media params exist, populate _mediaJson once (no second pipeline).
 */
function ensureCanonicalMediaJsonOnParameters_(p) {
  p = p || {};
  if (String(p._mediaJson || "").trim()) return;
  var n = parseInt(String(p.NumMedia || "0"), 10) || 0;
  if (n < 1) return;
  var arr = [];
  for (var i = 0; i < n; i++) {
    var url = String(p["MediaUrl" + i] || "").trim();
    if (!url) continue;
    var typ = String(p["MediaContentType" + i] || "").trim();
    arr.push({ url: url, contentType: typ, mimeType: typ, source: "twilio" });
  }
  if (arr.length) p._mediaJson = JSON.stringify(arr);
}

/** Read first media item from event; return normalized facts (no AI). */
function extractInboundMediaFacts_(e) {
  var out = { hasMedia: false, mediaCount: 0, firstUrl: "", firstType: "", isImage: false, mediaSource: "" };
  try {
    var arr = parseCanonicalMediaArrayFromEvent_(e);
    if (!arr.length) return out;
    var m0 = arr[0];
    var url = String(m0.url || "").trim();
    var typ = String(m0.contentType || m0.mimeType || "").trim().toLowerCase();
    out.mediaCount = arr.length;
    out.firstUrl = url;
    out.firstType = typ;
    out.mediaSource = String(m0.source || "twilio").trim().toLowerCase();
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

/**
 * Intake opener vision (single pass): English issueHint + assetHint + locationArea. Not the legacy MEDIA_SIGNAL / brain adapter.
 */
function buildOpenerVisionIntakePrompt_(tenantTextEnglish) {
  var ctx = String(tenantTextEnglish || "").trim();
  var system =
    "You interpret tenant maintenance intake. The user sends one image plus optional English context text. " +
    "Return ONLY valid JSON with keys: issueHint (string), assetHint (string), locationArea (string), confidence (number 0-1). " +
    "All strings must be canonical English. " +
    "issueHint: one short sentence for the problem, combining image evidence with context text when both exist. " +
    "If the text is vague (e.g. 'look at this') but the image shows a clear issue, infer the problem from the image. " +
    "assetHint: visible equipment or fixture (e.g. kitchen sink, washing machine, intercom panel) or empty. " +
    "locationArea: one label when possible: BATHROOM, KITCHEN, LIVING_ROOM, BEDROOM, LAUNDRY, HALLWAY, LOBBY, ELEVATOR, STAIRWELL, ENTRYWAY, GYM, PARKING, BASEMENT, ROOF, EXTERIOR, MAILROOM, or empty if unknown. " +
    "Do not invent property or unit numbers. If unreadable, use low confidence and leave issueHint minimal.";
  var user = "Tenant message (English): " + (ctx || "(no text; image only)") + "\n\nReturn JSON now.";
  return { system: system, user: user };
}

/**
 * One vision call for canonical intake package. Caller merges issueHint into opener text; no second brain pass.
 */
function properaOpenerVisionIntakeOnce_(phone, apiKey, mediaItem, tenantTextEnglish) {
  var out = { ok: false, issueHint: "", assetHint: "", locationArea: "", confidence: 0, err: "init" };
  if (!mediaItem || typeof mediaItem !== "object") {
    out.err = "no_media";
    return out;
  }
  var url = String(mediaItem.url || "").trim();
  if (!url) {
    out.err = "no_url";
    return out;
  }
  var typ = String(mediaItem.contentType || mediaItem.mimeType || "").trim().toLowerCase().split(";")[0];
  if (!typ || typ.indexOf("image/") !== 0) {
    out.err = "not_image";
    return out;
  }
  apiKey = String(apiKey || "").trim();
  if (!apiKey) {
    out.err = "no_key";
    return out;
  }
  var src = String(mediaItem.source || "").trim().toLowerCase();
  var imageDataUrl = (typeof fetchInboundMediaAsDataUrl_ === "function")
    ? fetchInboundMediaAsDataUrl_(url, src, typ)
    : "";
  if (!imageDataUrl) {
    out.err = "fetch_fail";
    try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "OPENER_VISION_FAIL reason=fetch"); } catch (_) {}
    return out;
  }
  var pr = buildOpenerVisionIntakePrompt_(tenantTextEnglish);
  var result = openaiVisionJson_({
    apiKey: apiKey,
    imageDataUrl: imageDataUrl,
    imageUrl: url,
    system: pr.system,
    userText: pr.user,
    phone: phone,
    timeoutMs: 22000,
    maxRetries: 2,
    logLabel: "OPENER_VISION"
  });
  if (!result.ok || !result.json) {
    out.err = String(result.err || "vision_fail");
    try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "OPENER_VISION_FAIL reason=" + out.err); } catch (_) {}
    return out;
  }
  var j = result.json;
  out.issueHint = String(j.issueHint || "").trim();
  out.assetHint = String(j.assetHint || "").trim();
  out.locationArea = String(j.locationArea || "").trim();
  out.confidence = typeof j.confidence === "number" ? Math.max(0, Math.min(1, j.confidence)) : 0;
  out.ok = true;
  out.err = "";
  try { if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "OPENER_VISION_OK conf=" + String(out.confidence)); } catch (_) {}
  return out;
}

/** Minimal mediaFacts shape for maybeAttachMediaFactsToTurn_ when package ran opener vision (no MEDIA_SIGNAL). */
function properaShimMediaFactsFromPackage_(turnFacts) {
  var empty = {
    hasMedia: false, mediaCount: 0, mediaType: "", detectedObjects: [], extractedText: "",
    propertyHint: "", unitHint: "", tenantNameHint: "",
    issueHints: { category: "", subcategory: "", issueSummary: "", symptoms: [], attemptedFixes: [], locationsInUnit: [], safetySensitive: false },
    syntheticBody: "", confidence: 0, firstUrl: "", firstType: "", mediaSource: ""
  };
  if (!turnFacts || !turnFacts.mediaVisionInterpreted) return empty;
  var media = turnFacts.media;
  var m0 = (Array.isArray(media) && media.length) ? media[0] : null;
  var hint = String(turnFacts.issueHint || turnFacts.issue || "").trim();
  var conf = typeof turnFacts.mediaVisionConfidence === "number" ? turnFacts.mediaVisionConfidence : 0;
  return {
    hasMedia: true,
    mediaCount: Array.isArray(media) ? media.length : 1,
    mediaType: "real_world_photo",
    detectedObjects: [],
    extractedText: String(turnFacts.assetHint || "").trim(),
    propertyHint: "", unitHint: "", tenantNameHint: "",
    issueHints: {
      category: "",
      subcategory: "",
      issueSummary: hint,
      symptoms: [],
      attemptedFixes: [],
      locationsInUnit: [],
      safetySensitive: false
    },
    syntheticBody: hint,
    confidence: conf,
    firstUrl: m0 ? String(m0.url || "").trim() : "",
    firstType: m0 ? String(m0.contentType || "").trim() : "",
    mediaSource: m0 ? String(m0.source || "").trim().toLowerCase() : ""
  };
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
    if (typeof logDevSms_ === "function") logDevSms_(phone || "", "", "MEDIA_SIGNAL_START type=image");
  } catch (_) {}
  var imageDataUrl = (typeof fetchInboundMediaAsDataUrl_ === "function")
    ? fetchInboundMediaAsDataUrl_(facts.firstUrl, facts.mediaSource, facts.firstType)
    : ((typeof fetchTwilioMediaAsDataUrl_ === "function") ? fetchTwilioMediaAsDataUrl_(facts.firstUrl) : "");
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
  turnFacts.meta.mediaFirstSource = String(mediaFacts.mediaSource || "").trim().toLowerCase();
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
  var m = (turnFacts && turnFacts.meta) ? turnFacts.meta : {};
  return {
    firstMediaUrl: first,
    firstMediaContentType: String(m.mediaFirstType || "").trim(),
    firstMediaSource: String(m.mediaFirstSource || "").trim()
  };
}

/** First media URL + adapter-declared MIME + source from compiled turnFacts.meta (for finalizeDraftAndCreateTicket_ opts). */
function firstMediaFieldsFromTurnFacts_(turnFacts) {
  var m = (turnFacts && turnFacts.meta) ? turnFacts.meta : {};
  var loc = (turnFacts && turnFacts.location) ? turnFacts.location : {};
  var ltRaw = String(loc.locationType || loc.locationScopeBroad || "UNIT").trim();
  if (typeof properaNormalizeLocationTypeForTicket_ === "function") {
    ltRaw = properaNormalizeLocationTypeForTicket_(ltRaw);
  }
  return {
    firstMediaUrl: (m.mediaUrls && m.mediaUrls[0]) ? String(m.mediaUrls[0]).trim() : "",
    firstMediaContentType: String(m.mediaFirstType || "").trim(),
    firstMediaSource: String(m.mediaFirstSource || "").trim(),
    locationType: ltRaw,
    locationArea: String(loc.locationArea || "").trim(),
    locationDetail: String(loc.locationDetail || "").trim(),
    locationText: String(loc.locationText || "").trim(),
    turnIssueMeta: (turnFacts && turnFacts.issueMeta && typeof turnFacts.issueMeta === "object") ? turnFacts.issueMeta : null,
    semanticTextEnglish: (turnFacts && turnFacts.semanticTextEnglish != null) ? String(turnFacts.semanticTextEnglish || "").trim() : "",
    structuredSignal: (turnFacts && turnFacts.structuredSignal && typeof turnFacts.structuredSignal === "object") ? turnFacts.structuredSignal : null,
    slotFillOnly: !!(turnFacts && turnFacts.slotFillOnly),
    attachMessageRole: String((turnFacts && turnFacts.attachMessageRole) || "").trim()
  };
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
  if (m === "application/pdf") return "pdf";
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

  var allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"];
  if (mime === "image/jpg" || mime === "image/pjpeg" || mime === "image/jfif") mime = "image/jpeg";
  if (allowed.indexOf(mime) === -1) {
    try { if (typeof logDevSms_ === "function") logDevSms_("", "", "ATTACH_FETCH_FAIL reason=[unsupported_type] type=" + mime); } catch (_) {}
    return { ok: false, err: "unsupported_type" };
  }

  try {
    if (blob && mime && typeof blob.setContentType === "function") blob.setContentType(mime);
  } catch (_) {}

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

  var declaredMime = String(opts.declaredMime || opts.canonicalContentType || "").trim();
  var mediaSource = String(opts.mediaSource || "").trim().toLowerCase();
  var fetchRes = (typeof fetchInboundMediaBlob_ === "function")
    ? fetchInboundMediaBlob_(mediaUrl, mediaSource, declaredMime)
    : fetchTwilioMediaBlob_(mediaUrl);
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

