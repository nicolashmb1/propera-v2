"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSafetyGatherReply } = require("../../src/adapters/tenantAgent/gatherSafetyReply");
const {
  isDuplicateGatherInbound,
  stampInboundTurnFingerprint,
} = require("../../src/adapters/tenantAgent/dedupeGatherInbound");

const FLOOD_PARTIAL = {
  issue: "water dripping through ceiling",
  _safety: { isEmergency: true, emergencyType: "FLOOD", skipScheduling: true },
};

test("buildSafetyGatherReply — urgency lead only on first turn", () => {
  const first = buildSafetyGatherReply("property", FLOOD_PARTIAL, [
    { code: "PENN", display: "Penn" },
  ]);
  assert.match(first, /treating this as urgent/i);
  assert.match(first, /building/i);

  const second = buildSafetyGatherReply(
    "unit",
    { ...FLOOD_PARTIAL, property: "PENN", _safety_ack_sent: true },
    []
  );
  assert.doesNotMatch(second, /treating this as urgent/i);
  assert.match(second, /And your unit number/i);
});

test("isDuplicateGatherInbound — long copy-paste resend after assistant replied", () => {
  const body =
    "hey i just got home and theres water coming through my ceiling in the living room";
  const conv = {
    messages: [
      { role: "user", content: body },
      { role: "assistant", content: "Which building?" },
    ],
    partial_package: stampInboundTurnFingerprint({}, body, ""),
  };
  assert.equal(isDuplicateGatherInbound(conv, body, ""), true);
});

test("isDuplicateGatherInbound — different follow-up answer is not duplicate", () => {
  const conv = {
    messages: [
      { role: "user", content: "water through ceiling" },
      { role: "assistant", content: "Which building?" },
    ],
    partial_package: stampInboundTurnFingerprint({}, "water through ceiling", ""),
  };
  assert.equal(isDuplicateGatherInbound(conv, "penn", ""), false);
});

test("isDuplicateGatherInbound — fingerprint within window", () => {
  const body = "same long maintenance report about ceiling water dripping badly";
  const partial = stampInboundTurnFingerprint({}, body, "");
  const conv = { messages: [], partial_package: partial };
  assert.equal(isDuplicateGatherInbound(conv, body, ""), true);
});
