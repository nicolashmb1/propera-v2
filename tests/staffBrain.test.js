/**
 * Pure staff brain helpers — no DB.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { resolveTargetWorkItemForStaff } = require("../src/brain/staff/resolveTargetWorkItemForStaff");
const { normalizeStaffOutcome } = require("../src/brain/staff/normalizeStaffOutcome");

describe("resolveTargetWorkItemForStaff", () => {
  test("single open WI — owner match", () => {
    const openWis = [
      {
        workItemId: "WI_ABC",
        unitId: "12",
        propertyId: "PENN",
        metadata_json: {},
      },
    ];
    const r = resolveTargetWorkItemForStaff({
      openWis,
      bodyTrim: "done",
      ctx: null,
      knownPropertyCodesUpper: new Set(["PENN"]),
    });
    assert.equal(r.wiId, "WI_ABC");
    assert.equal(r.reason, "OWNER_MATCH");
  });

  test("WI_ hint wins among many", () => {
    const openWis = [
      { workItemId: "WI_X1", unitId: "1", propertyId: "PENN", metadata_json: {} },
      { workItemId: "WI_X2", unitId: "2", propertyId: "PENN", metadata_json: {} },
    ];
    const r = resolveTargetWorkItemForStaff({
      openWis,
      bodyTrim: "WI_X2 done",
      ctx: null,
      knownPropertyCodesUpper: new Set(["PENN"]),
    });
    assert.equal(r.wiId, "WI_X2");
    assert.equal(r.reason, "WI_ID_MATCH");
  });
});

describe("normalizeStaffOutcome", () => {
  test("done → COMPLETED", () => {
    assert.equal(normalizeStaffOutcome("all done now"), "COMPLETED");
  });
  test("waiting on parts → object", () => {
    const o = normalizeStaffOutcome("waiting on parts");
    assert.equal(typeof o, "object");
    assert.equal(o.outcome, "WAITING_PARTS");
  });
});
