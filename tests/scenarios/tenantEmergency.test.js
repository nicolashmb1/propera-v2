/**
 * Phase 1 — emergency fast path: skip post-finalize schedule ask.
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

describe("scenarios — tenant emergency (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("fire wording one-liner → emergency ticket + receipt without schedule template", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "sc-em-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "303 penn kitchen is on fire",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 1);
    const em = String(mem._state.tickets[0].emergency || "").trim();
    assert.match(em.toLowerCase(), /^yes$/i);
    const reply = String((r.coreRun && r.coreRun.replyText) || "");
    assert.ok(
      !reply.includes("tomorrow morning") && !reply.includes("9am to 12pm"),
      "no pre-filled schedule suggestion in emergency receipt"
    );
    assert.ok(
      r.coreRun.outgate && r.coreRun.outgate.templateKey === "MAINTENANCE_RECEIPT_ONLY",
      "outgate receipt-only for skip-scheduling path"
    );
  });
});
