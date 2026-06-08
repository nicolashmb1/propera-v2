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
  searchParts,
  buildPartsLinks,
  runJarvisReasoning,
  setReasonChatForTests,
  clearReasonChatForTests,
} = require("../../../src/agent/jarvisReason");

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

describe("searchParts", () => {
  test("builds Amazon + PartSelect model page + RepairClinic links", async () => {
    const res = await searchParts({
      make: "Whirlpool",
      model: "WDT750SAKZ",
      part: "heating element",
      applianceType: "dishwasher",
    });
    assert.equal(res.ok, true);
    assert.equal(res.pricesFetched, false); // links only

    const by = Object.fromEntries(res.sources.map((s) => [s.name, s]));
    assert.match(by.Amazon.url, /^https:\/\/www\.amazon\.com\/s\?k=/);
    assert.match(by.Amazon.url, /Whirlpool/);
    assert.match(by.Amazon.url, /heating%20element|heating\+element/i);
    // PartSelect lands on the model's OEM catalog page
    assert.equal(by.PartSelect.url, "https://www.partselect.com/Models/WDT750SAKZ/");
    assert.match(by.RepairClinic.url, /google\.com\/search/);
    assert.match(by.RepairClinic.url, /site%3Arepairclinic\.com/);
  });

  test("no model => PartSelect falls back to site-scoped search", async () => {
    const { sources } = buildPartsLinks({ make: "GE", part: "ice maker", applianceType: "refrigerator" });
    const ps = sources.find((s) => s.name === "PartSelect");
    assert.match(ps.url, /google\.com\/search/);
    assert.match(ps.url, /site%3Apartselect\.com/);
  });

  test("requires at least a model or a part", async () => {
    const res = await searchParts({ make: "Whirlpool" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "missing_part_query");
  });
});

describe("reasoning loop — parts composition", () => {
  afterEach(() => {
    clearReasonChatForTests();
    clearSupabaseClientForTests();
  });

  test("resolves model via assets then builds part links", async () => {
    setSupabaseClientForTests(
      makeSb({
        units: [{ id: "u410", property_code: "PENN", unit_label: "410" }],
        unit_assets: [
          { id: "a1", unit_catalog_id: "u410", property_code: "PENN", status: "active", asset_type: "dishwasher", make: "Whirlpool", model: "WDT750SAKZ", serial_number: "SN410D" },
        ],
      })
    );
    let turn = 0;
    let partsToolMsg = null;
    setReasonChatForTests((body) => {
      turn += 1;
      for (const m of body.messages) if (m.role === "tool" && /partselect\.com\/Models\/WDT750SAKZ/.test(m.content)) partsToolMsg = m.content;
      if (turn === 1) return toolCall("get_unit_assets", { propertyCode: "PENN", unit: "410", assetType: "dishwasher" });
      if (turn === 2) return toolCall("search_parts", { make: "Whirlpool", model: "WDT750SAKZ", part: "heating element", applianceType: "dishwasher" });
      return final("Here are links for the Whirlpool WDT750SAKZ heating element: Amazon (usually cheaper/faster for common parts) and PartSelect (pricier, finds almost anything).");
    });

    const res = await runJarvisReasoning({
      question: "I'm working on unit 410's dishwasher, needs a new heating element — find me the part",
    });
    assert.equal(res.ok, true);
    assert.equal(res.trace[0].tool, "get_unit_assets");
    assert.equal(res.trace[1].tool, "search_parts");
    assert.ok(partsToolMsg, "parts tool result with model page link was fed back to the model");
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
            tool_calls: [{ id: "c_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    },
  };
}

function final(text) {
  return { ok: true, data: { choices: [{ message: { content: text } }] } };
}
