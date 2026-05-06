process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.INTAKE_COMPILE_TURN = "1";
process.env.INTAKE_MEDIA_SIGNAL_ENABLED = "0";
process.env.OPENAI_API_KEY = "";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createMemorySupabase } = require("./helpers/memorySupabaseStaffCapture");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../src/db/supabase");

const STAFF_PHONE = "+15551234000";

function seedBase() {
  return {
    contacts: [{ id: "c1", phone_e164: STAFF_PHONE }],
    staff: [
      {
        id: "s1",
        staff_id: "staff-1",
        contact_id: "c1",
        display_name: "Pat",
        role: "manager",
        active: true,
      },
    ],
    properties: [
      {
        code: "PENN",
        display_name: "Penn",
        ticket_prefix: "PENN",
        short_name: "Penn",
        address: "1 Penn",
        active: true,
      },
    ],
    staff_capture_drafts: [],
    telegram_chat_link: [],
    conversation_ctx: [],
    property_aliases: [],
    property_policy: [],
    intake_sessions: [],
    tickets: [],
    work_items: [],
  };
}

function twilioImageRouterParameter(body) {
  return {
    Body: body,
    From: STAFF_PHONE,
    _phoneE164: STAFF_PHONE,
    NumMedia: "1",
    MediaUrl0: "https://api.twilio.com/Media/MM1",
    MediaContentType0: "image/jpeg",
    _mediaJson: JSON.stringify([
      {
        provider: "twilio",
        source: "twilio",
        url: "https://api.twilio.com/Media/MM1",
        contentType: "image/jpeg",
        kind: "image",
      },
    ]),
  };
}

function twilioMultiImageRouterParameter(body) {
  return {
    ...twilioImageRouterParameter(body),
    NumMedia: "2",
    MediaUrl1: "https://api.twilio.com/Media/MM2",
    MediaContentType1: "image/jpeg",
    _mediaJson: JSON.stringify([
      {
        provider: "twilio",
        source: "twilio",
        url: "https://api.twilio.com/Media/MM1",
        contentType: "image/jpeg",
        kind: "image",
      },
      {
        provider: "twilio",
        source: "twilio",
        url: "https://api.twilio.com/Media/MM2",
        contentType: "image/jpeg",
        kind: "image",
      },
    ]),
  };
}

function depsForSignal(signal) {
  return {
    enrichInboundMediaWithOcr: async (list) => list.map((m) => ({ ...m })),
    extractImageMaintenanceSignal: async () => signal,
  };
}

function depsForOcr(ocrText, signal) {
  return {
    enrichInboundMediaWithOcr: async (list) =>
      list.map((m) => ({ ...m, ocr_text: ocrText })),
    extractImageMaintenanceSignal: async () => signal || {
      kind: "screenshot_text",
      ocrText,
      confidence: { ocr: 0.9, issue: 0 },
    },
  };
}

describe("staff capture image signal path", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[require.resolve("../src/inbound/runInboundPipeline.js")];
  });

  test("# + clear photo fills issue and asks for missing property, not generic issue", async () => {
    const mem = createMemorySupabase(seedBase());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "staff-img-issue",
      transportChannel: "sms",
      routerParameter: twilioImageRouterParameter("#"),
      mediaSignalDeps: depsForSignal({
        kind: "photo",
        syntheticBody: "sink leaking",
        issueNameHint: "sink leaking",
        confidence: { issue: 0.82, visual: 0.8 },
      }),
    });

    assert.ok(r.coreRun && r.coreRun.ok, "core should handle staff image turn");
    assert.equal(mem._state.staff_capture_drafts.length, 1);
    assert.match(mem._state.staff_capture_drafts[0].draft_issue, /sink leaking/i);
    assert.notEqual(r.coreRun.expected, "ISSUE");
  });

  test("#staff Penn 403 + clear photo finalizes one ticket with attachment ref", async () => {
    const mem = createMemorySupabase(seedBase());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "staff-img-finalize",
      transportChannel: "sms",
      routerParameter: twilioImageRouterParameter("#staff Penn 403"),
      mediaSignalDeps: depsForSignal({
        kind: "photo",
        syntheticBody: "sink leaking",
        issueNameHint: "sink leaking",
        issueCategoryHint: "plumbing",
        confidence: { issue: 0.86, visual: 0.8 },
      }),
    });

    assert.ok(r.coreRun && r.coreRun.ok, "core should handle staff image turn");
    assert.equal(mem._state.tickets.length, 1);
    assert.equal(mem._state.tickets[0].property_code, "PENN");
    assert.equal(mem._state.tickets[0].unit_label, "403");
    assert.match(mem._state.tickets[0].message_raw, /sink leaking/i);
    assert.match(mem._state.tickets[0].attachments, /https:\/\/api\.twilio\.com\/Media\/MM1/);
  });

  test("screenshot OCR feeds normal staff draft extraction", async () => {
    const mem = createMemorySupabase(seedBase());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "staff-img-ocr",
      transportChannel: "sms",
      routerParameter: twilioImageRouterParameter("# Penn"),
      mediaSignalDeps: depsForOcr("Unit 403 bathroom light is not working"),
    });

    assert.ok(r.coreRun && r.coreRun.ok, "core should handle OCR screenshot");
    assert.equal(mem._state.tickets.length, 1);
    assert.equal(mem._state.tickets[0].unit_label, "403");
    assert.match(mem._state.tickets[0].message_raw, /bathroom light is not working/i);
  });

  test("unclear photo asks for clarification and does not invent an issue", async () => {
    const mem = createMemorySupabase(seedBase());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "staff-img-unclear",
      transportChannel: "sms",
      routerParameter: twilioImageRouterParameter("# Penn 403"),
      mediaSignalDeps: depsForSignal({
        kind: "unknown",
        visualSummary: "Blurry image.",
        needsClarification: true,
        confidence: { issue: 0.1, visual: 0.2 },
      }),
    });

    assert.ok(r.coreRun && r.coreRun.ok, "core should keep draft pending");
    assert.equal(mem._state.tickets.length, 0);
    assert.equal(mem._state.staff_capture_drafts.length, 1);
    assert.equal(String(mem._state.staff_capture_drafts[0].draft_issue || ""), "");
    assert.match(r.coreRun.replyText, /received the photo for PENN 403/i);
  });

  test("multiple photos stay one staff draft/ticket and preserve both refs", async () => {
    const mem = createMemorySupabase(seedBase());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "staff-img-multi",
      transportChannel: "sms",
      routerParameter: twilioMultiImageRouterParameter("# Penn 403"),
      mediaSignalDeps: depsForSignal({
        kind: "photo",
        syntheticBody: "ceiling leak stain",
        issueNameHint: "ceiling leak stain",
        confidence: { issue: 0.76, visual: 0.7 },
      }),
    });

    assert.ok(r.coreRun && r.coreRun.ok, "core should handle multi-photo turn");
    assert.equal(mem._state.tickets.length, 1);
    assert.match(mem._state.tickets[0].message_raw, /ceiling leak stain/i);
    assert.match(mem._state.tickets[0].attachments, /MM1/);
    assert.match(mem._state.tickets[0].attachments, /MM2/);
  });
});
