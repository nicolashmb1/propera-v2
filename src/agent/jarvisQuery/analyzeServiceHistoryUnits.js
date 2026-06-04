/**
 * In-memory unit analytics on service history ticket sets (deterministic).
 */

/**
 * @param {object} ticket
 */
function unitKey(ticket) {
  const prop = String(ticket.propertyCode || "UNKNOWN")
    .trim()
    .toUpperCase();
  const unit = String(ticket.unitLabel || "").trim() || "(no unit)";
  return `${prop}|${unit}`;
}

/**
 * @param {object[]} tickets
 */
function analyzeUnitsFromTickets(tickets) {
  const rows = Array.isArray(tickets) ? tickets : [];
  /** @type {Map<string, { propertyCode: string, unitLabel: string, count: number, tickets: object[] }>} */
  const byUnit = new Map();

  for (const t of rows) {
    const key = unitKey(t);
    const prop = String(t.propertyCode || "UNKNOWN").trim().toUpperCase();
    const unitLabel = String(t.unitLabel || "").trim() || "(no unit)";
    const hit = byUnit.get(key) || {
      propertyCode: prop,
      unitLabel,
      count: 0,
      tickets: [],
    };
    hit.count += 1;
    hit.tickets.push(t);
    byUnit.set(key, hit);
  }

  const units = Array.from(byUnit.values()).sort((a, b) => b.count - a.count);
  const repeatUnits = units.filter((u) => u.count >= 2);
  const singleTicketUnits = units.filter((u) => u.count === 1);

  return {
    distinctUnitCount: units.length,
    repeatUnitCount: repeatUnits.length,
    singleTicketUnitCount: singleTicketUnits.length,
    totalTickets: rows.length,
    repeatUnits: repeatUnits.map((u) => ({
      propertyCode: u.propertyCode,
      unitLabel: u.unitLabel,
      count: u.count,
      ticketIds: u.tickets
        .map((t) => t.humanTicketId)
        .filter(Boolean)
        .slice(0, 5),
    })),
    unitBreakdown: units.map((u) => ({
      propertyCode: u.propertyCode,
      unitLabel: u.unitLabel,
      count: u.count,
    })),
  };
}

module.exports = { analyzeUnitsFromTickets, unitKey };
