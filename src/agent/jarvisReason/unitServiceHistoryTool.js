/**
 * Jarvis reasoning — a unit's past service work, WITH what was tried.
 *
 * Diagnosis needs more than "which tickets" — it needs "what was already done."
 * lookup_tickets returns ticket facts but not service notes; this tool returns a
 * chronological unit history (open + closed) including service_notes, so the model
 * can reason about recurring causes and what's already been attempted.
 *
 * Reads `portal_tickets_v1` scoped by property + unit. Read-only.
 * @see src/agent/jarvisReason/ticketLookupTool.js (the broader ticket search)
 */

const { getSupabase } = require("../../db/supabase");

const HISTORY_WINDOW = 200;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;

const SELECT_COLS =
  "ticket_row_id, ticket_id, property_code, unit_label, status, category, category_final, " +
  "priority, message_raw, service_notes, assigned_name, assign_to, created_at, updated_at, closed_at";

// Equivalence groups for matching the equipment word in free-text issues.
const SYNONYM_GROUPS = [
  ["fridge", "refrigerator", "freezer"],
  ["ac", "a/c", "air conditioner", "air conditioning", "hvac", "heater", "furnace"],
  ["dishwasher"],
  ["washer", "washing machine"],
  ["dryer"],
  ["stove", "oven", "range"],
  ["microwave"],
  ["water heater"],
];

function lc(s) {
  return String(s || "").trim().toLowerCase();
}

function normUnit(s) {
  return lc(s).replace(/\s/g, "");
}

function matchWordsFor(assetType) {
  const t = lc(assetType);
  if (!t) return [];
  const group = SYNONYM_GROUPS.find((g) => g.includes(t));
  return group || [t];
}

function ageDays(createdAt) {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

/**
 * @param {object} params — see UNIT_SERVICE_HISTORY_TOOL_SCHEMA
 * @returns {Promise<object>} read-only unit service history
 */
async function getUnitServiceHistory(params) {
  const p = params || {};
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const propertyCode = String(p.propertyCode || "").trim().toUpperCase();
  const unit = normUnit(p.unit || p.unitLabel);
  if (!propertyCode || !unit) return { ok: false, error: "missing_property_or_unit" };

  const limit = Math.min(Math.max(parseInt(p.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const matchWords = matchWordsFor(p.assetType);

  let query = sb.from("portal_tickets_v1").select(SELECT_COLS).eq("property_code", propertyCode);
  query = query.order("updated_at", { ascending: false }).limit(HISTORY_WINDOW);

  const { data, error } = await query;
  if (error) return { ok: false, error: String(error.message || error) };
  const raw = Array.isArray(data) ? data : [];
  const capped = raw.length >= HISTORY_WINDOW;

  const history = [];
  for (const row of raw) {
    if (normUnit(row.unit_label) !== unit) continue;
    if (matchWords.length) {
      const blob = lc(row.message_raw) + " " + lc(row.category_final) + " " + lc(row.category);
      if (!matchWords.some((w) => blob.includes(w))) continue;
    }
    if (history.length >= limit) break;
    history.push({
      id: String(row.ticket_id || row.ticket_row_id || "").trim(),
      status: String(row.status || "").trim(),
      category: String(row.category_final || row.category || "").trim(),
      priority: String(row.priority || "").trim(),
      assignee: String(row.assigned_name || row.assign_to || "").trim(),
      created: String(row.created_at || "").slice(0, 10),
      closed: String(row.closed_at || "").slice(0, 10),
      ageDays: ageDays(row.created_at),
      issue: String(row.message_raw || "").trim().slice(0, 220),
      serviceNotes: String(row.service_notes || "").trim().slice(0, 300), // what was tried
    });
  }

  return {
    ok: true,
    propertyCode,
    unit: String(p.unit || p.unitLabel || "").trim(),
    assetType: p.assetType ? String(p.assetType).trim() : null,
    count: history.length,
    capped,
    history,
  };
}

/** OpenAI function-calling schema. */
const UNIT_SERVICE_HISTORY_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "get_unit_service_history",
    description:
      "Chronological past service work for a unit (open + closed), INCLUDING the service notes " +
      "describing what was already tried. Read-only. Use for diagnosis — to see recurring issues and " +
      "prior repairs before suggesting possible causes. Pass assetType (e.g. refrigerator) to focus on one " +
      "piece of equipment.",
    parameters: {
      type: "object",
      properties: {
        propertyCode: { type: "string", description: "Building code, e.g. PENN." },
        unit: { type: "string", description: "Unit label, e.g. 502." },
        assetType: {
          type: "string",
          description: "Optional: focus on one equipment type, e.g. refrigerator (fridge), hvac (ac), dishwasher.",
        },
        limit: { type: "number", description: "Max history rows (default 12, max 30)." },
      },
      additionalProperties: false,
    },
  },
};

module.exports = {
  getUnitServiceHistory,
  UNIT_SERVICE_HISTORY_TOOL_SCHEMA,
};
