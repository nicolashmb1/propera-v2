/**
 * portal_chat + # + mocked audio transcript → same pipeline outcome as typed staff capture text.
 */
process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.INTAKE_COMPILE_TURN = "1";
process.env.INTAKE_LLM_ENABLED = "0";
process.env.OPENAI_API_KEY = "";
process.env.INTAKE_MEDIA_OCR_ENABLED = "0";
process.env.INTAKE_AUDIO_ENABLED = "1";
process.env.INTAKE_AUDIO_TRANSCRIPTION_ENABLED = "1";
process.env.OPENAI_AUDIO_TRANSCRIPTION_ENABLED = "1";
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

describe("scenarios — portal_chat staff capture + audio transcript (in-memory)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
    delete process.env.INTAKE_AUDIO_ENABLED;
    delete process.env.INTAKE_AUDIO_TRANSCRIPTION_ENABLED;
    delete process.env.OPENAI_AUDIO_TRANSCRIPTION_ENABLED;
  });

  test("# + injected audio transcript finalizes same property/unit as typed body", async () => {
    const mem = createScenarioMemorySupabase(
      scenarioMaintenanceSeedPennWithStaffPhone(SCENARIO_STAFF_E164)
    );
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const typed = buildRouterParameterFromPortal({
      action: "portal_chat",
      actorPhoneE164: SCENARIO_STAFF_E164,
      body: "# PENN apt 707 plumbing clogged from typed portal",
    });
    const rTyped = await runInboundPipeline({
      traceId: "sc-portal-audio-typed",
      transportChannel: "portal",
      routerParameter: typed,
    });
    assert.equal(rTyped.coreRun && rTyped.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 1);
    const typedTicket = mem._state.tickets[0];

    mem._state.tickets = [];

    const audioRouter = buildRouterParameterFromPortal({
      action: "portal_chat",
      actorPhoneE164: SCENARIO_STAFF_E164,
      body: "#",
      portal_chat_mode: "staff_capture",
      media: [
        {
          kind: "audio",
          storagePath: "portal-chat-audio/mock.webm",
          mimeType: "audio/webm",
          filename: "mock.webm",
        },
      ],
    });

    const rAudio = await runInboundPipeline({
      traceId: "sc-portal-audio-mock",
      transportChannel: "portal",
      routerParameter: audioRouter,
      mediaSignalDeps: {
        enrichInboundMediaWithAudioTranscription: async (media) =>
          media.map((m) =>
            m && typeof m === "object" && String(m.kind).toLowerCase() === "audio"
              ? {
                  ...m,
                  transcript: "PENN apt 707 plumbing clogged from typed portal",
                  transcription_status: "completed",
                }
              : m
          ),
      },
    });

    assert.equal(rAudio.coreRun && rAudio.coreRun.brain, "core_finalized");
    assert.equal(mem._state.tickets.length, 1);
    assert.equal(
      String(mem._state.tickets[0].property_code || "").toUpperCase(),
      String(typedTicket.property_code || "").toUpperCase()
    );
    assert.equal(
      String(mem._state.tickets[0].unit_label || "").trim(),
      String(typedTicket.unit_label || "").trim()
    );
  });
});
