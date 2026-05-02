"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRouterParameterFromPortal,
} = require("../src/contracts/buildRouterParameterFromPortal");
const { parsePortalPmTicketRequest } = require("../src/dal/portalTicketMutations");

test("portal JSON with ticketId + attachments uses noop body and parses as update", () => {
  const rp = buildRouterParameterFromPortal({
    action: "staff_command",
    actorPhoneE164: "+15551234567",
    ticketId: "PENN-010126-0001",
    attachments: ["https://cdn.example.com/photo1.jpg"],
  });
  assert.equal(rp.Body, "noop");
  assert.match(String(rp._portalPayloadJson || ""), /attachments/);
  const parsed = parsePortalPmTicketRequest(rp);
  assert.ok(parsed);
  assert.equal(parsed.kind, "update");
  assert.equal(parsed.humanTicketId, "PENN-010126-0001");
  assert.ok(Array.isArray(parsed.fields.attachmentsAdd));
  assert.equal(parsed.fields.attachmentsAdd.length, 1);
  assert.equal(parsed.fields.attachmentsAdd[0], "https://cdn.example.com/photo1.jpg");
});
