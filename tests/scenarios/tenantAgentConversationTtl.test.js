/**
 * Tenant Agent — 48h conversation TTL (lazy expiry on inbound).
 */
process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.TENANT_AGENT_ENABLED = "1";
process.env.TENANT_AGENT_LLM_ENABLED = "0";
process.env.TENANT_AGENT_CONVERSATION_TTL_HOURS = "48";
process.env.INTAKE_COMPILE_TURN = "1";
process.env.INTAKE_LLM_ENABLED = "0";
process.env.OPENAI_API_KEY = "";
process.env.STRUCTURED_LOG = "0";
process.env.OUTGATE_CHANNEL_RENDER = "0";

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

describe("scenarios — tenant agent conversation TTL", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("stale row — deleted, event logged, fresh gather on Hi", async () => {
    const staleAt = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    mem._state.tenant_conversations.push({
      id: "conv-stale-1",
      tenant_actor_key: SCENARIO_TENANT_E164,
      transport_channel: "sms",
      status: "handoff_done",
      partial_package: { property: "PENN", unit: "403", issue: "clog" },
      messages: [{ role: "user", content: "old", at: staleAt }],
      turn_count: 5,
      max_turns: 12,
      tenant_locale: "en",
      active_ticket_key: "ticket-old",
      updated_at: staleAt,
      created_at: staleAt,
    });
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-ttl-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "Hi",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tenant_conversations.length, 1);
    const conv = mem._state.tenant_conversations[0];
    assert.notEqual(conv.id, "conv-stale-1");
    assert.equal(conv.status, "gathering");
    assert.deepEqual(conv.partial_package, {});
    assert.equal(r.brain, "tenant_agent_gather");

    const expired = mem._state.event_log.filter(
      (e) => e.event === "TENANT_AGENT_CONVERSATION_EXPIRED"
    );
    assert.equal(expired.length, 1);
    assert.equal(expired[0].payload.active_ticket_key, "ticket-old");
    assert.equal(expired[0].payload.partial_summary.property, "PENN");
  });
});
