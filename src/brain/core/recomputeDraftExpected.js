/**
 * Port of GAS `recomputeDraftExpected_` — **pre-ticket** slice (`11_TICKET_FINALIZE_ENGINE.gs` ~147–171)
 * + expiry minutes (`~173–176`) + emergency guard **only** when `next === "SCHEDULE"` (`~161–171`, not `SCHEDULE_PRETICKET`).
 *
 * Active-ticket whitelist is enforced in `handleInboundCore` (GAS `pendingRow >= 2` guard ~178–191).
 * Issue-count logging (`issueAlignOpt`) remains GAS-only; not returned here.
 *
 * @param {object} s
 * @param {boolean} s.hasIssue
 * @param {boolean} s.hasProperty
 * @param {boolean} s.hasUnit
 * @param {boolean} [s.hasSchedule]
 * @param {number} [s.pendingTicketRow] — Sheet row; 0 = no ticket yet. V2: 0 until finalize creates one.
 * @param {boolean} [s.skipScheduling] — ctx / emergency: skip schedule stage
 * @param {boolean} [s.isEmergencyContinuation]
 * @param {string} [s.openerNext] — compile opener hint (`SCHEDULE` => ask pre-ticket schedule)
 */

/**
 * GAS `expiryMins` — `11_TICKET_FINALIZE_ENGINE.gs` ~174 (30 for schedule asks, else 10).
 * @param {string} next — stage after recompute
 * @returns {number | null} minutes, or null when `next` is empty (no pending expiry)
 */
function expiryMinutesForExpectedStage(next) {
  const n = String(next || "").trim().toUpperCase();
  if (!n) return null;
  return n === "SCHEDULE" || n === "SCHEDULE_PRETICKET" ? 30 : 10;
}

function recomputeDraftExpected(s) {
  const hasIssue = !!s.hasIssue;
  const hasProperty = !!s.hasProperty;
  const hasUnit = !!s.hasUnit;
  const hasSchedule = !!s.hasSchedule;
  const pendingRow = Number(s.pendingTicketRow || 0);
  const skipScheduling = !!s.skipScheduling;
  const emerg = !!s.isEmergencyContinuation;
  const openerNext = String(s.openerNext || "").trim().toUpperCase();

  let next = "";
  if (!hasIssue) next = "ISSUE";
  else if (!hasProperty) next = "PROPERTY";
  else if (!hasUnit) next = "UNIT";
  else if (pendingRow > 0 && !hasSchedule) {
    next = "SCHEDULE";
  } else if (pendingRow <= 0) {
    next = !hasSchedule && openerNext === "SCHEDULE"
      ? "SCHEDULE_PRETICKET"
      : "FINALIZE_DRAFT";
  } else {
    next = "";
  }

  if (next === "SCHEDULE" && (emerg || skipScheduling)) {
    next = "EMERGENCY_DONE";
  }

  const expiryMinutes = expiryMinutesForExpectedStage(next);

  return {
    next,
    expiryMinutes,
    flags: {
      hasIssue,
      hasProperty,
      hasUnit,
      hasSchedule,
      pendingTicketRow: pendingRow,
    },
  };
}

module.exports = { recomputeDraftExpected, expiryMinutesForExpectedStage };
