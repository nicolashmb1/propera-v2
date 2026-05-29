"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isLaneCloseSignal,
  isAccessLaneAckOnly,
} = require("../../src/adapters/tenantAgent/conversationLane");
const { bodyHasAccessTimeIntent } = require("../../src/adapters/tenantAgent/accessConversationSignals");
const { parseAccessWindow } = require("../../src/access/parseAccessIntent");

describe("access lane ack after booking", () => {
  it("thanks papa closes lane", () => {
    assert.equal(isLaneCloseSignal("thanks papa"), true);
    assert.equal(isAccessLaneAckOnly("thanks papa"), true);
  });

  it("9-10pm is time intent, not ack", () => {
    assert.equal(isAccessLaneAckOnly("9-10pm brother"), false);
    assert.equal(bodyHasAccessTimeIntent("9-10pm brother"), true);
  });

  it("parseAccessWindow accepts compact 9-10p", () => {
    const w = parseAccessWindow("tomorrow 9-10p", new Date("2026-05-27T15:00:00Z"), "UTC");
    assert.ok(w && w.startAt && w.endAt);
  });
});
