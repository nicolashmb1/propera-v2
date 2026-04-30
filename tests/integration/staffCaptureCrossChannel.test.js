/**
 * Integration tests: staff #capture draft continuation across transports.
 * Run in isolation: `npm run test:integration` (sets PROPERA_TEST_INJECT_SB + in-memory DB).
 * Do not rely on real Supabase or .env credentials.
 */
process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
/** Deterministic intake (no OpenAI) — integration proves identity + draft rows, not LLM extraction. */
process.env.INTAKE_COMPILE_TURN = "1";
process.env.OPENAI_API_KEY = "";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createMemorySupabase } = require("../helpers/memorySupabaseStaffCapture");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../../src/db/supabase");

const CANON_E164 = "+15551234000";

function seedBase() {
  return {
    contacts: [{ id: "c1", phone_e164: CANON_E164 }],
    staff: [
      {
        id: "row1",
        staff_id: "staff-row-uuid",
        contact_id: "c1",
        display_name: "Pat",
        role: "manager",
        active: true,
      },
    ],
    properties: [
      {
        code: "WESTFIELD",
        display_name: "Westfield",
        ticket_prefix: "WF",
        short_name: "West",
        address: "1 Main",
        active: true,
      },
    ],
    staff_capture_drafts: [],
    telegram_chat_link: [],
    conversation_ctx: [],
    property_aliases: [],
  };
}

describe(
  "staff capture cross-channel (serial; shared inject)",
  { concurrency: false },
  () => {
    afterEach(() => {
      clearSupabaseClientForTests();
      delete require.cache[require.resolve("../../src/inbound/runInboundPipeline.js")];
    });

    test("Scenario A — Telegram then SMS: same draft row, same canonical key", async () => {
      const mem = createMemorySupabase(seedBase());
      setSupabaseClientForTests(mem);

      const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

      const r1 = await runInboundPipeline({
        traceId: "int-a-1",
        transportChannel: "telegram",
        routerParameter: {
          Body: "# 305 ice maker clogged",
          From: "TG:888888888",
          _phoneE164: CANON_E164,
          _channel: "TELEGRAM",
        },
        telegramSignal: {
          channel: require("../../src/signal/inboundSignal").CHANNEL_TELEGRAM,
          transport: { chat_id: "999" },
        },
      });

      assert.ok(r1.coreRun && r1.coreRun.ok !== false, "first turn should enter core");
      assert.equal(mem._state.staff_capture_drafts.length, 1, "one draft row");
      assert.equal(mem._state.staff_capture_drafts[0].staff_phone_e164, CANON_E164);
      const seq1 = mem._state.staff_capture_drafts[0].draft_seq;

      const r2 = await runInboundPipeline({
        traceId: "int-a-2",
        transportChannel: "sms",
        routerParameter: {
          Body: "#d1 WESTFIELD",
          From: CANON_E164,
          _phoneE164: CANON_E164,
        },
      });

      assert.ok(r2.coreRun && r2.coreRun.ok !== false, "second turn should enter core");
      assert.equal(mem._state.staff_capture_drafts.length, 1, "no duplicate draft for same canonical staff");
      assert.equal(mem._state.staff_capture_drafts[0].staff_phone_e164, CANON_E164);
      assert.equal(mem._state.staff_capture_drafts[0].draft_seq, seq1);
      assert.ok(
        String(mem._state.staff_capture_drafts[0].draft_property || "")
          .toUpperCase()
          .includes("WESTFIELD") || r2.coreRun.replyText,
        "property should be captured or reply present"
      );
    });

    test("Scenario B — SMS then WhatsApp: same draft namespace", async () => {
      const mem = createMemorySupabase(seedBase());
      setSupabaseClientForTests(mem);
      const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

      await runInboundPipeline({
        traceId: "int-b-1",
        transportChannel: "sms",
        routerParameter: {
          Body: "# sink leak under cabinet",
          From: CANON_E164,
          _phoneE164: CANON_E164,
        },
      });
      assert.equal(mem._state.staff_capture_drafts.length, 1);

      await runInboundPipeline({
        traceId: "int-b-2",
        transportChannel: "whatsapp",
        routerParameter: {
          Body: "#d1 WESTFIELD",
          From: "whatsapp:" + CANON_E164,
          _phoneE164: CANON_E164,
        },
      });

      assert.equal(mem._state.staff_capture_drafts.length, 1);
      assert.equal(mem._state.staff_capture_drafts[0].staff_phone_e164, CANON_E164);
    });

    test("Scenario C — WhatsApp then Telegram: same draft", async () => {
      const mem = createMemorySupabase(seedBase());
      setSupabaseClientForTests(mem);
      const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");
      const { CHANNEL_TELEGRAM } = require("../../src/signal/inboundSignal");

      await runInboundPipeline({
        traceId: "int-c-1",
        transportChannel: "whatsapp",
        routerParameter: {
          Body: "# dishwasher not draining",
          From: "whatsapp:" + CANON_E164,
          _phoneE164: CANON_E164,
        },
      });
      assert.equal(mem._state.staff_capture_drafts.length, 1);

      await runInboundPipeline({
        traceId: "int-c-2",
        transportChannel: "telegram",
        routerParameter: {
          Body: "#d1 WESTFIELD",
          From: "TG:777777",
          _phoneE164: CANON_E164,
          _channel: "TELEGRAM",
        },
        telegramSignal: {
          channel: CHANNEL_TELEGRAM,
          transport: { chat_id: "100" },
        },
      });

      assert.equal(mem._state.staff_capture_drafts.length, 1);
      assert.equal(mem._state.staff_capture_drafts[0].staff_phone_e164, CANON_E164);
    });

    test("Scenario D — STAFF: canonical: two core turns share draft owner prefix", async () => {
      const mem = createMemorySupabase({
        contacts: [{ id: "c-empty", phone_e164: null }],
        staff: [
          {
            id: "sr",
            staff_id: "uuid-staff-only",
            contact_id: "c-empty",
            display_name: "Q",
            role: "m",
            active: true,
          },
        ],
        properties: seedBase().properties,
        staff_capture_drafts: [],
        telegram_chat_link: [],
        conversation_ctx: [],
        property_aliases: [],
      });
      setSupabaseClientForTests(mem);

      const { resolveCanonicalBrainActorKey } = require("../../src/signal/resolveCanonicalBrainActorKey");
      const key = await resolveCanonicalBrainActorKey({
        sb: mem,
        routerParameter: {},
        staffRow: { contact_id: "c-empty", staff_id: "uuid-staff-only" },
        transportActorKey: "TG:111",
        isStaff: true,
      });
      assert.match(key, /^STAFF:uuid-staff-only$/);

      const { handleInboundCore } = require("../../src/brain/core/handleInboundCore");

      const staffRowD = { staff_id: "uuid-staff-only", contact_id: "c-empty" };
      const r1 = await handleInboundCore({
        traceId: "d-1",
        mode: "MANAGER",
        isStaffCapture: true,
        routerParameter: {
          Body: "# first issue line",
          From: "TG:111",
          _canonicalBrainActorKey: key,
        },
        bodyText: "first issue line",
        canonicalBrainActorKey: key,
        staffRow: staffRowD,
        staffDraftParsed: { draftSeq: null, rest: "first issue line" },
      });
      assert.ok(r1.ok, String(r1.brain));

      assert.equal(mem._state.staff_capture_drafts.length, 1);
      assert.equal(mem._state.staff_capture_drafts[0].staff_phone_e164, key);

      const seq = mem._state.staff_capture_drafts[0].draft_seq;
      const r2 = await handleInboundCore({
        traceId: "d-2",
        mode: "MANAGER",
        isStaffCapture: true,
        routerParameter: {
          Body: "#d" + seq + " WESTFIELD",
          From: "+19999999999",
          _canonicalBrainActorKey: key,
        },
        bodyText: "WESTFIELD",
        canonicalBrainActorKey: key,
        staffRow: staffRowD,
        staffDraftParsed: { draftSeq: seq, rest: "WESTFIELD" },
      });
      assert.ok(r2.ok, String(r2.brain));
      assert.equal(mem._state.staff_capture_drafts.length, 1);
    });
  }
);
