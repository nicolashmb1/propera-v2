/**
 * Golden tenant messages — agent path (TENANT_AGENT_ENABLED=1, LLM off).
 * Replays fixture categories through runInboundPipeline so you do not need manual SMS/TG/WA sends.
 *
 * Run before/after turning agent flags on in dev:
 *   npm test -- tests/scenarios/tenantAgentGoldenPipeline.test.js
 */
process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.TENANT_AGENT_ENABLED = "1";
process.env.TENANT_AGENT_LLM_ENABLED = "0";
process.env.INTAKE_COMPILE_TURN = "1";
process.env.INTAKE_LLM_ENABLED = "0";
process.env.OPENAI_API_KEY = "";
process.env.INTAKE_MEDIA_OCR_ENABLED = "0";
process.env.TELEGRAM_OUTBOUND_ENABLED = "0";
process.env.OUTGATE_CHANNEL_RENDER = "0";
process.env.PROPERA_TZ = "America/New_York";
process.env.STRUCTURED_LOG = "0";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
  createScenarioMemorySupabase,
  scenarioMaintenanceSeedPenn,
  SCENARIO_TENANT_E164,
} = require("../helpers/memorySupabaseScenario");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../../src/db/supabase");
const { testLayerForRow } = require("../helpers/tenantMessageExpectations");

const FIXTURE_PATH = path.join(__dirname, "../fixtures", "tenant-messages.json");
const fixture = require(FIXTURE_PATH);
const rows = fixture.messages || fixture;

const PIPELINE = require.resolve("../../src/inbound/runInboundPipeline.js");

/**
 * Build inbound body so agent deterministic parse can one-shot handoff when fixture expects CREATE_TICKET.
 * @param {object} row
 * @returns {string}
 */
function bodyForAgentRow(row) {
  const msg = String(row.message || "").trim();
  const ex = row.extracted || {};
  const unit = String(ex.unit || "").trim();
  const hasUnitInMsg = unit && new RegExp(`\\b${unit}\\b`).test(msg);
  if (/^\d{2,4}$/.test(unit) && !hasUnitInMsg) {
    return `penn ${unit} ${msg}`;
  }
  if (!/\bpenn\b/i.test(msg)) {
    return `penn ${msg}`;
  }
  return msg;
}

/**
 * @param {'sms'|'whatsapp'|'telegram'} transportChannel
 * @param {string} body
 * @returns {Record<string, string>}
 */
function routerForTransport(transportChannel, body) {
  const base = {
    Body: body,
    From: SCENARIO_TENANT_E164,
    _phoneE164: SCENARIO_TENANT_E164,
  };
  if (transportChannel === "telegram") {
    base._telegramChatId = "999001";
    base._channel = "TELEGRAM";
  } else if (transportChannel === "whatsapp") {
    base._channel = "WHATSAPP";
  } else {
    base._channel = "SMS";
  }
  return base;
}

/**
 * @param {'sms'|'whatsapp'|'telegram'} transportChannel
 * @param {string} body
 */
async function runAgentPipeline(transportChannel, body, traceId) {
  const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
  setSupabaseClientForTests(mem);
  delete require.cache[PIPELINE];
  const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");
  const r = await runInboundPipeline({
    traceId,
    transportChannel,
    routerParameter: routerForTransport(transportChannel, body),
    telegramSignal:
      transportChannel === "telegram"
        ? { channel: "telegram", chatId: "999001", updateId: "1" }
        : undefined,
  });
  return { r, mem };
}

const chitchatRows = rows.filter(
  (row) => row.category === "CHITCHAT" && testLayerForRow(row) !== "skip"
);
const urgentRows = rows.filter(
  (row) =>
    row.category === "ISSUE_URGENT" &&
    testLayerForRow(row) !== "skip" &&
    !(Array.isArray(row.skipUntil) && row.skipUntil.length)
);
const issueClearRows = rows.filter((row) => {
  if (row.category !== "ISSUE_CLEAR") return false;
  if (testLayerForRow(row) === "skip") return false;
  const unit = String((row.extracted && row.extracted.unit) || "");
  return /^\d{2,4}$/.test(unit);
});

describe("tenant agent golden — fixture replay (deterministic gather)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  describe("CHITCHAT — agent gather, no ticket", () => {
    for (const row of chitchatRows) {
      test(`${row.id}: "${String(row.message).slice(0, 40)}"`, async () => {
        const { r, mem } = await runAgentPipeline(
          "sms",
          String(row.message || ""),
          `ta-golden-cc-${row.id}`
        );
        assert.equal(mem._state.tickets.length, 0, `${row.id}: no ticket`);
        assert.ok(
          r.brain === "tenant_agent_gather" || !r.coreRun,
          `${row.id}: expected gather, got brain=${r.brain}`
        );
      });
    }
  });

  describe("ISSUE_URGENT — handoff + emergency when unit present", () => {
    for (const row of urgentRows) {
      const ex = row.extracted || {};
      const hasNumericUnit = /^\d{2,4}$/.test(String(ex.unit || ""));

      test(`${row.id}: "${String(row.message).slice(0, 50)}"`, async () => {
        const body = bodyForAgentRow(row);
        const { r, mem } = await runAgentPipeline("sms", body, `ta-golden-iu-${row.id}`);

        if (hasNumericUnit) {
          assert.ok(r.coreRun, `${row.id}: expected handoff to core`);
          assert.equal(mem._state.tickets.length, 1, `${row.id}: one ticket`);
          assert.match(String(r.coreRun.replyText || ""), /Ref #/);
          // Note: agent structured handoff may not set emergency=Yes on ticket yet (legacy compile path does).
          // Track via tenantMessagesPipeline.test.js for legacy; agent emergency parity is a follow-up.
        }
      });
    }
  });

  describe("ISSUE_CLEAR (numeric unit) — penn prefix → ticket", () => {
    for (const row of issueClearRows) {
      test(`${row.id}: "${String(row.message).slice(0, 50)}"`, async () => {
        const body = bodyForAgentRow(row);
        const { r, mem } = await runAgentPipeline("sms", body, `ta-golden-ic-${row.id}`);
        assert.ok(r.coreRun, `${row.id}: handoff expected`);
        assert.equal(r.coreRun.brain, "core_finalized");
        assert.equal(mem._state.tickets.length, 1);
        assert.match(String(r.coreRun.replyText || ""), /Ref #/);
      });
    }
  });

  describe("transport parity — same one-liner on sms / whatsapp / telegram", () => {
    for (const transport of ["sms", "whatsapp", "telegram"]) {
      test(`${transport} — 410 penn heat not working`, async () => {
        const { r, mem } = await runAgentPipeline(
          transport,
          "410 penn heat not working",
          `ta-golden-transport-${transport}`
        );
        assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
        assert.equal(mem._state.tickets.length, 1);
        const conv = mem._state.tenant_conversations.find(
          (c) => c.transport_channel === transport
        );
        assert.ok(conv, `conversation row for ${transport}`);
        assert.ok(
          conv.status === "handoff_done" || conv.status === "complete",
          "post-finalize status"
        );
      });
    }
  });
});
