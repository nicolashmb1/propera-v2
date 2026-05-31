const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  expandMeterKeyAliases,
  buildMeterKeyCandidates,
  findUniquePartialMeter,
} = require("../src/meterRuns/meterKeyAliases");

describe("expandMeterKeyAliases", () => {
  test("adds MTR_ prefix for property-prefixed QR", () => {
    const out = expandMeterKeyAliases("WESTGRAND_404_WATER", "WESTGRAND");
    assert.ok(out.includes("MTR_WESTGRAND_404_WATER"));
  });

  test("does not rewrite portfolio-specific typos in meter keys", () => {
    const out = expandMeterKeyAliases("MTR_WESTGRAD_302_WATER", "WESTGRAND");
    assert.deepEqual(out, ["MTR_WESTGRAD_302_WATER"]);
  });

  test("WG shorthand expands using property code", () => {
    const out = expandMeterKeyAliases("WG_203_WATER", "WESTGRAND");
    assert.ok(out.includes("MTR_WESTGRAND_203_WATER"));
  });

  test("WG human label to canonical", () => {
    const out = expandMeterKeyAliases("WG 402 WATER", "WESTGRAND");
    assert.ok(out.includes("MTR_WESTGRAND_402_WATER"));
  });

  test("leaves unrecognized shorthand keys unchanged", () => {
    const out = expandMeterKeyAliases("MTR_WG203_WATER", "PENN");
    assert.deepEqual(out, ["MTR_WG203_WATER"]);
  });
});

describe("buildMeterKeyCandidates", () => {
  test("prefers full MTR key over human meterLabel", () => {
    const c = buildMeterKeyCandidates(
      "WESTGRAND",
      {
        meterLabel: "WG 402 WATER",
        qrValue: "MTR_WESTGRAND_402_WATER",
      },
      null
    );
    assert.equal(c[0], "MTR_WESTGRAND_402_WATER");
    assert.ok(c.includes("MTR_WESTGRAND_402_WATER"));
    assert.ok(c.includes("WG_402_WATER"));
  });
});

describe("findUniquePartialMeter", () => {
  test("returns null when multiple meters match substring", () => {
    const meters = [
      { meter_key: "MTR_WESTGRAND_101_WATER" },
      { meter_key: "MTR_WESTGRAND_102_WATER" },
    ];
    assert.equal(findUniquePartialMeter(meters, "MTR_WESTGRAND"), null);
  });

  test("returns sole match", () => {
    const meters = [
      { meter_key: "MTR_WESTGRAND_101_WATER" },
      { meter_key: "MTR_WESTGRAND_102_WATER" },
    ];
    const hit = findUniquePartialMeter(meters, "MTR_WESTGRAND_101_WATER");
    assert.equal(hit.meter_key, "MTR_WESTGRAND_101_WATER");
  });
});
