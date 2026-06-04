const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyJarvisIntent,
  isPortfolioOpenListQuestion,
} = require("../../src/agent/jarvisAsk/classifyJarvisIntent");
const { sortTickets, ticketBrief } = require("../../src/voice/listOpenServiceTickets");

describe("classifyJarvisIntent portfolio", () => {
  it("detects all open services as portfolio list", () => {
    assert.equal(isPortfolioOpenListQuestion("give me all open services"), true);
    assert.equal(isPortfolioOpenListQuestion("full list of open tickets"), true);
    assert.equal(isPortfolioOpenListQuestion("what is open at PENN"), false);
  });
});

describe("listOpenServiceTickets helpers", () => {
  it("sortTickets prioritizes urgent", () => {
    const sorted = sortTickets([
      { humanTicketId: "A", status: "Open", summary: "leak" },
      { humanTicketId: "B", status: "Urgent", summary: "no heat" },
    ]);
    assert.equal(sorted[0].humanTicketId, "B");
  });

  it("ticketBrief includes property and unit", () => {
    const line = ticketBrief({
      propertyCode: "PENN",
      unitLabel: "502",
      summary: "dishwasher",
    });
    assert.match(line, /PENN/);
    assert.match(line, /502/);
  });
});
