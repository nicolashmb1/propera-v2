/**
 * Tenant Agent Sprint 1 — deterministic gather + structured handoff → one ticket + receipt.
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

describe("scenarios — tenant agent handoff (Sprint 1)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("single message — fast gather complete → core_finalized + Ref receipt", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-handoff-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "penn 410 heat not working asap",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.ok(r.coreRun, "handoff reaches core");
    assert.equal(r.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 1);
    assert.match(String(r.coreRun.replyText || ""), /Ref #/);
    assert.doesNotMatch(String(r.coreRun.replyText || ""), /Ticket logged:/i);
    assert.match(String(mem._state.tickets[0].preferred_window || ""), /asap/i);
    assert.equal(String(mem._state.tickets[0].category || "").trim(), "HVAC");

    const conv = mem._state.tenant_conversations.find(
      (c) => c.tenant_actor_key === SCENARIO_TENANT_E164
    );
    assert.ok(conv, "conversation row persisted");
    assert.ok(
      conv.status === "handoff_done" || conv.status === "complete",
      "post-finalize conversation status"
    );
  });

  test("gather includes schedule on ticket — no second schedule ask", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-sch-gather",
      transportChannel: "sms",
      routerParameter: {
        Body: "penn 410 heat not working asap",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    assert.match(String(mem._state.tickets[0].preferred_window || ""), /asap/i);
    assert.doesNotMatch(String(r.coreRun.replyText || ""), /When would be a good time/i);
  });

  test("multi-turn gather — issue then property+unit → one ticket", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r1 = await runInboundPipeline({
      traceId: "ta-gather-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "heat not working",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r1.brain, "tenant_agent_gather");
    assert.equal(mem._state.tickets.length, 0);
    assert.match(String(r1.channelRenderedBody || r1.json?.outbound?.body || ""), /building/i);

    const r2 = await runInboundPipeline({
      traceId: "ta-gather-2",
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
  });

  test("TENANT_AGENT_ENABLED=0 — legacy path unchanged (no conversation row)", async () => {
    process.env.TENANT_AGENT_ENABLED = "0";
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    delete require.cache[PIPELINE];
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-legacy-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "penn 410 heat not working asap",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    process.env.TENANT_AGENT_ENABLED = "1";

    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tenant_conversations.length, 0);
  });

  test("post-handoff thanks — ack only, no new gather", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    mem._state.tenant_conversations.push({
      id: "conv-post-1",
      tenant_actor_key: SCENARIO_TENANT_E164,
      transport_channel: "sms",
      status: "handoff_done",
      partial_package: {},
      messages: [],
      turn_count: 4,
      max_turns: 12,
      tenant_locale: "en",
      active_ticket_key: "ticket-uuid-1",
      last_brain_result: { brain: "core_finalized" },
    });
    setSupabaseClientForTests(mem);
    delete require.cache[PIPELINE];
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-post-thanks",
      transportChannel: "sms",
      routerParameter: {
        Body: "Awesome thanks",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.brain, "tenant_agent_post_handoff");
    assert.equal(mem._state.tickets.length, 0);
    assert.doesNotMatch(String(r.tenantAgentRun?.replyText || ""), /unit number/i);
    assert.match(String(r.tenantAgentRun?.replyText || ""), /welcome!/i);
    const conv = mem._state.tenant_conversations.find(
      (c) => c.tenant_actor_key === SCENARIO_TENANT_E164
    );
    assert.ok(conv.status === "handoff_done" || conv.status === "complete");
  });

  test("gather greeting — intro with DB display name when pilot is one property", async () => {
    process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = "PENN";
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    delete require.cache[PIPELINE];
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "ta-greet-hi",
      transportChannel: "telegram",
      routerParameter: {
        Body: "Hi",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
        _telegramChatId: "999001",
        _channel: "TELEGRAM",
      },
      telegramSignal: {
        channel: "telegram",
        transport: { chat_id: "999001", telegram_user_id: "999001", update_id: "1" },
      },
    });

    process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = "";

    assert.equal(r.brain, "tenant_agent_gather");
    const reply = String(r.tenantAgentRun?.replyText || "");
    assert.match(reply, /virtual maintenance assistant/i);
    assert.match(reply, /How can I help you today/i);
    assert.equal(mem._state.tickets.length, 0);
  });
});
