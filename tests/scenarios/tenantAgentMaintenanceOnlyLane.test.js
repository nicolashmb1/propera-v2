/**
 * Tenant Agent — maintenance-only lane deflects non-maintenance to staff contact.
 */
process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.TENANT_AGENT_ENABLED = "1";
process.env.TENANT_AGENT_LLM_ENABLED = "0";
process.env.INTAKE_COMPILE_TURN = "1";
process.env.INTAKE_LLM_ENABLED = "0";
process.env.OPENAI_API_KEY = "";
process.env.INTAKE_MEDIA_OCR_ENABLED = "0";
process.env.TELEGRAM_OUTBOUND_ENABLED = "0";
process.env.OUTGATE_CHANNEL_RENDER = "0";
process.env.PROPERA_TZ = "America/New_York";
process.env.STRUCTURED_LOG = "0";
process.env.COMM_MAIN_NUMBER_DISPLAY = "+19085550100";

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

const PIPELINE = require.resolve("../../src/inbound/runInboundPipeline.js");

describe("scenarios — tenant agent maintenance-only lane", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("lease copy — deflect, no ticket", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-nonmaint-lease",
      transportChannel: "sms",
      routerParameter: {
        Body: "Need a copy of the lease?",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 0);
    assert.equal(r.tenantAgentRun && r.tenantAgentRun.brain, "tenant_agent_non_maintenance_deflect");
    assert.match(String(r.tenantAgentRun.replyText || ""), /only help with maintenance intake/i);
    assert.match(String(r.tenantAgentRun.replyText || ""), /\(908\) 555-0100/);

    const conv = mem._state.tenant_conversations.find(
      (c) => c.tenant_actor_key === SCENARIO_TENANT_E164
    );
    assert.ok(conv);
    assert.equal(conv.status, "closed");
  });

  test("gameroom reserve — deflect, no ticket", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-nonmaint-game",
      transportChannel: "sms",
      routerParameter: {
        Body: "Can I reserve the gameroom?",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 0);
    assert.equal(r.tenantAgentRun && r.tenantAgentRun.brain, "tenant_agent_non_maintenance_deflect");
    assert.match(String(r.tenantAgentRun.replyText || ""), /contact the office/i);
  });

  test("maintenance issue — still gathers normally", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-nonmaint-heat",
      transportChannel: "sms",
      routerParameter: {
        Body: "penn 410 heat not working asap",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
  });
});
