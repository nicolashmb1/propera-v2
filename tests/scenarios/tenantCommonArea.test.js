/**
 * Phase 1 — COMMON_AREA intake: no unit, skip tenant schedule ask after finalize.
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

describe("scenarios — tenant common area (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("lobby issue one-liner → finalized ticket with COMMON_AREA + receipt only", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "sc-ca-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "penn lobby light is broken",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 1);
    const t = mem._state.tickets[0];
    assert.equal(String(t.location_type || "").toUpperCase(), "COMMON_AREA");
    assert.equal(String(t.unit_label || "").trim(), "");
    const reply = String((r.coreRun && r.coreRun.replyText) || "");
    assert.ok(
      !/\bpreferred time\b/i.test(reply) && !/\bwhen can\b/i.test(reply),
      "no tenant schedule prompt after common-area finalize"
    );
  });
});
