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
  assert.ok(p.Body.includes("apt"));
  assert.ok(p.Body.includes("Preferred:"));
  assert.ok(p.Body.includes("tomorrow afternoon"));
});

test("create_ticket common_area Body omits apt fragment", () => {
  const p = buildRouterParameterFromPortal({
    action: "create_ticket",
    actorPhoneE164: "+19085550101",
    property: "PENN",
    location_kind: "common_area",
    unit: "",
    category: "Safety",
    message: "Wet floor",
    preferredWindow: "",
  });
  assert.ok(!/\bapt\b/i.test(p.Body));
  assert.ok(p.Body.includes("Wet floor"));
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

test("portal_chat passes body and sets _portalAction", () => {
  const p = buildRouterParameterFromPortal({
    action: "portal_chat",
    actorPhoneE164: "+19085550101",
    body: "# Penn apt 316 sink clogged",
  });
  assert.equal(p._portalAction, "portal_chat");
  assert.equal(p.Body, "# Penn apt 316 sink clogged");
  assert.equal(p._mediaJson, "");
});

test("portal_chat accepts message alias", () => {
  const p = buildRouterParameterFromPortal({
    action: "portal_chat",
    actorPhoneE164: "+19085550101",
    message: "Schedule tomorrow",
  });
  assert.equal(p.Body, "Schedule tomorrow");
});

test("portal_chat # only + media", () => {
  const p = buildRouterParameterFromPortal({
    action: "portal_chat",
    actorPhoneE164: "+19085550101",
    body: "#",
    media: [{ kind: "image", mime_type: "image/png", dataUrl: "data:image/png;base64,AAAA" }],
  });
  assert.equal(p.Body, "#");
  const arr = JSON.parse(p._mediaJson);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].kind, "image");
});

test("portal_chat rejects empty body and no media", () => {
  assert.throws(
    () =>
      buildRouterParameterFromPortal({
        action: "portal_chat",
        actorPhoneE164: "+19085550101",
        body: "   ",
      }),
    /portal_chat requires body\/message or media/
  );
});

test("portal_chat rejects media without body", () => {
  assert.throws(
    () =>
      buildRouterParameterFromPortal({
        action: "portal_chat",
        actorPhoneE164: "+19085550101",
        media: [{ kind: "image", dataUrl: "data:image/png;base64,QQ==" }],
      }),
    /media-only requires body/
  );
});
