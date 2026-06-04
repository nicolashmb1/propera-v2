const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { runJarvisVoiceTool } = require("../../src/voice/jarvisVoiceTools");

const staffCtx = {
  staffContext: { isStaff: true, staff: { staff_id: "STAFF_TEST" } },
  staffActorKey: "+15555550100",
  traceId: "test-trace",
};

describe("jarvis voice tool gates", () => {
  it("blocks confirm before staff has spoken", async () => {
    const result = await runJarvisVoiceTool("confirm_pending_proposal", {}, {
      ...staffCtx,
      staffTurnCount: 0,
      pendingConfirmToken: "fake-token",
      confirmTokenIssuedAtTurn: 0,
      requireSessionConfirmToken: true,
    });
    assert.equal(result.error, "awaiting_staff_speech");
  });

  it("blocks confirm in same staff turn as propose", async () => {
    const result = await runJarvisVoiceTool("confirm_pending_proposal", {}, {
      ...staffCtx,
      staffTurnCount: 1,
      pendingConfirmToken: "fake-token",
      confirmTokenIssuedAtTurn: 1,
      requireSessionConfirmToken: true,
    });
    assert.equal(result.error, "confirm_after_readback");
  });

  it("blocks confirm without session proposal token", async () => {
    const result = await runJarvisVoiceTool("confirm_pending_proposal", {}, {
      ...staffCtx,
      staffTurnCount: 2,
      pendingConfirmToken: "",
      confirmTokenIssuedAtTurn: 1,
      requireSessionConfirmToken: true,
    });
    assert.equal(result.error, "no_session_proposal");
  });
});
