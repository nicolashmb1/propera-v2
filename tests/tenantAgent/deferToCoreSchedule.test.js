"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";

const test = require("node:test");
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
const {
  tenantAgentShouldDeferToCoreSchedule,
} = require("../../src/adapters/tenantAgent/deferToCoreSchedule");

test("tenantAgentShouldDeferToCoreSchedule — true when intake expects SCHEDULE", async () => {
  const mem = createScenarioMemorySupabase({
    ...scenarioMaintenanceSeedPenn(),
    intake_sessions: [
      {
        phone_e164: SCENARIO_TENANT_E164,
        expected: "SCHEDULE",
        active_artifact_key: "ticket-key-1",
        stage: "WAIT",
        lane: "tenant",
      },
    ],
  });
  setSupabaseClientForTests(mem);

  const defer = await tenantAgentShouldDeferToCoreSchedule({
    routerParameter: {
      _canonicalBrainActorKey: SCENARIO_TENANT_E164,
      From: SCENARIO_TENANT_E164,
    },
  });

  assert.equal(defer, true);
  clearSupabaseClientForTests();
});

test("tenantAgentShouldDeferToCoreSchedule — false without session or wrong expected", async () => {
  const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
  setSupabaseClientForTests(mem);

  assert.equal(
    await tenantAgentShouldDeferToCoreSchedule({
      routerParameter: { _phoneE164: SCENARIO_TENANT_E164 },
    }),
    false
  );

  mem._state.intake_sessions.push({
    phone_e164: SCENARIO_TENANT_E164,
    expected: "UNIT",
    active_artifact_key: "ticket-key-1",
  });

  assert.equal(
    await tenantAgentShouldDeferToCoreSchedule({
      routerParameter: { _phoneE164: SCENARIO_TENANT_E164 },
    }),
    false
  );

  clearSupabaseClientForTests();
});
