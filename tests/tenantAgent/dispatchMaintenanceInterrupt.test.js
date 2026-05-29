/**
 * Regression test: deterministic maintenance interrupt is ALWAYS-ON.
 *
 * Bug history (May 27 2026): with the LLM enabled in prod, a tenant on the
 * access lane wrote "send someone tomorrow morning to look at my sink ..
 * slow drip ... water under cabinets" and the bot replied with another
 * Game Room availability message. Root cause: `dispatchByActiveLane` gated
 * the deterministic `isStrongMaintenanceInterrupt` check behind
 * `if (!llmIsActive())`. When the LLM was on, the safety net was off, and
 * the LLM silently misclassified the maintenance request as a list_slots
 * intent because the prior turn had stamped one into `_access_request`.
 *
 * Doctrine (PROPERA_NORTH_COMPASS.md): "AI is interpretation, not control."
 * Lane decisions are control. The regex is the deterministic control rule;
 * the LLM is an accelerator for nuanced phrasings the regex doesn't match.
 *
 * This test pins the safety net in place. It bypasses the supabase DAL by
 * stubbing the only two side-effect modules dispatch reaches into
 * (`conversationStore` for save, `dal/appendEventLog` for the audit trail).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// --- Side-effect stubs ------------------------------------------------------

const _savedConvs = [];
const _eventLogs = [];

const conversationStorePath = require.resolve("../../src/adapters/tenantAgent/conversationStore.js");
require.cache[conversationStorePath] = {
  id: conversationStorePath,
  filename: conversationStorePath,
  loaded: true,
  exports: {
    appendMessage(convOrSeed, role, content) {
      const base = convOrSeed && convOrSeed.messages ? convOrSeed : { messages: [] };
      return {
        ...base,
        messages: [...(base.messages || []), { role, content, at: "2026-05-27T20:00:00.000Z" }],
      };
    },
    async saveTenantConversation(conv) {
      _savedConvs.push(conv);
      return { ...conv, id: conv.id || "conv-stub-id" };
    },
    async loadTenantConversation() {
      return null;
    },
  },
};

const appendEventLogPath = require.resolve("../../src/dal/appendEventLog.js");
require.cache[appendEventLogPath] = {
  id: appendEventLogPath,
  filename: appendEventLogPath,
  loaded: true,
  exports: {
    async appendEventLog(entry) {
      _eventLogs.push(entry);
    },
  },
};

// Force LLM-active so we exercise the path that used to be broken. The
// previous code only ran the maintenance regex when `!llmIsActive()`.
process.env.TENANT_AGENT_LLM_ENABLED = "1";
process.env.OPENAI_API_KEY = "sk-test-dispatch";

const {
  dispatchByActiveLane,
} = require("../../src/adapters/tenantAgent/dispatchByActiveLane");
const {
  CONVERSATION_LANE,
} = require("../../src/adapters/tenantAgent/conversationState");

function buildAccessConv(overrides = {}) {
  return {
    id: "conv-1",
    tenant_actor_key: "+15551234001",
    transport_channel: "telegram",
    status: "gathering",
    turn_count: 5,
    tenant_locale: "en",
    messages: [],
    partial_package: {
      _active_lane: CONVERSATION_LANE.ACCESS,
      _access_request: {
        intentType: "ACCESS_LIST_SLOTS",
        dateForDay: "sunday",
        locationId: "aca90432-7fca-43e0-9336-37645727b6cc",
        locationHint: "Game Room",
      },
      _access_last_booking: {
        reservationId: "res-1",
        startAt: "2026-05-31T12:00:00.000Z",
        endAt: "2026-05-31T16:00:00.000Z",
      },
      _access_last_error: {
        brain: "access_slots_listed",
        replyText: "On 5/31/2026, Game Room is already booked: 8:00 AM-12:00 PM.",
      },
      ...(overrides.partial_package || {}),
    },
    ...overrides,
  };
}

function resetCapture() {
  _savedConvs.length = 0;
  _eventLogs.length = 0;
}

describe("dispatchByActiveLane: maintenance interrupt safety net", () => {
  it("fires for the sink/drip phrase that hit prod (LLM-active mode)", async () => {
    resetCapture();
    const conv = buildAccessConv();
    const result = await dispatchByActiveLane({
      conv,
      bodyText:
        "thanks.. also can u send someone tomorrow morning to look at my sink .. i think it has a slow drip. ive seen water under the cabinets a few times. nothing urgent.",
      routerParameter: {},
      tenantActorKey: "+15551234001",
      traceId: "trace-test-1",
      transportChannel: "telegram",
    });

    assert.equal(result, null, "dispatch must return null so maintenance gather picks up the turn");

    assert.equal(_savedConvs.length, 1, "expected exactly one save (lane cleared)");
    const partial = _savedConvs[0].partial_package;
    assert.equal(
      partial._active_lane,
      undefined,
      "_active_lane must be stripped after safety net fires"
    );
    assert.equal(
      partial._access_request,
      undefined,
      "_access_request must be stripped so next turn doesn't re-run list_slots"
    );
    assert.equal(
      partial._access_last_error,
      undefined,
      "_access_last_error must be stripped (it's a cache of the rejection that just got superseded)"
    );
    assert.ok(
      partial._access_last_booking,
      "_access_last_booking must survive — successful bookings are not erased by lane switch"
    );

    assert.equal(_eventLogs.length, 1, "exactly one audit event must be emitted");
    const ev = _eventLogs[0];
    assert.equal(ev.event, "TENANT_AGENT_ACCESS_LANE_DETERMINISTIC_INTERRUPT");
    assert.equal(ev.log_kind, "tenant_agent");
    assert.equal(ev.payload.to, "maintenance");
    assert.equal(ev.payload.llm_active, true);
    assert.equal(ev.payload.tenant_actor_key, "+15551234001");
  });

  it("fires for the explicit 'i need maintenance' fallback", async () => {
    resetCapture();
    const conv = buildAccessConv();
    const result = await dispatchByActiveLane({
      conv,
      bodyText: "i need maintenance",
      routerParameter: {},
      tenantActorKey: "+15551234001",
      traceId: "trace-test-2",
      transportChannel: "telegram",
    });

    assert.equal(result, null);
    assert.equal(_savedConvs.length, 1, "lane must be cleared for explicit 'maintenance' word");
    assert.equal(_savedConvs[0].partial_package._active_lane, undefined);
    assert.equal(_eventLogs.length, 1);
    assert.equal(_eventLogs[0].event, "TENANT_AGENT_ACCESS_LANE_DETERMINISTIC_INTERRUPT");
  });

  it("does NOT fire for a normal access correction ('saturday not sunday')", async () => {
    resetCapture();
    const conv = buildAccessConv();
    const result = await dispatchByActiveLane({
      conv,
      bodyText: "sorry saturday not sunday",
      routerParameter: {},
      tenantActorKey: "+15551234001",
      traceId: "trace-test-3",
      transportChannel: "telegram",
    });

    assert.equal(_eventLogs.length, 0, "no audit event on a normal day correction");
    // Note: `result` may be non-null because `maybeHandleAccessTurn` runs.
    // The contract we care about for this test is: the safety net stays quiet.
    // Whatever maybeHandleAccessTurn returns is fine for this case.
  });

  it("does NOT fire maintenance interrupt for thanks (deterministic close instead)", async () => {
    resetCapture();
    const conv = buildAccessConv();
    const result = await dispatchByActiveLane({
      conv,
      bodyText: "thanks",
      routerParameter: {},
      tenantActorKey: "+15551234001",
      traceId: "trace-test-4",
      transportChannel: "telegram",
    });

    assert.equal(
      _eventLogs.filter((e) => e.event === "TENANT_AGENT_ACCESS_LANE_DETERMINISTIC_INTERRUPT").length,
      0
    );
    assert.equal(result?.handled, true);
    assert.equal(_eventLogs[0]?.event, "TENANT_AGENT_ACCESS_LANE_DETERMINISTIC_CLOSE");
  });

  it("closes lane after booking on 'ok. thanks brother' without re-reserving", async () => {
    resetCapture();
    const conv = buildAccessConv({
      partial_package: {
        _active_lane: "access",
        _access_last_booking: {
          reservationId: "res-booked",
          locationId: "aca90432-7fca-43e0-9336-37645727b6cc",
          locationHint: "Game Room",
          dateForDay: "today",
          startAt: "2026-05-31T21:00:00.000Z",
          endAt: "2026-05-31T23:00:00.000Z",
        },
        _access_request: undefined,
      },
    });
    const result = await dispatchByActiveLane({
      conv,
      bodyText: "ok. thanks brother",
      routerParameter: {},
      tenantActorKey: "+15551234001",
      traceId: "trace-test-5",
      transportChannel: "telegram",
    });

    assert.equal(result?.handled, true);
    assert.match(String(result?.replyText || ""), /all set|talk soon/i);
    assert.equal(_savedConvs[0].partial_package._active_lane, undefined);
    assert.equal(
      _eventLogs.some((e) => e.event === "TENANT_AGENT_ACCESS_LANE_DETERMINISTIC_CLOSE"),
      true
    );
  });
});
