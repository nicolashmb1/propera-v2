/**
 * Phase 1 outgate voice — tenant receipt copy on finalize (in-memory).
 */
require("../helpers/legacyPipelineEnv");
process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.INTAKE_COMPILE_TURN = "1";
process.env.INTAKE_LLM_ENABLED = "0";
process.env.OPENAI_API_KEY = "";
process.env.INTAKE_MEDIA_OCR_ENABLED = "0";
process.env.TELEGRAM_OUTBOUND_ENABLED = "0";
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

describe("scenarios — tenant outgate voice (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("routine fast path — Ref #, issue echo, no Ticket logged", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "og-voice-routine",
      transportChannel: "sms",
      routerParameter: {
        Body: "sink leaking 303 penn",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 1);
    const reply = String((r.coreRun && r.coreRun.replyText) || "");
    assert.match(reply, /Ref #/i);
    assert.match(reply, /303/);
    assert.match(reply, /leak/i);
    assert.match(reply, /We'll be in touch/i);
    assert.doesNotMatch(reply, /Ticket logged/i);
    assert.doesNotMatch(reply, /emergency/i);
  });

  test("emergency — differentiated copy, no schedule ask", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "og-voice-em",
      transportChannel: "sms",
      routerParameter: {
        Body: "303 penn kitchen is on fire",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    const reply = String((r.coreRun && r.coreRun.replyText) || "");
    assert.match(reply, /We're treating this as an emergency/i);
    assert.match(reply, /303/);
    assert.match(reply, /fire/i);
    assert.match(reply, /stay safe/i);
    assert.doesNotMatch(reply, /When would be a good time/i);
    assert.doesNotMatch(reply, /Got it/i);
    assert.doesNotMatch(reply, /Ticket logged/i);
    assert.equal(
      r.coreRun.outgate && r.coreRun.outgate.templateKey,
      "MAINTENANCE_RECEIPT_EMERGENCY"
    );
  });

  test("common area — location label, receipt only", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "og-voice-ca",
      transportChannel: "sms",
      routerParameter: {
        Body: "penn lobby light is broken",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    const reply = String((r.coreRun && r.coreRun.replyText) || "");
    assert.match(reply, /Ref #/i);
    assert.match(reply, /lobby|common area|light/i);
    assert.doesNotMatch(reply, /When would be a good time/i);
    assert.doesNotMatch(reply, /Ticket logged/i);
  });

  test("multi-issue — two Ref lines + closing", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "og-voice-multi",
      transportChannel: "sms",
      routerParameter: {
        Body: "303 penn my ice maker is not working and ac does not run",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 2);
    const reply = String((r.coreRun && r.coreRun.replyText) || "");
    assert.match(reply, /Ref #/g);
    assert.match(reply, /Both are being handled/i);
    assert.doesNotMatch(reply, /Ticket logged/i);
    assert.equal(
      r.coreRun.outgate && r.coreRun.outgate.templateKey,
      "MAINTENANCE_RECEIPT_MULTI"
    );
  });
});
