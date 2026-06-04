const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildScheduleTicketProposal,
} = require("../../../src/agent/proposals/scheduleTicket");
const { PROPOSAL_OPS } = require("../../../src/agent/proposals/types");
const { verifyProposalConfirmToken } = require("../../../src/agent/proposals/proposalToken");
const { extractProposalPortalFields } = require("../../../src/agent/proposals/proposalPortalFields");

describe("schedule_ticket proposal", () => {
  it("builds proposal with window and portal fields", () => {
    const { proposal, confirmToken } = buildScheduleTicketProposal(
      {
        humanTicketId: "PENN-060126-0001",
        ticketKey: "uuid-key-1",
        preferredWindow: "today 1-5pm",
        propertyCode: "PENN",
      },
      "Schedule PENN-060126-0001"
    );

    assert.equal(proposal.op, PROPOSAL_OPS.SCHEDULE_TICKET);
    assert.equal(proposal.payload.preferred_window, "today 1-5pm");
    assert.ok(confirmToken);

    const verified = verifyProposalConfirmToken(confirmToken);
    const fields = extractProposalPortalFields("schedule_ticket", verified.payload);
    assert.equal(fields.humanTicketId, "PENN-060126-0001");
    assert.equal(fields.preferredWindow, "today 1-5pm");
    assert.equal(fields.statusTo, "Scheduled");
  });
});
