"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  createScenarioMemorySupabase,
  scenarioTurnoverSeedPenn316,
} = require("./helpers/memorySupabaseScenario");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../src/db/supabase");
const {
  readTurnoverIdsFromPortalPayload,
  startTurnover,
  getTurnoverById,
  markTurnoverReady,
  updateTurnoverItem,
  createTicketFromTurnoverItem,
} = require("../src/dal/turnovers");

describe("turnovers DAL", () => {
  afterEach(() => {
    clearSupabaseClientForTests();
  });

  test("readTurnoverIdsFromPortalPayload reads snake and camelCase", () => {
    const r1 = readTurnoverIdsFromPortalPayload({
      _portalPayloadJson: JSON.stringify({
        turnover_id: "t1",
        turnover_item_id: "i1",
      }),
    });
    assert.equal(r1.turnoverId, "t1");
    assert.equal(r1.turnoverItemId, "i1");

    const r2 = readTurnoverIdsFromPortalPayload({
      _portalPayloadJson: JSON.stringify({
        turnoverId: "t2",
        turnoverItemId: "i2",
      }),
    });
    assert.equal(r2.turnoverId, "t2");
    assert.equal(r2.turnoverItemId, "i2");
  });

  test("startTurnover seeds template items and rejects duplicate active", async () => {
    const mem = createScenarioMemorySupabase(scenarioTurnoverSeedPenn316());
    setSupabaseClientForTests(mem);

    const out = await startTurnover({
      property_code: "PENN",
      unit_catalog_id: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
      traceId: "ttest-1",
    });
    assert.equal(out.ok, true);
    assert.ok(out.turnover_id);

    const full = await getTurnoverById(out.turnover_id, true);
    assert.equal(full.ok, true);
    assert.ok(full.items.length >= 8);

    const dup = await startTurnover({
      property_code: "PENN",
      unit_catalog_id: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
      traceId: "ttest-2",
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.error, "active_turnover_exists");
  });

  test("markTurnoverReady requires all non-canceled items DONE", async () => {
    const mem = createScenarioMemorySupabase(scenarioTurnoverSeedPenn316());
    setSupabaseClientForTests(mem);

    const started = await startTurnover({
      property_code: "PENN",
      unit_catalog_id: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
      traceId: "ttest-3",
    });
    assert.equal(started.ok, true);
    const tid = started.turnover_id;

    const blocked = await markTurnoverReady(tid, { traceId: "x" });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.reasons && blocked.reasons.length > 0);

    const { items } = await getTurnoverById(tid, true);
    for (const it of items) {
      await updateTurnoverItem(
        tid,
        String(it.id),
        { status: "DONE" },
        { traceId: "x" }
      );
    }

    const ok = await markTurnoverReady(tid, { traceId: "x" });
    assert.equal(ok.ok, true);

    const again = await getTurnoverById(tid, true);
    assert.equal(String(again.turnover.status).toUpperCase(), "READY");
  });

  test("createTicketFromTurnoverItem writes turnover_id on ticket row", async () => {
    const mem = createScenarioMemorySupabase(scenarioTurnoverSeedPenn316());
    setSupabaseClientForTests(mem);

    const started = await startTurnover({
      property_code: "PENN",
      unit_catalog_id: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
      traceId: "ttest-4",
    });
    const turnoverId = started.turnover_id;
    const { items } = await getTurnoverById(turnoverId, true);
    const walk = items.find((x) => String(x.source) === "walkthrough");
    assert.ok(!walk);
    const first = items[0];
    assert.ok(first);

    const ct = await createTicketFromTurnoverItem({
      turnoverId,
      itemId: String(first.id),
      actorPhoneE164: "+15551234002",
      traceId: "ttest-ct",
    });
    assert.equal(ct.ok, true);

    const ticket = mem._state.tickets.find((t) => t.ticket_id === ct.ticket_id);
    assert.ok(ticket);
    assert.equal(String(ticket.turnover_id), turnoverId);
    assert.equal(String(ticket.turnover_item_id), String(first.id));
  });
});
