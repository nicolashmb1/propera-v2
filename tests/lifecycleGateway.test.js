/**
 * Lifecycle gateway — pure helpers.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { isTransitionAllowed } = require("../src/brain/lifecycle/lifecycleAllowedTransitions");
const {
  normalizeLegacyWiStateForLifecycle,
} = require("../src/brain/lifecycle/normalizeLegacyWiState");
const { buildLifecycleFacts } = require("../src/brain/lifecycle/buildLifecycleFacts");
const {
  inferTenantVerifySentiment,
} = require("../src/brain/lifecycle/tryTenantVerifyResolutionReply");

describe("normalizeLegacyWiStateForLifecycle", () => {
  test("OPEN / INTAKE → UNSCHEDULED", () => {
    assert.equal(normalizeLegacyWiStateForLifecycle("OPEN"), "UNSCHEDULED");
    assert.equal(normalizeLegacyWiStateForLifecycle("INTAKE"), "UNSCHEDULED");
  });
  test("IN_PROGRESS → INHOUSE_WORK", () => {
    assert.equal(normalizeLegacyWiStateForLifecycle("IN_PROGRESS"), "INHOUSE_WORK");
  });
});

describe("isTransitionAllowed", () => {
  test("UNSCHEDULED → DONE allowed", () => {
    assert.equal(isTransitionAllowed("UNSCHEDULED", "DONE"), true);
  });
  test("UNSCHEDULED → ACTIVE_WORK not in table (schedule uses direct apply in GAS)", () => {
    assert.equal(isTransitionAllowed("UNSCHEDULED", "ACTIVE_WORK"), false);
  });
});

describe("inferTenantVerifySentiment", () => {
  test("positive / negative / null", () => {
    assert.equal(inferTenantVerifySentiment("yes thanks"), true);
    assert.equal(inferTenantVerifySentiment("still leaking"), false);
    assert.equal(inferTenantVerifySentiment("maybe"), null);
  });
});

describe("buildLifecycleFacts", () => {
  test("merges WI + signal", () => {
    const wi = {
      state: "UNSCHEDULED",
      substate: "",
      phone_e164: "+15551234567",
      ticket_key: "tk-uuid",
      metadata_json: {},
    };
    const sig = {
      eventType: "STAFF_UPDATE",
      wiId: "WI_1",
      propertyId: "PENN",
      outcome: "COMPLETED",
      scheduledEndAt: new Date("2026-04-20T15:00:00Z"),
    };
    const f = buildLifecycleFacts(wi, sig, new Date());
    assert.equal(f.currentState, "UNSCHEDULED");
    assert.equal(f.outcome, "COMPLETED");
    assert.equal(f.ticketKey, "tk-uuid");
  });
});
