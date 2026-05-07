/**
 * Phase 1 — portal JSON create_ticket → same pipeline as messaging; structured finalize.
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
const { buildRouterParameterFromPortal } = require("../../src/contracts/buildRouterParameterFromPortal");

const PIPELINE = require.resolve("../../src/inbound/runInboundPipeline.js");

describe("scenarios — portal create_ticket structured (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("POST-shaped payload → core_finalized + ticket on PENN", async () => {
    const mem = createScenarioMemorySupabase(
      scenarioMaintenanceSeedPennWithStaffPhone(SCENARIO_STAFF_E164)
    );
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const routerParameter = buildRouterParameterFromPortal({
      action: "create_ticket",
      actorPhoneE164: SCENARIO_STAFF_E164,
      property: "PENN",
      unit: "808",
      category: "Plumbing",
      message: "Portal scenario clogged drain line",
      preferredWindow: "",
    });

    const r = await runInboundPipeline({
      traceId: "sc-portal-1",
      transportChannel: "portal",
      routerParameter,
    });

    assert.ok(r.coreRun, "core runs for portal create_ticket");
    assert.equal(r.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 1);
    assert.equal(String(mem._state.tickets[0].property_code || "").toUpperCase(), "PENN");
    assert.equal(String(mem._state.tickets[0].unit_label || "").trim(), "808");
    assert.ok(
      String(mem._state.tickets[0].message_raw || "")
        .toLowerCase()
        .includes("portal"),
      "issue text from structured message"
    );
  });
});
