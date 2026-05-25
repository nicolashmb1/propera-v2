"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isPostHandoffChitchat,
  postHandoffAckReply,
} = require("../../src/adapters/tenantAgent/postHandoffReply");

test("isPostHandoffChitchat — thanks after receipt", () => {
  assert.equal(isPostHandoffChitchat("Awesome thanks"), true);
  assert.equal(isPostHandoffChitchat("thank you so much"), true);
  assert.equal(isPostHandoffChitchat("👍"), true);
});

test("isPostHandoffChitchat — not when new issue present", () => {
  assert.equal(isPostHandoffChitchat("thanks, also my toilet is leaking"), false);
  assert.equal(isPostHandoffChitchat("heat not working"), false);
});

test("postHandoffAckReply — short welcome close", () => {
  assert.equal(postHandoffAckReply("Awesome thanks"), "You're welcome!");
  assert.ok(postHandoffAckReply("Awesome thanks").length <= 20);
});
