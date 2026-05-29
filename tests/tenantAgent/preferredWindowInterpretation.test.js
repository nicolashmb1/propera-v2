"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  needsPreferredWindowInterpretation,
} = require("../../src/adapters/tenantAgent/preferredWindowNeedsInterpretation");

test("needsPreferredWindowInterpretation — negated before + best time", () => {
  assert.equal(
    needsPreferredWindowInterpretation(
      "tomorrow before 3pm is no good.. best time is 4pm"
    ),
    true
  );
});

test("needsPreferredWindowInterpretation — simple tomorrow 4pm", () => {
  assert.equal(needsPreferredWindowInterpretation("tomorrow 4pm"), false);
});
