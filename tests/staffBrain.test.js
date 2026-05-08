/**
 * Pure staff brain helpers — no DB.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { resolveTargetWorkItemForStaff } = require("../src/brain/staff/resolveTargetWorkItemForStaff");
const { normalizeStaffOutcome, parsePartsEta } = require("../src/brain/staff/normalizeStaffOutcome");
const {
  staffExtractScheduleRemainderFromTarget,
} = require("../src/brain/staff/lifecycleExtract");

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

  test("short_name / friendly building name + unit (properties menu, parity with intake)", () => {
    const openWis = [
      {
        workItemId: "WI_M1",
        unitId: "204",
        propertyId: "MURR",
        metadata_json: {},
      },
      {
        workItemId: "WI_M2",
        unitId: "305",
        propertyId: "MURR",
        metadata_json: {},
      },
    ];
    const menu = [
      {
        code: "MURR",
        display_name: "Murray Commons",
        short_name: "Murray",
        ticket_prefix: "MURR",
      },
    ];
    const r = resolveTargetWorkItemForStaff({
      openWis,
      bodyTrim: "Murray 204 scheduled for tomorrow 11am",
      ctx: null,
      knownPropertyCodesUpper: new Set(["MURR"]),
      propertiesList: menu,
    });
    assert.equal(r.wiId, "WI_M1");
    assert.equal(r.reason, "PROPERTY_UNIT_MATCH");
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

  test("empty property_id on WI: Murray + unit still resolves (relaxed filter)", () => {
    const openWis = [
      {
        workItemId: "WI_319",
        unitId: "319",
        propertyId: "",
        metadata_json: { issueSummary: "Tube clogged" },
      },
      {
        workItemId: "WI_204",
        unitId: "204",
        propertyId: "MURR",
        metadata_json: {},
      },
    ];
    const menu = [
      {
        code: "MURR",
        display_name: "Murray Commons",
        short_name: "Murray",
        ticket_prefix: "MURR",
      },
    ];
    const r = resolveTargetWorkItemForStaff({
      openWis,
      bodyTrim: "Murray 319, Tube clogged schedule for tomorrow afternoon",
      ctx: null,
      knownPropertyCodesUpper: new Set(["MURR"]),
      propertiesList: menu,
    });
    assert.equal(r.wiId, "WI_319");
    assert.equal(r.reason, "UNIT_MATCH_RELAXED_PROPERTY");
  });

  test("two WIs same property+unit — Tube in body disambiguates (not only tub)", () => {
    const openWis = [
      {
        workItemId: "WI_TUBE",
        unitId: "319",
        propertyId: "MURR",
        metadata_json: { issueSummary: "Tube clogged in bathroom" },
      },
      {
        workItemId: "WI_SINK",
        unitId: "319",
        propertyId: "MURR",
        metadata_json: { issueSummary: "Kitchen sink leak" },
      },
    ];
    const menu = [
      {
        code: "MURR",
        display_name: "Murray Commons",
        short_name: "Murray",
        ticket_prefix: "MURR",
      },
    ];
    const r = resolveTargetWorkItemForStaff({
      openWis,
      bodyTrim: "Murray 319, Tube clogged schedule tomorrow afternoon",
      ctx: null,
      knownPropertyCodesUpper: new Set(["MURR"]),
      propertiesList: menu,
    });
    assert.equal(r.wiId, "WI_TUBE");
    assert.equal(r.reason, "ISSUE_HINT_MATCH");
  });

  test("multi candidate — issue hint match (GAS scoreCandidatesByIssueHints_)", () => {
    const openWis = [
      {
        workItemId: "WI_A",
        unitId: "12",
        propertyId: "PENN",
        metadata_json: { issueSummary: "Kitchen sink clogged" },
      },
      {
        workItemId: "WI_B",
        unitId: "12",
        propertyId: "PENN",
        metadata_json: { issueSummary: "Toilet running" },
      },
    ];
    const r = resolveTargetWorkItemForStaff({
      openWis,
      bodyTrim: "sink clogged done",
      ctx: null,
      knownPropertyCodesUpper: new Set(["PENN"]),
    });
    assert.equal(r.wiId, "WI_A");
    assert.equal(r.reason, "ISSUE_HINT_MATCH");
  });

  test("CTX fallback when pending id not in open list but DB row is open + owner match", () => {
    const openWis = [
      { workItemId: "WI_OTHER", unitId: "1", propertyId: "PENN", metadata_json: {} },
      { workItemId: "WI_Z", unitId: "2", propertyId: "PENN", metadata_json: {} },
    ];
    /** Property + unit filter yields 0 matches so resolver reaches CTX (not CLARIFICATION_MULTI_MATCH). */
    const r = resolveTargetWorkItemForStaff({
      openWis,
      bodyTrim: "PENN unit 999 done",
      ctx: { pending_work_item_id: "WI_CTX" },
      knownPropertyCodesUpper: new Set(["PENN"]),
      staffId: "STAFF_1",
      ctxPendingWi: {
        status: "OPEN",
        owner_id: "STAFF_1",
      },
    });
    assert.equal(r.wiId, "WI_CTX");
    assert.equal(r.reason, "CTX");
  });

  test("CTX fallback does not steal another owner ticket", () => {
    const openWis = [
      { workItemId: "WI_OTHER", unitId: "1", propertyId: "PENN", metadata_json: {} },
      { workItemId: "WI_Z", unitId: "2", propertyId: "PENN", metadata_json: {} },
    ];
    const r = resolveTargetWorkItemForStaff({
      openWis,
      bodyTrim: "PENN unit 999 done",
      ctx: { pending_work_item_id: "WI_CTX" },
      knownPropertyCodesUpper: new Set(["PENN"]),
      staffId: "STAFF_1",
      ctxPendingWi: {
        status: "OPEN",
        owner_id: "STAFF_2",
      },
    });
    assert.equal(r.wiId, "");
  });
});

describe("staffExtractScheduleRemainderFromTarget (GAS staffExtractScheduleRemainderFromTarget_)", () => {
  test("strips property code and unit, leaves schedule phrase", () => {
    const r = staffExtractScheduleRemainderFromTarget(
      "PENN unit 12 tomorrow 9-11am",
      "12",
      "PENN"
    );
    assert.match(r, /tomorrow/i);
    assert.match(r, /9/);
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

  test("parts ETA — slash date (GAS lifecycleParsePartsEta_)", () => {
    const eta = parsePartsEta("waiting on parts eta 4/17/2026");
    assert.ok(eta.partsEtaAt);
    assert.match(eta.partsEtaText, /4\/17/);
  });

  test("parts ETA — month name", () => {
    const eta = parsePartsEta("waiting for parts by april 20");
    assert.ok(eta.partsEtaAt);
    assert.match(eta.partsEtaText, /april/i);
  });
});
