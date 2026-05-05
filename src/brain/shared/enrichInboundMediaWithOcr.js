/**
 * Single inbound checkpoint for `_mediaJson` OCR before router/core.
 * Channel-agnostic: dispatches on canonical `provider` (preferred) or legacy `source` / shape.
 *
 * @see `contracts/buildRouterParameterFromTwilio.js` — sets `provider: "twilio"`
 * @see `adapters/telegram/normalizeTelegramUpdate.js` — sets `provider: "telegram"`
 */

const {
  intakeMediaOcrEnabled,
  openaiApiKey,
  openaiModelVision,
  twilioAccountSid,
  twilioAuthToken,
  telegramBotToken,
} = require("../../config/env");
const { enrichMediaWithOcr } = require("./mediaOcr");
const { openaiVisionOcrFromDataUrl } = require("../../integrations/openaiTransport");
const { fetchTwilioMediaAsDataUrl } = require("../../adapters/twilio/fetchTwilioMediaAsDataUrl");

const OCR_TIMEOUT_MS = 18000;

/**
 * Canonical transport discriminator for `_mediaJson[]` items.
 * Prefer `provider`; fall back to `source` (Twilio legacy); then infer Telegram via `file_id` without `url`.
 *
 * @param {object} item
 * @returns {'twilio'|'telegram'|''}
 */
function normalizeInboundMediaProvider(item) {
  if (!item || typeof item !== "object") return "";
  const p = String(item.provider || "").trim().toLowerCase();
  if (p === "telegram" || p === "twilio") return p;
  const s = String(item.source || "").trim().toLowerCase();
  if (s === "twilio") return "twilio";
  const fid = String(item.file_id || "").trim();
  const url = String(item.url || "").trim();
  if (fid && !url) return "telegram";
  return "";
}

function b64FromArrayBuffer(ab) {
  return Buffer.from(ab).toString("base64");
}

async function getTelegramFilePath(fileId, botToken) {
  const url = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(
    fileId
  )}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok || !j.result || !j.result.file_path) return "";
  return String(j.result.file_path || "").trim();
}

/**
 * @param {object} item
 * @param {{ apiKey: string, model: string, sid: string, token: string }} twilio
 */
async function ocrTwilioImageItem(item, twilio) {
  const url = String(item && item.url ? item.url : "").trim();
  if (!url) return "";
  const kind = String(item.kind || "").toLowerCase();
  const ct = String(item.contentType || "").toLowerCase();
  if (kind !== "image" && !ct.startsWith("image/")) return "";

  const dataUrl = await fetchTwilioMediaAsDataUrl(
    url,
    twilio.sid,
    twilio.token,
    item.contentType
  );
  if (!dataUrl) return "";

  return openaiVisionOcrFromDataUrl(dataUrl, {
    apiKey: twilio.apiKey,
    model: twilio.model,
    timeoutMs: OCR_TIMEOUT_MS,
    maxRetries: 2,
  });
}

/**
 * @param {object} item
 * @param {{ apiKey: string, model: string, botToken: string }} tg
 */
async function ocrTelegramImageItem(item, tg) {
  const fileId = String(item && item.file_id ? item.file_id : "").trim();
  if (!fileId) return "";

  const path = await getTelegramFilePath(fileId, tg.botToken);
  if (!path) return "";
  const fileUrl = `https://api.telegram.org/file/bot${tg.botToken}/${path}`;
  const fr = await fetch(fileUrl);
  if (!fr.ok) return "";
  const resolvedMime = String(fr.headers.get("content-type") || "image/jpeg").trim();
  const ab = await fr.arrayBuffer();
  if (!ab || ab.byteLength < 8) return "";
  const dataUrl = `data:${resolvedMime};base64,${b64FromArrayBuffer(ab)}`;
  return openaiVisionOcrFromDataUrl(dataUrl, {
    apiKey: tg.apiKey,
    model: tg.model,
    timeoutMs: OCR_TIMEOUT_MS,
    maxRetries: 2,
  });
}

/**
 * @param {unknown[]} mediaList — parsed `_mediaJson` array
 * @param {object} [opts]
 * @param {{ enrichMediaWithOcr?: typeof enrichMediaWithOcr }} [opts.deps] — test injection (single orchestrator pass)
 * @returns {Promise<unknown[]>}
 */
async function enrichInboundMediaWithOcr(mediaList, opts) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  if (!list.length) return list;

  const enrichImpl =
    opts && opts.deps && typeof opts.deps.enrichMediaWithOcr === "function"
      ? opts.deps.enrichMediaWithOcr
      : enrichMediaWithOcr;

  const enabled = intakeMediaOcrEnabled();
  const apiKey = openaiApiKey();
  const model = openaiModelVision();
  const sid = twilioAccountSid();
  const token = twilioAuthToken();
  const botToken = telegramBotToken();

  const twilioReady = !!(enabled && apiKey && sid && token);
  const telegramReady = !!(enabled && apiKey && botToken);

  const injectedOrchestrator =
    opts && opts.deps && typeof opts.deps.enrichMediaWithOcr === "function";

  if (!injectedOrchestrator && !twilioReady && !telegramReady) return list;

  return enrichImpl(list, {
    enabled: true,
    ocrOne: async (item) => {
      const prov = normalizeInboundMediaProvider(item);
      if (prov === "twilio") {
        if (!twilioReady) return "";
        return ocrTwilioImageItem(item, { apiKey, model, sid, token });
      }
      if (prov === "telegram") {
        if (!telegramReady) return "";
        return ocrTelegramImageItem(item, { apiKey, model, botToken });
      }
      return "";
    },
  });
}

module.exports = {
  enrichInboundMediaWithOcr,
  normalizeInboundMediaProvider,
};
