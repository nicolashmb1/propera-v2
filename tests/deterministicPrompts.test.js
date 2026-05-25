"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  promptForMissingField,
  buildPropertyAsk,
} = require("../src/adapters/tenantAgent/deterministicPrompts");

/** Realistic rows — short tenant labels from DB (migration 055 shape). */
const GRAND_PROPERTIES = [
  {
    code: "PENN",
    display_name: "The Grand at Penn",
    display_name_short: "Penn",
    short_name: "Penn",
  },
  {
    code: "MORRIS",
    display_name: "The Grand at Morris",
    display_name_short: "Morris",
    short_name: "Morris",
  },
];

describe("deterministicPrompts", () => {
  it("property ask uses DB short names from propertiesList", () => {
    const text = buildPropertyAsk(GRAND_PROPERTIES);
    assert.match(text, /Penn/);
    assert.match(text, /Morris/);
    assert.doesNotMatch(text, /Grand at/i);
    assert.doesNotMatch(text, /e\.g\./i);
    assert.doesNotMatch(promptForMissingField("property", {}, GRAND_PROPERTIES), /e\.g\./i);
  });

  it("schedule prompt has no e.g. examples", () => {
    const text = promptForMissingField("schedule", {}, []);
    assert.doesNotMatch(text, /e\.g\./i);
    assert.match(text, /maintenance visit/i);
  });

  it("unit prompt uses short name from partial property", () => {
    const text = promptForMissingField(
      "unit",
      { property: "MORRIS" },
      GRAND_PROPERTIES
    );
    assert.match(text, /Morris/);
    assert.doesNotMatch(text, /Grand at/i);
    assert.doesNotMatch(text, /MORRIS/);
  });
});
