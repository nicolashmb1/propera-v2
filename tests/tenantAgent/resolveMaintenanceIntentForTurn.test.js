const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  setMaintenanceIntentLlmForTests,
  clearMaintenanceIntentLlmForTests,
} = require("../../src/adapters/tenantAgent/classifyMaintenanceIntentWithLlm");
const {
  resolveMaintenanceIntentForTurn,
} = require("../../src/adapters/tenantAgent/resolveMaintenanceIntentForTurn");

describe("resolveMaintenanceIntentForTurn", () => {
  after(() => {
    clearMaintenanceIntentLlmForTests();
  });

  it("honors LLM unclear for wassup — does not default to maintenance_repair", async () => {
    setMaintenanceIntentLlmForTests(async () => ({
      intent: "unclear",
      reason: "greeting only",
      source: "llm",
    }));
    const r = await resolveMaintenanceIntentForTurn({
      bodyText: "wassup my brother",
      conv: null,
      partial: {},
    });
    assert.equal(r.intent, "unclear");
    assert.notEqual(r.source, "default_gather");
  });

  it("honors LLM maintenance_repair for real issues", async () => {
    setMaintenanceIntentLlmForTests(async () => ({
      intent: "maintenance_repair",
      reason: "sink leak",
      source: "llm",
    }));
    const r = await resolveMaintenanceIntentForTurn({
      bodyText: "slow drip under the kitchen sink",
      conv: null,
      partial: {},
    });
    assert.equal(r.intent, "maintenance_repair");
  });

  it("regex greeting when LLM off", async () => {
    clearMaintenanceIntentLlmForTests();
    const prev = process.env.TENANT_AGENT_LLM_ENABLED;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.TENANT_AGENT_LLM_ENABLED = "0";
    process.env.OPENAI_API_KEY = "";
    const r = await resolveMaintenanceIntentForTurn({
      bodyText: "wassup my brother",
      conv: null,
      partial: {},
    });
    assert.equal(r.intent, "unclear");
    assert.equal(r.source, "regex_greeting");
    process.env.TENANT_AGENT_LLM_ENABLED = prev;
    process.env.OPENAI_API_KEY = prevKey;
  });
});
