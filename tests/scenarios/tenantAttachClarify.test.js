/**
 * Phase 1 — unit mismatch → attach_clarify latch; digit "1" resolves attach.
 */
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

describe("scenarios — tenant attach clarify (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("different unit while draft has unit → attach_clarify; then 1 continues intake", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    await runInboundPipeline({
      traceId: "sc-ac-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "PENN 4B kitchen sink is leaking",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });
    await runInboundPipeline({
      traceId: "sc-ac-2",
      transportChannel: "sms",
      routerParameter: {
        Body: "303",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    const r3 = await runInboundPipeline({
      traceId: "sc-ac-3",
      transportChannel: "sms",
      routerParameter: {
        Body: "404 water still leaking from sink",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r3.coreRun && r3.coreRun.brain, "attach_clarify");
    const latch = mem._state.conversation_ctx.find(
      (c) => c.phone_e164 === SCENARIO_TENANT_E164
    );
    assert.ok(latch);
    assert.equal(String(latch.pending_expected || "").toUpperCase(), "ATTACH_CLARIFY");

    const r4 = await runInboundPipeline({
      traceId: "sc-ac-4",
      transportChannel: "sms",
      routerParameter: {
        Body: "1",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.notEqual(r4.coreRun && r4.coreRun.brain, "attach_clarify_repeat");
    const cleared = mem._state.conversation_ctx.find(
      (c) => c.phone_e164 === SCENARIO_TENANT_E164
    );
    assert.ok(
      !cleared || String(cleared.pending_expected || "").toUpperCase() !== "ATTACH_CLARIFY",
      "latch cleared after attach resolution"
    );
  });
});
