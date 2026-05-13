const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { validateMeterReading } = require("../src/meterRuns/validateMeterReading");

function baseExtraction(over) {
  return Object.assign(
    {
      needsReviewHint: false,
      confidence: "high",
      digits: [],
      possibleReadings: [],
    },
    over || {}
  );
}

describe("validateMeterReading — usage / scale gates", () => {
  test("West Grand 202-style extra-digit OCR → CHECK_PHOTO (not AUTO_ACCEPTED)", () => {
    const v = validateMeterReading({
      previousReading: 656_030,
      currentReading: 6_599_860,
      extraction: baseExtraction(),
    });
    assert.equal(v.status, "CHECK_PHOTO");
    assert.ok(v.reviewReasons.includes("usage_jump_vs_previous"));
    assert.ok(v.reviewReasons.includes("reading_scale_vs_previous"));
    assert.equal(v.usage, 5_943_830);
  });

  test("same meter plausible reading still AUTO_ACCEPTED", () => {
    const v = validateMeterReading({
      previousReading: 656_030,
      currentReading: 659_860,
      extraction: baseExtraction(),
    });
    assert.equal(v.status, "AUTO_ACCEPTED");
    assert.equal(v.usage, 3830);
  });

  test("absolute usage cap flags very large deltas even when relative is loose", () => {
    const v = validateMeterReading({
      previousReading: 2_000_000,
      currentReading: 2_130_000,
      extraction: baseExtraction(),
    });
    assert.equal(v.status, "CHECK_PHOTO");
    assert.ok(v.reviewReasons.includes("usage_jump_vs_previous"));
  });

  test("relative jump vs large totalizer (old bug: prev*10 threshold too high)", () => {
    const v = validateMeterReading({
      previousReading: 656_030,
      currentReading: 820_000,
      extraction: baseExtraction(),
    });
    assert.equal(v.status, "CHECK_PHOTO");
    assert.ok(v.reviewReasons.includes("usage_jump_vs_previous"));
  });
});
