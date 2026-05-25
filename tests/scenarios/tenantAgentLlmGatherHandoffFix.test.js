/**
 * LLM gather — explicit slots only; no roster auto-fill; handoff when complete.
 */
process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.TENANT_AGENT_ENABLED = "1";
process.env.TENANT_AGENT_LLM_ENABLED = "1";
process.env.INTAKE_COMPILE_TURN = "1";
process.env.INTAKE_LLM_ENABLED = "0";
process.env.OPENAI_API_KEY = "test-llm-key";
process.env.INTAKE_MEDIA_OCR_ENABLED = "0";
process.env.TELEGRAM_OUTBOUND_ENABLED = "0";
process.env.OUTGATE_CHANNEL_RENDER = "0";
process.env.PROPERA_TZ = "America/New_York";
process.env.STRUCTURED_LOG = "0";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  createScenarioMemorySupabase,
  scenarioMaintenanceSeedPenn,
  SCENARIO_TENANT_E164,
} = require("../helpers/memorySupabaseScenario");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../../src/db/supabase");
const {
  setTenantAgentLlmForTests,
  clearTenantAgentLlmForTests,
} = require("../../src/adapters/tenantAgent");

const PIPELINE = require.resolve("../../src/inbound/runInboundPipeline.js");

describe("scenarios — tenant agent LLM gather handoff fix", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    clearTenantAgentLlmForTests();
    delete require.cache[PIPELINE];
  });

  test("unit+issue only, LLM fake handoff — asks building, no ticket", async () => {
    setTenantAgentLlmForTests(async () => ({
      ok: true,
      reply:
        "Thank you! I'll pass this along for maintenance. Is there a preferred time for them to come by?",
      partialUpdates: { unit: "502", issue: "front door not locking" },
      handoffReady: true,
      err: "",
    }));

    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-llm-fake-handoff",
      transportChannel: "sms",
      routerParameter: {
        Body: "502. My front door is not locking",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 0);
    assert.equal(r.brain, "tenant_agent_gather");
    assert.match(String(r.tenantAgentRun?.replyText || ""), /building/i);
    assert.doesNotMatch(String(r.tenantAgentRun?.replyText || ""), /pass this along/i);
  });

  test("all slots in messages — handoff + ticket (no roster)", async () => {
    setTenantAgentLlmForTests(async () => ({
      ok: true,
      reply: "Thanks — logging that now.",
      partialUpdates: {
        property: "PENN",
        unit: "502",
        issue: "front door not locking",
        preferredWindow: "asap",
      },
      handoffReady: true,
      err: "",
    }));

    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-llm-full-handoff",
      transportChannel: "telegram",
      routerParameter: {
        Body: "Penn 502 front door not locking asap",
        From: "TG:9988776655",
        _phoneE164: "TG:9988776655",
        _canonicalBrainActorKey: "TG:9988776655",
        _telegramChatId: "9988776655",
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    assert.equal(r.coreRun?.brain, "core_finalized");
    assert.match(String(mem._state.tickets[0].tenant_phone_e164 || ""), /^TG:/);
  });
});
