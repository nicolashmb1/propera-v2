"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.PROPERA_UNIT_LIFECYCLE_ENABLED = "1";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  createScenarioMemorySupabase,
  scenarioOccupancySeedPenn316,
} = require("./helpers/memorySupabaseScenario");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../src/db/supabase");
const { openUnitOccupancy, closeUnitOccupancy } = require("../src/dal/unitOccupancies");
const {
  applyUnitCatalogStatus,
  syncUnitStatusOnOccupancyOpen,
  syncUnitStatusOnOccupancyClose,
} = require("../src/lifecycle/unitStatusSync");
const { closeOccupancyWithOptions, openOccupancyWithSync } = require("../src/lifecycle/unitLifecycleOrchestrator");

const UNIT_ID = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";
const TENANT_ID = "bbbbbbbb-cccc-4ddd-eeee-ffffffffffff";

describe("unitStatusSync (Sync V4)", () => {
  afterEach(() => {
    clearSupabaseClientForTests();
  });

  test("applyUnitCatalogStatus sets Occupied on unit row", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const out = await applyUnitCatalogStatus(UNIT_ID, "Occupied", { traceId: "v4-open" });
    assert.equal(out.ok, true);
    assert.equal(out.unit_status, "Occupied");

    const unit = mem._state.units.find((u) => u.id === UNIT_ID);
    assert.equal(unit.status, "Occupied");
  });

  test("applyUnitCatalogStatus skips protected Down status", async () => {
    const seed = scenarioOccupancySeedPenn316();
    seed.units[0].status = "Down";
    const mem = createScenarioMemorySupabase(seed);
    setSupabaseClientForTests(mem);

    const out = await applyUnitCatalogStatus(UNIT_ID, "Vacant");
    assert.equal(out.ok, true);
    assert.equal(out.skipped, "protected_status");
    assert.equal(mem._state.units[0].status, "Down");
  });

  test("openOccupancyWithSync marks unit Occupied", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const opened = await openOccupancyWithSync({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.unit_status_sync.unit_status, "Occupied");
    assert.equal(mem._state.units.find((u) => u.id === UNIT_ID).status, "Occupied");
  });

  test("closeOccupancyWithOptions marks unit Vacant", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const opened = await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });
    mem._state.units.find((u) => u.id === UNIT_ID).status = "Occupied";

    const closed = await closeOccupancyWithOptions(opened.occupancy_id, { traceId: "v4-close" });
    assert.equal(closed.ok, true);
    assert.equal(closed.unit_status_sync.unit_status, "Vacant");
    assert.equal(mem._state.units.find((u) => u.id === UNIT_ID).status, "Vacant");
  });

  test("syncUnitStatusOnOccupancyClose uses ended_at on updated_at", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const opened = await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });
    const closed = await closeUnitOccupancy(opened.occupancy_id, {
      ended_at: "2026-05-01T12:00:00.000Z",
    });
    assert.equal(closed.ok, true);
    mem._state.units.find((u) => u.id === UNIT_ID).status = "Occupied";

    await syncUnitStatusOnOccupancyClose(closed.occupancy, { unitStatus: "Vacant" });
    const unit = mem._state.units.find((u) => u.id === UNIT_ID);
    assert.equal(unit.status, "Vacant");
    assert.equal(unit.updated_at, "2026-05-01T12:00:00.000Z");
  });
});
