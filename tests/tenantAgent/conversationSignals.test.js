/**
 * Conversation signal handling.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectConversationSignalRules,
  shouldApplyConversationSignal,
  normalizeConversationSignal,
} = require("../../src/adapters/tenantAgent/handleConversationSignals");
const { resolveGatherReply } = require("../../src/adapters/tenantAgent/resolveGatherReply");

describe("handleConversationSignals", () => {
  test("ok thank you — closing", () => {
    assert.equal(detectConversationSignalRules({ bodyText: "ok thank you." }), "closing");
  });

  test("normalize LLM signal", () => {
    assert.equal(normalizeConversationSignal("done"), "closing");
    assert.equal(normalizeConversationSignal("confusion"), "confused");
  });

  test("applies on closed conv", () => {
    assert.equal(
      shouldApplyConversationSignal({
        conv: { status: "closed", partial_package: {} },
      }),
      true
    );
  });

  test("what you mean — confused tenant", () => {
    assert.equal(detectConversationSignalRules({ bodyText: "what you mean?" }), "confused");
  });

  test("applies confused gather without property", () => {
    assert.equal(
      shouldApplyConversationSignal({
        bodyText: "what you mean?",
        conv: {
          status: "gathering",
          partial_package: { issue: "Request for clarification on a previous message." },
        },
      }),
      true
    );
  });
});

describe("resolveGatherReply", () => {
  test("uses LLM reply for unit slot", () => {
    const reply = resolveGatherReply({
      llmGatherReply: "Got it — what's your unit number at Penn?",
      complete: { ready: false, missing: "unit" },
      partial: { property: "PENN" },
    });
    assert.match(reply, /unit number at Penn/i);
  });

  test("forces property prompt when property missing", () => {
    const reply = resolveGatherReply({
      llmGatherReply: "Tell me more about the icemaker issue.",
      complete: { ready: false, missing: "property" },
      partial: {},
      propertiesList: [{ code: "PENN", display_name: "Penn" }],
    });
    assert.match(reply, /building/i);
  });

  test("whatsup — greeting not building ask", () => {
    const reply = resolveGatherReply({
      complete: { ready: false, missing: "property" },
      partial: {},
      bodyText: "whatsup",
      propertiesList: [],
    });
    assert.match(reply, /How can I help you today/i);
    assert.doesNotMatch(reply, /Which building/i);
  });

  test("what you mean — confusion reset", () => {
    const reply = resolveGatherReply({
      complete: { ready: false, missing: "property" },
      partial: {},
      bodyText: "what you mean?",
    });
    assert.match(reply, /Sorry if that was unclear/i);
  });
});
