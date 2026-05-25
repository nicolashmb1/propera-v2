/**
 * Tenant Agent Sprint 3 — shaped receipt, channel render hooks, property allowlist.
 */
process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.TENANT_AGENT_ENABLED = "1";
process.env.TENANT_AGENT_LLM_ENABLED = "0";
process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = "PENN";
process.env.INTAKE_COMPILE_TURN = "1";
process.env.INTAKE_LLM_ENABLED = "0";
process.env.OPENAI_API_KEY = "";
process.env.INTAKE_MEDIA_OCR_ENABLED = "0";
process.env.TELEGRAM_OUTBOUND_ENABLED = "0";
process.env.OUTGATE_CHANNEL_RENDER = "1";
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

const PIPELINE = require.resolve("../../src/inbound/runInboundPipeline.js");

describe("scenarios — tenant agent Sprint 3", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
    process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = "PENN";
  });

  test("handoff — shaped Ref receipt + SMS footer on first contact", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-s3-receipt",
      transportChannel: "sms",
      routerParameter: {
        Body: "410 penn heat not working",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    assert.match(String(r.coreRun.replyText || ""), /Ref #/);
    assert.doesNotMatch(String(r.coreRun.replyText || ""), /Ticket logged/i);
    const body = String(r.channelRenderedBody || "");
    assert.match(body, /Reply STOP to opt out/i);
  });

  test("gather on telegram — no receipt markdown on conversational prompt", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-s3-gather-tg",
      transportChannel: "telegram",
      routerParameter: {
        Body: "heat not working",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.brain, "tenant_agent_gather");
    const body = String(r.channelRenderedBody || "");
    assert.ok(body.length > 0);
    assert.doesNotMatch(body, /\*Ref #/);
  });

  test("non-pilot property — falls through to legacy core (no agent ticket)", async () => {
    process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = "DEMO";
    delete require.cache[PIPELINE];
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-s3-allowlist",
      transportChannel: "sms",
      routerParameter: {
        Body: "410 penn heat not working",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 1);
    const closed = mem._state.tenant_conversations.find(
      (c) => c.tenant_actor_key === SCENARIO_TENANT_E164
    );
    assert.ok(closed, "agent conversation closed after pilot miss");
    assert.equal(closed.status, "closed");
  });
});
