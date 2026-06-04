const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTicketLifecycleProposal,
  portalMutationInputForLifecycleOp,
  normalizeVoiceTicketStatus,
} = require("../../../src/agent/proposals/ticketLifecycleOps");
const { PROPOSAL_OPS } = require("../../../src/agent/proposals/types");
const { verifyProposalConfirmToken } = require("../../../src/agent/proposals/proposalToken");
const { extractProposalPortalFields } = require("../../../src/agent/proposals/proposalPortalFields");

describe("ticket lifecycle proposals", () => {
  it("normalizes voice status phrases", () => {
    assert.equal(normalizeVoiceTicketStatus("in progress"), "In Progress");
    assert.equal(normalizeVoiceTicketStatus("scheduled"), "Scheduled");
    assert.equal(normalizeVoiceTicketStatus("done"), "Completed");
  });

  it("builds set_ticket_status with portal payload", () => {
    const { proposal, confirmToken } = buildTicketLifecycleProposal(
      PROPOSAL_OPS.SET_TICKET_STATUS,
      {
        humanTicketId: "PENN-060126-0042",
        statusTo: "In Progress",
        propertyCode: "PENN",
      },
      "Set PENN-060126-0042 status to In Progress"
    );
    assert.equal(proposal.op, PROPOSAL_OPS.SET_TICKET_STATUS);
    assert.equal(proposal.payload.status_to, "In Progress");

    const verified = verifyProposalConfirmToken(confirmToken);
    const input = portalMutationInputForLifecycleOp(
      PROPOSAL_OPS.SET_TICKET_STATUS,
      verified.payload
    );
    assert.equal(input.portalPayload.status, "In Progress");
    assert.equal(input.portalPayload.ticket_id, "PENN-060126-0042");

    const fields = extractProposalPortalFields("set_ticket_status", verified.payload);
    assert.equal(fields.statusTo, "In Progress");
    assert.equal(fields.humanTicketId, "PENN-060126-0042");
  });

  it("builds cancel_ticket with soft-delete body", () => {
    const { proposal } = buildTicketLifecycleProposal(
      PROPOSAL_OPS.CANCEL_TICKET,
      { humanTicketId: "PENN-060126-0099" },
      "Cancel PENN-060126-0099"
    );
    assert.equal(proposal.op, PROPOSAL_OPS.CANCEL_TICKET);
    const input = portalMutationInputForLifecycleOp(
      PROPOSAL_OPS.CANCEL_TICKET,
      proposal.payload
    );
    assert.equal(input.body, "PENN-060126-0099 canceled");

    const fields = extractProposalPortalFields("cancel_ticket", proposal.payload);
    assert.equal(fields.statusTo, "Deleted");
  });

  it("builds update_ticket_issue portal fields", () => {
    const { proposal } = buildTicketLifecycleProposal(
      PROPOSAL_OPS.UPDATE_TICKET_ISSUE,
      {
        humanTicketId: "PENN-060126-0001",
        issueText: "AC not cooling",
      },
      "Update issue"
    );
    const input = portalMutationInputForLifecycleOp(
      PROPOSAL_OPS.UPDATE_TICKET_ISSUE,
      proposal.payload
    );
    assert.equal(input.portalPayload.issue, "AC not cooling");
    const fields = extractProposalPortalFields("update_ticket_issue", proposal.payload);
    assert.equal(fields.issue, "AC not cooling");
  });

  it("builds close_ticket as Completed", () => {
    const { proposal } = buildTicketLifecycleProposal(
      PROPOSAL_OPS.CLOSE_TICKET,
      { humanTicketId: "PENN-060126-0002" },
      "Mark complete"
    );
    const input = portalMutationInputForLifecycleOp(
      PROPOSAL_OPS.CLOSE_TICKET,
      proposal.payload
    );
    assert.equal(input.portalPayload.status, "Completed");
  });
});
