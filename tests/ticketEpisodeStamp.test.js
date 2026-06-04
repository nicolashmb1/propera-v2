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
const { openUnitOccupancy } = require("../src/dal/unitOccupancies");
const { resolveTicketEpisodeStamp } = require("../src/lifecycle/ticketEpisodeStamp");
const {
  listUnitEpisodeTicketHistory,
  ticketFallsInOccupancyWindow,
} = require("../src/dal/unitEpisodeTicketHistory");

const UNIT_ID = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";
const TENANT_ID = "bbbbbbbb-cccc-4ddd-eeee-ffffffffffff";

describe("ticket episode stamp", () => {
  afterEach(() => {
    clearSupabaseClientForTests();
  });

  test("ticketFallsInOccupancyWindow matches created_at between stay dates", () => {
    assert.equal(
      ticketFallsInOccupancyWindow("2026-03-15T10:00:00.000Z", "2026-01-01T12:00:00.000Z", "2026-06-30T12:00:00.000Z"),
      true
    );
    assert.equal(
      ticketFallsInOccupancyWindow("2025-12-01T10:00:00.000Z", "2026-01-01T12:00:00.000Z", "2026-06-30T12:00:00.000Z"),
      false
    );
  });

  test("resolveTicketEpisodeStamp returns current occupancy ids", async () => {
    const mem = createScenarioMemorySupabase(scenarioOccupancySeedPenn316());
    setSupabaseClientForTests(mem);

    const opened = await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });
    assert.ok(opened.ok);

    const stamp = await resolveTicketEpisodeStamp({
      unitCatalogId: UNIT_ID,
      tenantPhoneE164: "+15551234001",
    });
    assert.equal(stamp.unit_occupancy_id, opened.occupancy_id);
    assert.equal(stamp.tenant_roster_id_at_open, TENANT_ID);
  });

  test("listUnitEpisodeTicketHistory groups stamped and legacy tickets", async () => {
    const seed = scenarioOccupancySeedPenn316();
    const mem = createScenarioMemorySupabase(seed);
    setSupabaseClientForTests(mem);

    const opened = await openUnitOccupancy({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
      tenant_roster_id: TENANT_ID,
    });
    const occId = opened.occupancy_id;

    const { closeUnitOccupancy } = require("../src/dal/unitOccupancies");
    await closeUnitOccupancy(occId);

    mem._state.tickets.push({
      id: "11111111-2222-4333-8444-555555555501",
      ticket_id: "PENN-EP-1",
      ticket_key: "tk-ep-1",
      property_code: "PENN",
      unit_label: "316",
      unit_catalog_id: UNIT_ID,
      unit_occupancy_id: occId,
      status: "CLOSED",
      category: "Plumbing",
      message_raw: "Leak under sink",
      created_at: "2026-02-15T14:00:00.000Z",
      closed_at: "2026-02-20T14:00:00.000Z",
    });

    mem._state.tickets.push({
      id: "11111111-2222-4333-8444-555555555502",
      ticket_id: "PENN-EP-2",
      ticket_key: "tk-ep-2",
      property_code: "PENN",
      unit_label: "316",
      unit_catalog_id: UNIT_ID,
      unit_occupancy_id: null,
      status: "OPEN",
      category: "HVAC",
      message_raw: "No heat",
      created_at: "2026-03-01T14:00:00.000Z",
      closed_at: null,
    });

    const hist = await listUnitEpisodeTicketHistory({
      property_code: "PENN",
      unit_catalog_id: UNIT_ID,
    });
    assert.equal(hist.ok, true);
    assert.equal(hist.episodes.length, 1);
    assert.equal(hist.episodes[0].tickets.length, 2);
  });
});
