const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ticketFromScopeSnapshot } = require("../../src/portal/handleJarvisPendingProposal");

describe("ticketFromScopeSnapshot", () => {
  it("maps anchor fields for pending proposal ticket card", () => {
    const t = ticketFromScopeSnapshot({
      anchor: {
        humanTicketId: "MURR-053026-4247",
        ticketRowId: "uuid-1",
        unit: "303",
        propertyCode: "MURRAY",
      },
    });
    assert.equal(t.humanTicketId, "MURR-053026-4247");
    assert.equal(t.unitLabel, "303");
    assert.equal(t.propertyCode, "MURRAY");
  });

  it("returns null without human ticket id", () => {
    assert.equal(ticketFromScopeSnapshot({ anchor: { unit: "303" } }), null);
  });
});
