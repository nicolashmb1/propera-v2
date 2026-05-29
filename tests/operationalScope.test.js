const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildStoryLine,
  filterWorkItemsByAnchor,
} = require("../src/agent/operationalScope/compileOperationalScope");
const {
  isPortalChatInbound,
} = require("../src/agent/operationalScope/logOperationalScopeForInbound");

test("buildStoryLine summarizes anchor and focus", () => {
  const story = buildStoryLine({
    anchor: {
      propertyCode: "PENN",
      unit: "306",
      surface: "tickets",
    },
    activeWork: [{ workItemId: "WI_1" }],
    propertyOpenTickets: [],
    focus: { humanTicketId: "PENN-010126-0001", reason: "ANCHOR_HUMAN_TICKET" },
  });
  assert.match(story, /Property PENN/);
  assert.match(story, /unit 306/);
  assert.match(story, /Focus ticket PENN-010126-0001/);
});

test("filterWorkItemsByAnchor narrows by property and unit", () => {
  const all = [
    { workItemId: "A", propertyId: "PENN", unitId: "306" },
    { workItemId: "B", propertyId: "PENN", unitId: "307" },
    { workItemId: "C", propertyId: "MORRIS", unitId: "306" },
  ];
  const filtered = filterWorkItemsByAnchor(all, {
    propertyCode: "PENN",
    unit: "306",
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].workItemId, "A");
});

test("filterWorkItemsByAnchor returns all when anchor empty", () => {
  const all = [{ workItemId: "A", propertyId: "PENN", unitId: "1" }];
  assert.equal(filterWorkItemsByAnchor(all, {}).length, 1);
});

test("isPortalChatInbound matches portal portal_chat only", () => {
  assert.equal(
    isPortalChatInbound("portal", { _portalAction: "portal_chat" }),
    true
  );
  assert.equal(
    isPortalChatInbound("portal", { _portalAction: "create_ticket" }),
    false
  );
  assert.equal(
    isPortalChatInbound("telegram", { _portalAction: "portal_chat" }),
    false
  );
});
