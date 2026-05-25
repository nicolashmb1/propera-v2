"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSameOrNewReply,
  buildSameOrNewPrompt,
  buildSameOrNewReaskPrompt,
  resolveSameOrNewReply,
} = require("../../src/adapters/tenantAgent/sameOrNewClarify");
const {
  setSameOrNewLlmForTests,
  clearSameOrNewLlmForTests,
} = require("../../src/adapters/tenantAgent/sameOrNewLlmClassify");

test("parseSameOrNewReply — natural language same", () => {
  assert.equal(parseSameOrNewReply("yes same one"), "same");
  assert.equal(parseSameOrNewReply("yeah the existing request"), "same");
  assert.equal(parseSameOrNewReply("same request"), "same");
  assert.equal(parseSameOrNewReply("still leaking badly"), "same");
  assert.equal(parseSameOrNewReply("here is another photo"), "same");
});

test("parseSameOrNewReply — natural language new", () => {
  assert.equal(parseSameOrNewReply("no it's a new issue"), "new");
  assert.equal(parseSameOrNewReply("different problem"), "new");
  assert.equal(parseSameOrNewReply("new issue"), "new");
  assert.equal(parseSameOrNewReply("something else"), "new");
  assert.equal(parseSameOrNewReply("nope different"), "new");
});

test("parseSameOrNewReply — legacy numeric still accepted", () => {
  assert.equal(parseSameOrNewReply("1"), "same");
  assert.equal(parseSameOrNewReply("2"), "new");
});

test("buildSameOrNewPrompt — conversational, no numeric menu", () => {
  const p = buildSameOrNewPrompt({
    last_brain_result: {
      brain: "core_finalized",
      finalize: { ticketId: "PENN-010126-99" },
    },
  });
  assert.match(p, /Ref #PENN-010126-99/);
  assert.match(p, /different issue/i);
  assert.doesNotMatch(p, /Reply 1/);
});

test("buildSameOrNewReaskPrompt — conversational re-ask", () => {
  const p = buildSameOrNewReaskPrompt();
  assert.match(p, /existing maintenance request/i);
  assert.doesNotMatch(p, /Reply 1/);
});

test("resolveSameOrNewReply — LLM first when enabled", async () => {
  process.env.TENANT_AGENT_LLM_ENABLED = "1";
  process.env.OPENAI_API_KEY = "test-key";
  setSameOrNewLlmForTests(async () => ({
    choice: "same",
    appendNote: "still leaking badly",
    source: "llm",
  }));
  const r = await resolveSameOrNewReply({
    bodyText: "yep same",
    pendingFollowUp: { bodyText: "still leaking badly", mediaJson: "" },
  });
  assert.equal(r.choice, "same");
  assert.equal(r.appendNote, "still leaking badly");
  assert.equal(r.source, "llm");
  clearSameOrNewLlmForTests();
  delete process.env.TENANT_AGENT_LLM_ENABLED;
  delete process.env.OPENAI_API_KEY;
});

test("resolveSameOrNewReply — heuristics when LLM off", async () => {
  delete process.env.TENANT_AGENT_LLM_ENABLED;
  delete process.env.OPENAI_API_KEY;
  setSameOrNewLlmForTests(async () => {
    throw new Error("LLM should not run");
  });
  const r = await resolveSameOrNewReply({ bodyText: "yes same request" });
  assert.equal(r.choice, "same");
  assert.equal(r.source, "heuristic");
  clearSameOrNewLlmForTests();
});
