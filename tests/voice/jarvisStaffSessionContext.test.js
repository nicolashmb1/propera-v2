const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatJarvisStaffContextBlock,
} = require("../../src/voice/jarvisStaffSessionContext");

describe("formatJarvisStaffContextBlock", () => {
  it("includes story and work items", () => {
    const block = formatJarvisStaffContextBlock(
      {
        story: "Property PENN, 2 open work item(s) for actor",
        anchor: { propertyCode: "PENN", unit: "303" },
        activeWork: [
          {
            propertyId: "PENN",
            unitId: "303",
            ticketHumanId: "PENN-060126-1001",
            state: "UNSCHEDULED",
          },
        ],
        propertyOpenTickets: [],
      },
      [{ roleKey: "building_super", label: "Building lead" }],
      null
    );
    assert.match(block, /Staff Jarvis context/i);
    assert.match(block, /PENN/);
    assert.match(block, /303/);
    assert.match(block, /Building lead/);
    assert.match(block, /never recite capabilities/i);
  });

  it("shows pending proposal from thread", () => {
    const block = formatJarvisStaffContextBlock(
      { story: "Property PENN", anchor: { propertyCode: "PENN" }, activeWork: [] },
      [],
      {
        pendingProposals: [
          {
            state: "awaiting_confirm",
            summary_human: "Attach $33 parts to unit 303",
          },
        ],
      }
    );
    assert.match(block, /Pending confirm/i);
    assert.match(block, /\$33/);
  });
});
