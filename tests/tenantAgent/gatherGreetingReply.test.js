"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isGatheringGreetingOnly,
  buildGatherGreetingReply,
  inferBrandDisplayName,
} = require("../../src/adapters/tenantAgent/gatherGreetingReply");

const PENN_LIST = [{ code: "PENN", display_name: "The Grand at Penn" }];

test("isGatheringGreetingOnly — hi without maintenance", () => {
  assert.equal(isGatheringGreetingOnly("Hi", {}), true);
  assert.equal(isGatheringGreetingOnly("good morning", {}), true);
  assert.equal(isGatheringGreetingOnly("whatsup", {}), true);
  assert.equal(isGatheringGreetingOnly("what's up", {}), true);
  assert.equal(isGatheringGreetingOnly("/start", {}), true);
  assert.equal(isGatheringGreetingOnly("/start propera", {}), true);
  assert.equal(isGatheringGreetingOnly("heat not working", {}), false);
});

test("buildGatherGreetingReply — brand from single-property allowlist", () => {
  const prev = process.env.TENANT_AGENT_PROPERTY_ALLOWLIST;
  process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = "PENN";
  const reply = buildGatherGreetingReply({ propertiesList: PENN_LIST, partial: {} });
  assert.match(reply, /The Grand at Penn/);
  assert.match(reply, /virtual maintenance assistant/i);
  assert.match(reply, /How can I help you today/i);
  assert.doesNotMatch(reply, /PENN\b/);
  process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = prev;
});

test("buildGatherGreetingReply — no brand when unknown property", () => {
  const prev = process.env.TENANT_AGENT_PROPERTY_ALLOWLIST;
  process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = "";
  const reply = buildGatherGreetingReply({ propertiesList: PENN_LIST, partial: {} });
  assert.match(reply, /How can I help you today with maintenance/i);
  assert.doesNotMatch(reply, /Grand|PENN|The Grand/i);
  process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = prev;
});

test("inferBrandDisplayName — from partial property slot", () => {
  assert.equal(
    inferBrandDisplayName(PENN_LIST, { property: "PENN" }),
    "The Grand at Penn"
  );
});
