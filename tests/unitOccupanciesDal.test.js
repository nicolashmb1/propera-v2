"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";

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
const {
  leaseSnapshotFromRow,
  openUnitOccupancy,
  closeUnitOccupancy,
  getCurrentUnitOccupancy,
  listUnitOccupancies,
  patchUnitOccupancy,
} = require("../src/dal/unitOccupancies");

const UNIT_ID = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";
const TENANT_ID = "bbbbbbbb-cccc-4ddd-eeee-ffffffffffff";

describe("unitOccupancies DAL", () => {
  afterEach(() => {
    clearSupabaseClientForTests();
  });

  test("leaseSnapshotFromRow maps lease fields", () => {
    const snap = leaseSnapshotFromRow({
      rent_cents: 100000,
      security_deposit_cents: 50000,
      lease_start: "2026-01-01",
      lease_end: "2026-12-31",
      charge_lines: [{ type: "parking", mode: "fixed", amount_cents: 5000 }],
      notes: "renewal",
    });
    assert.equal(snap.rent_cents, 100000);
    assert.equal(snap.lease_start, "2026-01-01");
    assert.equal(snap.charge_lines.length, 1);
    assert.equal(snap.notes, "renewal");
  });

  test("openUnitOccupancy creates current row with lease snapshot", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const out = await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
      traceId: "occ-test-1",
    });
    assert.equal(out.ok, true);
    assert.ok(out.occupancy_id);
    assert.equal(out.occupancy.status, "current");
    assert.equal(out.occupancy.tenant_roster_id, TENANT_ID);
    assert.equal(out.occupancy.resident_name_snapshot, "Alex Tenant");
    assert.equal(out.occupancy.lease_snapshot_json.rent_cents, 185000);
    assert.equal(out.occupancy.lease_snapshot_json.lease_start, "2026-01-01");
  });

  test("openUnitOccupancy rejects duplicate current occupancy", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const first = await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });
    assert.equal(first.ok, true);

    const dup = await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.error, "active_occupancy_exists");
    assert.ok(dup.existing_occupancy_id);
  });

  test("openUnitOccupancy rejects tenant unit mismatch", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    await mem.from("tenant_roster").insert({
      id: "dddddddd-eeee-4fff-0000-111111111111",
      property_code: "PENN",
      unit_label: "999",
      phone_e164: "+15559999999",
      resident_name: "Wrong Unit",
      active: true,
    });

    const out = await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: "dddddddd-eeee-4fff-0000-111111111111",
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "tenant_unit_mismatch");
  });

  test("closeUnitOccupancy marks past and ended_at set", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const opened = await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });
    assert.equal(opened.ok, true);

    const closed = await closeUnitOccupancy(opened.occupancy_id, { traceId: "occ-close" });
    assert.equal(closed.ok, true);
    assert.equal(closed.occupancy.status, "past");
    assert.ok(closed.occupancy.ended_at);

    const current = await getCurrentUnitOccupancy(UNIT_ID);
    assert.equal(current.ok, true);
    assert.equal(current.occupancy, null);

    const list = await listUnitOccupancies({ unit_catalog_id: UNIT_ID });
    assert.equal(list.ok, true);
    assert.equal(list.occupancies.length, 1);
    assert.equal(list.occupancies[0].status, "past");
  });

  test("patchUnitOccupancy links move_out_turnover_id on past row", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const opened = await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });
    const closed = await closeUnitOccupancy(opened.occupancy_id);
    assert.equal(closed.ok, true);

    const patched = await patchUnitOccupancy(opened.occupancy_id, {
      move_out_turnover_id: "tttttttt-uuuu-4vvv-wwww-xxxxxxxxxxxx",
    });
    assert.equal(patched.ok, true);
    assert.equal(patched.occupancy.move_out_turnover_id, "tttttttt-uuuu-4vvv-wwww-xxxxxxxxxxxx");
  });

  test("patchUnitOccupancy updates lease snapshot on current row", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const opened = await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });
    assert.equal(opened.ok, true);

    const patched = await patchUnitOccupancy(opened.occupancy_id, {
      lease_snapshot_json: { rent_cents: 190000, notes: "adjusted" },
    });
    assert.equal(patched.ok, true);
    assert.equal(patched.occupancy.lease_snapshot_json.rent_cents, 190000);
    assert.equal(patched.occupancy.lease_snapshot_json.notes, "adjusted");
  });
});
