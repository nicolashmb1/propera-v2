"use strict";

/**
 * Resident portal structured create_ticket must not require PM staff JWT actor gate.
 */
require("./helpers/legacyPipelineEnv");
process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.INTAKE_COMPILE_TURN = "0";
process.env.INTAKE_LLM_ENABLED = "0";
process.env.OPENAI_API_KEY = "";
process.env.INTAKE_MEDIA_OCR_ENABLED = "0";
process.env.TELEGRAM_OUTBOUND_ENABLED = "0";
process.env.PROPERA_TZ = "America/New_York";
process.env.STRUCTURED_LOG = "0";
process.env.PROPERA_PORTAL_ACTOR_JWT_REQUIRED = "1";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  createScenarioMemorySupabase,
  scenarioMaintenanceSeedPenn,
  SCENARIO_TENANT_E164,
} = require("./helpers/memorySupabaseScenario");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../src/db/supabase");
const { buildRouterParameterFromPortal } = require("../src/contracts/buildRouterParameterFromPortal");

const PIPELINE = require.resolve("../src/inbound/runInboundPipeline.js");

afterEach(() => {
  clearSupabaseClientForTests();
  delete require.cache[PIPELINE];
});

test("tenant_portal create_ticket — no staff JWT, not portal_actor_gate", async () => {
  const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
  setSupabaseClientForTests(mem);

  const { runInboundPipeline } = require("../src/inbound/runInboundPipeline");
  const routerParameter = buildRouterParameterFromPortal({
    action: "create_ticket",
    channel: "tenant_portal",
    actor_type: "TENANT",
    actorPhoneE164: SCENARIO_TENANT_E164,
    tenantPhoneE164: SCENARIO_TENANT_E164,
    property: "PENN",
    unit: "303",
    category: "Plumbing",
    message: "Kitchen sink is leaking badly",
    description: "Kitchen sink is leaking badly",
    attachmentUrls: ["https://example.test/tenant-photo.jpg"],
  });

  const r = await runInboundPipeline({
    traceId: "tp-create-1",
    transportChannel: "portal",
    routerParameter,
    portalUserAccessToken: "",
  });

  assert.notEqual(r.staffRun && r.staffRun.brain, "portal_actor_gate");
  assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
  assert.equal(mem._state.tickets.length, 1);
  assert.ok(
    String(mem._state.tickets[0].attachments || "").includes("tenant-photo.jpg")
  );
  assert.equal(
    String(mem._state.tickets[0].intake_channel || ""),
    ""
  );
});
