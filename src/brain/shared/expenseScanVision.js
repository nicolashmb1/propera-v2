/**
 * Expense bill scan — vision extraction for property operating expenses.
 * Provider: PROPERA_EXPENSE_SCAN_PROVIDER = openai (default) | anthropic
 * Model:    PROPERA_EXPENSE_SCAN_MODEL     (defaults: gpt-4o-mini / claude-haiku-4-5-20251001)
 */

const {
  openaiApiKey,
  anthropicApiKey,
  expenseScanProvider,
  expenseScanModel,
} = require("../../config/env");
const { openaiChatCompletionsWithRetry } = require("../../integrations/openaiTransport");

const EXPENSE_CATEGORIES = [
  "property_tax", "insurance_building", "insurance_liability", "hoa_condo_fees",
  "permits_licenses", "water_sewer", "electric", "gas", "trash_recycling",
  "landscaping", "snow_removal", "pest_control", "elevator_contract",
  "security_monitoring", "pool_maintenance", "management_fee",
  "staff_payroll_allocation", "legal_accounting", "other",
];

const SYSTEM_PROMPT =
  "You are a bill and invoice parser for a property management system.\n" +
  "Extract structured data from the image (utility bill, tax notice, insurance renewal, vendor invoice, or receipt).\n" +
  "Return ONLY a single JSON object — no prose, no markdown fences.\n\n" +
  "Required fields:\n" +
  "- vendor: company or person name on the bill (string or null)\n" +
  "- amount_cents: total amount due or paid in cents as integer (e.g. $142.50 → 14250), or null if unclear\n" +
  "- expense_date: invoice/bill/due date in YYYY-MM-DD format, or null\n" +
  "- category: best matching value from: " + EXPENSE_CATEGORIES.join(", ") + " — or null\n" +
  "- description: one short phrase (e.g. \"May water bill\", \"Q2 property tax\") or null\n\n" +
  "If a field cannot be determined, use null. Never guess amounts.";

const USER_PROMPT = "Extract the expense data from this bill or receipt image.";

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
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: safeType, data: base64 } },
            { type: "text", text: USER_PROMPT },
          ],
        }],
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

function parseOutput(raw) {
  const s = String(raw || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fence ? fence[1] : s;
  const trimmed = jsonStr.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) return {};

  let parsed;
  try { parsed = JSON.parse(trimmed.slice(start, end + 1)); }
  catch { return {}; }

  const vendor = typeof parsed.vendor === "string" && parsed.vendor.trim() ? parsed.vendor.trim() : null;
  const description = typeof parsed.description === "string" && parsed.description.trim() ? parsed.description.trim() : null;

  let amount_cents = null;
  const n = Math.round(Number(parsed.amount_cents));
  if (Number.isFinite(n) && n > 0) amount_cents = n;

  let expense_date = null;
  if (typeof parsed.expense_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.expense_date.trim())) {
    expense_date = parsed.expense_date.trim();
  }

  let category = null;
  if (typeof parsed.category === "string" && EXPENSE_CATEGORIES.includes(parsed.category.trim())) {
    category = parsed.category.trim();
  }

  return { vendor, amount_cents, expense_date, category, description };
}

/**
 * @param {string} base64
 * @param {string} mimeType
 * @returns {Promise<{ vendor, amount_cents, expense_date, category, description, provider, model }>}
 */
async function scanExpenseImage(base64, mimeType) {
  const provider = expenseScanProvider();
  const model = expenseScanModel();
  const apiKey = provider === "anthropic" ? anthropicApiKey() : openaiApiKey();

  if (!apiKey) throw new Error(`${provider}_api_key_missing`);

  const raw = provider === "anthropic"
    ? await callAnthropic(base64, mimeType, model, apiKey)
    : await callOpenAI(base64, mimeType, model, apiKey);

  return { ...parseOutput(raw), provider, model };
}

module.exports = { scanExpenseImage };
