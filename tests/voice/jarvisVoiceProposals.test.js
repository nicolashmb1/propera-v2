const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatDisambiguationSpeak,
  formatCandidateLine,
} = require("../../src/voice/jarvisVoiceProposals");

describe("jarvisVoiceProposals helpers", () => {
  it("formatDisambiguationSpeak lists options briefly", () => {
    const speak = formatDisambiguationSpeak([
      { humanTicketId: "PENN-060126-1001", unitLabel: "303", category: "dishwasher" },
      { humanTicketId: "PENN-060126-1002", unitLabel: "415", category: "microwave" },
    ]);
    assert.match(speak, /Which one/i);
    assert.match(speak, /303|dishwasher/i);
  });

  it("formatCandidateLine includes ticket id", () => {
    const line = formatCandidateLine(
      { humanTicketId: "MURR-053026-4247", unitLabel: "205", summary: "heat exchanger" },
      0
    );
    assert.match(line, /MURR-053026-4247/);
    assert.match(line, /205/);
  });
});
