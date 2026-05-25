"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  setAwaiting,
  getAwaiting,
  awaitingIs,
  clearAwaiting,
} = require("../../src/adapters/tenantAgent/conversationAwaiting");

test("conversationAwaiting — set and get active awaiting", () => {
  const partial = setAwaiting({}, "schedule_retry", { policyKey: "too_soon" });
  const a = getAwaiting(partial);
  assert.ok(a);
  assert.equal(a.type, "schedule_retry");
  assert.equal(a.context.policyKey, "too_soon");
  assert.ok(a.expires_at);
});

test("conversationAwaiting — awaitingIs matches type", () => {
  const partial = setAwaiting({}, "schedule_retry");
  assert.equal(awaitingIs(partial, "schedule_retry"), true);
  assert.equal(awaitingIs(partial, "unit"), false);
  assert.equal(awaitingIs(partial, ["unit", "schedule_retry"]), true);
});

test("conversationAwaiting — expired awaiting returns null", () => {
  const partial = {
    _awaiting: {
      type: "schedule_retry",
      expires_at: new Date(Date.now() - 1000).toISOString(),
      context: {},
    },
  };
  assert.equal(getAwaiting(partial), null);
  assert.equal(awaitingIs(partial, "schedule_retry"), false);
});

test("conversationAwaiting — clearAwaiting removes state", () => {
  const partial = setAwaiting({ issue: "leak" }, "issue");
  const cleared = clearAwaiting(partial);
  assert.equal(getAwaiting(cleared), null);
  assert.equal(cleared.issue, "leak");
});
