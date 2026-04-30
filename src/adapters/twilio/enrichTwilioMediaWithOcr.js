/**
 * SMS / WhatsApp media → `_mediaJson.ocr_text` (GAS `05` Twilio path).
 */
const {
  intakeMediaOcrEnabled,
  openaiApiKey,
  openaiModelVision,
  twilioAccountSid,
  twilioAuthToken,
} = require("../../config/env");
const { enrichMediaWithOcr } = require("../../brain/shared/mediaOcr");
const { openaiVisionOcrFromDataUrl } = require("../../integrations/openaiTransport");
const { fetchTwilioMediaAsDataUrl } = require("./fetchTwilioMediaAsDataUrl");

const OCR_TIMEOUT_MS = 18000;

/**
 * @param {unknown[]} mediaList — items with `url`, `source: twilio`, optional `contentType`, `kind`
 */
async function enrichTwilioMediaWithOcr(mediaList) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  const enabled = intakeMediaOcrEnabled();
  const apiKey = openaiApiKey();
  const model = openaiModelVision();
  const sid = twilioAccountSid();
  const token = twilioAuthToken();

  if (!enabled || !apiKey || !sid || !token) return list;

  return enrichMediaWithOcr(list, {
    enabled: true,
    ocrOne: async (item) => {
      const src = String(item && item.source ? item.source : "").toLowerCase();
      if (src !== "twilio") return "";
      const url = String(item && item.url ? item.url : "").trim();
      if (!url) return "";
      const kind = String(item.kind || "").toLowerCase();
      const ct = String(item.contentType || "").toLowerCase();
      if (kind !== "image" && !ct.startsWith("image/")) return "";

      const dataUrl = await fetchTwilioMediaAsDataUrl(
        url,
        sid,
        token,
        item.contentType
      );
      if (!dataUrl) return "";

      return openaiVisionOcrFromDataUrl(dataUrl, {
        apiKey,
        model,
        timeoutMs: OCR_TIMEOUT_MS,
        maxRetries: 2,
      });
    },
  });
}

module.exports = { enrichTwilioMediaWithOcr };
