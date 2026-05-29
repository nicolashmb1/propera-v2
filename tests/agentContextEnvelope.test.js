const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRouterParameterFromPortal } = require("../src/contracts/buildRouterParameterFromPortal");
const {
  readPortalPageContext,
  bodyReferencesPageTicket,
} = require("../src/agent/contextEnvelope");

test("buildRouterParameterFromPortal carries portal_page_context", () => {
  const p = buildRouterParameterFromPortal({
    action: "portal_chat",
    actorPhoneE164: "+15551234567",
    body: "# close this ticket",
    portal_page_context: {
      surface: "tickets",
      property_code: "PENN",
      unit: "306",
      human_ticket_id: "PENN-010126-0001",
    },
  });
  const ctx = readPortalPageContext(p);
  assert.ok(ctx);
  assert.equal(ctx.propertyCode, "PENN");
  assert.equal(ctx.unit, "306");
  assert.equal(ctx.humanTicketId, "PENN-010126-0001");
});

test("bodyReferencesPageTicket detects deictic schedule", () => {
  assert.equal(bodyReferencesPageTicket("schedule this ticket"), true);
  assert.equal(bodyReferencesPageTicket("306 penn done"), false);
});
