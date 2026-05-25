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
});
