/**
 * Port of GAS `recomputeDraftExpected_` — **pre-ticket** slice only (`11_TICKET_FINALIZE_ENGINE.gs` ~147–171).
 *
 * PARITY GAP: `SCHEDULE_PRETICKET` / opener branches and full GAS branch set not ported.
 * Intake order: Issue → Property → Unit → (schedule post-ticket in full GAS) → FINALIZE_DRAFT.
 *
 * @param {object} s
 * @param {boolean} s.hasIssue
 * @param {boolean} s.hasProperty
 * @param {boolean} s.hasUnit
 * @param {boolean} [s.hasSchedule]
 * @param {number} [s.pendingTicketRow] — Sheet row; 0 = no ticket yet. V2: 0 until finalize creates one.
 * @param {boolean} [s.skipScheduling] — ctx / emergency: skip schedule stage
 * @param {boolean} [s.isEmergencyContinuation]
 */
function recomputeDraftExpected(s) {
  const hasIssue = !!s.hasIssue;
  const hasProperty = !!s.hasProperty;
  const hasUnit = !!s.hasUnit;
  const hasSchedule = !!s.hasSchedule;
  const pendingRow = Number(s.pendingTicketRow || 0);
  const skipScheduling = !!s.skipScheduling;
  const emerg = !!s.isEmergencyContinuation;

  let next = "";
  if (!hasIssue) next = "ISSUE";
  else if (!hasProperty) next = "PROPERTY";
  else if (!hasUnit) next = "UNIT";
  else if (pendingRow > 0 && !hasSchedule) {
    next = "SCHEDULE";
  } else if (pendingRow <= 0) {
    next = "FINALIZE_DRAFT";
  } else {
    next = "";
  }

  if (next === "SCHEDULE" && (emerg || skipScheduling)) {
    next = "EMERGENCY_DONE";
  }

  return {
    next,
    flags: {
      hasIssue,
      hasProperty,
      hasUnit,
      hasSchedule,
      pendingTicketRow: pendingRow,
    },
  };
}

module.exports = { recomputeDraftExpected };
