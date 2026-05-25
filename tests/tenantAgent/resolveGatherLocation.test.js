"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyGatherLocationFields,
  tenantDescribesCommonAreaIssue,
} = require("../../src/adapters/tenantAgent/resolveGatherLocation");
const { completenessCheck } = require("../../src/adapters/tenantAgent/completeness");
const {
  buildHandoffRouterParameterFromAgent,
} = require("../../src/adapters/tenantAgent/buildHandoffRouterParameter");

test("tenantDescribesCommonAreaIssue — elevator not in unit", () => {
  const msg =
    "I'm from unit 205 but the issue is not in my unit it's in the elevator at the lobby";
  assert.equal(tenantDescribesCommonAreaIssue(msg), true);
});

test("applyGatherLocationFields — common area keeps reporter unit", () => {
  const next = {
    property: "WESTFIELD",
    unit: "205",
    issue: "elevator smells horrible in the lobby",
  };
  applyGatherLocationFields(next, {
    body: "I'm from unit 205 but the issue is not in my unit it's in the elevator at the lobby",
    prev: {},
    parsed: { unitLabel: "205", locationType: "UNIT" },
  });
  assert.equal(next.location_kind, "common_area");
  assert.equal(next.unit, "");
  assert.equal(next.report_source_unit, "205");
  assert.equal(next.location_label_snapshot, "elevator");
  assert.equal(next.preferredWindow, undefined);
});

test("completenessCheck — common_area ready without schedule", () => {
  const known = new Set(["WESTFIELD"]);
  assert.deepEqual(
    completenessCheck(
      {
        property: "WESTFIELD",
        issue: "elevator odor in lobby",
        location_kind: "common_area",
        location_label_snapshot: "elevator",
      },
      known
    ),
    { ready: true, missing: null }
  );
});

test("buildHandoffRouterParameterFromAgent — common_area omits unit visit schedule", () => {
  const rp = buildHandoffRouterParameterFromAgent({
    partialPackage: {
      property: "WESTFIELD",
      issue: "Elevator odor in lobby",
      location_kind: "common_area",
      location_label_snapshot: "elevator",
      report_source_unit: "205",
      preferredWindow: "tomorrow morning",
    },
    tenantActorKey: "+15551234001",
    transportChannel: "telegram",
    conversationId: "conv-1",
    traceId: "trace-1",
  });
  const payload = JSON.parse(rp._portalPayloadJson);
  assert.equal(payload.location_kind, "common_area");
  assert.equal(payload.unit, "");
  assert.equal(payload.report_source_unit, "205");
  assert.equal(payload.preferredWindow, "");
  assert.equal(payload.postCreate.scheduleMode, "NONE");
});
