/**
 * Golden tenant messages — layer B (runInboundPipeline, in-memory Supabase).
 * Covers CHITCHAT and ISSUE_URGENT categories from the fixture.
 *
 * CHITCHAT: pipeline must never create a ticket.
 * ISSUE_URGENT: pipeline should finalize a ticket; EMERGENCY rows must set emergency="Yes".
 *
 * "red is OK" on first run — rows without a resolvable unit (COMMON, PROFILE_LOOKUP) may
 * not finalize and are intentionally left as soft checks.
 */
require("./helpers/legacyPipelineEnv");
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
const path = require("path");
const {
  createScenarioMemorySupabase,
  scenarioMaintenanceSeedPenn,
  SCENARIO_TENANT_E164,
} = require("./helpers/memorySupabaseScenario");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../src/db/supabase");

const FIXTURE_PATH = path.join(__dirname, "fixtures", "tenant-messages.json");
const fixture = require(FIXTURE_PATH);
const rows = fixture.messages || fixture;

const PIPELINE = require.resolve("../src/inbound/runInboundPipeline.js");

const chitchatRows = rows.filter((r) => r.category === "CHITCHAT");
const urgentRows = rows.filter(
  (r) => r.category === "ISSUE_URGENT" && !(Array.isArray(r.skipUntil) && r.skipUntil.length)
);

describe("tenant golden messages — pipeline layer B", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  describe("CHITCHAT — no ticket created", () => {
    for (const row of chitchatRows) {
      test(`${row.id}: "${String(row.message).slice(0, 40)}"`, async () => {
        const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
        setSupabaseClientForTests(mem);
        const { runInboundPipeline } = require("../src/inbound/runInboundPipeline");

        await runInboundPipeline({
          traceId: `golden-${row.id}`,
          transportChannel: "sms",
          routerParameter: {
            Body: "penn " + row.message,
            From: SCENARIO_TENANT_E164,
            _phoneE164: SCENARIO_TENANT_E164,
          },
        });

        assert.equal(
          mem._state.tickets.length,
          0,
          `${row.id}: chitchat must not create a ticket`
        );
      });
    }
  });

  describe("ISSUE_URGENT — ticket + emergency flag", () => {
    for (const row of urgentRows) {
      const ex = row.extracted || {};
      const hasNumericUnit = /^\d{2,4}$/.test(String(ex.unit || ""));
      const isEmergencyRow = ex.urgency === "EMERGENCY";

      test(`${row.id}: "${String(row.message).slice(0, 50)}"`, async () => {
        const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
        setSupabaseClientForTests(mem);
        const { runInboundPipeline } = require("../src/inbound/runInboundPipeline");

        await runInboundPipeline({
          traceId: `golden-${row.id}`,
          transportChannel: "sms",
          routerParameter: {
            Body: "penn " + row.message,
            From: SCENARIO_TENANT_E164,
            _phoneE164: SCENARIO_TENANT_E164,
          },
        });

        if (hasNumericUnit) {
          assert.ok(
            mem._state.tickets.length >= 1,
            `${row.id}: expected ticket for urgent message with unit ${ex.unit}`
          );
        }

        if (isEmergencyRow && mem._state.tickets.length >= 1) {
          const em = String(mem._state.tickets[0].emergency || "").toLowerCase();
          assert.match(em, /^yes$/, `${row.id}: expected emergency="Yes" for EMERGENCY row`);
        }
      });
    }
  });
});
