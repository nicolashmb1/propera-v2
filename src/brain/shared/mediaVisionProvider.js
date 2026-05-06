/**
 * Provider boundary for maintenance image understanding.
 *
 * Extracted facts only: no ticket creation, lifecycle decisions, ownership, or
 * schedule logic belongs here.
 */

const {
  intakeMediaVisionEnabled,
  openaiApiKey,
  openaiModelVision,
} = require("../../config/env");
const { openaiChatCompletionsWithRetry } = require("../../integrations/openaiTransport");

function emptyImageMaintenanceSignal() {
  return {
    kind: "unknown",
    ocrText: "",
    visualSummary: "",
    syntheticBody: "",
    issueNameHint: "",
    issueDescriptionHint: "",
    issueCategoryHint: "",
    propertyHint: "",
    unitHint: "",
    locationHint: "",
    urgencyHint: "unknown",
    safetyHint: "unknown",
    confidence: {
      ocr: 0,
      visual: 0,
      issue: 0,
      propertyUnit: 0,
    },
    needsClarification: false,
  };
}

async function extractImageMaintenanceSignal() {
  const o = arguments[0] && typeof arguments[0] === "object" ? arguments[0] : {};
  const dataUrl = String(o.dataUrl || "").trim();
  const apiKey = String(
    Object.prototype.hasOwnProperty.call(o, "apiKey") ? o.apiKey : openaiApiKey()
  ).trim();
  const enabled =
    o.enabled === true ||
    (o.enabled !== false && intakeMediaVisionEnabled());
  if (!enabled || !apiKey || !dataUrl) return emptyImageMaintenanceSignal();

  const model = String(o.model || openaiModelVision() || "gpt-4o-mini").trim();
  const bodyText = String(o.bodyText || "").trim();
  const media = o.media && typeof o.media === "object" ? o.media : {};
  const mimeType = String(o.mimeType || media.contentType || media.mime_type || "").trim();
  const chatImpl =
    typeof o.openaiChatCompletionsWithRetry === "function"
      ? o.openaiChatCompletionsWithRetry
      : openaiChatCompletionsWithRetry;
  const r = await chatImpl({
    apiKey,
    timeoutMs: o.timeoutMs != null ? o.timeoutMs : 22000,
    maxRetries: o.maxRetries != null ? o.maxRetries : 2,
    body: buildVisionRequestBody({ model, dataUrl, mimeType, bodyText }),
  });

  if (!r.ok || !r.data) return unclearImageMaintenanceSignal();
  const content =
    r.data.choices &&
    r.data.choices[0] &&
    r.data.choices[0].message &&
    r.data.choices[0].message.content;
  return parseImageMaintenanceSignal(content);
}

function unclearImageMaintenanceSignal() {
  const sig = emptyImageMaintenanceSignal();
  sig.needsClarification = true;
  return sig;
}

function clamp01(v) {
  const n = Number(v);
  return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function normalizeKind(v) {
  const s = String(v || "").trim().toLowerCase();
  return ["photo", "screenshot", "screenshot_text", "unknown"].includes(s)
    ? s
    : "unknown";
}

function normalizeEnum(v, allowed, fallback) {
  const s = String(v || "").trim().toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

function normalizeImageMaintenanceSignal(raw) {
  if (!raw || typeof raw !== "object") return unclearImageMaintenanceSignal();
  const base = emptyImageMaintenanceSignal();
  const c = raw.confidence && typeof raw.confidence === "object" ? raw.confidence : {};
  const out = {
    kind: normalizeKind(raw.kind),
    ocrText: String(raw.ocrText || raw.ocr_text || "").trim(),
    visualSummary: String(raw.visualSummary || "").trim(),
    syntheticBody: String(raw.syntheticBody || "").trim(),
    issueNameHint: String(raw.issueNameHint || "").trim(),
    issueDescriptionHint: String(raw.issueDescriptionHint || "").trim(),
    issueCategoryHint: String(raw.issueCategoryHint || "").trim(),
    propertyHint: String(raw.propertyHint || "").trim(),
    unitHint: String(raw.unitHint || "").trim(),
    locationHint: String(raw.locationHint || "").trim(),
    urgencyHint: normalizeEnum(
      raw.urgencyHint,
      ["normal", "urgent", "emergency", "unknown"],
      base.urgencyHint
    ),
    safetyHint: normalizeEnum(
      raw.safetyHint,
      ["sparks", "fire", "flood", "mold", "gas", "exposed_wires", "none", "unknown"],
      base.safetyHint
    ),
    confidence: {
      ocr: clamp01(c.ocr),
      visual: clamp01(c.visual),
      issue: clamp01(c.issue),
      propertyUnit: clamp01(c.propertyUnit),
    },
    needsClarification: !!raw.needsClarification,
  };
  if (!out.syntheticBody && !out.issueNameHint && out.confidence.issue <= 0.2) {
    out.needsClarification = true;
  }
  return out;
}

function parseJsonObject(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    const match = s.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_e) {
      return null;
    }
  }
}

function parseImageMaintenanceSignal(content) {
  const parsed = parseJsonObject(content);
  if (!parsed) return unclearImageMaintenanceSignal();
  return normalizeImageMaintenanceSignal(parsed);
}

function buildVisionRequestBody({ model, dataUrl, mimeType, bodyText }) {
  const text = [
    "Extract maintenance intake facts from this image for a property operations system.",
    "Return JSON only.",
    "",
    "Classify kind as one of: photo, screenshot, screenshot_text, unknown.",
    "Extract visible OCR text, short visual summary, likely maintenance issue, issue category, location inside unit, property/unit hints only if visible or clearly written, and safety concerns.",
    "Do not invent facts. Do not invent property or unit. If the image is unclear, return low confidence and needsClarification true.",
    "If screenshot text is readable, prioritize text over visual guessing. If a real-world photo clearly shows a maintenance problem, produce a concise syntheticBody. If ambiguous, do not guess.",
    "",
    "Return this exact JSON shape:",
    JSON.stringify(emptyImageMaintenanceSignal()),
    bodyText ? "\nInbound text/caption context: " + bodyText.slice(0, 800) : "",
    mimeType ? "\nMedia MIME hint: " + mimeType : "",
  ].join("\n");

  return {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are extracting maintenance intake facts from an image for a property operations system. Return JSON only.",
      },
      {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  };
}

module.exports = {
  emptyImageMaintenanceSignal,
  extractImageMaintenanceSignal,
  parseImageMaintenanceSignal,
  normalizeImageMaintenanceSignal,
  unclearImageMaintenanceSignal,
  buildVisionRequestBody,
};
