/**
 * Portal structured common_area — no unit, no tenant phone; same pipeline → finalize.
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

describe("scenarios — portal create_ticket common_area (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("structured common_area → core_finalized + COMMON_AREA ticket", async () => {
    const mem = createScenarioMemorySupabase(
      scenarioMaintenanceSeedPennWithStaffPhone(SCENARIO_STAFF_E164)
    );
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const routerParameter = buildRouterParameterFromPortal({
      action: "create_ticket",
      actorPhoneE164: SCENARIO_STAFF_E164,
      tenantPhoneE164: "",
      property: "PENN",
      location_kind: "common_area",
      location_label_snapshot: "Lobby",
      unit: "",
      category: "Safety",
      message: "Wet floor signage missing",
      preferredWindow: "",
    });

    const r = await runInboundPipeline({
      traceId: "sc-portal-ca-1",
      transportChannel: "portal",
      routerParameter,
    });

    assert.ok(r.coreRun, "core runs");
    assert.equal(r.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 1);
    const t = mem._state.tickets[0];
    assert.equal(String(t.location_type || "").toUpperCase(), "COMMON_AREA");
    assert.equal(String(t.unit_label || "").trim(), "");
    assert.equal(String(t.tenant_phone_e164 || "").trim(), "");
    assert.ok(
      String(t.location_label_snapshot || "").toLowerCase().includes("lobby") ||
        String(t.message_raw || "").toLowerCase().includes("wet floor"),
      "snapshot or message preserves issue"
    );
  });
});
