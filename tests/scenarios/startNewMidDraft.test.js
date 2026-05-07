/**
 * Phase 1 — explicit new-ticket marker mid draft → intake_start_new.
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

describe("scenarios — start new mid draft (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("new issue marker after unit slot → brain intake_start_new + fresh ISSUE slot", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    await runInboundPipeline({
      traceId: "sc-sn-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "PENN 4B kitchen sink is leaking",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });
    await runInboundPipeline({
      traceId: "sc-sn-2",
      transportChannel: "sms",
      routerParameter: {
        Body: "303",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    const r3 = await runInboundPipeline({
      traceId: "sc-sn-3",
      transportChannel: "sms",
      routerParameter: {
        Body: "another issue the heat is broken",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r3.coreRun && r3.coreRun.brain, "intake_start_new");
    const sess = mem._state.intake_sessions.find(
      (s) => s.phone_e164 === SCENARIO_TENANT_E164
    );
    assert.ok(sess);
    const exp = String(sess.expected || "").toUpperCase();
    assert.ok(
      exp === "ISSUE" || exp === "PROPERTY",
      "restarted draft asks for issue or property first"
    );
    assert.equal(mem._state.tickets.length, 0);
  });
});
