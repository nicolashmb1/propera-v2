"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveLocationTarget,
  normalizeTargetKindFromPortal,
  isUuid,
} = require("../src/brain/location/resolveLocationTarget");
const {
  createScenarioMemorySupabase,
  scenarioMaintenanceSeedPenn,
} = require("./helpers/memorySupabaseScenario");

test("normalizeTargetKindFromPortal defaults to unit", () => {
  assert.equal(normalizeTargetKindFromPortal(""), "unit");
  assert.equal(normalizeTargetKindFromPortal("COMMON_AREA"), "common_area");
  assert.equal(normalizeTargetKindFromPortal("property"), "property");
});

test("isUuid accepts RFC4122 shape", () => {
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid("550e8400-e29b-41d4-a716-446655440000"), true);
});

test("structured_portal common_area resolves without unit", async () => {
  const r = await resolveLocationTarget({
    sb: null,
    source: "structured_portal",
    propertyCode: "PENN",
    portalPayload: {
      location_kind: "common_area",
      location_label_snapshot: "Lobby",
      message: "wet floor",
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.target.locationType, "COMMON_AREA");
  assert.equal(r.target.unit_label_snapshot, "");
});

test("structured_portal common_area with location_id uses property_locations row", async () => {
  const locId = "550e8400-e29b-41d4-a716-446655440099";
  const seed = {
    ...scenarioMaintenanceSeedPenn(),
    property_locations: [
      {
        id: locId,
        property_code: "PENN",
        kind: "common_area",
        label: "Lobby",
        active: true,
      },
    ],
  };
  const sb = createScenarioMemorySupabase(seed);
  const r = await resolveLocationTarget({
    sb,
    source: "structured_portal",
    propertyCode: "PENN",
    portalPayload: {
      location_kind: "common_area",
      location_id: locId,
      message: "wet floor",
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.target.location_id, locId);
  assert.equal(r.target.location_label_snapshot, "Lobby");
});

test("structured_portal common_area rejects location_id with wrong kind", async () => {
  const locId = "550e8400-e29b-41d4-a716-446655440088";
  const seed = {
    ...scenarioMaintenanceSeedPenn(),
    property_locations: [
      {
        id: locId,
        property_code: "PENN",
        kind: "property",
        label: "Whole building",
        active: true,
      },
    ],
  };
  const sb = createScenarioMemorySupabase(seed);
  const r = await resolveLocationTarget({
    sb,
    source: "structured_portal",
    propertyCode: "PENN",
    portalPayload: {
      location_kind: "common_area",
      location_id: locId,
      message: "issue",
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error_code, "unknown_target");
});

test("structured_portal unit requires target when no catalog match possible", async () => {
  const r = await resolveLocationTarget({
    sb: null,
    source: "structured_portal",
    propertyCode: "PENN",
    portalPayload: {
      location_kind: "unit",
      unit: "",
      unit_catalog_id: "550e8400-e29b-41d4-a716-446655440000",
      message: "leak",
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error_code, "unknown_target");
});

test("draft_hints COMMON_AREA from NL hints", async () => {
  const r = await resolveLocationTarget({
    sb: null,
    source: "draft_hints",
    propertyCode: "PENN",
    fastDraft: { unitLabel: "", issueText: "elevator stuck", locationType: "UNIT" },
    effectiveBody: "elevator stuck between floors",
    issueText: "elevator stuck",
  });
  assert.equal(r.ok, true);
  assert.equal(r.target.locationType, "COMMON_AREA");
});

test("draft_hints unit requires label when sb missing catalog", async () => {
  const r = await resolveLocationTarget({
    sb: null,
    source: "draft_hints",
    propertyCode: "PENN",
    fastDraft: { unitLabel: "808", issueText: "leak" },
    effectiveBody: "# PENN apt 808 Plumbing: leak",
    issueText: "leak",
  });
  assert.equal(r.ok, true);
  assert.equal(r.target.kind, "unit");
  assert.equal(r.target.unit_label_snapshot, "808");
});
