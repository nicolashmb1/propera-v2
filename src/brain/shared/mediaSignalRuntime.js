/**
 * Shared media signal runtime.
 *
 * This is extracted signal only: it enriches canonical media with OCR / visual facts
 * and returns `mediaSignals[]`. It does not create tickets, assign ownership, or
 * decide lifecycle state.
 */
const { intakeMediaSignalEnabled } = require("../../config/env");
const { enrichInboundMediaWithOcr } = require("./enrichInboundMediaWithOcr");
const {
  emptyImageMaintenanceSignal,
  extractImageMaintenanceSignal,
} = require("./mediaVisionProvider");
const {
  fetchTelegramMediaAsDataUrl,
  normalizeInboundMediaProvider,
} = require("./enrichInboundMediaWithOcr");
const { fetchTwilioMediaAsDataUrl } = require("../../adapters/twilio/fetchTwilioMediaAsDataUrl");
const {
  twilioAccountSid,
  twilioAuthToken,
  telegramBotToken,
} = require("../../config/env");

function parseMediaSignalsJson(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x === "object");
  } catch (_) {
    return [];
  }
}

function mediaItemId(item, index) {
  const m = item || {};
  return (
    String(m.mediaId || m.id || m.file_unique_id || m.file_id || m.url || "").trim() ||
    "media:" + String(index)
  );
}

function mediaSourceChannel(item, fallbackChannel) {
  const m = item || {};
  const source = String(m.source || "").trim().toLowerCase();
  const provider = String(m.provider || "").trim().toLowerCase();
  const ch = String(fallbackChannel || "").trim().toLowerCase();
  if (ch) return ch;
  if (source === "twilio") return "twilio";
  if (provider === "telegram") return "telegram";
  return source || provider || "unknown";
}

function normalizeConfidence(confidence) {
  const c = confidence && typeof confidence === "object" ? confidence : {};
  const one = (v) => {
    const n = Number(v);
    return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  };
  return {
    ocr: one(c.ocr),
    visual: one(c.visual),
    issue: one(c.issue),
    propertyUnit: one(c.propertyUnit),
  };
}

function normalizeMediaSignal(raw, item, index, fallbackChannel) {
  const base = emptyImageMaintenanceSignal();
  const r = raw && typeof raw === "object" ? raw : {};
  const contentType = String(
    item && (item.contentType || item.mime_type || item.mimeType) || ""
  ).trim();
  return {
    mediaId: mediaItemId(item, index),
    sourceChannel: mediaSourceChannel(item, fallbackChannel),
    provider: String(item && item.provider || "").trim().toLowerCase(),
    contentType,
    kind: String(r.kind || base.kind || "unknown").trim() || "unknown",
    ocrText: String(r.ocrText || r.ocr_text || item && item.ocr_text || "").trim(),
    visualSummary: String(r.visualSummary || "").trim(),
    syntheticBody: String(r.syntheticBody || "").trim(),
    issueNameHint: String(r.issueNameHint || "").trim(),
    issueDescriptionHint: String(r.issueDescriptionHint || "").trim(),
    issueCategoryHint: String(r.issueCategoryHint || "").trim(),
    propertyHint: String(r.propertyHint || "").trim(),
    unitHint: String(r.unitHint || "").trim(),
    locationHint: String(r.locationHint || "").trim(),
    urgencyHint: String(r.urgencyHint || base.urgencyHint || "unknown").trim() || "unknown",
    safetyHint: String(r.safetyHint || base.safetyHint || "unknown").trim() || "unknown",
    confidence: normalizeConfidence(r.confidence || base.confidence),
    needsClarification: !!r.needsClarification,
  };
}

function mediaItemLooksImage(item) {
  if (!item || typeof item !== "object") return false;
  const kind = String(item.kind || "").trim().toLowerCase();
  const ct = String(item.contentType || item.mime_type || item.mimeType || "")
    .trim()
    .toLowerCase();
  return kind === "image" || ct.indexOf("image/") === 0;
}

async function fetchImageDataUrlForSignal(item) {
  if (!mediaItemLooksImage(item)) return "";
  if (item && item.dataUrl) return String(item.dataUrl || "").trim();
  const provider = normalizeInboundMediaProvider(item);
  if (provider === "twilio") {
    return fetchTwilioMediaAsDataUrl(
      item && item.url,
      twilioAccountSid(),
      twilioAuthToken(),
      item && (item.contentType || item.mime_type || item.mimeType)
    );
  }
  if (provider === "telegram") {
    return fetchTelegramMediaAsDataUrl(
      item && item.file_id,
      telegramBotToken(),
      item && (item.mime_type || item.contentType || item.mimeType)
    );
  }
  return "";
}

/**
 * @param {unknown[]} mediaArr
 * @param {object} [opts]
 * @param {string} [opts.bodyText]
 * @param {string} [opts.channel]
 * @param {object} [opts.deps]
 * @returns {Promise<{ media: unknown[], mediaSignals: object[] }>}
 */
async function enrichInboundMediaWithSignals(mediaArr, opts) {
  const list = Array.isArray(mediaArr) ? mediaArr : [];
  const bodyText = String(opts && opts.bodyText || "").trim();
  const channel = String(opts && opts.channel || "").trim().toLowerCase();
  const deps = opts && opts.deps && typeof opts.deps === "object" ? opts.deps : {};

  const ocrImpl =
    typeof deps.enrichInboundMediaWithOcr === "function"
      ? deps.enrichInboundMediaWithOcr
      : enrichInboundMediaWithOcr;
  const media = await ocrImpl(list);

  const signalEnabled =
    deps.forceEnabled === true ||
    typeof deps.extractImageMaintenanceSignal === "function" ||
    intakeMediaSignalEnabled();
  if (!signalEnabled || !media.length) return { media, mediaSignals: [] };

  const provider =
    typeof deps.extractImageMaintenanceSignal === "function"
      ? deps.extractImageMaintenanceSignal
      : extractImageMaintenanceSignal;

  const mediaSignals = [];
  for (let i = 0; i < media.length; i++) {
    const item = media[i] || {};
    if (!mediaItemLooksImage(item)) continue;
    let raw = null;
    try {
      const dataUrl =
        typeof deps.fetchImageDataUrlForSignal === "function"
          ? await deps.fetchImageDataUrlForSignal(item)
          : await fetchImageDataUrlForSignal(item);
      raw = await provider({
        mediaItem: item,
        media: item,
        dataUrl,
        mimeType: item.contentType || item.mime_type || item.mimeType || "",
        bodyText,
        sourceChannel: channel || mediaSourceChannel(item, ""),
        context: {
          sourceChannel: channel || mediaSourceChannel(item, ""),
        },
      });
    } catch (_) {
      raw = null;
    }
    const sig = normalizeMediaSignal(raw, item, i, channel);
    if (sig.ocrText && !item.ocr_text) item.ocr_text = sig.ocrText.slice(0, 1800);
    mediaSignals.push(sig);
  }

  return { media, mediaSignals };
}

module.exports = {
  enrichInboundMediaWithSignals,
  parseMediaSignalsJson,
  normalizeMediaSignal,
};
