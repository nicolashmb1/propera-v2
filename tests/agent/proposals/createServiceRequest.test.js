const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCreateServiceRequestProposal,
} = require("../../../src/agent/proposals/createServiceRequest");
const { PROPOSAL_OPS } = require("../../../src/agent/proposals/types");
const { verifyProposalConfirmToken } = require("../../../src/agent/proposals/proposalToken");
const { extractProposalPortalFields } = require("../../../src/agent/proposals/proposalPortalFields");

describe("create_service_request proposal", () => {
  it("builds proposal with confirm token and portal fields", () => {
    const { proposal, confirmToken } = buildCreateServiceRequestProposal(
      {
        propertyCode: "PENN",
        unitLabel: "303",
        issueText: "Dishwasher not draining",
        category: "Appliance",
        urgency: "Normal",
      },
      "Create PENN unit 303"
    );

    assert.equal(proposal.op, PROPOSAL_OPS.CREATE_SERVICE_REQUEST);
    assert.equal(proposal.payload.property_code, "PENN");
    assert.equal(proposal.payload.unit_label, "303");
    assert.equal(proposal.payload.issue_text, "Dishwasher not draining");
    assert.ok(confirmToken);

    const verified = verifyProposalConfirmToken(confirmToken);
    assert.equal(verified?.op, PROPOSAL_OPS.CREATE_SERVICE_REQUEST);

    const fields = extractProposalPortalFields("create_service_request", verified.payload);
    assert.equal(fields.propertyCode, "PENN");
    assert.equal(fields.unitLabel, "303");
    assert.equal(fields.issue, "Dishwasher not draining");
    assert.equal(fields.category, "Appliance");
  });

  it("includes preferred_window on create payload for one-confirm schedule", () => {
    const { proposal } = buildCreateServiceRequestProposal(
      {
        propertyCode: "PENN",
        unitLabel: "402",
        issueText: "Refrigerator stopped working",
        preferredWindow: "today 11am",
      },
      "Create with window"
    );
    assert.equal(proposal.payload.preferred_window, "today 11am");
    const fields = extractProposalPortalFields(
      "create_service_request",
      proposal.payload
    );
    assert.equal(fields.preferredWindow, "today 11am");
  });
});
