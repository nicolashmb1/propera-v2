"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.PROPERA_UNIT_LIFECYCLE_ENABLED = "1";
process.env.JARVIS_REASON_MAX_STEPS = "2";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../../../src/db/supabase");
const {
  getUnitAssets,
  runJarvisReasoning,
  setReasonChatForTests,
  clearReasonChatForTests,
} = require("../../../src/agent/jarvisReason");

// Table-aware chainable stub: from(table) reads tables[table], applies eq filters on await.
function makeSb(tables) {
  return {
    from(table) {
      const rows = (tables[table] || []).slice();
      const eqs = [];
      const builder = {
        select: () => builder,
        eq: (c, v) => (eqs.push([c, v]), builder),
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
    units: [
      { id: "u410", property_code: "PENN", unit_label: "410" },
      { id: "u502", property_code: "PENN", unit_label: "502" },
    ],
    unit_assets: [
      { id: "a1", unit_catalog_id: "u410", property_code: "PENN", status: "active", asset_type: "dishwasher", category: "appliance", make: "Whirlpool", model: "WDT750SAKZ", serial_number: "SN410D", installed_at: "2024-01-01", warranty_end: "2026-01-01", nameplate_photo_url: "https://x/np.jpg" },
      { id: "a2", unit_catalog_id: "u410", property_code: "PENN", status: "active", asset_type: "refrigerator", category: "appliance", make: "Whirlpool", model: "WRS321SDHZ", serial_number: "SN410F", nameplate_photo_url: "" },
      { id: "a3", unit_catalog_id: "u502", property_code: "PENN", status: "active", asset_type: "refrigerator", category: "appliance", make: "LG", model: "LRFXC2406S", serial_number: "SN502F", nameplate_photo_url: "" },
    ],
  };
}

describe("getUnitAssets", () => {
  afterEach(() => clearSupabaseClientForTests());

  test("resolves a unit and returns its assets with model/serial", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await getUnitAssets({ propertyCode: "penn", unit: "410" });
    assert.equal(res.ok, true);
    assert.equal(res.unitCatalogId, "u410");
    assert.equal(res.assetCount, 2);
    const dw = res.assets.find((a) => a.assetType === "dishwasher");
    assert.equal(dw.make, "Whirlpool");
    assert.equal(dw.model, "WDT750SAKZ");
    assert.equal(dw.hasNameplatePhoto, true);
  });

  test("assetType filter narrows to one piece of equipment", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await getUnitAssets({ propertyCode: "PENN", unit: "410", assetType: "dishwasher" });
    assert.equal(res.assetCount, 1);
    assert.equal(res.assets[0].model, "WDT750SAKZ");
  });

  test("synonym 'fridge' maps to refrigerator", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await getUnitAssets({ propertyCode: "PENN", unit: "410", assetType: "fridge" });
    assert.equal(res.assetCount, 1);
    assert.equal(res.assets[0].make, "Whirlpool");
    assert.equal(res.assets[0].assetType, "refrigerator");
  });

  test("unknown unit => unit_not_found", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    const res = await getUnitAssets({ propertyCode: "PENN", unit: "999" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "unit_not_found");
  });

  test("registry disabled => assets_not_enabled", async () => {
    const saved = process.env.PROPERA_UNIT_LIFECYCLE_ENABLED;
    delete process.env.PROPERA_UNIT_LIFECYCLE_ENABLED;
    try {
      const res = await getUnitAssets({ propertyCode: "PENN", unit: "410" });
      assert.equal(res.ok, false);
      assert.equal(res.error, "assets_not_enabled");
    } finally {
      process.env.PROPERA_UNIT_LIFECYCLE_ENABLED = saved;
    }
  });
});

describe("reasoning loop — get_unit_assets registration", () => {
  afterEach(() => {
    clearReasonChatForTests();
    clearSupabaseClientForTests();
  });

  test("model resolves equipment via get_unit_assets then answers", async () => {
    setSupabaseClientForTests(makeSb(seed()));
    let turn = 0;
    let toolMsg = null;
    setReasonChatForTests((body) => {
      turn += 1;
      if (turn === 1) {
        return {
          ok: true,
          data: {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: {
                        name: "get_unit_assets",
                        arguments: JSON.stringify({ propertyCode: "PENN", unit: "410", assetType: "dishwasher" }),
                      },
                    },
                  ],
                },
              },
            ],
          },
        };
      }
      toolMsg = body.messages.find((m) => m.role === "tool");
      return { ok: true, data: { choices: [{ message: { content: "That dishwasher is a Whirlpool WDT750SAKZ." } }] } };
    });

    const res = await runJarvisReasoning({
      question: "I'm working on unit 410's dishwasher — what model is it?",
    });
    assert.equal(res.ok, true);
    assert.equal(res.trace[0].tool, "get_unit_assets");
    assert.match(toolMsg.content, /WDT750SAKZ/);
  });
});
