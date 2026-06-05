const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  runJarvisVoiceTool,
  staffAffirmsUtterance,
} = require("../../src/voice/jarvisVoiceTools");

const staffCtx = {
  staffContext: { isStaff: true, staff: { staff_id: "STAFF_TEST" } },
  staffActorKey: "+15555550100",
  traceId: "test-trace",
};

describe("staffAffirmsUtterance", () => {
  it("detects common affirmatives", () => {
    assert.equal(staffAffirmsUtterance("yes"), true);
    assert.equal(staffAffirmsUtterance("yeah go ahead"), true);
    assert.equal(staffAffirmsUtterance("what tickets are open"), false);
  });
});

describe("jarvis voice tool gates", () => {
  it("allows read tools before transcript is ready if speech was detected", async () => {
    const result = await runJarvisVoiceTool(
      "list_open_service_tickets",
      {},
      {
        ...staffCtx,
        staffTurnCount: 0,
        staffSpeechSeen: true,
      }
    );
    assert.notEqual(result.error, "awaiting_staff_speech");
  });

  it("blocks writes before staff speech", async () => {
    const result = await runJarvisVoiceTool(
      "propose_append_service_note",
      { note_text: "test" },
      {
        ...staffCtx,
        staffTurnCount: 0,
        staffSpeechSeen: false,
      }
    );
    assert.equal(result.error, "awaiting_staff_speech");
  });

  it("blocks confirm before staff has spoken", async () => {
    const result = await runJarvisVoiceTool("confirm_pending_proposal", {}, {
      ...staffCtx,
      staffTurnCount: 0,
      staffSpeechSeen: false,
      pendingConfirmToken: "fake-token",
      confirmTokenIssuedAtTurn: 0,
      requireSessionConfirmToken: true,
    });
    assert.equal(result.error, "awaiting_staff_speech");
  });

  it("blocks confirm in same turn unless staff said yes", async () => {
    const result = await runJarvisVoiceTool("confirm_pending_proposal", {}, {
      ...staffCtx,
      staffTurnCount: 1,
      staffSpeechSeen: true,
      lastStaffTranscript: "add a note on 216",
      pendingConfirmToken: "fake-token",
      confirmTokenIssuedAtTurn: 1,
      requireSessionConfirmToken: true,
    });
    assert.equal(result.error, "confirm_after_readback");
  });

  it("allows confirm in same turn when staff said yes", async () => {
    const result = await runJarvisVoiceTool("confirm_pending_proposal", {}, {
      ...staffCtx,
      staffTurnCount: 1,
      staffSpeechSeen: true,
      lastStaffTranscript: "yes",
      pendingConfirmToken: "fake-token",
      confirmTokenIssuedAtTurn: 1,
      requireSessionConfirmToken: true,
    });
    assert.notEqual(result.error, "confirm_after_readback");
    assert.notEqual(result.error, "awaiting_staff_speech");
  });

  it("blocks confirm without session proposal token", async () => {
    const result = await runJarvisVoiceTool("confirm_pending_proposal", {}, {
      ...staffCtx,
      staffTurnCount: 2,
      staffSpeechSeen: true,
      lastStaffTranscript: "yes",
      pendingConfirmToken: "",
      confirmTokenIssuedAtTurn: 1,
      requireSessionConfirmToken: true,
    });
    assert.equal(result.error, "no_session_proposal");
  });
});
