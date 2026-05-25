/**
 * Golden tenant messages — layer C (runInboundPipeline, LLM mocked, in-memory Supabase).
 * Covers CHITCHAT (cc_001–cc_009) and TICKET_CANCEL (real_012b).
 *
 * CHITCHAT: LLM mock returns failure → deterministic fallback → 0 tickets.
 * TICKET_CANCEL: seeded open ticket + intake session; assert ticket suspended.
 *   NOTE: SUSPEND_TICKET is not yet implemented in V2 — cancel assertions will be RED.
 */
require("./helpers/legacyPipelineEnv");
process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.INTAKE_COMPILE_TURN = "1";
process.env.INTAKE_LLM_ENABLED = "1";
process.env.OPENAI_API_KEY = "test-llm-key";
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
const {
  setLlmExtractorForTests,
  clearLlmExtractorForTests,
} = require("../src/brain/intake/openaiStructuredSignal");

const FIXTURE_PATH = path.join(__dirname, "fixtures", "tenant-messages.json");
const fixture = require(FIXTURE_PATH);
const rows = fixture.messages || fixture;

const PIPELINE = require.resolve("../src/inbound/runInboundPipeline.js");

const chitchatRows = rows.filter((r) => r.category === "CHITCHAT");
const cancelRows = rows.filter((r) => r.category === "TICKET_CANCEL");

describe("tenant golden messages — pipeline layer C (LLM mocked)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    clearLlmExtractorForTests();
    delete require.cache[PIPELINE];
  });

  describe("CHITCHAT — LLM mocked off → 0 tickets", () => {
    for (const row of chitchatRows) {
      test(`${row.id}: "${String(row.message).slice(0, 40)}"`, async () => {
        setLlmExtractorForTests(() => ({ ok: false, signal: null, err: "mocked_off" }));

        const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
        setSupabaseClientForTests(mem);
        const { runInboundPipeline } = require("../src/inbound/runInboundPipeline");

        await runInboundPipeline({
          traceId: `layerc-${row.id}`,
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
          `${row.id}: chitchat must not create a ticket even with LLM path active`
        );
      });
    }
  });

  describe("TICKET_CANCEL — suspend linked open ticket", () => {
    for (const row of cancelRows) {
      test(`${row.id}: "${String(row.message).slice(0, 50)}"`, async () => {
        setLlmExtractorForTests(() => ({ ok: false, signal: null, err: "mocked_off" }));

        const ex = row.extracted || {};
        const unit = String(ex.unit || "416");
        const ticketId = "ticket-cancel-test-001";
        const ticketKey = "PENN-010125-0001";

        const seed = scenarioMaintenanceSeedPenn();
        seed.units = [
          {
            id: "unit-416-id",
            property_code: "PENN",
            unit_label: unit,
            floor: "4",
            bedrooms: "1",
            bathrooms: "1",
            status: "Occupied",
            notes: "",
          },
        ];
        seed.tickets = [
          {
            id: ticketId,
            ticket_key: ticketKey,
            property_code: "PENN",
            unit_label: unit,
            issue_text: "dishwasher leak",
            status: "OPEN",
            emergency: "No",
            report_source_phone: SCENARIO_TENANT_E164,
          },
        ];
        // Intake session simulates post-ticket schedule-wait state so unit is resolvable
        seed.intake_sessions = [
          {
            phone_e164: SCENARIO_TENANT_E164,
            stage: "SCHEDULE",
            expected: "SCHEDULE",
            lane: "MAINTENANCE",
            draft_property: "PENN",
            draft_unit: unit,
            draft_issue: "dishwasher leak",
            issue_buf_json: [],
            draft_schedule_raw: "",
            active_artifact_key: ticketKey,
            expires_at_iso: "",
            updated_at_iso: new Date().toISOString(),
          },
        ];

        const mem = createScenarioMemorySupabase(seed);
        setSupabaseClientForTests(mem);
        const { runInboundPipeline } = require("../src/inbound/runInboundPipeline");

        await runInboundPipeline({
          traceId: `layerc-${row.id}`,
          transportChannel: "sms",
          routerParameter: {
            Body: row.message,
            From: SCENARIO_TENANT_E164,
            _phoneE164: SCENARIO_TENANT_E164,
          },
        });

        // RED: SUSPEND_TICKET is not yet implemented in V2 — this will fail until wired
        const ticket = mem._state.tickets.find((t) => t.id === ticketId);
        assert.ok(ticket, `${row.id}: pre-seeded ticket should still be present`);
        assert.equal(
          String(ticket && ticket.status || "").toUpperCase(),
          "SUSPENDED",
          `${row.id}: expected ticket.status === "SUSPENDED" after tenant cancel intent`
        );
      });
    }
  });
});
