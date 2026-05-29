const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldStayInAccessLane,
  inferConversationLane,
  resolveActiveLane,
  isLaneCloseSignal,
  isStrongMaintenanceInterrupt,
  clearConversationLane,
  CONVERSATION_LANE,
} = require("../../src/adapters/tenantAgent/conversationLane");

describe("conversationLane", () => {
  it("stays in access lane after booking until maintenance repair", () => {
    const conv = {
      partial_package: {
        _active_lane: CONVERSATION_LANE.ACCESS,
        _access_last_booking: { reservationId: "r1" },
      },
    };
    assert.equal(shouldStayInAccessLane(conv, "sorry saturday not sunday"), true);
    assert.equal(
      shouldStayInAccessLane(conv, "slow drip under the sink"),
      false
    );
  });

  it("infers access lane from last booking without explicit flag", () => {
    assert.equal(
      inferConversationLane({
        partial_package: { _access_last_booking: { reservationId: "r1" } },
        last_brain_result: { brain: "access_reserved" },
      }),
      CONVERSATION_LANE.ACCESS
    );
  });

  it("resolveActiveLane is sticky once stamped", () => {
    assert.equal(
      resolveActiveLane({ partial_package: { _active_lane: "access" } }),
      "access"
    );
    assert.equal(resolveActiveLane({ partial_package: {} }), "");
  });

  it("recognises lane close signals", () => {
    assert.equal(isLaneCloseSignal("thanks"), true);
    assert.equal(isLaneCloseSignal("all set"), true);
    assert.equal(isLaneCloseSignal("never mind"), true);
    assert.equal(isLaneCloseSignal("ok. thanks brother"), true);
    assert.equal(isLaneCloseSignal("thanks papa"), true);
    assert.equal(isLaneCloseSignal("saturday not sunday"), false);
    assert.equal(isLaneCloseSignal("10am to 1pm"), false);
  });

  it("detects strong maintenance interrupt", () => {
    assert.equal(
      isStrongMaintenanceInterrupt("can you check the sink, slow drip"),
      true
    );
    assert.equal(isStrongMaintenanceInterrupt("sorry saturday not sunday"), false);
  });

  it("clearConversationLane removes lane flag", () => {
    const next = clearConversationLane({ _active_lane: "access", other: 1 });
    assert.equal(next._active_lane, undefined);
    assert.equal(next.other, 1);
  });
});
