"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.PROPERA_UNIT_LIFECYCLE_ENABLED = "1";
process.env.PROPERA_TURNOVER_ENGINE_ENABLED = "1";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  createScenarioMemorySupabase,
  scenarioAssetSeedPenn316,
} = require("./helpers/memorySupabaseScenario");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../src/db/supabase");
const { loadUnitLifecycleScope } = require("../src/agent/operationalScope/loadUnitLifecycleScope");
const { openUnitOccupancy } = require("../src/dal/unitOccupancies");
const { addUnitAsset } = require("../src/dal/unitAssets");

const UNIT_ID = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";
const TENANT_ID = "bbbbbbbb-cccc-4ddd-eeee-ffffffffffff";

describe("loadUnitLifecycleScope", () => {
  afterEach(() => {
    clearSupabaseClientForTests();
  });

  test("loads occupancy and assets for unit catalog id", async () => {
    const mem = createScenarioMemorySupabase(scenarioAssetSeedPenn316());
    setSupabaseClientForTests(mem);

    await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });
    await addUnitAsset({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      asset_type: "dishwasher",
      model: "WRS571",
      serial_number: "SN-1",
    });

    const pack = await loadUnitLifecycleScope({
      propertyCode: "PENN",
      unitCatalogId: UNIT_ID,
    });
    assert.ok(pack);
    assert.equal(pack.unitCatalogId, UNIT_ID);
    assert.equal(pack.activeOccupancy?.residentName, "Alex Tenant");
    assert.equal(pack.unitAssets.length, 1);
    assert.equal(pack.unitAssets[0].model, "WRS571");
  });

  test("resolves unit catalog id from property and unit label", async () => {
    const mem = createScenarioMemorySupabase(scenarioAssetSeedPenn316());
    setSupabaseClientForTests(mem);

    const pack = await loadUnitLifecycleScope({
      propertyCode: "PENN",
      unitLabel: "316",
    });
    assert.ok(pack);
    assert.equal(pack.unitCatalogId, UNIT_ID);
  });
});
