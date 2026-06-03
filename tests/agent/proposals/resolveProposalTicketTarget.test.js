const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  openTicketRowToTarget,
  rankOpenTicketsByIssueHint,
} = require("../../../src/agent/proposals/resolveProposalTicketTarget");

describe("resolveProposalTicketTarget helpers", () => {
  it("normalizes open ticket row", () => {
    const t = openTicketRowToTarget({
      ticket_row_id: "uuid-1",
      ticket_id: "PENN-060126-1001",
      unit_label: "303",
      property_code: "penn",
      category_final: "Appliance",
      message_raw: "dishwasher not draining",
    });
    assert.equal(t.humanTicketId, "PENN-060126-1001");
    assert.equal(t.propertyCode, "PENN");
    assert.equal(t.unitLabel, "303");
  });

  it("ranks by issue hint", () => {
    const rows = [
      {
        humanTicketId: "A",
        unitLabel: "303",
        category: "Plumbing",
        summary: "sink clog",
      },
      {
        humanTicketId: "B",
        unitLabel: "303",
        category: "Appliance",
        summary: "dishwasher malfunction",
      },
    ];
    const ranked = rankOpenTicketsByIssueHint(rows, "dishwasher");
    assert.equal(ranked[0].humanTicketId, "B");
  });
});
