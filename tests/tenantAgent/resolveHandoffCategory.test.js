"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveHandoffCategory } = require("../../src/adapters/tenantAgent/resolveHandoffCategory");

test("resolveHandoffCategory — plumbing from sink issue", () => {
  assert.equal(resolveHandoffCategory({ issue: "kitchen sink clogged" }), "Plumbing");
});

test("resolveHandoffCategory — HVAC from heat issue", () => {
  assert.equal(resolveHandoffCategory({ issue: "heat not working" }), "HVAC");
});
