/**
 * Unit asset nameplate scan — vision extraction for appliance/fixture registry.
 * Provider: PROPERA_UNIT_ASSET_SCAN_PROVIDER (falls back to expense scan provider)
 * Model:    PROPERA_UNIT_ASSET_SCAN_MODEL     (falls back to expense scan model)
 */

const {
  openaiApiKey,
  anthropicApiKey,
  unitAssetScanProvider,
  unitAssetScanModel,
} = require("../../config/env");
const { openaiChatCompletionsWithRetry } = require("../../integrations/openaiTransport");

const ASSET_CATEGORIES = ["appliance", "fixture", "hvac", "lock", "other"];

const COMMON_ASSET_TYPES = [
  "dishwasher",
  "oven",
  "range",
  "refrigerator",
  "microwave",
  "washer",
  "dryer",
  "water_heater",
  "garbage_disposal",
  "hvac_unit",
  "thermostat",
  "smoke_detector",
  "door_lock",
];

const SYSTEM_PROMPT =
  "You are an appliance and equipment nameplate OCR assistant for a property management system.\n" +
  "Extract structured data from the nameplate or label photo.\n" +
  "Return ONLY a single JSON object — no prose, no markdown fences.\n\n" +
  "Required fields:\n" +
  "- make: manufacturer / brand (string or null)\n" +
  "- model: model number or model name (string or null)\n" +
  "- serial_number: serial / S/N / service tag (string or null)\n" +
  "- asset_type: best matching slug from: " +
  COMMON_ASSET_TYPES.join(", ") +
  " — or a short snake_case slug if none match (e.g. ice_maker), or null\n" +
  "- category: one of " +
  ASSET_CATEGORIES.join(", ") +
  " — or null\n" +
  "- confidence: object with 0-1 scores for make, model, serial_number, asset_type (numbers or null)\n\n" +
  "Rules: read only what is visible on the label. If unclear, use null and low confidence. Never invent serial numbers.";

const USER_PROMPT = "Extract nameplate fields from this equipment label photo.";

async function callOpenAI(base64, mimeType, model, apiKey) {
  const r = await openaiChatCompletionsWithRetry({
    apiKey,
    timeoutMs: 22000,
    maxRetries: 2,
    body: {
      model,
      max_tokens: 512,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
            { type: "text", text: USER_PROMPT },
          ],
        },
      ],
    },
  });

  if (!r.ok || !r.data) throw new Error(r.err || "openai_error");
  return String(r.data?.choices?.[0]?.message?.content ?? "");
}

async function callAnthropic(base64, mimeType, model, apiKey) {
  const validMimes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  const safeType = validMimes.includes(mimeType) ? mimeType : "image/jpeg";

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: safeType, data: base64 } },
              { type: "text", text: USER_PROMPT },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const txt = await res.text().catch(() => String(res.status));
      throw new Error(`anthropic_${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    const block = json?.content?.[0];
    return String(block?.type === "text" ? block.text : "");
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function normSlug(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_/-]/g, "")
    .replace(/-/g, "_");
}

function parseOutput(raw) {
  const s = String(raw || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fence ? fence[1] : s;
  const trimmed = jsonStr.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) return emptyDraft();

  let parsed;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return emptyDraft();
  }

  const make = typeof parsed.make === "string" && parsed.make.trim() ? parsed.make.trim() : null;
  const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : null;
  const serial_number =
    typeof parsed.serial_number === "string" && parsed.serial_number.trim()
      ? parsed.serial_number.trim()
      : null;

  let asset_type = null;
  if (typeof parsed.asset_type === "string" && parsed.asset_type.trim()) {
    const slug = normSlug(parsed.asset_type);
    asset_type = slug || null;
  }

  let category = null;
  const catRaw = String(parsed.category || "")
    .trim()
    .toLowerCase();
  if (ASSET_CATEGORIES.includes(catRaw)) category = catRaw;

  const c = parsed.confidence && typeof parsed.confidence === "object" ? parsed.confidence : {};
  const confidence = {
    make: clamp01(c.make),
    model: clamp01(c.model),
    serial_number: clamp01(c.serial_number),
    asset_type: clamp01(c.asset_type),
  };

  return { make, model, serial_number, asset_type, category, confidence };
}

function emptyDraft() {
  return {
    make: null,
    model: null,
    serial_number: null,
    asset_type: null,
    category: null,
    confidence: { make: 0, model: 0, serial_number: 0, asset_type: 0 },
  };
}

/**
 * @param {string} base64
 * @param {string} mimeType
 * @returns {Promise<{ make, model, serial_number, asset_type, category, confidence, provider, model }>}
 */
async function scanUnitAssetNameplate(base64, mimeType) {
  const provider = unitAssetScanProvider();
  const scanModel = unitAssetScanModel();
  const apiKey = provider === "anthropic" ? anthropicApiKey() : openaiApiKey();

  if (!apiKey) throw new Error(`${provider}_api_key_missing`);

  const raw =
    provider === "anthropic"
      ? await callAnthropic(base64, mimeType, scanModel, apiKey)
      : await callOpenAI(base64, mimeType, scanModel, apiKey);

  const draft = parseOutput(raw);
  return { ...draft, provider, scan_model: scanModel };
}

module.exports = {
  scanUnitAssetNameplate,
  parseOutput,
  ASSET_CATEGORIES,
  COMMON_ASSET_TYPES,
};
