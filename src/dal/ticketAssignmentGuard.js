/**
 * PM assignment override — policy writes must not clobber `assignment_source = PM_OVERRIDE`.
 * @see docs/PM_ASSIGNMENT_OVERRIDE.md Phase 3
 *
 * // PARITY GAP: only ticket-row columns are stripped; work_items.owner_id has no second writer today —
 * // see docs/PM_ASSIGNMENT_OVERRIDE.md if a policy path starts syncing WI owner without the ticket row.
 */

/** Machine value written by `applyPortalTicketAssignment` (portal PM cockpit). */
const PM_ASSIGNMENT_OVERRIDE_SOURCE = "PM_OVERRIDE";

/** Ticket columns owned by policy/automation assignment (not status/schedule/body). */
const TICKET_ASSIGNMENT_POLICY_KEYS = [
  "assign_to",
  "assigned_name",
  "assigned_type",
  "assigned_id",
  "assigned_at",
  "assigned_by",
  "assignment_source",
  "assignment_note",
  "assignment_updated_at",
  "assignment_updated_by",
];

/**
 * @param {unknown} assignmentSource — `tickets.assignment_source`
 * @returns {boolean}
 */
function isPmAssignmentOverride(assignmentSource) {
  return String(assignmentSource || "").trim().toUpperCase() === PM_ASSIGNMENT_OVERRIDE_SOURCE;
}

/**
 * @param {{ assignment_source?: unknown } | null | undefined} row — `tickets` row (partial ok)
 * @returns {boolean}
 */
function ticketRowHasPmAssignmentOverride(row) {
  return !!(row && isPmAssignmentOverride(row.assignment_source));
}

/**
 * Returns a shallow copy of `patch` with policy assignment keys removed when the existing
 * ticket row is PM-locked. Call before `tickets.update` for any non-PM-portal write.
 *
 * @param {{ assignment_source?: unknown } | null | undefined} existingTicketRow
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>}
 */
function mergeTicketUpdateRespectingPmOverride(existingTicketRow, patch) {
  const p = patch && typeof patch === "object" ? { ...patch } : {};
  if (!ticketRowHasPmAssignmentOverride(existingTicketRow)) return p;
  for (const k of TICKET_ASSIGNMENT_POLICY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(p, k)) delete p[k];
  }
  return p;
}

module.exports = {
  PM_ASSIGNMENT_OVERRIDE_SOURCE,
  TICKET_ASSIGNMENT_POLICY_KEYS,
  isPmAssignmentOverride,
  ticketRowHasPmAssignmentOverride,
  mergeTicketUpdateRespectingPmOverride,
};
