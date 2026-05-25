/**
 * Tenant Agent Sprint 2 — LLM gather (mocked) + rules-based handoff confirm.
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

describe("scenarios — tenant agent LLM gather (Sprint 2)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    clearTenantAgentLlmForTests();
    delete require.cache[PIPELINE];
  });

  test("LLM gather turn 1 — asks building (deterministic), no ticket", async () => {
    setTenantAgentLlmForTests(async () => ({
      ok: true,
      reply: "Sorry about the heat — I'll pass this along once I know your building.",
      partialUpdates: { issue: "heat not working" },
      handoffReady: false,
      tenantLocale: "en",
      err: "",
    }));

    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-llm-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "heat not working",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.brain, "tenant_agent_gather");
    assert.equal(mem._state.tickets.length, 0);
    assert.match(
      String(r.channelRenderedBody || r.json?.outbound?.body || ""),
      /building/i
    );

    const conv = mem._state.tenant_conversations[0];
    assert.ok(conv);
    assert.equal(String(conv.partial_package.issue || ""), "heat not working");
  });

  test("LLM gather turn 2 — slots complete → handoff + ticket", async () => {
    let call = 0;
    setTenantAgentLlmForTests(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          reply: "Which building?",
          partialUpdates: { issue: "heat not working" },
          handoffReady: false,
          err: "",
        };
      }
      return {
        ok: true,
        reply: "Thanks — logging that now.",
        partialUpdates: { property: "PENN", unit: "410", preferredWindow: "tomorrow morning" },
        handoffReady: true,
        err: "",
      };
    });

    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    await runInboundPipeline({
      traceId: "ta-llm-2a",
      transportChannel: "sms",
      routerParameter: {
        Body: "heat not working",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    const r2 = await runInboundPipeline({
      traceId: "ta-llm-2b",
      transportChannel: "sms",
      routerParameter: {
        Body: "penn 410 tomorrow morning",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.ok(r2.coreRun);
    assert.equal(r2.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 1);
    assert.match(String(r2.coreRun.replyText || ""), /Ref #/);
  });

  test("LLM failure — falls back to deterministic prompt", async () => {
    setTenantAgentLlmForTests(async () => ({
      ok: false,
      err: "mocked_fail",
    }));

    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-llm-fail",
      transportChannel: "sms",
      routerParameter: {
        Body: "heat not working",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.brain, "tenant_agent_gather");
    assert.match(
      String(r.channelRenderedBody || r.json?.outbound?.body || ""),
      /building/i
    );
    const failed = mem._state.event_log.find((e) => e.event === "TENANT_AGENT_LLM_FAILED");
    assert.ok(failed, "logs LLM failure");
  });

  test("LLM handoff_ready ignored when completeness rules fail", async () => {
    setTenantAgentLlmForTests(async () => ({
      ok: true,
      reply: "I'll get that logged.",
      partialUpdates: { issue: "heat not working" },
      handoffReady: true,
      err: "",
    }));

    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-llm-premature",
      transportChannel: "sms",
      routerParameter: {
        Body: "heat not working",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.brain, "tenant_agent_gather");
    assert.equal(mem._state.tickets.length, 0);
  });
});
