/**
 * Phase 1 — staff `#` finalize without schedule text → no tenant-style SCHEDULE template.
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

describe("scenarios — staff capture no schedule prompt (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("finalize without Preferred window → STAFF_CAPTURE_NO_SCHEDULE_PROMPT logged", async () => {
    const mem = createScenarioMemorySupabase(
      scenarioMaintenanceSeedPennWithStaffPhone(SCENARIO_STAFF_E164)
    );
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    await runInboundPipeline({
      traceId: "sc-nosch-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "# broken window latch",
        From: SCENARIO_STAFF_E164,
        _phoneE164: SCENARIO_STAFF_E164,
      },
    });
    const seq = mem._state.staff_capture_drafts[0].draft_seq;
    await runInboundPipeline({
      traceId: "sc-nosch-2",
      transportChannel: "sms",
      routerParameter: {
        Body: "#d" + seq + " PENN",
        From: SCENARIO_STAFF_E164,
        _phoneE164: SCENARIO_STAFF_E164,
      },
    });
    const r3 = await runInboundPipeline({
      traceId: "sc-nosch-3",
      transportChannel: "sms",
      routerParameter: {
        Body: "#d" + seq + " 201",
        From: SCENARIO_STAFF_E164,
        _phoneE164: SCENARIO_STAFF_E164,
      },
    });

    assert.equal(r3.coreRun && r3.coreRun.brain, "core_finalized");
    const ev = mem._state.event_log.some(
      (e) => String(e.event || "") === "STAFF_CAPTURE_NO_SCHEDULE_PROMPT"
    );
    assert.ok(ev, "flight recorder marks no tenant schedule block for staff");
    const reply = String((r3.coreRun && r3.coreRun.replyText) || "");
    assert.ok(
      !/what (time|day)\b/i.test(reply) && !/preferred window/i.test(reply),
      "reply is receipt-focused, not tenant schedule interview"
    );
  });
});
