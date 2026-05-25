/**
 * Phase 6 — find_related_ticket after 48h conversation expiry.
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

describe("scenarios — tenant agent find_related Phase 6", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  function seedStaleConversation(mem) {
    const staleAt = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    mem._state.tenant_conversations.push({
      id: "conv-stale-p6",
      tenant_actor_key: SCENARIO_TENANT_E164,
      transport_channel: "sms",
      status: "complete",
      partial_package: {},
      messages: [],
      turn_count: 5,
      active_ticket_key: "tk-old",
      updated_at: staleAt,
      created_at: staleAt,
    });
  }

  test("after TTL — strong match surfaces open ticket, no new ticket", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    seedStaleConversation(mem);
    mem._state.tickets.push({
      ticket_key: "tk-open-sink",
      ticket_id: "PENN-042626-3001",
      property_code: "PENN",
      unit_label: "410",
      message_raw: "Kitchen sink is leaking",
      category: "Plumbing",
      status: "Open",
      tenant_phone_e164: SCENARIO_TENANT_E164,
      assigned_name: "Nick",
      preferred_window: "Tomorrow afternoon",
      updated_at: new Date().toISOString(),
    });
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "p6-strong",
      transportChannel: "sms",
      routerParameter: {
        Body: "My sink is still leaking",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    assert.equal(r.brain, "tenant_agent_find_related_match");
    assert.match(String(r.tenantAgentRun?.replyText || ""), /Ref #PENN-042626-3001/i);
    assert.match(String(r.tenantAgentRun?.replyText || ""), /Nick/i);
    const conv = mem._state.tenant_conversations.find(
      (c) => c.tenant_actor_key === SCENARIO_TENANT_E164
    );
    assert.equal(conv.status, "same_or_new_pending");
    assert.equal(conv.active_ticket_key, "tk-open-sink");
  });

  test("after TTL — no open tickets → gather, no duplicate ticket", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    seedStaleConversation(mem);
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "p6-none",
      transportChannel: "sms",
      routerParameter: {
        Body: "My sink is still leaking",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 0);
    assert.equal(r.brain, "tenant_agent_find_related_no_match");
    const conv = mem._state.tenant_conversations.find(
      (c) => c.tenant_actor_key === SCENARIO_TENANT_E164
    );
    assert.equal(conv.status, "gathering");
  });

  test("after TTL — greeting only skips lookup", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    seedStaleConversation(mem);
    mem._state.tickets.push({
      ticket_key: "tk-open-sink",
      ticket_id: "PENN-042626-3002",
      property_code: "PENN",
      unit_label: "410",
      message_raw: "sink leak",
      status: "Open",
      tenant_phone_e164: SCENARIO_TENANT_E164,
    });
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "p6-hi",
      transportChannel: "sms",
      routerParameter: {
        Body: "Hi",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.brain, "tenant_agent_gather");
    const findEvents = mem._state.event_log.filter(
      (e) => e.event === "TENANT_FIND_RELATED_TICKET"
    );
    assert.equal(findEvents.length, 0);
  });
});
