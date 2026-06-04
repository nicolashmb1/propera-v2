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

test("buildStoryLine includes unit lifecycle occupancy turnover assets", () => {
  const story = buildStoryLine({
    anchor: { propertyCode: "MORRIS", unit: "505" },
    activeWork: [],
    propertyOpenTickets: [],
    focus: null,
    unitLifecycle: {
      unitCatalogId: "uid-505",
      activeOccupancy: {
        occupancyId: "occ-1",
        residentName: "Alex Tenant",
        status: "current",
        startedAt: "2026-01-01T00:00:00Z",
      },
      activeTurnover: {
        turnoverId: "to-1",
        status: "IN_PROGRESS",
        startedAt: "2026-06-01",
        targetReadyDate: "2026-06-15",
        unitLabel: "505",
      },
      turnoverBlocker: "Paint / touch-up",
      unitAssets: [
        { assetId: "a1", assetType: "dishwasher", make: "Whirlpool", model: "WRS571", serialNumber: "X1" },
      ],
    },
  });
  assert.match(story, /Current resident Alex Tenant/);
  assert.match(story, /Active turnover IN_PROGRESS/);
  assert.match(story, /blocker: Paint/);
  assert.match(story, /installed asset/);
  assert.match(story, /dishwasher \(WRS571\)/);
});

test("buildStoryLine notes vacant unit when lifecycle pack has no occupancy", () => {
  const story = buildStoryLine({
    anchor: { propertyCode: "MORRIS", unit: "505" },
    activeWork: [],
    propertyOpenTickets: [],
    focus: null,
    unitLifecycle: {
      unitCatalogId: "uid-505",
      activeOccupancy: null,
      activeTurnover: null,
      turnoverBlocker: "",
      unitAssets: [],
    },
  });
  assert.match(story, /vacant/i);
});

test("readPortalPageContext carries unit_catalog_id and turnover_id", () => {
  const { readPortalPageContext } = require("../src/agent/contextEnvelope");
  const ctx = readPortalPageContext({
    _portalPageContextJson: JSON.stringify({
      surface: "properties",
      property_code: "MORRIS",
      unit: "505",
      unit_catalog_id: "5001a301-9f00-47a0-988a-518bcfb62982",
      turnover_id: "to-uuid-1",
    }),
  });
  assert.ok(ctx);
  assert.equal(ctx.unitCatalogId, "5001a301-9f00-47a0-988a-518bcfb62982");
  assert.equal(ctx.turnoverId, "to-uuid-1");
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
