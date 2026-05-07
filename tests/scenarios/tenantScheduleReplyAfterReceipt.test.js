/**
 * Phase 1 — post-receipt schedule: pending SCHEDULE + core_schedule_captured on follow-up.
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

describe("scenarios — tenant schedule after receipt (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("finalize then schedule reply updates preferred_window; brain core_schedule_captured", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    await runInboundPipeline({
      traceId: "sc-sch-a",
      transportChannel: "sms",
      routerParameter: {
        Body: "PENN 4B kitchen sink is leaking",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });
    await runInboundPipeline({
      traceId: "sc-sch-b",
      transportChannel: "sms",
      routerParameter: {
        Body: "303",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });
    await runInboundPipeline({
      traceId: "sc-sch-c",
      transportChannel: "sms",
      routerParameter: {
        Body: "tomorrow morning 9am to 12pm",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    const ticketKey = mem._state.tickets[0].ticket_key;

    const r2 = await runInboundPipeline({
      traceId: "sc-sch-d",
      transportChannel: "sms",
      routerParameter: {
        Body: "next Monday 10am to 2pm",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(mem._state.tickets.length, 1);
    assert.equal(mem._state.tickets[0].ticket_key, ticketKey);
    assert.equal(r2.coreRun && r2.coreRun.brain, "core_schedule_captured");
    const pw = String(mem._state.tickets[0].preferred_window || "").trim();
    assert.ok(pw.length > 3, "preferred_window updated");
  });
});
