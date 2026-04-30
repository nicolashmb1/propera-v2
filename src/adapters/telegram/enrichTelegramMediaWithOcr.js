const {
  intakeMediaOcrEnabled,
  openaiApiKey,
  openaiModelVision,
  telegramBotToken,
} = require("../../config/env");
const { enrichMediaWithOcr } = require("../../brain/shared/mediaOcr");
const { openaiVisionOcrFromDataUrl } = require("../../integrations/openaiTransport");

const OCR_TIMEOUT_MS = 18000;

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
 * Telegram-specific producer hook.
 * Core remains adapter-neutral and consumes only `_mediaJson` contract.
 */
async function enrichTelegramMediaWithOcr(mediaList) {
  const enabled = intakeMediaOcrEnabled();
  const apiKey = openaiApiKey();
  const model = openaiModelVision();
  const botToken = telegramBotToken();

  if (!enabled || !apiKey || !botToken) return Array.isArray(mediaList) ? mediaList : [];

  return enrichMediaWithOcr(mediaList, {
    enabled: true,
    ocrOne: async (item) => {
      const fileId = String(item && item.file_id ? item.file_id : "").trim();
      if (!fileId) return "";
      const path = await getTelegramFilePath(fileId, botToken);
      if (!path) return "";
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${path}`;
      const fr = await fetch(fileUrl);
      if (!fr.ok) return "";
      const mime = String(fr.headers.get("content-type") || "image/jpeg").trim();
      const ab = await fr.arrayBuffer();
      if (!ab || ab.byteLength < 8) return "";
      const dataUrl = `data:${mime};base64,${b64FromArrayBuffer(ab)}`;
      return openaiVisionOcrFromDataUrl(dataUrl, {
        apiKey,
        model,
        timeoutMs: OCR_TIMEOUT_MS,
        maxRetries: 2,
      });
    },
  });
}

module.exports = { enrichTelegramMediaWithOcr };
