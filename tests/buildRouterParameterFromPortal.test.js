"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRouterParameterFromPortal,
} = require("../src/contracts/buildRouterParameterFromPortal");

test("create_ticket composes Body with Preferred line", () => {
  const p = buildRouterParameterFromPortal({
    action: "create_ticket",
    actorPhoneE164: "+19085550101",
    property: "PENN",
    unit: "303",
    category: "Appliance",
    message: "Icemaker broken",
    preferredWindow: "tomorrow afternoon",
  });
  assert.equal(p._channel, "PORTAL");
  assert.ok(p.Body.includes("PENN"));
  assert.ok(p.Body.includes("Preferred:"));
  assert.ok(p.Body.includes("tomorrow afternoon"));
});

test("staff_command passes body through", () => {
  const p = buildRouterParameterFromPortal({
    action: "staff_command",
    actorPhoneE164: "+19085550101",
    body: "PENN-031 done",
  });
  assert.equal(p.Body, "PENN-031 done");
});

test("staff_command: noop body when JSON is a ticket row save (message_raw only)", () => {
  const p = buildRouterParameterFromPortal({
    action: "staff_command",
    actorPhoneE164: "+19085550101",
    ticket: {
      ticket_id: "PENN-042626-8784",
      message_raw: "ICEMAKER WORKS BUT DISPENSER IS NOT WORKING",
    },
  });
  assert.equal(p.Body, "noop");
  const json = JSON.parse(p._portalPayloadJson);
  assert.equal(json.ticket.message_raw, "ICEMAKER WORKS BUT DISPENSER IS NOT WORKING");
});

test("staff_command: accepts actorPhone alias", () => {
  const p = buildRouterParameterFromPortal({
    actorPhone: "+19085550101",
    body: "x",
  });
  assert.equal(p.From, "+19085550101");
});
