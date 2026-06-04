/**
 * Enrich ticket targets for Jarvis co-pilot display (read-only).
 */

const { getSupabase } = require("../db/supabase");

/**
 * @param {Date | string | null | undefined}
 */
function ticketAgeDays(createdAt) {
  if (!createdAt) return undefined;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

/**
 * @param {object | null | undefined} target
 */
async function enrichTicketForCopilot(target) {
  const base = target && typeof target === "object" ? { ...target } : null;
  if (!base) return null;

  const humanId = String(base.humanTicketId || base.human_ticket_id || "")
    .trim()
    .toUpperCase();
  if (!humanId) return base;

  const sb = getSupabase();
  if (!sb) return base;

  const { data } = await sb
    .from("portal_tickets_v1")
    .select(
      "ticket_id, ticket_row_id, unit_label, property_code, status, category_final, category, message_raw, created_at"
    )
    .eq("ticket_id", humanId)
    .maybeSingle();

  if (!data) {
    return {
      humanTicketId: humanId,
      ticketRowId: String(base.ticketRowId || base.ticket_row_id || "").trim() || undefined,
      unitLabel: String(base.unitLabel || base.unit_label || "").trim() || undefined,
      propertyCode: String(base.propertyCode || base.property_code || "").trim() || undefined,
      category: String(base.category || "").trim() || undefined,
      status: String(base.status || "").trim() || undefined,
      issue: String(base.issue || base.summary || "").trim().slice(0, 160) || undefined,
    };
  }

  return {
    humanTicketId: String(data.ticket_id || humanId).trim(),
    ticketRowId: String(data.ticket_row_id || base.ticketRowId || "").trim() || undefined,
    unitLabel: String(data.unit_label || base.unitLabel || "").trim() || undefined,
    propertyCode: String(data.property_code || base.propertyCode || "").trim() || undefined,
    category: String(data.category_final || data.category || base.category || "").trim() || undefined,
    status: String(data.status || base.status || "").trim() || undefined,
    issue: String(data.message_raw || base.issue || base.summary || "")
      .trim()
      .slice(0, 160),
    summary: String(data.message_raw || base.summary || "")
      .trim()
      .slice(0, 160),
    created_at: data.created_at || base.created_at || null,
    ageDays: ticketAgeDays(data.created_at || base.created_at),
  };
}

/**
 * @param {object[]} candidates
 */
async function enrichCandidatesForCopilot(candidates) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!list.length) return [];

  const sb = getSupabase();
  const ids = [
    ...new Set(
      list
        .map((c) =>
          String(c.humanTicketId || c.human_ticket_id || "")
            .trim()
            .toUpperCase()
        )
        .filter(Boolean)
    ),
  ];

  /** @type {Map<string, object>} */
  const byId = new Map();
  if (sb && ids.length) {
    const { data } = await sb
      .from("portal_tickets_v1")
      .select(
        "ticket_id, ticket_row_id, unit_label, property_code, status, category_final, category, message_raw, created_at"
      )
      .in("ticket_id", ids);
    for (const row of data || []) {
      const id = String(row.ticket_id || "")
        .trim()
        .toUpperCase();
      if (id) byId.set(id, row);
    }
  }

  return list.map((c) => {
    const humanId = String(c.humanTicketId || c.human_ticket_id || "")
      .trim()
      .toUpperCase();
    const row = humanId ? byId.get(humanId) : null;
    const issue = String(
      row?.message_raw || c.issue || c.summary || c.message_raw || ""
    )
      .trim()
      .slice(0, 160);
    const created = row?.created_at || c.created_at || c.createdAt || null;
    return {
      ...c,
      humanTicketId: humanId || c.humanTicketId,
      unitLabel: String(c.unitLabel || c.unit_label || row?.unit_label || "").trim() || undefined,
      propertyCode:
        String(c.propertyCode || c.property_code || row?.property_code || "")
          .trim()
          .toUpperCase() || undefined,
      category:
        String(c.category || row?.category_final || row?.category || "").trim() || undefined,
      issue: issue || undefined,
      summary: issue || c.summary,
      created_at: created,
      ageDays: ticketAgeDays(created),
    };
  });
}

/**
 * @param {object | null | undefined} scope
 */
function openTicketsFromScope(scope) {
  const opens = (scope?.propertyOpenTickets || []).filter(
    (t) => t && String(t.humanTicketId || "").trim()
  );
  return opens.slice(0, 8).map((t) => ({
    humanTicketId: String(t.humanTicketId).trim(),
    unitLabel: String(t.unitLabel || "").trim() || undefined,
    propertyCode: String(t.propertyCode || scope?.anchor?.propertyCode || "")
      .trim()
      .toUpperCase() || undefined,
    category: String(t.category || "").trim() || undefined,
    status: String(t.status || "").trim() || undefined,
    issue: String(t.summary || "").trim().slice(0, 120) || undefined,
  }));
}

module.exports = {
  enrichTicketForCopilot,
  enrichCandidatesForCopilot,
  openTicketsFromScope,
  ticketAgeDays,
};
