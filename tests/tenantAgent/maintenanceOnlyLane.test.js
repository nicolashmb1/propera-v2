/**
 * Maintenance-only lane — classify + deflect reply.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  isNonMaintenanceRequest,
  isMaintenanceRepairRequest,
  isAccessRequest,
} = require("../../src/adapters/tenantAgent/classifyNonMaintenanceRequest");
const {
  buildStaffContactDeflectReply,
  formatPhoneForTenantDisplay,
} = require("../../src/adapters/tenantAgent/buildStaffContactDeflectReply");
const {
  shouldApplyMaintenanceOnlyGate,
} = require("../../src/adapters/tenantAgent/handleNonMaintenanceDeflect");

describe("classifyNonMaintenanceRequest", () => {
  test("lease copy — non-maintenance", () => {
    assert.equal(isNonMaintenanceRequest("Need a copy of the lease?"), true);
  });

  test("invoice copy — non-maintenance", () => {
    assert.equal(isNonMaintenanceRequest("can i get a copy of my invoice?"), true);
    assert.equal(isNonMaintenanceRequest("no different i need a copy of my rent invoice"), true);
  });

  test("headache abuse — non-maintenance", () => {
    assert.equal(isNonMaintenanceRequest("I have a headache"), true);
  });

  test("garbage truck FAQ — non-maintenance", () => {
    assert.equal(isNonMaintenanceRequest("Where does the garbage truck come?"), true);
  });

  test("gameroom reserve — non-maintenance", () => {
    assert.equal(isNonMaintenanceRequest("Can I reserve the gameroom?"), true);
  });

  test("pool availability — non-maintenance, routes to access not repair", () => {
    const msg =
      "trying to use the pool. is it available or still no open for reservations?";
    assert.equal(isNonMaintenanceRequest(msg), true);
    assert.equal(isMaintenanceRepairRequest(msg), false);
    assert.equal(isAccessRequest(msg), true);
  });

  test("gym hours — non-maintenance", () => {
    assert.equal(
      isNonMaintenanceRequest("hi what time is the gym open until?"),
      true
    );
  });

  test("sink leak — maintenance", () => {
    assert.equal(isNonMaintenanceRequest("410 penn my sink is leaking"), false);
    assert.equal(isMaintenanceRepairRequest("410 penn my sink is leaking"), true);
  });

  test("still leaking after complete — maintenance", () => {
    assert.equal(isNonMaintenanceRequest("My sink is still leaking"), false);
  });

  test("elevator smell — maintenance repair", () => {
    const msg = "Can u send someone to clean this elevator . It's smelling pretty bad";
    assert.equal(isNonMaintenanceRequest(msg), false);
    assert.equal(isMaintenanceRepairRequest(msg), true);
  });
});

describe("buildStaffContactDeflectReply", () => {
  test("includes office phone when provided", () => {
    const reply = buildStaffContactDeflectReply({
      phoneE164: "+19083380390",
      propertyCode: "PENN",
      propertiesList: [{ code: "PENN", display_name: "The Grand at Penn" }],
    });
    assert.match(reply, /only help with maintenance intake/i);
    assert.match(reply, /\(908\) 338-0390/);
    assert.match(reply, /The Grand at Penn/);
  });

  test("formatPhoneForTenantDisplay — US E.164", () => {
    assert.equal(formatPhoneForTenantDisplay("+19083380390"), "(908) 338-0390");
  });
});

describe("shouldApplyMaintenanceOnlyGate", () => {
  test("deflects billing pivot even when stale maintenance issue in partial", () => {
    assert.equal(
      shouldApplyMaintenanceOnlyGate({
        conv: { status: "complete", partial_package: { issue: "washer broken" } },
        bodyText: "can i get a copy of my invoice?",
        partial: { issue: "washer broken", property: "PENN" },
      }),
      true
    );
  });

  test("deflects when issue slot holds billing request mid-gather", () => {
    assert.equal(
      shouldApplyMaintenanceOnlyGate({
        conv: { status: "gathering", partial_package: { issue: "copy of rent invoice" } },
        bodyText: "why u need a maintenance visit?",
        partial: { issue: "copy of rent invoice", property: "PENN", unit: "502" },
      }),
      true
    );
  });

  test("skips when maintenance issue already gathered and message is maintenance", () => {
    assert.equal(
      shouldApplyMaintenanceOnlyGate({
        conv: { status: "gathering", partial_package: { issue: "heat out" } },
        bodyText: "still no heat in 502",
        partial: { issue: "heat out" },
      }),
      false
    );
  });

  test("deflects billing on post-complete even with stale maintenance issue", () => {
    assert.equal(
      shouldApplyMaintenanceOnlyGate({
        conv: { status: "complete", partial_package: { issue: "washer broken" } },
        bodyText: "can i get a copy of my invoice?",
        partial: { issue: "washer broken" },
      }),
      true
    );
  });

  test("allows gate on fresh gather", () => {
    assert.equal(
      shouldApplyMaintenanceOnlyGate({
        conv: { status: "gathering", partial_package: {} },
        bodyText: "need lease copy",
        partial: {},
      }),
      true
    );
  });
});
