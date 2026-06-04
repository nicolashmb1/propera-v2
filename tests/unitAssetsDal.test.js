"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";

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
const {
  addUnitAsset,
  getUnitAssetById,
  listUnitAssets,
  markUnitAssetInactive,
  replaceUnitAsset,
  updateUnitAsset,
} = require("../src/dal/unitAssets");

const UNIT_ID = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";

describe("unitAssets DAL", () => {
  afterEach(() => {
    clearSupabaseClientForTests();
  });

  test("addUnitAsset creates active row with nameplate fields", async () => {
    const mem = createScenarioMemorySupabase(scenarioAssetSeedPenn316());
    setSupabaseClientForTests(mem);

    const out = await addUnitAsset({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      category: "appliance",
      asset_type: "dishwasher",
      make: "Whirlpool",
      model: "WRS571CIHZ",
      serial_number: "XUAZ12345",
      installed_at: "2026-03-01",
      traceId: "asset-test-1",
    });
    assert.equal(out.ok, true);
    assert.ok(out.asset);
    assert.equal(out.asset.status, "active");
    assert.equal(out.asset.make, "Whirlpool");
    assert.equal(out.asset.model, "WRS571CIHZ");
    assert.equal(out.asset.serial_number, "XUAZ12345");
  });

  test("addUnitAsset rejects duplicate active asset type", async () => {
    const mem = createScenarioMemorySupabase(scenarioAssetSeedPenn316());
    setSupabaseClientForTests(mem);

    const first = await addUnitAsset({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      asset_type: "oven",
    });
    assert.equal(first.ok, true);

    const dup = await addUnitAsset({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      asset_type: "Oven",
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.error, "active_asset_type_exists");
  });

  test("updateUnitAsset patches active row", async () => {
    const mem = createScenarioMemorySupabase(scenarioAssetSeedPenn316());
    setSupabaseClientForTests(mem);

    const added = await addUnitAsset({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      asset_type: "range",
      model: "OLD",
    });
    assert.equal(added.ok, true);

    const patched = await updateUnitAsset(added.asset.id, { model: "NEW", serial_number: "SN1" });
    assert.equal(patched.ok, true);
    assert.equal(patched.asset.model, "NEW");
    assert.equal(patched.asset.serial_number, "SN1");
  });

  test("markUnitAssetInactive sets removed status", async () => {
    const mem = createScenarioMemorySupabase(scenarioAssetSeedPenn316());
    setSupabaseClientForTests(mem);

    const added = await addUnitAsset({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      asset_type: "water_heater",
    });
    assert.equal(added.ok, true);

    const removed = await markUnitAssetInactive(added.asset.id, "removed");
    assert.equal(removed.ok, true);
    assert.equal(removed.asset.status, "removed");
  });

  test("replaceUnitAsset chains old to new row", async () => {
    const mem = createScenarioMemorySupabase(scenarioAssetSeedPenn316());
    setSupabaseClientForTests(mem);

    const added = await addUnitAsset({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      asset_type: "dishwasher",
      model: "OLD-DW",
      serial_number: "OLD-SN",
    });
    assert.equal(added.ok, true);

    const replaced = await replaceUnitAsset(added.asset.id, {
      model: "NEW-DW",
      serial_number: "NEW-SN",
    });
    assert.equal(replaced.ok, true);
    assert.equal(replaced.asset.model, "NEW-DW");
    assert.equal(replaced.replaced_asset_id, added.asset.id);

    const old = await getUnitAssetById(added.asset.id);
    assert.equal(old.ok, true);
    assert.equal(old.asset.status, "replaced");
    assert.equal(old.asset.replaced_by_id, replaced.asset.id);

    const list = await listUnitAssets({ unit_catalog_id: UNIT_ID, status: "active" });
    assert.equal(list.ok, true);
    assert.equal(list.assets.length, 1);
    assert.equal(list.assets[0].model, "NEW-DW");
  });
});
