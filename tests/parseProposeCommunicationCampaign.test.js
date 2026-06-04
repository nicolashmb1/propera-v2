const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseProposeCommunicationCampaign,
} = require("../src/agent/jarvisPlan/parseProposeCommunicationCampaign");

test("parseProposeCommunicationCampaign — all tenants at property", () => {
  const parsed = parseProposeCommunicationCampaign(
    "send message to all tenants at PENN that they must remove belongings from parking spots",
    {}
  );
  assert.ok(parsed);
  assert.equal(parsed.audienceScope, "property");
  assert.match(parsed.propertyHint, /PENN/i);
  assert.match(parsed.brief, /remove belongings/i);
});

test("parseProposeCommunicationCampaign — portfolio", () => {
  const parsed = parseProposeCommunicationCampaign(
    "broadcast to all properties about elevator inspection next week",
    {}
  );
  assert.ok(parsed);
  assert.equal(parsed.audienceScope, "portfolio");
  assert.match(parsed.brief, /elevator inspection/i);
});

test("parseProposeCommunicationCampaign — ignores non-broadcast text", () => {
  assert.equal(parseProposeCommunicationCampaign("note: fixed the leak", {}), null);
});
