"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { parseOutput } = require("../src/brain/shared/assetNameplateVision");

describe("assetNameplateVision parseOutput", () => {
  test("parses fenced JSON with nameplate fields", () => {
    const raw = `\`\`\`json
{
  "make": "Whirlpool",
  "model": "WRS571CIHZ",
  "serial_number": "XUAZ12345",
  "asset_type": "Dishwasher",
  "category": "appliance",
  "confidence": { "make": 0.9, "model": 0.85, "serial_number": 0.95, "asset_type": 0.8 }
}
\`\`\``;
    const out = parseOutput(raw);
    assert.equal(out.make, "Whirlpool");
    assert.equal(out.model, "WRS571CIHZ");
    assert.equal(out.serial_number, "XUAZ12345");
    assert.equal(out.asset_type, "dishwasher");
    assert.equal(out.category, "appliance");
    assert.equal(out.confidence.serial_number, 0.95);
  });

  test("returns empty draft for invalid JSON", () => {
    const out = parseOutput("not json");
    assert.equal(out.make, null);
    assert.equal(out.model, null);
    assert.equal(out.confidence.make, 0);
  });

  test("normalizes unknown category to null", () => {
    const out = parseOutput('{"make":"GE","category":"invalid"}');
    assert.equal(out.make, "GE");
    assert.equal(out.category, null);
  });
});
