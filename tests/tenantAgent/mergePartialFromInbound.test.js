"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  propertyAddressContext,
  unitLooksLikeResolvedPropertyAddress,
  inferUnitFromNumberBeforeResolvedProperty,
  mergePartialFromInboundMessage,
} = require("../../src/adapters/tenantAgent/mergePartialFromInbound");

const PROPS = [
  {
    code: "WESTFIELD",
    display_name: "The Grand at Westfield",
    display_name_short: "Westfield",
    short_name: "Westfield",
    address: "619 Westfield Ave",
    aliases: [],
  },
];

test("propertyAddressContext builds GAS-style address hints from properties.address", () => {
  const ctx = propertyAddressContext(PROPS[0]);
  assert.deepEqual(ctx, {
    num: "619",
    hints: ["westfield"],
    suffixes: ["ave"],
  });
});

test("unitLooksLikeResolvedPropertyAddress blocks address number as unit", () => {
  assert.equal(
    unitLooksLikeResolvedPropertyAddress(
      "my sink is leaking at 619 westfield",
      "619",
      "WESTFIELD",
      PROPS
    ),
    true
  );
});

test("unitLooksLikeResolvedPropertyAddress allows non-address number as likely unit", () => {
  assert.equal(
    unitLooksLikeResolvedPropertyAddress(
      "my sink is leaking at 512 westfield",
      "512",
      "WESTFIELD",
      PROPS
    ),
    false
  );
});

test("unitLooksLikeResolvedPropertyAddress keeps explicit apt marker even if number matches address", () => {
  assert.equal(
    unitLooksLikeResolvedPropertyAddress(
      "apt 619 westfield radiator is banging",
      "619",
      "WESTFIELD",
      PROPS
    ),
    false
  );
});

test("inferUnitFromNumberBeforeResolvedProperty treats non-address leading number as likely unit", () => {
  assert.equal(
    inferUnitFromNumberBeforeResolvedProperty(
      "my sink is leaking at 512 westfield",
      "WESTFIELD",
      PROPS
    ),
    "512"
  );
});

test("mergePartialFromInboundMessage clears unit when it matches property address row", async () => {
  const out = await mergePartialFromInboundMessage(
    {},
    "my sink is leaking at 619 westfield",
    new Set(["WESTFIELD"]),
    PROPS
  );
  assert.equal(out.property, "WESTFIELD");
  assert.equal(String(out.unit || ""), "");
});

test("mergePartialFromInboundMessage keeps likely unit when number does not match address row", async () => {
  const out = await mergePartialFromInboundMessage(
    {},
    "my sink is leaking at 512 westfield",
    new Set(["WESTFIELD"]),
    PROPS
  );
  assert.equal(out.property, "WESTFIELD");
  assert.equal(out.unit, "512");
});
