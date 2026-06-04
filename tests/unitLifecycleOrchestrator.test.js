"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.PROPERA_UNIT_LIFECYCLE_ENABLED = "1";
process.env.PROPERA_TURNOVER_ENGINE_ENABLED = "1";

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
const { openUnitOccupancy, getCurrentUnitOccupancy } = require("../src/dal/unitOccupancies");
const {
  syncAfterTenantDeactivated,
  syncAfterLeaseMarkedVacating,
  closeOccupancyWithOptions,
  syncAfterProspectSigned,
  openOccupancyWithSync,
  syncLeaseSnapshotToCurrentOccupancy,
  leaseTermsFromProspect,
} = require("../src/lifecycle/unitLifecycleOrchestrator");

const UNIT_ID = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";
const TENANT_ID = "bbbbbbbb-cccc-4ddd-eeee-ffffffffffff";

describe("unitLifecycleOrchestrator", () => {
  afterEach(() => {
    clearSupabaseClientForTests();
  });

  test("syncAfterTenantDeactivated closes current occupancy", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const opened = await openUnitOccupancy({
      unit_catalog_id: UNIT_ID,
      property_code: "PENN",
      tenant_roster_id: TENANT_ID,
      traceId: "sync-tenant",
    });
    assert.ok(opened.ok);

    const sync = await syncAfterTenantDeactivated(TENANT_ID, { traceId: "sync-tenant" });
    assert.equal(sync.ok, true);
    assert.equal(sync.action, "occupancy_closed");
    assert.equal(String(sync.occupancy.status).toLowerCase(), "past");
  });

  test("syncAfterLeaseMarkedVacating closes current occupancy", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    await openUnitOccupancy({
      unit_catalog_id: UNIT_ID,
      property_code: "PENN",
      tenant_roster_id: TENANT_ID,
    });

    const sync = await syncAfterLeaseMarkedVacating(
      {
        id: "cccccccc-dddd-4eee-ffff-000000000001",
        unit_catalog_id: UNIT_ID,
        property_code: "PENN",
        renewal_status: "vacating",
      },
      { traceId: "sync-lease" }
    );
    assert.equal(sync.ok, true);
    assert.equal(sync.action, "occupancy_closed");
  });

  test("leaseTermsFromProspect derives rent and dates from budget and move-in", () => {
    const terms = leaseTermsFromProspect({
      budget_max_cents: 200000,
      target_move_in: "2026-07-01",
      notes: "pipeline",
    });
    assert.equal(terms.rent_cents, 200000);
    assert.equal(terms.lease_start, "2026-07-01");
    assert.equal(terms.lease_end, "2027-06-30");
  });

  test("syncAfterProspectSigned creates tenant, lease, and opens occupancy", async () => {
    const mem = createScenarioMemorySupabase({
      ...scenarioOccupancySeedPenn316(),
      leasing_prospects: [],
    });
    setSupabaseClientForTests(mem);

    const sync = await syncAfterProspectSigned({
      id: "dddddddd-eeee-4fff-0000-111111111111",
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      name: "Jordan Prospect",
      phone: "+15551234567",
      email: "jordan@example.com",
      budget_max_cents: 210000,
      target_move_in: "2026-08-01",
      notes: "signed via test",
      status: "signed",
    });
    assert.equal(sync.ok, true);
    assert.ok(sync.tenant_id);
    assert.equal(sync.occupancy_action, "occupancy_opened");
    assert.equal(sync.lease.rent_cents, 210000);

    const current = await getCurrentUnitOccupancy(UNIT_ID);
    assert.ok(current.occupancy);
    assert.equal(current.occupancy.tenant_roster_id, sync.tenant_id);
  });

  test("openOccupancyWithSync reactivates inactive tenant", async () => {
    const seed = scenarioOccupancySeedPenn316();
    seed.tenant_roster[0].active = false;
    const mem = createScenarioMemorySupabase(seed);
    setSupabaseClientForTests(mem);

    const opened = await openOccupancyWithSync({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
      traceId: "open-sync",
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.tenant_activated, true);

    const sb = mem;
    const { data: tenant } = await sb
      .from("tenant_roster")
      .select("active")
      .eq("id", TENANT_ID)
      .maybeSingle();
    assert.equal(tenant.active, true);
  });

  test("syncLeaseSnapshotToCurrentOccupancy refreshes current occupancy", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });

    const sb = mem;
    await sb
      .from("unit_leases")
      .update({ rent_cents: 199000, notes: "updated lease" })
      .eq("unit_catalog_id", UNIT_ID);

    const sync = await syncLeaseSnapshotToCurrentOccupancy(UNIT_ID);
    assert.equal(sync.ok, true);
    assert.equal(sync.occupancy.lease_snapshot_json.rent_cents, 199000);
  });

  test("closeOccupancyWithOptions can start turnover before close", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const opened = await openUnitOccupancy({
      unit_catalog_id: UNIT_ID,
      property_code: "PENN",
      tenant_roster_id: TENANT_ID,
    });
    assert.ok(opened.ok);

    const closed = await closeOccupancyWithOptions(opened.occupancy_id, {
      start_turnover: true,
      traceId: "sync-close-to",
    });
    assert.equal(closed.ok, true);
    assert.ok(closed.turnover_id);
    assert.equal(closed.turnover_started, true);
    assert.equal(closed.occupancy.move_out_turnover_id, closed.turnover_id);
  });
});
