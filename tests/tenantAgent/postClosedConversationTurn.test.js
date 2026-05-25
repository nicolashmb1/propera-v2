/**
 * Post-closed conversation turns — no gather loop after deflect.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  isNoFurtherHelpNeeded,
  isConfusionOnly,
  isPostHandoffChitchat,
  shouldSkipInboundSlotMerge,
} = require("../../src/adapters/tenantAgent/postHandoffReply");
const {
  isConversationClosed,
} = require("../../src/adapters/tenantAgent/handlePostClosedConversationTurn");

describe("postHandoffReply — closed conv signals", () => {
  test("ok thank you — chitchat", () => {
    assert.equal(isPostHandoffChitchat("ok thank you."), true);
  });

  test("im good no service — no further help", () => {
    assert.equal(isNoFurtherHelpNeeded("im good. no service schedule needed"), true);
    assert.equal(shouldSkipInboundSlotMerge("im good. no service schedule needed"), true);
  });

  test("question mark only — confusion", () => {
    assert.equal(isConfusionOnly("?"), true);
  });

  test("maintenance reopen — not no further help", () => {
    assert.equal(isNoFurtherHelpNeeded("502 sink still leaking"), false);
  });
});

describe("isConversationClosed", () => {
  test("detects closed status", () => {
    assert.equal(isConversationClosed({ status: "closed" }), true);
    assert.equal(isConversationClosed({ status: "complete" }), false);
  });
});
