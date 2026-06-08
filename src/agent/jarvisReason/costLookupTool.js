/**
 * Jarvis reasoning — flexible, read-only maintenance spend lookup.
 *
 * Answers money questions by aggregating real cost rows, not a canned report:
 *   - "how much did we spend this year on maintenance"  → createdAfter=YYYY-01-01
 *   - "what did we spend on plumbing at Penn this month" → propertyCode + entryTypeIn + createdWithinDays + groupBy
 *   - "biggest costs lately"                              → rows (not countOnly)
 *
 * Reads `ticket_cost_entries` (042). Gated by the finance flags — returns
 * finance_not_enabled so the model can say cost tracking is off rather than $0.
 * Voided rows are filtered in JS so this works whether or not migration 053 is applied.
 * @see docs/PROPERA_FINANCIAL_LAYER_MAP.md
 */

const { getSupabase } = require("../../db/supabase");
const { financeCoreEnabled, financeTicketCostsEnabled } = require("../../config/env");

const COST_WINDOW = 2000;
const DEFAULT_ROW_LIMIT = 20;
const MAX_ROW_LIMIT = 50;

const ENTRY_TYPES = new Set([
  "material",
  "parts",
  "labor",
  "vendor_invoice",
  "cleaning",
  "permit",
  "other",
]);

function lc(s) {
  return String(s || "").trim().toLowerCase();
}

function financeAvailable() {
  return financeCoreEnabled() || financeTicketCostsEnabled();
}

function fmtUsd(cents) {
  const n = (Number(cents) || 0) / 100;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function isoFromAfterOrDays(afterIso, withinDays) {
  const after = String(afterIso || "").trim();
  if (after) return after;
  const n = Number(withinDays);
  if (Number.isFinite(n) && n > 0) return new Date(Date.now() - n * 86400000).toISOString();
  return "";
}

/**
 * @param {object} params — see COST_LOOKUP_TOOL_SCHEMA
 * @returns {Promise<object>} read-only spend aggregation
 */
async function lookupCosts(params) {
  const p = params || {};
  if (!financeAvailable()) return { ok: false, error: "finance_not_enabled", financeEnabled: false };
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const propertyCode = String(p.propertyCode || "").trim().toUpperCase();
  const entryTypeIn = Array.isArray(p.entryTypeIn)
    ? p.entryTypeIn.map(lc).filter((t) => ENTRY_TYPES.has(t))
    : [];
  const vendorContains = lc(p.vendorContains);
  const createdAfter = isoFromAfterOrDays(p.createdAfter, p.createdWithinDays);
  const createdBefore = String(p.createdBefore || "").trim();
  const limit = Math.min(
    Math.max(parseInt(p.limit, 10) || DEFAULT_ROW_LIMIT, 1),
    MAX_ROW_LIMIT
  );
  const countOnly = p.countOnly === true;
  const groupBy = ["entry_type", "property", "vendor"].includes(p.groupBy) ? p.groupBy : null;

  let query = sb.from("ticket_cost_entries").select("*");
  if (propertyCode) query = query.eq("property_code", propertyCode);
  if (createdAfter) query = query.gte("created_at", createdAfter);
  if (createdBefore) query = query.lte("created_at", createdBefore);
  query = query.order("created_at", { ascending: false }).limit(COST_WINDOW);

  const { data, error } = await query;
  if (error) return { ok: false, error: String(error.message || error) };
  const raw = Array.isArray(data) ? data : [];
  const capped = raw.length >= COST_WINDOW;

  let companyCents = 0;
  let tenantCents = 0;
  let count = 0;
  const groups = groupBy ? {} : null;
  const rows = [];

  for (const r of raw) {
    if (r.voided_at) continue; // exclude voided (works even if 053 unapplied: field absent => falsy)
    if (entryTypeIn.length && !entryTypeIn.includes(lc(r.entry_type))) continue;
    if (vendorContains && !lc(r.vendor_name).includes(vendorContains)) continue;

    const amt = Number(r.amount_cents) || 0;
    const tc = r.tenant_charge_amount_cents == null ? 0 : Number(r.tenant_charge_amount_cents) || 0;
    companyCents += amt;
    tenantCents += tc;
    count += 1;

    if (groups) {
      const key =
        groupBy === "entry_type"
          ? String(r.entry_type || "other")
          : groupBy === "property"
          ? String(r.property_code || "").toUpperCase() || "—"
          : String(r.vendor_name || "").trim() || "(no vendor)";
      const g = groups[key] || (groups[key] = { count: 0, companyCents: 0 });
      g.count += 1;
      g.companyCents += amt;
    }

    if (!countOnly && rows.length < limit) {
      rows.push({
        amount: fmtUsd(amt),
        amountCents: amt,
        tenantCharge: tc ? fmtUsd(tc) : null,
        type: String(r.entry_type || ""),
        vendor: String(r.vendor_name || "").trim(),
        description: String(r.description || "").trim().slice(0, 140),
        property: String(r.property_code || "").toUpperCase(),
        date: String(r.created_at || "").slice(0, 10),
        on: r.ticket_id ? "ticket" : r.program_run_id ? "preventive" : "other",
      });
    }
  }

  let breakdown = null;
  if (groups) {
    breakdown = {};
    for (const [k, v] of Object.entries(groups)) {
      breakdown[k] = { count: v.count, company: fmtUsd(v.companyCents), companyCents: v.companyCents };
    }
  }

  return {
    ok: true,
    financeEnabled: true,
    entryCount: count,
    totalCompany: fmtUsd(companyCents),
    totalCompanyCents: companyCents,
    totalTenantCharge: fmtUsd(tenantCents),
    totalTenantChargeCents: tenantCents,
    capped, // true => totals are a floor: only the most recent COUNT_WINDOW rows were scanned
    countWindow: COST_WINDOW,
    breakdown,
    rows: countOnly ? [] : rows,
    filtersApplied: {
      propertyCode: propertyCode || null,
      entryTypeIn: entryTypeIn.length ? entryTypeIn : null,
      vendorContains: vendorContains || null,
      createdAfter: createdAfter || null,
      createdBefore: createdBefore || null,
      groupBy,
      countOnly,
      limit,
    },
  };
}

/** OpenAI function-calling schema. */
const COST_LOOKUP_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "lookup_costs",
    description:
      "Aggregate maintenance spend from real cost rows. Read-only. Use for money questions " +
      "('how much did we spend', 'what did plumbing cost'). Amounts are returned in cents and as " +
      "formatted USD. Use groupBy for 'what did we spend it on'. If it returns finance_not_enabled, " +
      "tell the user cost tracking is not turned on (do not report $0).",
    parameters: {
      type: "object",
      properties: {
        propertyCode: { type: "string", description: "Building code, e.g. PENN. Omit for portfolio-wide." },
        entryTypeIn: {
          type: "array",
          items: { type: "string" },
          description: "Filter to cost types: material, parts, labor, vendor_invoice, cleaning, permit, other.",
        },
        vendorContains: { type: "string", description: "Substring match on vendor name." },
        createdWithinDays: { type: "number", description: "Costs from the last N days (e.g. 30 for 'this month-ish')." },
        createdAfter: { type: "string", description: "Costs on/after this date (YYYY-MM-DD). Use YYYY-01-01 for 'this year'." },
        createdBefore: { type: "string", description: "Costs on/before this date (YYYY-MM-DD)." },
        groupBy: {
          type: "string",
          enum: ["entry_type", "property", "vendor"],
          description: "Break the spend down by this dimension.",
        },
        countOnly: { type: "boolean", description: "true = totals/breakdown only, no individual rows." },
        limit: { type: "number", description: "Max cost rows to return (default 20, max 50)." },
      },
      additionalProperties: false,
    },
  },
};

module.exports = {
  lookupCosts,
  COST_LOOKUP_TOOL_SCHEMA,
  COST_WINDOW,
};
