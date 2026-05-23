/**
 * Pure day-curve math for open-deck chart (open snapshots + completed cumulative).
 * @see docs/OPEN_DECK_DAY_CHART_V1.md
 */

const {
  endOfHourUtcMs,
  opsDateString,
  opsHour,
  formatHourLabel,
} = require("./ticketDayCurveTime");

const DISPLAY_START_HOUR = 8;
const DISPLAY_END_HOUR = 20;

const TERMINAL_STATUSES = new Set([
  "completed",
  "canceled",
  "cancelled",
  "resolved",
  "closed",
  "done",
  "deleted",
]);

/**
 * @param {string} raw
 */
function normalizeStatus(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
}

/**
 * @param {string} status
 */
function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(normalizeStatus(status));
}

/** Open-deck parity: non-terminal by status (Completed / Canceled / Resolved only). */
function isOpenForOpsStatus(status) {
  const n = normalizeStatus(status);
  if (!n) return true;
  if (n === "deleted") return false;
  if (n === "done" || n === "closed") return false;
  if (n === "completed" || n === "canceled" || n === "cancelled" || n === "resolved") return false;
  return true;
}

/**
 * @param {string} status
 */
function isDeletedStatus(status) {
  return normalizeStatus(status) === "deleted";
}

/**
 * @param {string|Date|null|undefined} v
 * @returns {number|null}
 */
function parseInstantMs(v) {
  if (v == null || v === "") return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {object} ev
 */
function eventClosesTicket(ev) {
  const k = String(ev.event_kind || "").trim().toLowerCase();
  if (k === "resolved_closed") return true;
  if (k === "status_changed") {
    const blob = `${ev.headline || ""} ${ev.detail || ""}`.toLowerCase();
    return /\b(completed|canceled|cancelled|resolved|closed|done)\b/.test(blob);
  }
  return false;
}

/**
 * @param {object} ev
 */
function eventReopensTicket(ev) {
  const k = String(ev.event_kind || "").trim().toLowerCase();
  if (k !== "status_changed") return false;
  return !eventClosesTicket(ev);
}

/**
 * @param {object} ticket
 * @param {object[]} events sorted asc by occurred_at
 * @param {number} instantMs
 */
function isOpenAtInstant(ticket, events, instantMs) {
  const createdMs = parseInstantMs(ticket.created_at);
  if (createdMs == null || createdMs > instantMs) return false;
  if (isDeletedStatus(ticket.status)) return false;

  const relevant = (events || [])
    .map((ev) => ({ ev, ms: parseInstantMs(ev.occurred_at) }))
    .filter((x) => x.ms != null && x.ms <= instantMs)
    .sort((a, b) => a.ms - b.ms);

  if (!relevant.length) {
    const closedMs = parseInstantMs(ticket.closed_at);
    if (closedMs != null) {
      if (closedMs <= instantMs) return false;
      return true;
    }
    return !isTerminalStatus(ticket.status);
  }

  let open = true;
  for (const { ev } of relevant) {
    if (eventClosesTicket(ev)) open = false;
    else if (eventReopensTicket(ev)) open = true;
  }
  return open;
}

/**
 * @param {object} ticket
 * @param {object[]} events
 * @returns {number|null}
 */
function getCompletedAtMs(ticket, events) {
  const closedMs = parseInstantMs(ticket.closed_at);
  if (closedMs != null && isTerminalStatus(ticket.status)) return closedMs;

  const sorted = (events || [])
    .map((ev) => ({ ev, ms: parseInstantMs(ev.occurred_at) }))
    .filter((x) => x.ms != null)
    .sort((a, b) => a.ms - b.ms);

  for (const { ev, ms } of sorted) {
    if (eventClosesTicket(ev)) return ms;
  }
  return null;
}

/**
 * @param {object} o
 * @param {string} o.date YYYY-MM-DD
 * @param {string} o.timeZone
 * @param {object[]} o.tickets
 * @param {Record<string, object[]>} o.eventsByTicketId keyed by tickets.id
 * @param {number} [o.nowMs]
 */
function buildTicketDayCurve(o) {
  const date = String(o.date || "").trim();
  const timeZone = String(o.timeZone || "UTC").trim() || "UTC";
  const nowMs = o.nowMs != null ? Number(o.nowMs) : Date.now();
  const opsToday = opsDateString(nowMs, timeZone);
  const tickets = Array.isArray(o.tickets) ? o.tickets : [];
  const eventsByTicketId = o.eventsByTicketId && typeof o.eventsByTicketId === "object" ? o.eventsByTicketId : {};

  const afterWindowMs = endOfHourUtcMs(date, DISPLAY_END_HOUR, timeZone);

  const scoped = tickets.filter((t) => !isDeletedStatus(t.status));

  const completedRecords = [];
  for (const t of scoped) {
    const events = eventsByTicketId[String(t.id)] || [];
    const completedMs = getCompletedAtMs(t, events);
    if (completedMs == null) continue;
    if (opsDateString(completedMs, timeZone) !== date) continue;
    completedRecords.push({ ticket: t, completedMs });
  }

  let completedTotal = completedRecords.length;
  let completedAfterDisplayWindow = 0;
  for (const r of completedRecords) {
    if (r.completedMs > afterWindowMs) completedAfterDisplayWindow += 1;
  }

  const currentOpsHour = opsHour(nowMs, timeZone);
  const isToday = date === opsToday;
  const isFutureDay = date > opsToday;
  const beforeDisplayWindow = isToday && currentOpsHour < DISPLAY_START_HOUR;

  let lastPlottedHour = DISPLAY_END_HOUR;
  if (isFutureDay) {
    lastPlottedHour = DISPLAY_START_HOUR - 1;
  } else if (isToday) {
    lastPlottedHour = DISPLAY_START_HOUR - 1;
    for (let h = DISPLAY_END_HOUR; h >= DISPLAY_START_HOUR; h--) {
      if (h <= currentOpsHour) {
        lastPlottedHour = h;
        break;
      }
    }
  }

  function countOpenAt(endMs, useDeckOpenRule) {
    let open = 0;
    for (const t of scoped) {
      if (useDeckOpenRule) {
        if (isOpenForOpsStatus(t.status)) open += 1;
      } else {
        const events = eventsByTicketId[String(t.id)] || [];
        if (isOpenAtInstant(t, events, endMs)) open += 1;
      }
    }
    return open;
  }

  /** @type {object[]} */
  const hours = [];
  for (let hour = DISPLAY_START_HOUR; hour <= DISPLAY_END_HOUR; hour++) {
    const endMs = endOfHourUtcMs(date, hour, timeZone);
    const useDeckRule =
      isToday && (hour >= currentOpsHour || hour === lastPlottedHour);
    const open = countOpenAt(endMs, useDeckRule);

    let completedCumulative = 0;
    for (const r of completedRecords) {
      if (r.completedMs <= endMs) completedCumulative += 1;
    }

    const isFuture = isFutureDay || (isToday && hour > currentOpsHour);

    hours.push({
      hour,
      label: formatHourLabel(hour),
      open,
      completedCumulative,
      isFuture,
    });
  }

  const openNow =
    date === opsToday
      ? scoped.filter((t) => isOpenForOpsStatus(t.status)).length
      : countOpenAt(nowMs, false);

  const openAt8Ms = endOfHourUtcMs(date, DISPLAY_START_HOUR, timeZone);
  let openAtDisplayStart = 0;
  for (const t of scoped) {
    const events = eventsByTicketId[String(t.id)] || [];
    if (isOpenAtInstant(t, events, openAt8Ms)) openAtDisplayStart += 1;
  }

  return {
    ok: true,
    date,
    timezone: timeZone,
    displayWindow: { startHour: DISPLAY_START_HOUR, endHour: DISPLAY_END_HOUR },
    opsToday,
    hours,
    summary: {
      completedTotal,
      completedAfterDisplayWindow,
      openNow: date === opsToday ? openNow : openAtDisplayStart,
      openAtDisplayStart,
    },
    isFutureDay,
    beforeDisplayWindow,
  };
}

module.exports = {
  DISPLAY_START_HOUR,
  DISPLAY_END_HOUR,
  TERMINAL_STATUSES,
  normalizeStatus,
  isTerminalStatus,
  isDeletedStatus,
  isOpenAtInstant,
  isOpenForOpsStatus,
  getCompletedAtMs,
  buildTicketDayCurve,
};
