"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  inferContextualGatherSafety,
} = require("../../src/adapters/tenantAgent/inferContextualGatherSafety");
const { mergeGatherSafety } = require("../../src/adapters/tenantAgent/detectGatherSafety");
const { buildSafetyGatherReply } = require("../../src/adapters/tenantAgent/gatherSafetyReply");
const { resolveGatherReply } = require("../../src/adapters/tenantAgent/resolveGatherReply");

const AC_HEAT_MSG =
  "its literally 100 degrees outside and our ac has been out since yesterday morning " +
  "we have been sweating all day and night i have a baby at home and we cannot sleep " +
  "its unbearable in here please someone needs to come today this is not ok";

test("inferContextualGatherSafety — baby + extreme heat + AC out + distress", () => {
  const s = inferContextualGatherSafety([AC_HEAT_MSG], AC_HEAT_MSG);
  assert.ok(s);
  assert.equal(s.emergencyType, "NO_AC");
  assert.equal(s.skipScheduling, true);
  assert.equal(s.receiptTier, "emergency");
});

test("inferContextualGatherSafety — AC noise alone is not emergency", () => {
  const msg = "my ac is making a loud humming noise in unit 305";
  assert.equal(inferContextualGatherSafety([msg], msg), null);
});

test("mergeGatherSafety — contextual backstop when LLM misses NO_AC", () => {
  const next = mergeGatherSafety(
    { issue: "AC not working" },
    AC_HEAT_MSG,
    { is_emergency: false },
    [AC_HEAT_MSG]
  );
  assert.equal(next._safety.emergencyType, "NO_AC");
  assert.equal(next.preferredWindow, undefined);
});

test("buildSafetyGatherReply — NO_AC first turn property ask", () => {
  const reply = buildSafetyGatherReply(
    "property",
    { _safety: { isEmergency: true, emergencyType: "NO_AC", skipScheduling: true } },
    [{ code: "WESTGRAND", display_name_short: "Westgrand" }]
  );
  assert.match(reply, /extreme heat without AC/i);
  assert.match(reply, /infant/i);
  assert.match(reply, /building/i);
});

test("resolveGatherReply — blocks minimizing LLM schedule ask under NO_AC", () => {
  const reply = resolveGatherReply({
    llmGatherReply:
      "I understand it's really uncomfortable without AC. Can you provide your unit number and a preferred time?",
    complete: { ready: false, missing: "unit" },
    partial: {
      property: "WESTGRAND",
      issue: "AC not working",
      _safety: { isEmergency: true, emergencyType: "NO_AC", skipScheduling: true },
    },
    propertiesList: [{ code: "WESTGRAND" }],
    bodyText: "westgrand",
  });
  assert.doesNotMatch(reply, /preferred time/i);
  assert.doesNotMatch(reply, /uncomfortable/i);
  assert.match(reply, /unit/i);
});
