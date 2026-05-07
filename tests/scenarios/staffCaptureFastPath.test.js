/**
 * Phase 1 — staff `#` capture: issue → property → unit → finalized ticket (no tenant schedule ask).
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

describe("scenarios — staff capture fast path (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("three turns: hash issue → #d1 property → #d1 unit → core_finalized", async () => {
    const mem = createScenarioMemorySupabase(
      scenarioMaintenanceSeedPennWithStaffPhone(SCENARIO_STAFF_E164)
    );
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r1 = await runInboundPipeline({
      traceId: "sc-stf-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "# sink leak under kitchen cabinet",
        From: SCENARIO_STAFF_E164,
        _phoneE164: SCENARIO_STAFF_E164,
      },
    });
    assert.ok(r1.coreRun && r1.coreRun.ok !== false, String(r1.coreRun && r1.coreRun.brain));
    assert.equal(mem._state.staff_capture_drafts.length, 1);
    const seq = mem._state.staff_capture_drafts[0].draft_seq;

    const r2 = await runInboundPipeline({
      traceId: "sc-stf-2",
      transportChannel: "sms",
      routerParameter: {
        Body: "#d" + seq + " PENN",
        From: SCENARIO_STAFF_E164,
        _phoneE164: SCENARIO_STAFF_E164,
      },
    });
    assert.ok(r2.coreRun && r2.coreRun.ok !== false);

    const r3 = await runInboundPipeline({
      traceId: "sc-stf-3",
      transportChannel: "sms",
      routerParameter: {
        Body: "#d" + seq + " 305",
        From: SCENARIO_STAFF_E164,
        _phoneE164: SCENARIO_STAFF_E164,
      },
    });

    assert.equal(r3.coreRun && r3.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 1);
    assert.equal(String(mem._state.tickets[0].property_code || "").toUpperCase(), "PENN");
    assert.equal(String(mem._state.tickets[0].unit_label || "").trim(), "305");
  });
});
