"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../../../src/db/supabase");
const { lookupTickets } = require("../../../src/agent/jarvisReason/ticketLookupTool");

// Minimal chainable Supabase stub: records eq/gte, applies them on await.
// Mirrors only what ticketLookupTool uses: from().select().eq().gte().order().limit().
function makeSb(rows) {
  return {
    from() {
      const eqs = [];
      const gtes = [];
      const builder = {
        select() {
          return builder;
        },
        eq(col, val) {
          eqs.push([col, val]);
          return builder;
        },
        gte(col, val) {
          gtes.push([col, val]);
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        then(resolve) {
          let out = rows.slice();
          for (const [c, v] of eqs) out = out.filter((r) => String(r[c]) === String(v));
          for (const [c, v] of gtes)
            out = out.filter((r) => String(r[c] || "") >= String(v));
          resolve({ data: out, error: null });
        },
      };
      return builder;
    },
  };
}

function seed() {
  return [
    {
      ticket_row_id: "r1",
      ticket_id: "PENN-1",
      property_code: "PENN",
      unit_label: "423",
      status: "Open",
      category_final: "Plumbing",
      priority: "urgent",
      assigned_name: "Nick",
      preferred_window: "",
      message_raw: "kitchen sink leak emergency",
      created_at: "2026-05-01T10:00:00Z",
      updated_at: "2026-06-01T10:00:00Z",
      closed_at: "",
    },
    {
      ticket_row_id: "r2",
      ticket_id: "PENN-2",
      property_code: "PENN",
      unit_label: "311",
      status: "Scheduled",
      category_final: "HVAC",
      priority: "high",
      assigned_name: "Maria",
      preferred_window: "2026-06-07 1-5pm",
      message_raw: "ac not cooling",
      created_at: "2026-05-20T10:00:00Z",
      updated_at: "2026-06-02T10:00:00Z",
      closed_at: "",
    },
    {
      ticket_row_id: "r3",
      ticket_id: "PENN-3",
      property_code: "PENN",
      unit_label: "423",
      status: "Completed",
      category_final: "Plumbing",
      priority: "normal",
      assigned_name: "Nick",
      preferred_window: "2026-06-05 9-12",
      message_raw: "faucet drip",
      created_at: "2026-01-15T10:00:00Z",
      updated_at: "2026-06-05T10:00:00Z",
      closed_at: "2026-06-05T16:00:00Z",
    },
    {
      ticket_row_id: "r4",
      ticket_id: "MOR-1",
      property_code: "MORRIS",
      unit_label: "5B",
      status: "Open",
      category_final: "Appliance",
      priority: "normal",
      assigned_name: "Maria",
      preferred_window: "",
      message_raw: "fridge warm",
      created_at: "2026-06-01T10:00:00Z",
      updated_at: "2026-06-03T10:00:00Z",
      closed_at: "",
    },
  ];
}

describe("lookupTickets", () => {
  afterEach(() => clearSupabaseClientForTests());

  test("status=open excludes closed tickets, scoped to property", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await lookupTickets({ propertyCode: "penn", status: "open" });
    assert.equal(res.ok, true);
    assert.equal(res.total, 2); // PENN-1 + PENN-2 (PENN-3 completed excluded)
    const ids = res.rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ["PENN-1", "PENN-2"]);
  });

  test("priorityIn finds emergencies (urgent/high)", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await lookupTickets({
      propertyCode: "PENN",
      priorityIn: ["urgent", "high"],
      status: "any",
    });
    assert.equal(res.total, 2);
    assert.ok(res.rows.every((r) => ["urgent", "high"].includes(r.priority)));
  });

  test("assignee + closed + countOnly answers 'what did Nick do'", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await lookupTickets({
      assigneeContains: "nick",
      status: "closed",
      countOnly: true,
    });
    assert.equal(res.total, 1); // only PENN-3 is Nick + completed
    assert.equal(res.rows.length, 0); // countOnly => no rows
  });

  test("groupBy category returns a breakdown", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await lookupTickets({ status: "any", groupBy: "category", countOnly: true });
    assert.deepEqual(res.breakdown, { Plumbing: 2, HVAC: 1, Appliance: 1 });
  });

  test("scheduled=false returns only unscheduled tickets", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await lookupTickets({ status: "open", scheduled: false });
    const ids = res.rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ["MOR-1", "PENN-1"]); // both open with no preferred_window
  });

  test("createdAfter filters by date", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await lookupTickets({ status: "any", createdAfter: "2026-05-01" });
    const ids = res.rows.map((r) => r.id).sort();
    // PENN-3 created 2026-01-15 is excluded
    assert.deepEqual(ids, ["MOR-1", "PENN-1", "PENN-2"]);
  });

  test("no db client degrades gracefully", async () => {
    setSupabaseClientForTests(null);
    const res = await lookupTickets({ propertyCode: "PENN" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "no_db");
  });
});
