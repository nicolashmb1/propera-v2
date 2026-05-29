const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildProposalConfirmToken,
  verifyProposalConfirmToken,
  proposalFromExpenseDraft,
  normalizeProposalForPortal,
  PROPOSAL_OPS,
} = require("../src/agent/proposals");
const { enrichStaffRunWithProposal } = require("../src/agent/proposals/enrichStaffRunWithProposal");

test("proposal token round-trip with attach_ticket_cost op", () => {
  const token = buildProposalConfirmToken(
    {
      ticketRowId: "row-uuid",
      ticketHumanId: "PENN-010126-1001",
      vendorAmt: 4200,
      tenantAmt: 0,
      hasTenantCharge: false,
      entryType: "parts",
      vendorName: "homedepot",
      idempotencyKey: "test-key",
      normalizedBody: "42 homedepot",
    },
    PROPOSAL_OPS.ATTACH_TICKET_COST
  );
  const v = verifyProposalConfirmToken(token);
  assert.ok(v);
  assert.equal(v.op, PROPOSAL_OPS.ATTACH_TICKET_COST);
  assert.equal(v.payload.ticketHumanId, "PENN-010126-1001");
  assert.equal(v.payload.vendorAmt, 4200);
});

test("enrichStaffRunWithProposal adds proposal on needsConfirm", () => {
  const token = buildProposalConfirmToken(
    {
      ticketRowId: "row-uuid",
      ticketHumanId: "PENN-010126-1001",
      vendorAmt: 1000,
      tenantAmt: 0,
      hasTenantCharge: false,
    },
    PROPOSAL_OPS.ATTACH_TICKET_COST
  );
  const run = enrichStaffRunWithProposal({
    ok: true,
    brain: "staff_expense_capture",
    replyText: "Confirm?",
    resolution: {
      needsConfirm: true,
      confirmToken: token,
      confirmSummary: "Post $10.00 company on PENN-010126-1001?",
    },
  });
  assert.ok(run.resolution.proposal);
  assert.equal(run.resolution.proposal.op, PROPOSAL_OPS.ATTACH_TICKET_COST);
  assert.equal(run.resolution.proposal.confirm_token, token);
});

test("proposalFromExpenseDraft shape", () => {
  const p = normalizeProposalForPortal(
    proposalFromExpenseDraft(
      {
        ticketRowId: "r1",
        ticketHumanId: "PENN-1",
        vendorAmt: 500,
        proposal_id: "pid-1",
      },
      "Summary line"
    )
  );
  assert.equal(p.op, PROPOSAL_OPS.ATTACH_TICKET_COST);
  assert.equal(p.summary_human, "Summary line");
  assert.equal(p.target.human_ticket_id, "PENN-1");
});
