"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolvePostCompleteFollowUpIntent,
} = require("../../src/adapters/tenantAgent/resolvePostCompleteFollowUpIntent");
const {
  setPostCompleteFollowUpLlmForTests,
  clearPostCompleteFollowUpLlmForTests,
} = require("../../src/adapters/tenantAgent/classifyPostCompleteFollowUpWithLlm");

test.afterEach(() => {
  clearPostCompleteFollowUpLlmForTests();
});

test("resolvePostCompleteFollowUpIntent — structural schedule on open ticket", async () => {
  const r = await resolvePostCompleteFollowUpIntent({
    bodyText: "9-10 brow tomorrow morning",
    activeTicketKey: "tk-3944",
    recentMessages: [],
    mediaItems: [],
  });
  assert.equal(r.intent, "schedule_update");
  assert.equal(r.source, "schedule_shape");
});

test("resolvePostCompleteFollowUpIntent — LLM schedule_update with window extract", async () => {
  setPostCompleteFollowUpLlmForTests(async () => ({
    intent: "schedule_update",
    preferredWindow: "tomorrow morning 8-10am",
    source: "llm",
  }));
  const r = await resolvePostCompleteFollowUpIntent({
    bodyText: "could they come earlier in the day than we booked?",
    activeTicketKey: "tk-3944",
    recentMessages: [{ role: "assistant", content: "Ticket #3944 opened." }],
    mediaItems: [],
  });
  assert.equal(r.intent, "schedule_update");
  assert.equal(r.preferredWindow, "tomorrow morning 8-10am");
  assert.equal(r.source, "llm");
});
