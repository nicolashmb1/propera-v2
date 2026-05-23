/**
 * Portal API: hourly open snapshot + completed cumulative for one ops day.
 * @see docs/OPEN_DECK_DAY_CHART_V1.md
 */

const { getSupabase } = require("../db/supabase");
const { properaTimezone } = require("../config/env");
const { buildTicketDayCurve, isOpenForOpsStatus } = require("./ticketDayCurveCore");
const { opsDateString, zonedLocalToUtcMs } = require("./ticketDayCurveTime");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMELINE_CHUNK = 120;

const OPEN_STATUS_DB_VARIANTS = [
  "Open",
  "OPEN",
  "Scheduled",
  "SCHEDULED",
  "Pending",
  "PENDING",
  "In Progress",
  "IN PROGRESS",
  "IN_PROGRESS",
  "Active Work",
  "ACTIVE",
  "Waiting Parts",
  "WAITING PARTS",
  "Waiting Vendor",
  "WAITING VENDOR",
  "Waiting Tenant",
  "WAITING TENANT",
];

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string[]} ticketIds
 */
async function loadTimelineEventsByTicketId(sb, ticketIds, dayEndIso) {
  /** @type {Record<string, object[]>} */
  const eventsByTicketId = {};
  for (let i = 0; i < ticketIds.length; i += TIMELINE_CHUNK) {
    const chunk = ticketIds.slice(i, i + TIMELINE_CHUNK);
    const { data: evRows, error: eErr } = await sb
      .from("ticket_timeline_events")
      .select("ticket_id, occurred_at, event_kind, headline, detail")
      .in("ticket_id", chunk)
      .lte("occurred_at", dayEndIso)
      .order("occurred_at", { ascending: true });
    if (eErr) throw new Error(eErr.message || "timeline_read_failed");
    for (const ev of evRows || []) {
      const tid = String(ev.ticket_id);
      if (!eventsByTicketId[tid]) eventsByTicketId[tid] = [];
      eventsByTicketId[tid].push(ev);
    }
  }
  return eventsByTicketId;
}

/**
 * @param {object} o
 * @param {string} o.date
 * @param {string} [o.propertyCode]
 */
async function fetchTicketDayCurve(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const date = String(o.date || "").trim();
  if (!DATE_RE.test(date)) return { ok: false, error: "invalid_date" };

  const propertyCode = String(o.propertyCode || "")
    .trim()
    .toUpperCase();
  const timeZone = properaTimezone();
  const dayStartIso = new Date(zonedLocalToUtcMs(date, 0, 0, 0, 0, timeZone)).toISOString();
  const dayEndIso = new Date(zonedLocalToUtcMs(date, 23, 59, 59, 999, timeZone)).toISOString();

  try {
    const selectCols = "id, ticket_key, property_code, status, created_at, closed_at";
    let openQ = sb
      .from("tickets")
      .select(selectCols)
      .lte("created_at", dayEndIso)
      .is("closed_at", null);
    let closedQ = sb
      .from("tickets")
      .select(selectCols)
      .gte("closed_at", dayStartIso)
      .lte("closed_at", dayEndIso);

    if (propertyCode) {
      openQ = openQ.eq("property_code", propertyCode);
      closedQ = closedQ.eq("property_code", propertyCode);
    }

    let staleQ = sb
      .from("tickets")
      .select(selectCols)
      .lte("created_at", dayEndIso)
      .not("closed_at", "is", null)
      .in("status", OPEN_STATUS_DB_VARIANTS);

    if (propertyCode) {
      staleQ = staleQ.eq("property_code", propertyCode);
    }

    const [openRes, closedRes, staleRes] = await Promise.all([openQ, closedQ, staleQ]);
    if (openRes.error) return { ok: false, error: openRes.error.message || "tickets_read_failed" };
    if (closedRes.error) return { ok: false, error: closedRes.error.message || "tickets_read_failed" };
    if (staleRes.error) return { ok: false, error: staleRes.error.message || "tickets_read_failed" };

    const staleOpen = (staleRes.data || []).filter((t) => isOpenForOpsStatus(t.status));

    const byId = new Map();
    for (const t of [...(openRes.data || []), ...(closedRes.data || []), ...staleOpen]) {
      if (t && t.id) byId.set(String(t.id), t);
    }
    const tickets = [...byId.values()].filter(
      (t) => String(t.status || "").trim().toLowerCase() !== "deleted"
    );
    const ticketIds = tickets.map((t) => t.id).filter(Boolean);

    const eventsByTicketId =
      ticketIds.length > 0 ? await loadTimelineEventsByTicketId(sb, ticketIds, dayEndIso) : {};

    const curve = buildTicketDayCurve({
      date,
      timeZone,
      tickets,
      eventsByTicketId,
      nowMs: Date.now(),
    });

    return {
      ...curve,
      propertyCode: propertyCode || null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @param {string} [date]
 */
function defaultCurveDate(date) {
  const d = String(date || "").trim();
  if (DATE_RE.test(d)) return d;
  return opsDateString(Date.now(), properaTimezone());
}

module.exports = {
  fetchTicketDayCurve,
  defaultCurveDate,
};
