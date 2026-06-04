const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { extractProposalPortalFields } = require("../../../src/agent/proposals/proposalPortalFields");

describe("extractProposalPortalFields", () => {
  it("maps service note payload", () => {
    const f = extractProposalPortalFields("append_service_note", {
      humanTicketId: "PENN-060126-0001",
      noteText: "needs replacement",
      unitLabel: "303",
      propertyCode: "PENN",
    });
    assert.equal(f.noteText, "needs replacement");
    assert.equal(f.humanTicketId, "PENN-060126-0001");
    assert.equal(f.unitLabel, "303");
  });

  it("maps cost payload", () => {
    const f = extractProposalPortalFields("attach_ticket_cost", {
      vendorAmt: 4250,
      entryType: "parts",
      vendorName: "Home Depot",
      humanTicketId: "PENN-060126-0001",
    });
    assert.equal(f.amountCents, 4250);
    assert.equal(f.entryType, "parts");
    assert.equal(f.vendorName, "Home Depot");
  });

  it("maps vendor dispatch default true", () => {
    const f = extractProposalPortalFields("propose_vendor_request", {
      vendorDisplayName: "ABC Plumbing",
      humanTicketId: "PENN-060126-0001",
    });
    assert.equal(f.vendorName, "ABC Plumbing");
    assert.equal(f.dispatch, true);
  });

  it("maps vendor assign-only", () => {
    const f = extractProposalPortalFields("propose_vendor_request", {
      vendorDisplayName: "ABC Plumbing",
      dispatch: false,
    });
    assert.equal(f.dispatch, false);
  });

  it("maps create_service_request payload", () => {
    const f = extractProposalPortalFields("create_service_request", {
      property_code: "PENN",
      unit_label: "303",
      issue_text: "No heat",
      category: "HVAC",
    });
    assert.equal(f.propertyCode, "PENN");
    assert.equal(f.unitLabel, "303");
    assert.equal(f.issue, "No heat");
    assert.equal(f.category, "HVAC");
  });

  it("maps schedule_ticket payload", () => {
    const f = extractProposalPortalFields("schedule_ticket", {
      human_ticket_id: "PENN-060126-0001",
      preferred_window: "tomorrow 9-11am",
    });
    assert.equal(f.humanTicketId, "PENN-060126-0001");
    assert.equal(f.preferredWindow, "tomorrow 9-11am");
    assert.equal(f.statusTo, "Scheduled");
  });
});
