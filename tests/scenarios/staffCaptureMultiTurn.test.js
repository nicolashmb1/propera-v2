/**
 * Phase 1 — staff `#` capture: property reply then unit reply share one draft row.
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
  scenarioMaintenanceSeedPennWithStaffPhone,
  SCENARIO_STAFF_E164,
} = require("../helpers/memorySupabaseScenario");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../../src/db/supabase");

const PIPELINE = require.resolve("../../src/inbound/runInboundPipeline.js");

describe("scenarios — staff capture multi-turn (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("issue opener then property then unit: single draft_seq throughout", async () => {
    const mem = createScenarioMemorySupabase(
      scenarioMaintenanceSeedPennWithStaffPhone(SCENARIO_STAFF_E164)
    );
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    await runInboundPipeline({
      traceId: "sc-stm-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "# dishwasher not draining",
        From: SCENARIO_STAFF_E164,
        _phoneE164: SCENARIO_STAFF_E164,
      },
    });
    const seq = mem._state.staff_capture_drafts[0].draft_seq;

    await runInboundPipeline({
      traceId: "sc-stm-2",
      transportChannel: "sms",
      routerParameter: {
        Body: "#d" + seq + " penn",
        From: SCENARIO_STAFF_E164,
        _phoneE164: SCENARIO_STAFF_E164,
      },
    });

    assert.equal(mem._state.staff_capture_drafts.length, 1);
    assert.equal(mem._state.staff_capture_drafts[0].draft_seq, seq);

    await runInboundPipeline({
      traceId: "sc-stm-3",
      transportChannel: "sms",
      routerParameter: {
        Body: "#d" + seq + " 412",
        From: SCENARIO_STAFF_E164,
        _phoneE164: SCENARIO_STAFF_E164,
      },
    });

    assert.equal(mem._state.staff_capture_drafts.length, 0, "draft cleared after finalize");
    assert.equal(mem._state.tickets.length, 1);
  });
});
