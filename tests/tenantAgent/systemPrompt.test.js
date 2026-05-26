"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTenantAgentGatherSystemPrompt,
} = require("../../src/adapters/tenantAgent/systemPrompt");

test("buildTenantAgentGatherSystemPrompt — includes property codes", () => {
  const prompt = buildTenantAgentGatherSystemPrompt([
    { code: "PENN", display_name: "The Grand at Penn" },
  ]);
  assert.match(prompt, /PENN/);
  assert.match(prompt, /Do not invent ticket ids/i);
  assert.match(prompt, /handoff_ready/i);
  assert.match(prompt, /request_intent/i);
  assert.match(prompt, /conversation_signal/i);
  assert.match(prompt, /CONVERSATION AWARENESS/i);
  assert.match(prompt, /front door of my unit/i);
  assert.match(prompt, /building front door/i);
  assert.match(prompt, /radiator \/ boiler \/ heating-system smell/i);
  assert.match(prompt, /radiator bangs, gets very hot, and has a smell/i);
});
