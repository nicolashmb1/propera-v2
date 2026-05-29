const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveWorkItemFromPageContext } = require("../src/agent/resolvePageContextTarget");

test("resolveWorkItemFromPageContext matches human ticket id", async () => {
  const out = await resolveWorkItemFromPageContext({
    bodyTrim: "# schedule this ticket",
    pageContext: {
      propertyCode: "PENN",
      unit: "306",
      humanTicketId: "PENN-010126-0001",
    },
    openWis: [
      {
        workItemId: "WI_TEST_1",
        propertyId: "PENN",
        unitId: "306",
        ticketHumanId: "PENN-010126-0001",
      },
      {
        workItemId: "WI_TEST_2",
        propertyId: "PENN",
        unitId: "307",
        ticketHumanId: "PENN-010126-0002",
      },
    ],
  });
  assert.equal(out.wiId, "WI_TEST_1");
  assert.equal(out.reason, "PAGE_CONTEXT_HUMAN_TICKET");
});

test("resolveWorkItemFromPageContext skips without deictic body", async () => {
  const out = await resolveWorkItemFromPageContext({
    bodyTrim: "# 306 penn done",
    pageContext: { propertyCode: "PENN", unit: "306", humanTicketId: "PENN-010126-0001" },
    openWis: [{ workItemId: "WI_TEST_1", ticketHumanId: "PENN-010126-0001" }],
  });
  assert.equal(out.wiId, "");
});
