const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatStaffServiceNoteLine,
  proposalFromAppendServiceNoteDraft,
} = require("../../../src/agent/proposals/appendServiceNote");
const { PROPOSAL_OPS } = require("../../../src/agent/proposals/types");

describe("appendServiceNote proposal", () => {
  it("formats staff note line with timestamp", () => {
    const line = formatStaffServiceNoteLine("Model WRS432323 — heat element suspect", "Nicolas");
    assert.match(line, /Nicolas/);
    assert.match(line, /WRS432323/);
    assert.match(line, /^\[/);
  });

  it("builds proposal shape", () => {
    const p = proposalFromAppendServiceNoteDraft(
      {
        humanTicketId: "PENN-060126-1001",
        noteText: "Dishwasher model WRS432323",
        actorLabel: "Nicolas",
      },
      "Append note to PENN-060126-1001"
    );
    assert.equal(p.op, PROPOSAL_OPS.APPEND_SERVICE_NOTE);
    assert.equal(p.target.human_ticket_id, "PENN-060126-1001");
    assert.match(p.payload.note_text, /WRS432323/);
  });
});
