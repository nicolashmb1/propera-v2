/**
 * Service history analytics — read-only QuerySpec slice (Jarvis Layer 4).
 */

const { getSupabase } = require("../../db/supabase");
const { analyzeUnitsFromTickets } = require("./analyzeServiceHistoryUnits");

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const FETCH_LIMIT = 800;
const SAMPLE_LIMIT = 12;

/**
 * @param {object} row
 */
function ticketSearchText(row) {
  return [
    row.category_final,
    row.category,
    row.message_raw,
    row.service_notes,
  ]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * @param {object} row
 * @param {string[]} keywords
 */
function ticketMatchesKeywords(row, keywords) {
  const text = ticketSearchText(row);
  if (!text || !keywords.length) return false;
  return keywords.some((kw) => {
    const k = String(kw || "").trim().toLowerCase();
    return k.length >= 2 && text.includes(k);
  });
}

/**
 * @param {object} row
 */
function mapHistoryRow(row) {
  return {
    ticketRowId: String(row.ticket_row_id || "").trim(),
    humanTicketId: String(row.ticket_id || "").trim(),
    propertyCode: String(row.property_code || "").trim().toUpperCase(),
    unitLabel: String(row.unit_label || "").trim(),
    status: String(row.status || "").trim(),
    category: String(row.category_final || row.category || "").trim(),
    summary: String(row.message_raw || row.category_final || row.category || "")
      .trim()
      .slice(0, 160),
    createdAt: row.created_at || "",
  };
}

/**
 * @param {object} opts
 * @param {string[]} opts.issueKeywords
 * @param {number} [opts.daysBack]
 * @param {string} [opts.propertyCode]
 * @param {string} [opts.issueLabel]
 * @param {number} [opts.limit]
 * @param {'summary' | 'distinct_units' | 'repeat_units' | 'unit_breakdown'} [opts.analysisMode]
 */
async function queryServiceHistory(opts) {
  const keywords = (opts.issueKeywords || [])
    .map((k) => String(k || "").trim().toLowerCase())
    .filter((k) => k.length >= 2);
  if (!keywords.length) {
    return { ok: false, error: "missing_keywords", message: "Need issue keywords to search." };
  }

  const daysBack = Math.min(
    Math.max(Number(opts.daysBack) || DEFAULT_DAYS, 1),
    MAX_DAYS
  );
  const propertyCode = String(opts.propertyCode || "")
    .trim()
    .toUpperCase();
  const issueLabel = String(opts.issueLabel || keywords[0] || "issue").trim();

  const fromMs = Date.now() - daysBack * 86400000;
  const fromIso = new Date(fromMs).toISOString();

  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "no_db", message: "Database is not configured." };
  }

  let query = sb
    .from("portal_tickets_v1")
    .select(
      "ticket_row_id, ticket_id, property_code, unit_label, status, category, category_final, message_raw, service_notes, created_at"
    )
    .gte("created_at", fromIso)
    .order("created_at", { ascending: false })
    .limit(FETCH_LIMIT);

  if (propertyCode) {
    query = query.eq("property_code", propertyCode);
  }

  const { data, error } = await query;
  if (error) {
    return { ok: false, error: "query_failed", message: error.message };
  }

  const matched = (data || [])
    .filter((row) => ticketMatchesKeywords(row, keywords))
    .map(mapHistoryRow)
    .filter((t) => t.humanTicketId);

  const unitAnalysis = analyzeUnitsFromTickets(matched);
  const analysisMode = String(opts.analysisMode || "summary").trim() || "summary";

  return {
    ok: true,
    count: matched.length,
    daysBack,
    issueLabel,
    keywords,
    propertyCode: propertyCode || undefined,
    analysisMode,
    unitAnalysis,
    tickets: matched.slice(0, Math.min(Number(opts.limit) || SAMPLE_LIMIT, 25)),
    scanned: (data || []).length,
  };
}

module.exports = {
  queryServiceHistory,
  ticketSearchText,
  ticketMatchesKeywords,
  mapHistoryRow,
};
