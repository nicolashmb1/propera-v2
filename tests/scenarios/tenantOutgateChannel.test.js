/**
 * Outgate Phase 4 — first-contact property header + SMS footer via pipeline channel render.
 */
require("../helpers/legacyPipelineEnv");
process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.INTAKE_COMPILE_TURN = "1";
process.env.INTAKE_LLM_ENABLED = "0";
process.env.OPENAI_API_KEY = "";
process.env.INTAKE_MEDIA_OCR_ENABLED = "0";
process.env.TELEGRAM_OUTBOUND_ENABLED = "0";
process.env.OUTGATE_CHANNEL_RENDER = "1";
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
const { SMS_COMPLIANCE_FOOTER } = require("../../src/outgate/renderForChannel");

const PIPELINE = require.resolve("../../src/inbound/runInboundPipeline.js");

describe("scenarios — tenant outgate channel (Phase 4)", { concurrency: false }, () => {
  afterEach(() => {
    clearSupabaseClientForTests();
    delete require.cache[PIPELINE];
  });

  test("first SMS finalize today — property header + STOP footer on channel body", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "og-ch-1",
      transportChannel: "sms",
      routerParameter: {
        Body: "sink leaking 303 penn",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    const channel = String(r.channelRenderedBody || "");
    assert.match(channel, /The Grand at Penn — maintenance/);
    assert.match(channel, /Ref #/);
    assert.match(channel, new RegExp(SMS_COMPLIANCE_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(mem._state.tenant_outbound_day_mark.length, 1);
    assert.equal(
      String(mem._state.tenant_outbound_day_mark[0].tenant_actor_key),
      SCENARIO_TENANT_E164
    );
  });

  test("second SMS same day — no duplicate STOP footer", async () => {
    const { opsDateKeyInProperaTz } = require("../../src/dal/tenantOutboundDayMark");
    const mem = createScenarioMemorySupabase({
      ...scenarioMaintenanceSeedPenn(),
      tenant_outbound_day_mark: [
        {
          tenant_actor_key: SCENARIO_TENANT_E164,
          ops_date: opsDateKeyInProperaTz(),
          first_outbound_at: new Date().toISOString(),
        },
      ],
    });
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "og-ch-2",
      transportChannel: "sms",
      routerParameter: {
        Body: "410 penn door lock stuck",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    assert.equal(r.coreRun && r.coreRun.brain, "core_finalized");
    const channel = String(r.channelRenderedBody || "");
    assert.match(channel, /Ref #/);
    assert.doesNotMatch(channel, /Reply STOP to opt out/i);
    assert.doesNotMatch(channel, /The Grand at Penn — maintenance/);
  });

  test("core replyText unchanged — channel render is dispatch layer only", async () => {
    const mem = createScenarioMemorySupabase(scenarioMaintenanceSeedPenn());
    setSupabaseClientForTests(mem);
    const { runInboundPipeline } = require("../../src/inbound/runInboundPipeline");

    const r = await runInboundPipeline({
      traceId: "og-ch-3",
      transportChannel: "sms",
      routerParameter: {
        Body: "sink leaking 303 penn",
        From: SCENARIO_TENANT_E164,
        _phoneE164: SCENARIO_TENANT_E164,
      },
    });

    const coreReply = String((r.coreRun && r.coreRun.replyText) || "");
    const channel = String(r.channelRenderedBody || "");
    assert.doesNotMatch(coreReply, /Reply STOP/i);
    assert.match(channel, /Reply STOP/i);
  });
});
