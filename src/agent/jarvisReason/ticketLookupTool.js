/**
 * Jarvis reasoning — flexible, read-only ticket lookup.
 *
 * This is NOT a fixed report. It is one parameterized way to *look at tickets*
 * that the reasoning loop drives differently for every question:
 *   - "what's going on at Penn"        → property=PENN, status=open
 *   - "why so many emergencies at Penn" → property=PENN, priorityIn=[urgent,high], groupBy=category
 *   - "why did Nick only do 4 today"    → assigneeContains=Nick, status=closed, closedWithinDays=1, countOnly
 *
 * Reads `portal_tickets_v1` only. No writes, ever.
 * @see docs/JARVIS_SPINE.md § Read / Query layer
 */

const { getSupabase } = require("../../db/supabase");

// Recent-window cap. We narrow with cheap SQL filters (property + date) first,
// then apply the remaining filters in JS for uniform, case-insensitive matching.
// If the narrowed set still exceeds this, we tell the model the result is capped
// so it phrases counts honestly ("at least N in the recent window").
const COUNT_WINDOW = 300;
const DEFAULT_ROW_LIMIT = 25;
const MAX_ROW_LIMIT = 60;

const SELECT_COLS =
  "ticket_row_id, ticket_id, property_code, property_display_name, unit_label, " +
  "status, category, category_final, message_raw, assigned_name, assign_to, " +
  "preferred_window, priority, created_at, updated_at, closed_at";

const CLOSED_STATUSES = new Set([
  "completed",
  "canceled",
  "cancelled",
  "resolved",
  "closed",
  "done",
  "deleted",
]);

function isClosedStatus(status) {
  return CLOSED_STATUSES.has(String(status || "").trim().toLowerCase());
}

function lc(s) {
  return String(s || "").trim().toLowerCase();
}

function isoFromAfterOrDays(afterIso, withinDays) {
  const after = String(afterIso || "").trim();
  if (after) return after;
  const n = Number(withinDays);
  if (Number.isFinite(n) && n > 0) {
    return new Date(Date.now() - n * 86400000).toISOString();
  }
  return "";
}

function ageDays(createdAt) {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function mapRow(row) {
  const created = String(row.created_at || "");
  return {
    id: String(row.ticket_id || row.ticket_row_id || "").trim(),
    property: String(row.property_code || "").trim(),
    unit: String(row.unit_label || "").trim(),
    status: String(row.status || "").trim(),
    category: String(row.category_final || row.category || "").trim(),
    priority: String(row.priority || "").trim(),
    assignee: String(row.assigned_name || row.assign_to || "").trim(),
    scheduled: !!String(row.preferred_window || "").trim(),
    window: String(row.preferred_window || "").trim(),
    ageDays: ageDays(created),
    created: created.slice(0, 10),
    updated: String(row.updated_at || "").slice(0, 10),
    closed: String(row.closed_at || "").slice(0, 10),
    issue: String(row.message_raw || "").trim().slice(0, 120),
  };
}

function groupKey(mapped, groupBy) {
  switch (groupBy) {
    case "category":
      return mapped.category || "Uncategorized";
    case "priority":
      return mapped.priority || "unset";
    case "status":
      return mapped.status || "unknown";
    case "assignee":
      return mapped.assignee || "unassigned";
    case "property":
      return mapped.property || "—";
    case "unit":
      return mapped.unit || "—";
    default:
      return null;
  }
}

/**
 * @param {object} params — see TICKET_LOOKUP_TOOL_SCHEMA
 * @returns {Promise<object>} read-only result for the reasoning loop
 */
async function lookupTickets(params) {
  const p = params || {};
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", total: 0, returned: 0, rows: [] };

  const propertyCode = String(p.propertyCode || "").trim().toUpperCase();
  const status = ["open", "closed", "any"].includes(p.status) ? p.status : "any";
  const categoryContains = lc(p.categoryContains);
  const textContains = lc(p.textContains);
  const assigneeContains = lc(p.assigneeContains);
  const priorityIn = Array.isArray(p.priorityIn)
    ? p.priorityIn.map(lc).filter(Boolean)
    : [];
  const hasScheduledFilter = typeof p.scheduled === "boolean";
  const unit = lc(p.unit);

  const createdAfter = isoFromAfterOrDays(p.createdAfter, p.createdWithinDays);
  const updatedAfter = isoFromAfterOrDays(p.updatedAfter, p.updatedWithinDays);
  const closedAfter = isoFromAfterOrDays(p.closedAfter, p.closedWithinDays);

  const limit = Math.min(
    Math.max(parseInt(p.limit, 10) || DEFAULT_ROW_LIMIT, 1),
    MAX_ROW_LIMIT
  );
  const countOnly = p.countOnly === true;
  const groupBy = [
    "category",
    "priority",
    "status",
    "assignee",
    "property",
    "unit",
  ].includes(p.groupBy)
    ? p.groupBy
    : null;

  // Cheap, reliable SQL narrowing only. Everything case-sensitive or set-based
  // (open/closed, text, category, assignee, priority) is filtered in JS below.
  let query = sb.from("portal_tickets_v1").select(SELECT_COLS);
  if (propertyCode) query = query.eq("property_code", propertyCode);
  if (createdAfter) query = query.gte("created_at", createdAfter);
  if (updatedAfter) query = query.gte("updated_at", updatedAfter);
  if (closedAfter) query = query.gte("closed_at", closedAfter);
  query = query.order("updated_at", { ascending: false }).limit(COUNT_WINDOW);

  const { data, error } = await query;
  if (error) {
    return { ok: false, error: String(error.message || error), total: 0, returned: 0, rows: [] };
  }
  const raw = Array.isArray(data) ? data : [];
  const capped = raw.length >= COUNT_WINDOW;

  const matched = [];
  for (const row of raw) {
    const closed = isClosedStatus(row.status);
    if (status === "open" && closed) continue;
    if (status === "closed" && !closed) continue;

    if (unit && lc(row.unit_label) !== unit) continue;

    if (priorityIn.length && !priorityIn.includes(lc(row.priority))) continue;

    if (categoryContains) {
      const cat = lc(row.category_final) + " " + lc(row.category);
      if (!cat.includes(categoryContains)) continue;
    }
    if (textContains) {
      const blob =
        lc(row.message_raw) + " " + lc(row.category_final) + " " + lc(row.category);
      if (!blob.includes(textContains)) continue;
    }
    if (assigneeContains) {
      const who = lc(row.assigned_name) + " " + lc(row.assign_to);
      if (!who.includes(assigneeContains)) continue;
    }
    if (hasScheduledFilter) {
      const isScheduled = !!String(row.preferred_window || "").trim();
      if (isScheduled !== p.scheduled) continue;
    }

    matched.push(mapRow(row));
  }

  const total = matched.length;

  let breakdown = null;
  if (groupBy) {
    breakdown = {};
    for (const m of matched) {
      const k = groupKey(m, groupBy);
      breakdown[k] = (breakdown[k] || 0) + 1;
    }
  }

  const rows = countOnly ? [] : matched.slice(0, limit);

  return {
    ok: true,
    total,
    returned: rows.length,
    capped, // true => `total` is a floor: only the most recent COUNT_WINDOW rows were scanned
    countWindow: COUNT_WINDOW,
    breakdown,
    rows,
    filtersApplied: {
      propertyCode: propertyCode || null,
      status,
      unit: unit || null,
      categoryContains: categoryContains || null,
      textContains: textContains || null,
      assigneeContains: assigneeContains || null,
      priorityIn: priorityIn.length ? priorityIn : null,
      scheduled: hasScheduledFilter ? p.scheduled : null,
      createdAfter: createdAfter || null,
      updatedAfter: updatedAfter || null,
      closedAfter: closedAfter || null,
      groupBy,
      countOnly,
      limit,
    },
  };
}

/** OpenAI function-calling schema for the reasoning loop. */
const TICKET_LOOKUP_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "lookup_tickets",
    description:
      "Look up maintenance tickets with flexible filters. Read-only. Call it as many times " +
      "as needed and vary the filters per question. Use countOnly+groupBy for 'how many / why so many' " +
      "questions, and rows for 'what / which' questions. Counts reflect only the most recent window " +
      "when 'capped' is true — say 'at least N' in that case.",
    parameters: {
      type: "object",
      properties: {
        propertyCode: {
          type: "string",
          description: "Building code to scope to, e.g. PENN. Omit for portfolio-wide.",
        },
        status: {
          type: "string",
          enum: ["open", "closed", "any"],
          description: "open = not completed/canceled; closed = completed/canceled/resolved; any = both.",
        },
        unit: { type: "string", description: "Exact unit label, e.g. 423." },
        categoryContains: {
          type: "string",
          description: "Substring match on category, e.g. plumbing, hvac, appliance.",
        },
        textContains: {
          type: "string",
          description: "Substring match on the issue text/category, e.g. leak, emergency, ac.",
        },
        assigneeContains: {
          type: "string",
          description: "Substring match on the assigned staff name, e.g. Nick.",
        },
        priorityIn: {
          type: "array",
          items: { type: "string" },
          description: "Match any of these priorities, e.g. ['urgent','high'] for emergencies.",
        },
        scheduled: {
          type: "boolean",
          description: "true = only tickets with a scheduled window; false = only unscheduled.",
        },
        createdWithinDays: { type: "number", description: "Created in the last N days." },
        createdAfter: { type: "string", description: "Created on/after this date (YYYY-MM-DD). Use for 'this year'." },
        updatedWithinDays: { type: "number", description: "Updated in the last N days." },
        updatedAfter: { type: "string", description: "Updated on/after this date (YYYY-MM-DD)." },
        closedWithinDays: { type: "number", description: "Closed in the last N days. Use closedWithinDays:1 for 'today'." },
        closedAfter: { type: "string", description: "Closed on/after this date (YYYY-MM-DD)." },
        groupBy: {
          type: "string",
          enum: ["category", "priority", "status", "assignee", "property", "unit"],
          description: "Return a count breakdown by this dimension.",
        },
        countOnly: {
          type: "boolean",
          description: "true = return counts/breakdown only, no ticket rows.",
        },
        limit: { type: "number", description: "Max ticket rows to return (default 25, max 60)." },
      },
      additionalProperties: false,
    },
  },
};

module.exports = {
  lookupTickets,
  TICKET_LOOKUP_TOOL_SCHEMA,
  COUNT_WINDOW,
};
