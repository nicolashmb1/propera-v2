"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolvePropertyForGather,
} = require("../src/adapters/tenantAgent/resolvePropertyForGather");
const { buildPropertyDisambiguationPrompt } = require("../src/adapters/tenantAgent/deterministicPrompts");

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
  {
    code: "WESTGRAND",
    display_name: "The Grand at Westgrand",
    display_name_short: "Westgrand",
    short_name: "Westgrand",
  },
  {
    code: "MURRAY",
    display_name: "The Grand at Murray",
    display_name_short: "Murray",
    short_name: "Murray",
  },
];

describe("resolvePropertyForGather", () => {
  it("the grand — ambiguous, lists all Grand locations", () => {
    const res = resolvePropertyForGather("the grand", GRAND_PROPERTIES);
    assert.equal(res.status, "AMBIGUOUS");
    assert.equal(res.property_code, null);
    assert.ok(res.candidates.length >= 3);
    const prompt = buildPropertyDisambiguationPrompt(res.candidates);
    assert.match(prompt, /Grand at Penn/i);
    assert.match(prompt, /Westgrand/i);
    assert.doesNotMatch(prompt, /unit number/i);
  });

  it("for the grand — ambiguous Grand brand, not unresolved", () => {
    const res = resolvePropertyForGather("for the grand", GRAND_PROPERTIES);
    assert.equal(res.status, "AMBIGUOUS");
    assert.ok(res.candidates.length >= 3);
  });

  it("elevator issue with not — does not false-trigger property intent", () => {
    const { bodyHasPropertyIntent } = require("../src/adapters/tenantAgent/resolvePropertyForGather");
    assert.equal(
      bodyHasPropertyIntent("Yes the elevator is not well maintained. It smell horrible"),
      false
    );
  });

  it("the grand at peen — resolves Penn (typo)", () => {
    const res = resolvePropertyForGather(
      "not westgrand.. the grand at peen",
      GRAND_PROPERTIES
    );
    assert.equal(res.status, "RESOLVED");
    assert.equal(res.property_code, "PENN");
  });

  it("Penn — single resolved match", () => {
    const res = resolvePropertyForGather("Penn", GRAND_PROPERTIES);
    assert.equal(res.status, "RESOLVED");
    assert.equal(res.property_code, "PENN");
  });

  it("502 — unresolved, no guess", () => {
    const res = resolvePropertyForGather("502", GRAND_PROPERTIES);
    assert.equal(res.status, "UNRESOLVED");
    assert.equal(res.property_code, null);
  });
});
