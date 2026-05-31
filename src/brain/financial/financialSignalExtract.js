/**
 * LLM-based financial signal extraction from natural language.
 * Produces a raw hypothesis — V2 brain validates/resolves before posting.
 *
 * Canonical signal shape (same regardless of source channel):
 *   kind, amount_cents, property_hint, unit_hint, tenant_hint,
 *   category_hint, vendor_hint, date_hint, method_hint, reference_hint,
 *   confidence, needs_clarification[]
 */

const { openaiApiKey, openaiModelExtract } = require("../../config/env");
const { openaiChatCompletionsWithRetry } = require("../../integrations/openaiTransport");

const EXPENSE_CATEGORIES = [
  "property_tax", "insurance_building", "insurance_liability", "hoa_condo_fees",
  "permits_licenses", "water_sewer", "electric", "gas", "trash_recycling",
  "landscaping", "snow_removal", "pest_control", "elevator_contract",
  "security_monitoring", "pool_maintenance", "management_fee",
  "staff_payroll_allocation", "legal_accounting", "other",
];

const SYSTEM_PROMPT = [
  "You are a financial signal extractor for a property management system.",
  "Extract structured financial intent from the text. Return ONLY a JSON object — no prose.",
  "",
  "Fields:",
  "- kind: \"expense\" (property operating cost paid by PM), \"payment\" (rent/payment received from tenant),",
  "  \"charge\" (charge to be added to tenant ledger), \"waiver\" (waive a tenant charge), or \"unknown\"",
  "- amount_cents: total amount in cents as integer (e.g. $418 → 41800), or null",
  "- property_hint: property name, address, or abbreviation mentioned, or null",
  "- unit_hint: unit/apartment number or label (e.g. \"3A\", \"303\", \"apt 5\"), or null",
  "- tenant_hint: tenant name if mentioned, or null",
  `- category_hint: for expenses, best match from: ${EXPENSE_CATEGORIES.join(", ")} — or null`,
  "- vendor_hint: vendor, utility company, or payee name, or null",
  "- date_hint: ISO date YYYY-MM-DD if explicit, \"today\", \"yesterday\", or null",
  "- method_hint: for payments — \"check\", \"wire\", \"zelle\", \"ach\", \"cash\", \"money_order\", or null",
  "- reference_hint: check number, wire reference, or other payment ref, or null",
  "- confidence: \"high\" if amount + kind are clear, otherwise \"low\"",
  "- needs_clarification: array of field names that are missing or ambiguous (e.g. [\"property\", \"unit\"])",
  "",
  "Examples:",
  "  \"paid utility co $418 main building\" → kind=expense, vendor_hint=utility co, amount_cents=41800, property_hint=main building, category_hint=electric",
  "  \"apt 303 building A paid rent $3000 cash\" → kind=payment, unit_hint=303, property_hint=building A, amount_cents=300000, method_hint=cash",
  "  \"got check 1042 from Maria unit 5B $1800\" → kind=payment, unit_hint=5B, tenant_hint=Maria, amount_cents=180000, method_hint=check, reference_hint=1042",
  "  \"waive late fee unit 2A\" → kind=waiver, unit_hint=2A",
  "  \"water bill $380\" → kind=expense, category_hint=water_sewer, amount_cents=38000",
].join("\n");

function emptySignal() {
  return {
    kind: "unknown",
    amount_cents: null,
    property_hint: null,
    unit_hint: null,
    tenant_hint: null,
    category_hint: null,
    vendor_hint: null,
    date_hint: null,
    method_hint: null,
    reference_hint: null,
    confidence: "low",
    needs_clarification: [],
  };
}

function parseJson(raw) {
  const s = String(raw || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fence ? fence[1] : s;
  const trimmed = str.trim();
  const i = trimmed.indexOf("{");
  const j = trimmed.lastIndexOf("}");
  if (i === -1 || j === -1) return null;
  try { return JSON.parse(trimmed.slice(i, j + 1)); } catch { return null; }
}

function normalizeSignal(raw) {
  if (!raw || typeof raw !== "object") return emptySignal();
  const KINDS = new Set(["expense", "payment", "charge", "waiver", "unknown"]);
  const METHODS = new Set(["check", "wire", "zelle", "ach", "cash", "money_order"]);

  const kind = KINDS.has(String(raw.kind || "")) ? String(raw.kind) : "unknown";

  let amount_cents = null;
  const n = Math.round(Number(raw.amount_cents));
  if (Number.isFinite(n) && n > 0) amount_cents = n;

  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

  let date_hint = str(raw.date_hint);
  if (date_hint && !/^\d{4}-\d{2}-\d{2}$/.test(date_hint) && !/^today$|^yesterday$/i.test(date_hint)) {
    date_hint = null;
  }

  const category_hint = EXPENSE_CATEGORIES.includes(String(raw.category_hint || ""))
    ? String(raw.category_hint)
    : null;

  const method_hint = METHODS.has(String(raw.method_hint || "").toLowerCase())
    ? String(raw.method_hint).toLowerCase()
    : null;

  const needs_clarification = Array.isArray(raw.needs_clarification)
    ? raw.needs_clarification.map(String).filter(Boolean)
    : [];

  const confidence =
    kind !== "unknown" && amount_cents != null ? String(raw.confidence || "low") : "low";

  return {
    kind,
    amount_cents,
    property_hint: str(raw.property_hint),
    unit_hint: str(raw.unit_hint),
    tenant_hint: str(raw.tenant_hint),
    category_hint,
    vendor_hint: str(raw.vendor_hint),
    date_hint,
    method_hint,
    reference_hint: str(raw.reference_hint),
    confidence,
    needs_clarification,
  };
}

/**
 * Extract financial intent from natural language text using LLM.
 * Returns canonical signal shape — not validated against real DB state yet.
 *
 * @param {string} text
 * @param {{ apiKey?: string, model?: string }} [opts]
 * @returns {Promise<ReturnType<typeof emptySignal>>}
 */
async function extractFinancialSignal(text, opts) {
  const apiKey = String((opts && opts.apiKey) || openaiApiKey() || "").trim();
  const model = String((opts && opts.model) || openaiModelExtract() || "gpt-4o-mini").trim();
  const body = String(text || "").trim();
  if (!body) return emptySignal();
  if (!apiKey) {
    // Fallback: deterministic amount extraction when no LLM key
    return emptySignal();
  }

  const r = await openaiChatCompletionsWithRetry({
    apiKey,
    timeoutMs: 12000,
    maxRetries: 1,
    body: {
      model,
      max_tokens: 400,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: body },
      ],
    },
  });

  if (!r.ok || !r.data) return emptySignal();
  const content = r.data?.choices?.[0]?.message?.content;
  const parsed = parseJson(content);
  return normalizeSignal(parsed);
}

module.exports = { extractFinancialSignal, emptySignal, EXPENSE_CATEGORIES };
