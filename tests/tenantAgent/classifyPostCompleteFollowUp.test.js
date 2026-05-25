"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyPostCompleteFollowUp,
} = require("../../src/adapters/tenantAgent/classifyPostCompleteFollowUp");

test("classifyPostCompleteFollowUp — photo only asks clarify", () => {
  assert.equal(
    classifyPostCompleteFollowUp({ bodyText: "", mediaItems: [{ url: "x" }] }),
    "ask_same_or_new"
  );
});

test("classifyPostCompleteFollowUp — explicit new issue", () => {
  assert.equal(
    classifyPostCompleteFollowUp({
      bodyText: "New issue my bedroom door is broken",
      mediaItems: [],
    }),
    "explicit_new_intake"
  );
});

test("classifyPostCompleteFollowUp — also + symptom asks clarify", () => {
  assert.equal(
    classifyPostCompleteFollowUp({
      bodyText: "Also my bedroom door is broken",
      mediaItems: [],
    }),
    "ask_same_or_new"
  );
});

test("classifyPostCompleteFollowUp — thanks ack only", () => {
  assert.equal(
    classifyPostCompleteFollowUp({ bodyText: "Awesome thanks", mediaItems: [] }),
    "ack_only"
  );
});

test("classifyPostCompleteFollowUp — forget about it ack only", () => {
  assert.equal(
    classifyPostCompleteFollowUp({ bodyText: "forget about it", mediaItems: [] }),
    "ack_only"
  );
});

test("classifyPostCompleteFollowUp — never mind ack only", () => {
  assert.equal(
    classifyPostCompleteFollowUp({ bodyText: "never mind", mediaItems: [] }),
    "ack_only"
  );
});
