/**
 * Phase 4 — post-complete clarify: same/new before append; no media-only auto-attach.
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

function seedCompleteConversation(mem, ticketKey) {
  mem._state.tenant_conversations.push({
    id: "conv-p4-1",
    tenant_actor_key: SCENARIO_TENANT_E164,
    transport_channel: "sms",
    status: "complete",
    partial_package: {},
    messages: [],
    turn_count: 5,
    max_turns: 12,
    tenant_locale: "en",
    active_ticket_key: ticketKey,
    last_brain_result: {
      brain: "core_finalized",
      finalize: { ticketKey, ticketId: mem._state.tickets[0]?.ticket_id || "PENN-TEST-1" },
    },
    updated_at: new Date().toISOString(),
  });
}

describe("scenarios — tenant agent post-complete Phase 4", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("photo-only after complete — same/new ask, no second ticket", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    await runInboundPipeline({
      traceId: "p4-create",
      transportChannel: "sms",
      routerParameter: {
        Body: "410 penn kitchen sink is leaking",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    const ticketKey = mem._state.tickets[0].ticket_key;
    const conv0 = mem._state.tenant_conversations.find(
      (c) => c.tenant_actor_key === SCENARIO_TENANT_E164
    );
    assert.ok(conv0);
    conv0.status = "complete";
    conv0.active_ticket_key = ticketKey;
    mem._state.intake_sessions = (mem._state.intake_sessions || []).filter(
      (s) => String(s.phone_e164 || "") !== SCENARIO_TENANT_E164
    );

    const r = await runInboundPipeline({
      traceId: "p4-photo",
      transportChannel: "sms",
      routerParameter: {
        Body: "",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
        _mediaJson: JSON.stringify([
          { kind: "image", url: "https://cdn.example.com/sink-leak.jpg" },
        ]),
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    assert.equal(r.brain, "tenant_agent_post_complete_clarify");
    assert.match(String(r.tenantAgentRun?.replyText || r.json?.outbound?.body || ""), /different issue|maintenance request/i);
    const conv = mem._state.tenant_conversations.find(
      (c) => c.tenant_actor_key === SCENARIO_TENANT_E164
    );
    assert.equal(conv.status, "same_or_new_pending");
    assert.ok(conv.partial_package._follow_up_pending);
  });

  test("here is the sink photo — asks same/new before brain", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    mem._state.tickets.push({
      ticket_key: "tk-p4-2",
      ticket_id: "PENN-042626-2001",
      property_code: "PENN",
      unit_label: "410",
      message_raw: "sink leaking",
      category: "Plumbing",
      status: "Open",
      tenant_phone_e164: SCENARIO_TENANT_E164,
      attachments: "",
      service_notes: "",
    });
    seedCompleteConversation(mem, "tk-p4-2");
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "p4-sink-photo-text",
      transportChannel: "sms",
      routerParameter: {
        Body: "here is the sink photo",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    assert.equal(r.brain, "tenant_agent_post_complete_clarify");
    assert.ok(!r.coreRun);
  });

  test("yep same after photo clarify — append uses photo not confirm text", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    const media = JSON.stringify([{ url: "https://cdn.example.com/sink-leak.jpg" }]);
    mem._state.tickets.push({
      ticket_key: "tk-p4-photo",
      ticket_id: "PENN-042626-2010",
      property_code: "PENN",
      unit_label: "410",
      message_raw: "sink leaking",
      category: "Plumbing",
      status: "Open",
      tenant_phone_e164: SCENARIO_TENANT_E164,
      attachments: "",
      service_notes: "",
    });
    mem._state.tenant_conversations.push({
      id: "conv-p4-photo",
      tenant_actor_key: SCENARIO_TENANT_E164,
      transport_channel: "sms",
      status: "same_or_new_pending",
      partial_package: {
        _follow_up_pending: { bodyText: "", mediaJson: media },
      },
      messages: [],
      turn_count: 6,
      active_ticket_key: "tk-p4-photo",
      last_brain_result: {
        brain: "core_finalized",
        finalize: { ticketKey: "tk-p4-photo", ticketId: "PENN-042626-2010" },
      },
      updated_at: new Date().toISOString(),
    });
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "p4-yep-same-photo",
      transportChannel: "sms",
      routerParameter: {
        Body: "yep same",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.coreRun?.brain, "tenant_append_to_ticket");
    assert.ok(!String(mem._state.tickets[0].service_notes || "").toLowerCase().includes("yep same"));
    assert.ok(String(mem._state.tickets[0].attachments || "").includes("sink-leak.jpg"));
  });

  test("natural language same after clarify — append to same ticket", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    mem._state.tickets.push({
      ticket_key: "tk-p4-3",
      ticket_id: "PENN-042626-2002",
      property_code: "PENN",
      unit_label: "410",
      message_raw: "sink leaking",
      category: "Plumbing",
      status: "Open",
      tenant_phone_e164: SCENARIO_TENANT_E164,
      attachments: "",
      service_notes: "",
    });
    mem._state.tenant_conversations.push({
      id: "conv-p4-3",
      tenant_actor_key: SCENARIO_TENANT_E164,
      transport_channel: "sms",
      status: "same_or_new_pending",
      partial_package: {
        _follow_up_pending: {
          bodyText: "still leaking badly",
          mediaJson: "",
        },
      },
      messages: [],
      turn_count: 6,
      max_turns: 12,
      tenant_locale: "en",
      active_ticket_key: "tk-p4-3",
      last_brain_result: {
        brain: "core_finalized",
        finalize: { ticketKey: "tk-p4-3", ticketId: "PENN-042626-2002" },
      },
      updated_at: new Date().toISOString(),
    });
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "p4-append-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "yep same",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    assert.equal(r.coreRun?.brain, "tenant_append_to_ticket");
    assert.match(String(r.coreRun?.replyText || ""), /added that to/i);
    assert.ok(String(mem._state.tickets[0].service_notes || "").includes("still leaking"));
    assert.ok(!String(mem._state.tickets[0].service_notes || "").toLowerCase().includes("yep same"));
    const conv = mem._state.tenant_conversations.find(
      (c) => c.tenant_actor_key === SCENARIO_TENANT_E164
    );
    assert.equal(conv.status, "complete");
  });

  test("natural language new after clarify — starts new gather", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    mem._state.tickets.push({
      ticket_key: "tk-p4-4",
      ticket_id: "PENN-042626-2003",
      property_code: "PENN",
      unit_label: "410",
      message_raw: "sink leaking",
      status: "Open",
      tenant_phone_e164: SCENARIO_TENANT_E164,
    });
    mem._state.tenant_conversations.push({
      id: "conv-p4-4",
      tenant_actor_key: SCENARIO_TENANT_E164,
      transport_channel: "sms",
      status: "same_or_new_pending",
      partial_package: {
        _follow_up_pending: { bodyText: "bedroom door broken", mediaJson: "" },
      },
      messages: [],
      turn_count: 6,
      active_ticket_key: "tk-p4-4",
      last_brain_result: { brain: "core_finalized" },
      updated_at: new Date().toISOString(),
    });
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "p4-new-2",
      transportChannel: "sms",
      routerParameter: {
        Body: "no it's a new issue",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    assert.equal(r.brain, "tenant_agent_gather");
    const conv = mem._state.tenant_conversations.find(
      (c) => c.tenant_actor_key === SCENARIO_TENANT_E164
    );
    assert.equal(conv.status, "gathering");
  });

  test("new issue explicit — new gather without same/new ask", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    seedCompleteConversation(mem, "tk-p4-5");
    mem._state.tickets.push({
      ticket_key: "tk-p4-5",
      ticket_id: "PENN-042626-2004",
      property_code: "PENN",
      unit_label: "410",
      message_raw: "sink",
      status: "Open",
      tenant_phone_e164: SCENARIO_TENANT_E164,
    });
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "p4-new-explicit",
      transportChannel: "sms",
      routerParameter: {
        Body: "New issue my bedroom door is broken",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.brain, "tenant_agent_gather");
    assert.equal(mem._state.tickets.length, 1);
    assert.ok(!r.coreRun);
  });

  test("ambiguous reply after clarify — re-asks in natural language", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    mem._state.tickets.push({
      ticket_key: "tk-p4-ambig",
      ticket_id: "PENN-042626-2005",
      property_code: "PENN",
      unit_label: "410",
      message_raw: "sink leaking",
      status: "Open",
      tenant_phone_e164: SCENARIO_TENANT_E164,
      attachments: "",
      service_notes: "",
    });
    mem._state.tenant_conversations.push({
      id: "conv-p4-ambig",
      tenant_actor_key: SCENARIO_TENANT_E164,
      transport_channel: "sms",
      status: "same_or_new_pending",
      partial_package: {
        _follow_up_pending: { bodyText: "still leaking", mediaJson: "" },
      },
      messages: [],
      turn_count: 6,
      active_ticket_key: "tk-p4-ambig",
      last_brain_result: { brain: "core_finalized" },
      updated_at: new Date().toISOString(),
    });
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "p4-ambig",
      transportChannel: "sms",
      routerParameter: {
        Body: "hmm not sure",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    assert.equal(r.brain, "tenant_agent_post_complete_clarify");
    const reply = String(r.tenantAgentRun?.replyText || r.json?.outbound?.body || "");
    assert.match(reply, /existing maintenance request|something new/i);
    assert.doesNotMatch(reply, /Reply 1/);
  });
});
