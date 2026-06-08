"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.PROPERA_UNIT_LIFECYCLE_ENABLED = "1";
process.env.JARVIS_REASON_MAX_STEPS = "3";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../../../src/db/supabase");
const {
  getUnitServiceHistory,
  runJarvisReasoning,
  setReasonChatForTests,
  clearReasonChatForTests,
} = require("../../../src/agent/jarvisReason");

// Table-aware chainable stub.
function makeSb(tables) {
  return {
    from(table) {
      const rows = (tables[table] || []).slice();
      const eqs = [];
      const builder = {
        select: () => builder,
        eq: (c, v) => (eqs.push([c, v]), builder),
        gte: () => builder,
        lte: () => builder,
        order: () => builder,
        limit: () => builder,
        then(resolve) {
          let out = rows;
          for (const [c, v] of eqs) out = out.filter((r) => String(r[c]) === String(v));
          resolve({ data: out, error: null });
        },
      };
      return builder;
    },
  };
}

function seed() {
  return {
    units: [{ id: "u502", property_code: "PENN", unit_label: "502" }],
    unit_assets: [
      { id: "a3", unit_catalog_id: "u502", property_code: "PENN", status: "active", asset_type: "refrigerator", make: "LG", model: "LRFXC2406S", serial_number: "SN502F" },
    ],
    portal_tickets_v1: [
      { ticket_row_id: "r1", ticket_id: "PENN-501", property_code: "PENN", unit_label: "502", status: "Completed", category_final: "Appliance", priority: "normal", message_raw: "fridge not cooling", service_notes: "replaced start relay", assigned_name: "Nick", created_at: "2026-01-10T00:00:00Z", updated_at: "2026-01-12T00:00:00Z", closed_at: "2026-01-12T00:00:00Z" },
      { ticket_row_id: "r2", ticket_id: "PENN-540", property_code: "PENN", unit_label: "502", status: "Open", category_final: "Appliance", priority: "high", message_raw: "refrigerator warm again", service_notes: "", assigned_name: "", created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-02T00:00:00Z", closed_at: "" },
      { ticket_row_id: "r3", ticket_id: "PENN-560", property_code: "PENN", unit_label: "502", status: "Completed", category_final: "Plumbing", priority: "normal", message_raw: "sink clog", service_notes: "snaked drain", assigned_name: "Maria", created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-02T00:00:00Z", closed_at: "2026-03-02T00:00:00Z" },
      { ticket_row_id: "r4", ticket_id: "PENN-200", property_code: "PENN", unit_label: "410", status: "Open", category_final: "Appliance", priority: "normal", message_raw: "fridge noise", service_notes: "", assigned_name: "", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z", closed_at: "" },
    ],
  };
}

describe("getUnitServiceHistory", () => {
  afterEach(() => clearSupabaseClientForTests());

  test("returns the unit's full history with service notes", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await getUnitServiceHistory({ propertyCode: "penn", unit: "502" });
    assert.equal(res.ok, true);
    assert.equal(res.count, 3); // 502's three tickets; 410 excluded
    const relay = res.history.find((h) => h.id === "PENN-501");
    assert.equal(relay.serviceNotes, "replaced start relay"); // what was tried
  });

  test("assetType focuses on one equipment (synonym aware)", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await getUnitServiceHistory({ propertyCode: "PENN", unit: "502", assetType: "fridge" });
    const ids = res.history.map((h) => h.id).sort();
    assert.deepEqual(ids, ["PENN-501", "PENN-540"]); // both fridge tickets; plumbing excluded
  });

  test("missing property/unit => error", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await getUnitServiceHistory({ propertyCode: "PENN" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "missing_property_or_unit");
  });
});

describe("reasoning loop — diagnosis composition", () => {
  afterEach(() => {
    clearReasonChatForTests();
    clearSupabaseClientForTests();
  });

  test("fridge diagnosis composes assets + service history before answering", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    let turn = 0;
    const sawTool = {};
    setReasonChatForTests((body) => {
      turn += 1;
      for (const m of body.messages) if (m.role === "tool") {
        if (/LRFXC2406S/.test(m.content)) sawTool.assets = true;
        if (/replaced start relay/.test(m.content)) sawTool.history = true;
      }
      if (turn === 1) {
        return toolCall("get_unit_assets", { propertyCode: "PENN", unit: "502", assetType: "refrigerator" });
      }
      if (turn === 2) {
        return toolCall("get_unit_service_history", { propertyCode: "PENN", unit: "502", assetType: "refrigerator" });
      }
      return final(
        "It's an LG LRFXC2406S. Possible causes to check (not confirmed): the start relay was replaced in Jan, so a failing compressor or low refrigerant are worth checking next."
      );
    });

    const res = await runJarvisReasoning({
      question: "the refrigerator at penn 502 keeps going warm — what could be causing it?",
    });
    assert.equal(res.ok, true);
    assert.equal(res.trace[0].tool, "get_unit_assets");
    assert.equal(res.trace[1].tool, "get_unit_service_history");
    assert.equal(sawTool.assets, true);
    assert.equal(sawTool.history, true);
  });
});

function toolCall(name, args) {
  return {
    ok: true,
    data: {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    },
  };
}

function final(text) {
  return { ok: true, data: { choices: [{ message: { content: text } }] } };
}
