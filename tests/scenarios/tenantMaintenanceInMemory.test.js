/**
 * Scenario foundation: tenant maintenance through real `runInboundPipeline` + core
 * with injected in-memory Supabase (no live DB / OpenAI / OCR / Telegram).
 *
 * Uses existing seams: `setSupabaseClientForTests`, `PROPERA_TEST_INJECT_SB` (set below).
 *
 * **Compile-turn reality:** With `INTAKE_COMPILE_TURN=1` and LLM off, a single message like
 * `PENN 4B kitchen sink is leaking` still yields `expected: UNIT` (unit token not extracted as slot).
 * Fast-path `core_finalized` in one shot requires shapes such as `sink leaking 303 penn` today.
 * Scenarios below follow **actual** multi-turn behavior for the PENN 4B opener + numeric unit reply.
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
const { normalizeInboundEventFromRouterParameter } = require("../../src/brain/router/normalizeInboundEvent");
const { buildRouterParameterFromTwilio } = require("../../src/contracts/buildRouterParameterFromTwilio");
const { normalizeTelegramUpdate } = require("../../src/adapters/telegram/normalizeTelegramUpdate");
const { buildRouterParameterFromTelegram } = require("../../src/contracts/buildRouterParameterFromTelegram");

const PIPELINE = require.resolve("../../src/inbound/runInboundPipeline.js");

describe(
  "scenarios — tenant maintenance (in-memory DB)",
  { concurrency: false },
  () => {
    afterEach(() => {
      clearSupabaseClientForTests();
      delete require.cache[PIPELINE];
    });

    test("multi-turn intake (compile-turn): PENN 4B opener → unit → schedule → single ticket", async () => {
      const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
      setSupabaseClientForTests(mem);

      const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

      const r1 = await runInboundPipeline({
        traceId: "sc-mt-1",
        transportChannel: "sms",
        routerParameter: {
          Body: "PENN 4B kitchen sink is leaking",
          From: SCENARIO_TENANT_E164,
          _phoneE164: SCENARIO_TENANT_E164,
        },
      });

      assert.equal(r1.coreRun && r1.coreRun.brain, "core_draft_pending");
      assert.equal(mem._state.tickets.length, 0);
      const sess1 = mem._state.intake_sessions.find(
        (s) => s.phone_e164 === SCENARIO_TENANT_E164
      );
      assert.ok(sess1);
      assert.equal(String(sess1.expected || "").toUpperCase(), "UNIT");

      const r2 = await runInboundPipeline({
        traceId: "sc-mt-2",
        transportChannel: "sms",
        routerParameter: {
          Body: "303",
          From: SCENARIO_TENANT_E164,
          _phoneE164: SCENARIO_TENANT_E164,
        },
      });

      assert.equal(r2.coreRun && r2.coreRun.brain, "core_draft_pending");
      assert.equal(mem._state.tickets.length, 0);
      const sess2 = mem._state.intake_sessions.find(
        (s) => s.phone_e164 === SCENARIO_TENANT_E164
      );
      assert.ok(sess2);
      assert.equal(String(sess2.expected || "").toUpperCase(), "SCHEDULE_PRETICKET");

      const r3 = await runInboundPipeline({
        traceId: "sc-mt-3",
        transportChannel: "sms",
        routerParameter: {
          Body: "tomorrow morning 9am to 12pm",
          From: SCENARIO_TENANT_E164,
          _phoneE164: SCENARIO_TENANT_E164,
        },
      });

      assert.equal(r3.coreRun && r3.coreRun.brain, "core_finalized");
      assert.equal(mem._state.tickets.length, 1);
      assert.equal(mem._state.work_items.length, 1);

      const t = mem._state.tickets[0];
      assert.match(String(t.ticket_id || ""), /^PENN-/i);
      assert.equal(String(t.property_code || "").toUpperCase(), "PENN");
      assert.equal(String(t.unit_label || "").trim(), "303");

      const wi = mem._state.work_items[0];
      assert.equal(String(wi.ticket_key || ""), String(t.ticket_key || ""));
    });

    test("post-receipt schedule reply: same actor, no second ticket, preferred_window persisted", async () => {
      const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
      setSupabaseClientForTests(mem);
      const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

      await runInboundPipeline({
        traceId: "sc-sch-1",
        transportChannel: "sms",
        routerParameter: {
          Body: "PENN 4B kitchen sink is leaking",
          From: SCENARIO_TENANT_E164,
          _phoneE164: SCENARIO_TENANT_E164,
        },
      });
      await runInboundPipeline({
        traceId: "sc-sch-2",
        transportChannel: "sms",
        routerParameter: {
          Body: "303",
          From: SCENARIO_TENANT_E164,
          _phoneE164: SCENARIO_TENANT_E164,
        },
      });
      await runInboundPipeline({
        traceId: "sc-sch-3",
        transportChannel: "sms",
        routerParameter: {
          Body: "tomorrow morning 9am to 12pm",
          From: SCENARIO_TENANT_E164,
          _phoneE164: SCENARIO_TENANT_E164,
        },
      });

      assert.equal(mem._state.tickets.length, 1);
      const ticketKeyBefore = mem._state.tickets[0].ticket_key;

      const r4 = await runInboundPipeline({
        traceId: "sc-sch-4",
        transportChannel: "sms",
        routerParameter: {
          Body: "next Monday 10am to 2pm",
          From: SCENARIO_TENANT_E164,
          _phoneE164: SCENARIO_TENANT_E164,
        },
      });

      assert.equal(mem._state.tickets.length, 1);
      assert.equal(mem._state.tickets[0].ticket_key, ticketKeyBefore);
      assert.equal(r4.coreRun && r4.coreRun.brain, "core_schedule_captured");

      const pw = String(mem._state.tickets[0].preferred_window || "").trim();
      assert.ok(pw.length > 3, "preferred_window stored");
    });

    test("channel normalization: SMS vs Telegram RouterParameters match brain-visible body + actor when canonical phone aligned", () => {
      const body = "PENN 4B kitchen sink is leaking";

      const smsP = buildRouterParameterFromTwilio({
        From: SCENARIO_TENANT_E164,
        Body: body,
        NumMedia: "0",
      });
      smsP._phoneE164 = SCENARIO_TENANT_E164;
      smsP._canonicalBrainActorKey = SCENARIO_TENANT_E164;

      const signal = normalizeTelegramUpdate({
        update_id: 9001,
        message: {
          message_id: 1,
          from: { id: 424242 },
          chat: { id: 424242 },
          text: body,
        },
      });
      assert.ok(signal);
      const tgP = buildRouterParameterFromTelegram(signal, {});
      tgP._canonicalBrainActorKey = SCENARIO_TENANT_E164;

      const evSms = normalizeInboundEventFromRouterParameter(smsP);
      const evTg = normalizeInboundEventFromRouterParameter(tgP);

      assert.equal(evSms.bodyTrim, evTg.bodyTrim);
      assert.equal(evSms.actorId, evTg.actorId);
      assert.equal(evSms.media.length, evTg.media.length);
    });
  }
);
