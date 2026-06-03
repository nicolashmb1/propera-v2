const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatVoiceCallerContextBlock,
  findScheduleInTimeline,
} = require("../../src/voice/voiceCallerContext");

describe("formatVoiceCallerContextBlock", () => {
  it("formats empty open list", () => {
    const block = formatVoiceCallerContextBlock([]);
    assert.match(block, /Open requests: none/i);
    assert.match(block, /authoritative/i);
  });

  it("formats open tickets with schedule hints", () => {
    const block = formatVoiceCallerContextBlock([
      {
        ticketId: "PENN-060226-2664",
        status: "open",
        issue: "bathroom tub clogged",
        scheduled: null,
      },
    ]);
    assert.match(block, /PENN-060226-2664/);
    assert.match(block, /not scheduled yet/i);
    assert.match(block, /duplicate/i);
  });
});

describe("findScheduleInTimeline", () => {
  it("finds schedule events", () => {
    const hit = findScheduleInTimeline([
      { action: "Status updated", time: "2026-01-01T12:00:00Z" },
      { action: "Scheduled Wed Jun 3 at 9:00 AM", time: "2026-01-02T12:00:00Z" },
    ]);
    assert.match(String(hit), /Scheduled/i);
  });

  it("returns null when no schedule", () => {
    assert.equal(findScheduleInTimeline([]), null);
  });
});
