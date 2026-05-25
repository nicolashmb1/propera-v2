"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shapeBrainReplyForTenantAgent,
  FINALIZE_FAILED_REPLY,
} = require("../../src/adapters/tenantAgent/shapeBrainReply");

test("shapeBrainReply — rebuilds routine receipt from finalize facts", () => {
  const shaped = shapeBrainReplyForTenantAgent({
    brain: "core_finalized",
    replyText: "legacy Ticket logged: X",
    draft: {
      propertyCode: "PENN",
      unitLabel: "410",
      issueText: "heat not working",
      portalLocationKind: "unit",
    },
    finalize: { ticketId: "PENN-052326-2930", ticketKey: "uuid-1" },
    outgate: { templateKey: "MAINTENANCE_RECEIPT_ROUTINE", emergency: false },
  });
  assert.match(shaped, /Ref #PENN-052326-2930/);
  assert.match(shaped, /heat not working/i);
  assert.match(shaped, /unit 410/);
  assert.doesNotMatch(shaped, /Ticket logged/i);
});

test("shapeBrainReply — common area receipt references property", () => {
  const shaped = shapeBrainReplyForTenantAgent({
    brain: "core_finalized",
    replyText: "legacy",
    draft: {
      propertyCode: "WESTGRAND",
      issueText: "elevator broken",
      portalLocationKind: "common_area",
      locationLabelSnapshot: "elevator",
    },
    finalize: { ticketId: "WGRA-052426-6464", ticketKey: "uuid-1" },
    outgate: { templateKey: "MAINTENANCE_RECEIPT_ROUTINE", emergency: false },
  });
  assert.match(shaped, /Elevator broken confirmed at Westgrand\./);
  assert.doesNotMatch(shaped, /confirmed for the elevator/i);
});

test("shapeBrainReply — emergency tier", () => {
  const shaped = shapeBrainReplyForTenantAgent({
    brain: "core_finalized",
    replyText: "",
    draft: {
      unitLabel: "303",
      issueText: "kitchen is on fire",
      portalLocationKind: "unit",
    },
    finalize: { ticketId: "PENN-001" },
    outgate: { templateKey: "MAINTENANCE_RECEIPT_EMERGENCY", emergency: true },
  });
  assert.match(shaped, /treating this as an emergency/i);
  assert.match(shaped, /stay safe/i);
});

test("shapeBrainReply — multi ticket keeps brain body", () => {
  const multi =
    "Ref #PENN-001 — heat, unit 410.\nRef #PENN-002 — leak, unit 410.\nBoth are being handled.";
  const shaped = shapeBrainReplyForTenantAgent({
    brain: "core_finalized",
    replyText: multi,
    finalize: { ticketId: "PENN-001" },
    outgate: { templateKey: "MAINTENANCE_RECEIPT_MULTI" },
  });
  assert.equal(shaped, multi);
});

test("shapeBrainReply — finalize failed", () => {
  assert.equal(
    shapeBrainReplyForTenantAgent({ brain: "core_finalize_failed", replyText: "Could not save" }),
    FINALIZE_FAILED_REPLY
  );
});
