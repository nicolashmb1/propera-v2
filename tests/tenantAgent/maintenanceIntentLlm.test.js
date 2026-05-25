/**
 * LLM maintenance intent classification (mocked).
 */
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyMaintenanceIntentWithLlm,
  normalizeMaintenanceIntentLlmResult,
  setMaintenanceIntentLlmForTests,
  clearMaintenanceIntentLlmForTests,
} = require("../../src/adapters/tenantAgent/classifyMaintenanceIntentWithLlm");
const { resolveMaintenanceIntentForTurn } = require("../../src/adapters/tenantAgent/resolveMaintenanceIntentForTurn");

describe("normalizeMaintenanceIntentLlmResult", () => {
  test("maps non_maintenance aliases", () => {
    assert.deepEqual(normalizeMaintenanceIntentLlmResult({ intent: "building_question" }), {
      intent: "non_maintenance",
      reason: "",
    });
  });

  test("maps maintenance_repair aliases", () => {
    assert.deepEqual(normalizeMaintenanceIntentLlmResult({ intent: "maintenance_intake" }), {
      intent: "maintenance_repair",
      reason: "",
    });
  });
});

describe("classifyMaintenanceIntentWithLlm", () => {
  beforeEach(() => clearMaintenanceIntentLlmForTests());
  afterEach(() => clearMaintenanceIntentLlmForTests());

  test("cleaning schedule — non_maintenance via mock", async () => {
    setMaintenanceIntentLlmForTests(async () => ({
      intent: "non_maintenance",
      reason: "janitorial schedule inquiry",
      source: "llm",
    }));
    const r = await classifyMaintenanceIntentWithLlm({
      bodyText: "when is the cleaning guy coming to the building?",
    });
    assert.equal(r.intent, "non_maintenance");
    assert.equal(r.source, "llm");
  });
});

describe("resolveMaintenanceIntentForTurn", () => {
  beforeEach(() => clearMaintenanceIntentLlmForTests());
  afterEach(() => clearMaintenanceIntentLlmForTests());

  test("regex invoice still wins without LLM", async () => {
    const r = await resolveMaintenanceIntentForTurn({
      bodyText: "can i get a copy of my invoice?",
      conv: null,
      partial: {},
    });
    assert.equal(r.intent, "non_maintenance");
    assert.equal(r.source, "regex_body");
  });

  test("LLM classifies cleaning schedule when regex misses", async () => {
    process.env.TENANT_AGENT_LLM_ENABLED = "1";
    process.env.OPENAI_API_KEY = "test-key";
    setMaintenanceIntentLlmForTests(async () => ({
      intent: "non_maintenance",
      reason: "cleaning schedule",
      source: "llm",
    }));
    const r = await resolveMaintenanceIntentForTurn({
      bodyText: "hi. when is the cleaning guy coming to the building?",
      conv: { status: "gathering", messages: [] },
      partial: {},
      traceId: "t1",
    });
    assert.equal(r.intent, "non_maintenance");
    assert.equal(r.source, "llm");
    delete process.env.TENANT_AGENT_LLM_ENABLED;
    delete process.env.OPENAI_API_KEY;
  });

  test("active maintenance gather skips LLM deflect path", async () => {
    setMaintenanceIntentLlmForTests(async () => {
      throw new Error("LLM should not run");
    });
    const r = await resolveMaintenanceIntentForTurn({
      bodyText: "still no heat in 502",
      conv: { status: "gathering", messages: [] },
      partial: { issue: "heat out" },
    });
    assert.equal(r.intent, "maintenance_repair");
    assert.equal(r.source, "regex_active_gather");
  });

  test("elevator odor cleaning — regex repair wins over LLM non_maintenance", async () => {
    process.env.TENANT_AGENT_LLM_ENABLED = "1";
    process.env.OPENAI_API_KEY = "test-key";
    setMaintenanceIntentLlmForTests(async () => ({
      intent: "non_maintenance",
      reason: "cleaning service",
      source: "llm",
    }));
    const msg = "Can u send someone to clean this elevator . It's smelling pretty bad";
    const r = await resolveMaintenanceIntentForTurn({
      bodyText: msg,
      conv: null,
      partial: {},
      traceId: "t-elev",
    });
    assert.equal(r.intent, "maintenance_repair");
    assert.equal(r.source, "regex_repair_signal");
    delete process.env.TENANT_AGENT_LLM_ENABLED;
    delete process.env.OPENAI_API_KEY;
  });
});
