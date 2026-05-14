const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  isPmAssignmentOverride,
  ticketRowHasPmAssignmentOverride,
  mergeTicketUpdateRespectingPmOverride,
  TICKET_ASSIGNMENT_POLICY_KEYS,
} = require("../src/dal/ticketAssignmentGuard");

describe("ticketAssignmentGuard", () => {
  test("isPmAssignmentOverride is case-insensitive", () => {
    assert.equal(isPmAssignmentOverride("PM_OVERRIDE"), true);
    assert.equal(isPmAssignmentOverride(" pm_override "), true);
    assert.equal(isPmAssignmentOverride("POLICY"), false);
    assert.equal(isPmAssignmentOverride(""), false);
  });

  test("ticketRowHasPmAssignmentOverride reads row", () => {
    assert.equal(ticketRowHasPmAssignmentOverride({ assignment_source: "PM_OVERRIDE" }), true);
    assert.equal(ticketRowHasPmAssignmentOverride({ assignment_source: "POLICY" }), false);
    assert.equal(ticketRowHasPmAssignmentOverride(null), false);
  });

  test("merge strips policy assignment keys when PM_OVERRIDE", () => {
    const row = { assignment_source: "PM_OVERRIDE" };
    const patch = {
      status: "In Progress",
      assigned_id: "STAFF_X",
      assign_to: "X",
      assignment_source: "POLICY",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const out = mergeTicketUpdateRespectingPmOverride(row, patch);
    assert.equal(out.status, "In Progress");
    assert.equal(out.updated_at, "2026-01-01T00:00:00.000Z");
    assert.equal("assigned_id" in out, false);
    assert.equal("assign_to" in out, false);
    assert.equal("assignment_source" in out, false);
  });

  test("merge keeps assignment keys when not PM_OVERRIDE", () => {
    const row = { assignment_source: "POLICY" };
    const patch = { assigned_id: "STAFF_Y", updated_at: "z" };
    const out = mergeTicketUpdateRespectingPmOverride(row, patch);
    assert.equal(out.assigned_id, "STAFF_Y");
    assert.equal(out.updated_at, "z");
  });

  test("TICKET_ASSIGNMENT_POLICY_KEYS covers ticket assignment columns", () => {
    assert.ok(TICKET_ASSIGNMENT_POLICY_KEYS.includes("assigned_id"));
    assert.ok(TICKET_ASSIGNMENT_POLICY_KEYS.includes("assignment_source"));
    assert.ok(!TICKET_ASSIGNMENT_POLICY_KEYS.includes("status"));
  });
});
