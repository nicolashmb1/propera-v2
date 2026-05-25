"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAppendHandoffRouterParameter,
} = require("../../src/adapters/tenantAgent/buildAppendHandoffRouterParameter");

test("buildAppendHandoffRouterParameter — append_to_ticket shape", () => {
  const rp = buildAppendHandoffRouterParameter({
    ticketKey: "uuid-ticket-1",
    tenantActorKey: "+15551234001",
    message: "Still leaking",
    mediaJson: JSON.stringify([{ url: "https://cdn.example.com/sink.jpg" }]),
    transportChannel: "sms",
    conversationId: "conv-1",
    traceId: "trace-a",
  });

  assert.equal(rp._portalAction, "append_to_ticket");
  assert.equal(rp.Body, "noop");
  const payload = JSON.parse(rp._portalPayloadJson);
  assert.equal(payload.operation, "append_to_ticket");
  assert.equal(payload.ticket_key, "uuid-ticket-1");
  assert.equal(payload.message, "Still leaking");
  assert.equal(payload.attachmentUrls.length, 1);
});
