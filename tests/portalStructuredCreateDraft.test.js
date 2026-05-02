"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildStructuredPortalCreateDraft,
  resolvePortalPropertyCode,
} = require("../src/brain/core/portalStructuredCreateDraft");

test("resolvePortalPropertyCode matches code and ticket_prefix", () => {
  const known = new Set(["WGRA"]);
  const list = [
    {
      code: "WGRA",
      display_name: "Westgrand",
      ticket_prefix: "WEST",
      short_name: "",
      aliases: [],
    },
  ];
  assert.equal(resolvePortalPropertyCode("WGRA", known, list), "WGRA");
  assert.equal(resolvePortalPropertyCode("west", known, list), "WGRA");
});

test("buildStructuredPortalCreateDraft uses JSON fields and preferredWindow as scheduleRaw", () => {
  const known = new Set(["WGRA"]);
  const list = [{ code: "WGRA", display_name: "X", ticket_prefix: "", short_name: "", aliases: [] }];
  const rp = {
    _portalAction: "create_ticket",
    _portalPayloadJson: JSON.stringify({
      property: "WGRA",
      unit: "304",
      message: "Dryer igniter replace",
      category: "Appliance",
      preferredWindow: "Monday morning",
    }),
  };
  const d = buildStructuredPortalCreateDraft(rp, known, list);
  assert.ok(d);
  assert.equal(d.propertyCode, "WGRA");
  assert.equal(d.unitLabel, "304");
  assert.equal(d.issueText, "Dryer igniter replace");
  assert.equal(d.scheduleRaw, "Monday morning");
});

test("buildStructuredPortalCreateDraft returns null without unit", () => {
  const known = new Set(["WGRA"]);
  const list = [{ code: "WGRA", display_name: "X", ticket_prefix: "", short_name: "", aliases: [] }];
  const rp = {
    _portalAction: "create_ticket",
    _portalPayloadJson: JSON.stringify({
      property: "WGRA",
      unit: "",
      message: "x",
    }),
  };
  assert.equal(buildStructuredPortalCreateDraft(rp, known, list), null);
});
