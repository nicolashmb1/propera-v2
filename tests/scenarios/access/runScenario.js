/**
 * Access scenario harness — Piece 5 of the foundation refactor.
 *
 * Replays a declarative fixture (one full tenant conversation) through the
 * real agent + brain seam:
 *
 *   tenant text  -->  maybeHandleAccessTurn  -->  handleAccessInbound  -->  recordTenantAgentAccessResult
 *                       (gather lane)              (brain)                   (state)
 *
 * The harness owns the four indeterminisms that production code reads from
 * the outside world:
 *
 *   1. The LLM  -> scripted per turn via {@link setAccessAgentLlmForTests}.
 *   2. Wall clock -> frozen via a Date shim (DST-safe; `dayResolver` still
 *      computes correct local labels because it uses the real Intl API).
 *   3. Supabase -> in-memory scenario client (tenant_roster, tenant_conversations,
 *      event_log) plus a stubbed `tenantAccessService` for amenity/reservation
 *      access (avoids dragging in the entire DAL for unit-style tests).
 *   4. Env -> set once at module load, before any src/ require fires.
 *
 * Fixture shape: see ./fixtures/README.md
 */

// ---- Env (must be set before any src/ require) -----------------------------

process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.CORE_ENABLED = "1";
process.env.TENANT_AGENT_ENABLED = "1";
process.env.TENANT_AGENT_LLM_ENABLED = "1";
process.env.ACCESS_ENGINE_ENABLED = "1";
process.env.INTAKE_COMPILE_TURN = "1";
process.env.INTAKE_LLM_ENABLED = "0";
process.env.OPENAI_API_KEY = "sk-test-scenario-mock"; // makes openaiApiKey() truthy; LLM is still mocked.
process.env.INTAKE_MEDIA_OCR_ENABLED = "0";
process.env.TELEGRAM_OUTBOUND_ENABLED = "0";
process.env.OUTGATE_CHANNEL_RENDER = "0";
process.env.STRUCTURED_LOG = "0";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");

// ---- Stub injection: tenantAccessService -----------------------------------
//
// The access DAL (`src/dal/accessEngine.js`) reaches into ~10 Supabase tables
// (locations / policies / schedules / blackouts / reservations / passes / locks /
// policy_audit). Building a faithful in-memory mirror is out of scope for
// regression tests at the agent->brain seam, so we replace the upstream
// **service** module (the port) with an in-memory stub. Both
// `maybeHandleAccessTurn` and `handleAccessInbound` import from the same
// module, so a single `require.cache` swap covers both call sites.

const ACCESS_SERVICE_PATH = require.resolve("../../../src/tenant/tenantAccessService.js");

function genPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function maskPin(pin) {
  const s = String(pin || "");
  if (s.length < 2) return "****";
  return "***" + s.slice(-1);
}

// Stub functions in `handleAccessInbound.js` (and friends) are destructured
// from `tenantAccessService` at module load time. That destructured binding
// is permanent for the test process — replacing `require.cache` between
// fixtures does NOT update existing bindings. We therefore close every stub
// function over a single `stateHolder` object whose `.current` pointer the
// harness mutates per fixture. The closure stays alive across fixtures; only
// the data it sees swaps.
const _stubStateHolder = { current: null };

function currentState() {
  if (!_stubStateHolder.current) {
    throw new Error("scenario harness: stub accessed without active state");
  }
  return _stubStateHolder.current;
}

/**
 * Build the stub `tenantAccessService` API. Stateless — reads from the
 * harness-controlled `_stubStateHolder.current` on every call so a single
 * stub instance can serve every fixture.
 */
function createAccessServiceStub() {
  function tenantPropertyCode(ctx) {
    return String(ctx?.propertyCode || "").trim().toUpperCase();
  }
  function activeAmenities(propertyCode) {
    const code = String(propertyCode || "").trim().toUpperCase();
    return currentState()
      .amenities.filter(
        (a) => String(a.propertyCode || "").toUpperCase() === code && a.active !== false
      )
      .map((a) => ({ ...a }));
  }

  function tenantReservations(ctx) {
    const tid = String(ctx?.tenantId || "").trim();
    return currentState()
      .reservations.filter((r) => String(r.tenantId || "").trim() === tid)
      .map((r) => ({ ...r }));
  }

  function locationById(id) {
    return currentState().amenities.find((a) => String(a.id) === String(id)) || null;
  }

  return {
    /** Mirrors {@link src/tenant/tenantAccessService.listTenantAccessLocations}. */
    async listTenantAccessLocations(ctx) {
      return activeAmenities(tenantPropertyCode(ctx));
    },

    async getPublicAccessLocation(orgId, propertyCode, slug) {
      const code = String(propertyCode || "").trim().toUpperCase();
      const s = String(slug || "").trim().toLowerCase();
      return (
        state.amenities.find(
          (a) =>
            String(a.propertyCode || "").toUpperCase() === code &&
            String(a.slug || "").toLowerCase() === s &&
            a.active !== false
        ) || null
      );
    },

    async getTenantAccessLocationBySlug(ctx, slug) {
      return this.getPublicAccessLocation("", tenantPropertyCode(ctx), slug);
    },

    async listTenantAccessReservations(ctx) {
      // Most-recent first, matching production behavior.
      return tenantReservations(ctx).sort(
        (a, b) => String(b.startAt || "").localeCompare(String(a.startAt || ""))
      );
    },

    async getTenantAccessReservation(ctx, reservationId) {
      const tid = String(ctx?.tenantId || "").trim();
      const id = String(reservationId || "").trim();
      return (
        state.reservations.find(
          (r) => String(r.id) === id && String(r.tenantId || "").trim() === tid
        ) || null
      );
    },

    async checkTenantCanReserve(ctx, locationId, startAt, endAt) {
      const loc = locationById(locationId);
      if (!loc || String(loc.propertyCode || "").toUpperCase() !== tenantPropertyCode(ctx)) {
        return { allowed: false, reason: "location_not_found" };
      }
      const newStart = new Date(startAt).getTime();
      const newEnd = new Date(endAt).getTime();
      if (!Number.isFinite(newStart) || !Number.isFinite(newEnd) || newEnd <= newStart) {
        return { allowed: false, reason: "invalid_time_range" };
      }
      // Overlap with any CONFIRMED/PENDING booking at the same location is a hard reject.
      const overlap = currentState().reservations.find((r) => {
        if (String(r.locationId) !== String(locationId)) return false;
        const status = String(r.status || "").toUpperCase();
        if (!["PENDING_APPROVAL", "CONFIRMED", "ACTIVE"].includes(status)) return false;
        const rs = new Date(r.startAt).getTime();
        const re = new Date(r.endAt).getTime();
        return newStart < re && newEnd > rs;
      });
      if (overlap) return { allowed: false, reason: "overlap" };
      return { allowed: true };
    },

    async createTenantAccessReservation(ctx, body) {
      const loc = locationById(body.locationId);
      if (!loc) {
        const err = new Error("location_not_found");
        err.code = "location_not_found";
        throw err;
      }
      const pin = genPin();
      const reservation = {
        id: crypto.randomUUID(),
        tenantId: String(ctx?.tenantId || "").trim(),
        locationId: String(body.locationId || "").trim(),
        locationName: loc.name,
        locationSlug: loc.slug,
        startAt: String(body.startAt || "").trim(),
        endAt: String(body.endAt || "").trim(),
        status: "CONFIRMED",
        channel: String(body.channel || "test").toLowerCase(),
        pin,
        pinMasked: maskPin(pin),
        createdAt: new Date().toISOString(),
      };
      currentState().reservations.push(reservation);
      return { ...reservation };
    },

    async cancelTenantAccessReservation(ctx, reservationId) {
      const id = String(reservationId || "").trim();
      const tid = String(ctx?.tenantId || "").trim();
      const r = currentState().reservations.find(
        (x) => String(x.id) === id && String(x.tenantId || "").trim() === tid
      );
      if (!r) {
        const err = new Error("not_found");
        err.code = "not_found";
        throw err;
      }
      r.status = "CANCELLED";
      return { ...r };
    },

    async listSchedulesForTenantLocation(ctx, locationId) {
      const loc = locationById(locationId);
      if (!loc || String(loc.propertyCode || "").toUpperCase() !== tenantPropertyCode(ctx)) {
        return [];
      }
      return (currentState().schedules || [])
        .filter((s) => String(s.locationId) === String(locationId))
        .map((s) => ({
          dayOfWeek: s.dayOfWeek ?? s.day_of_week,
          openTime: s.openTime ?? s.open_time,
          closeTime: s.closeTime ?? s.close_time,
        }));
    },

    async listDayReservationsForTenantLocation(ctx, locationId, dayAnchorIso) {
      const loc = locationById(locationId);
      if (!loc || String(loc.propertyCode || "").toUpperCase() !== tenantPropertyCode(ctx)) {
        return [];
      }
      // The brain uses dayResolver to bound the day. We mirror that here so
      // the harness behaves like production: anything overlapping the property-
      // local day of the anchor counts.
      const { dayBoundsForInstant } = require("../../../src/access/dayResolver");
      const { startUtc, endUtc } = dayBoundsForInstant(dayAnchorIso);
      const dayStart = new Date(startUtc).getTime();
      const dayEnd = new Date(endUtc).getTime();
      return currentState()
        .reservations.filter((r) => String(r.locationId) === String(locationId))
        .filter((r) => {
          const status = String(r.status || "").toUpperCase();
          return ["PENDING_APPROVAL", "CONFIRMED", "ACTIVE"].includes(status);
        })
        .filter((r) => {
          const rs = new Date(r.startAt).getTime();
          const re = new Date(r.endAt).getTime();
          return rs < dayEnd && re > dayStart;
        })
        .map((r) => ({ ...r }));
    },
  };
}

// Single shared stub object — registered into require.cache exactly once per
// test process. Destructured imports in `handleAccessInbound.js` capture these
// function references at first load; we cannot replace them after that, so we
// instead route every call through `currentState()` (see comment on
// `_stubStateHolder`).
const _sharedStub = createAccessServiceStub();
let _stubInstalled = false;

function installAccessServiceStub(state) {
  if (!_stubInstalled) {
    require.cache[ACCESS_SERVICE_PATH] = {
      id: ACCESS_SERVICE_PATH,
      filename: ACCESS_SERVICE_PATH,
      loaded: true,
      children: [],
      paths: [path.dirname(ACCESS_SERVICE_PATH)],
      exports: _sharedStub,
    };
    _stubInstalled = true;
  }
  _stubStateHolder.current = state;
  return function uninstall() {
    _stubStateHolder.current = null;
    // We DO NOT delete from require.cache — destructured bindings in
    // downstream modules would dangle. Leaving the stub installed is the
    // only safe option for serial fixture replay.
  };
}

// ---- Date freezing ---------------------------------------------------------

function freezeNow(iso) {
  const fixed = new Date(iso).getTime();
  if (!Number.isFinite(fixed)) throw new Error("invalid frozenNow: " + iso);
  const RealDate = Date;
  function FrozenDate(...args) {
    if (!(this instanceof FrozenDate)) return new FrozenDate(...args);
    if (args.length === 0) return Reflect.construct(RealDate, [fixed], FrozenDate);
    return Reflect.construct(RealDate, args, FrozenDate);
  }
  Object.setPrototypeOf(FrozenDate.prototype, RealDate.prototype);
  Object.setPrototypeOf(FrozenDate, RealDate);
  FrozenDate.now = () => fixed;
  FrozenDate.UTC = RealDate.UTC;
  FrozenDate.parse = RealDate.parse;
  global.Date = FrozenDate;
  return function unfreeze() {
    global.Date = RealDate;
  };
}

// ---- LLM scripting ---------------------------------------------------------

/**
 * Build the per-turn LLM mock from fixture turns.
 *
 * Each turn may set `llm` to a literal `runAccessAgentLlmTurn` result
 * (`{ ok, reply, accessIntent, partialUpdates, handoffReady }`) OR a shorthand
 * `llmShorthand` we normalize here. `llm: null` (or absent) means the harness
 * does not expect the LLM to be invoked on this turn — if it IS invoked we fail
 * loudly so silent regressions don't pass.
 */
function buildLlmResponder(turns, ctx) {
  // Normalize the fixture's `accessIntent` through the same mapper the real
  // `runAccessAgentLlmTurn` uses, so fixtures speak the LLM wire format
  // ("reserve", "list_slots", "switch_maintenance", ...) just like
  // `accessSystemPrompt.js` teaches a real LLM to emit.
  const { normalizeAccessIntent } = require("../../../src/adapters/tenantAgent/mergeAccessPartialFromLlm");
  // `ctx.activeTurnIdx` is set by `driveTurn` before each call. We index by
  // turn (not by LLM call count) so turns where the LLM ISN'T invoked don't
  // shift later turns' scripts out of alignment.
  return async (_opts) => {
    const i = ctx.activeTurnIdx;
    const turn = turns[i];
    if (!turn) {
      throw new Error(
        `[${ctx.fixtureName}] LLM invoked but no turn at index ${i}.`
      );
    }
    ctx.llmCallCounts[i] = (ctx.llmCallCounts[i] || 0) + 1;
    if (!turn.llm) {
      throw new Error(
        `[${ctx.fixtureName}] turn ${i + 1} did not script an LLM response but the LLM was invoked.`
      );
    }
    const llm = turn.llm;
    return {
      ok: llm.ok !== false,
      reply: String(llm.reply || "").trim(),
      accessIntent: normalizeAccessIntent(llm.accessIntent || ""),
      partialUpdates: llm.partialUpdates || {},
      handoffReady: llm.handoffReady === true,
      err: String(llm.err || ""),
    };
  };
}

// ---- Memory Supabase seeding -----------------------------------------------

function seedMemorySupabase(fixture) {
  const {
    createScenarioMemorySupabase,
  } = require("../../helpers/memorySupabaseScenario");
  const tenant = fixture.tenant;
  const seed = {
    properties: [
      {
        id: crypto.randomUUID(),
        property_code: tenant.propertyCode,
        active: true,
      },
    ],
    tenant_roster: [
      {
        id: tenant.tenantId,
        property_code: tenant.propertyCode,
        unit_label: tenant.unitLabel,
        resident_name: tenant.residentName || "",
        phone_e164: tenant.phoneE164,
        active: true,
        updated_at: new Date(Date.parse(fixture.frozenNow) - 1000).toISOString(),
      },
    ],
    tenant_conversations: [],
    event_log: [],
    telegram_chat_link: tenant.telegramChatId
      ? [
          {
            telegram_user_id: String(tenant.telegramUserId || "").replace(/\D/g, ""),
            telegram_chat_id: String(tenant.telegramChatId),
            phone_e164: tenant.phoneE164,
            active: true,
          },
        ]
      : [],
  };
  return createScenarioMemorySupabase(seed);
}

// ---- Per-turn driver -------------------------------------------------------

/**
 * Drive one tenant message through the agent->brain seam and surface a
 * snapshot of the visible outcome plus the persisted conversation state.
 */
async function driveTurn(o) {
  const { fixture, turn, turnIdx } = o;
  const tenant = fixture.tenant;
  const {
    maybeHandleAccessTurn,
  } = require("../../../src/adapters/tenantAgent/maybeHandleAccessTurn");
  const {
    handleAccessInbound,
  } = require("../../../src/access/handleAccessInbound");
  const {
    recordTenantAgentAccessResult,
  } = require("../../../src/adapters/tenantAgent/recordTenantAgentAccessResult");
  const {
    loadTenantConversation,
  } = require("../../../src/adapters/tenantAgent/conversationStore");

  const transportChannel = String(tenant.transportChannel || "sms").toLowerCase();
  const tenantActorKey = String(tenant.phoneE164 || "").trim();
  const traceId = `scen-${fixture.name || "anon"}-t${turnIdx + 1}-${crypto.randomUUID().slice(0, 8)}`;

  const routerParameter = {
    Body: String(turn.userMessage || "").trim(),
    From: tenantActorKey,
    _phoneE164: tenantActorKey,
    _channel: transportChannel.toUpperCase(),
    _canonicalBrainActorKey: tenantActorKey,
  };

  const convBefore = await loadTenantConversation(tenantActorKey, transportChannel);

  // Mirror `dispatchByActiveLane` — once the conversation is on the access
  // lane, subsequent turns route INTO the lane even when the raw text
  // wouldn't satisfy `shouldRouteToAccessTurn` on its own (a one-word
  // "saturday" correction is the canonical example). The fixture can still
  // explicitly set `lockedLane: true` for first-turn routing experiments.
  const { readActiveLane, CONVERSATION_LANE } = require("../../../src/adapters/tenantAgent/conversationState");
  const inAccessLane =
    readActiveLane(convBefore?.partial_package) === CONVERSATION_LANE.ACCESS;
  const lockedLane = turn.lockedLane === true || inAccessLane;

  // `injectPayload` short-circuits the agent gather gate and feeds a
  // hand-crafted handoff payload straight into the brain. Use only for
  // testing handoff-schema kickback paths — `shouldHandoffAccess` already
  // refuses malformed payloads in normal flow, so the schema validator only
  // fires on payloads the agent gate would otherwise have rejected.
  let agentTurn;
  if (turn.injectPayload) {
    agentTurn = {
      handled: true,
      phase: "access_handoff",
      routerParameter: {
        _accessPayloadJson: JSON.stringify(turn.injectPayload),
        _accessIntentType: String(turn.injectPayload.intentType || "").trim(),
      },
      conversationId: convBefore?.id || "",
      tenantLocale: convBefore?.tenant_locale || "en",
    };
  } else {
    agentTurn = await maybeHandleAccessTurn({
      conv: convBefore,
      bodyText: routerParameter.Body,
      routerParameter,
      tenantActorKey,
      transportChannel,
      traceId,
      lockedLane,
    });
  }

  // Snapshot before brain runs.
  const snapshot = {
    turnIdx,
    userMessage: routerParameter.Body,
    phase: agentTurn ? String(agentTurn.phase || "") : null,
    agentReplyText: agentTurn ? String(agentTurn.replyText || "") : null,
    handled: !!(agentTurn && agentTurn.handled),
    brain: null,
    brainReplyText: null,
    accessFacts: null,
    reservationId: "",
    locationId: "",
    startAt: "",
    endAt: "",
  };

  if (agentTurn && agentTurn.phase === "access_handoff" && agentTurn.routerParameter) {
    Object.assign(routerParameter, agentTurn.routerParameter);
    const accessResult = await handleAccessInbound({
      traceId,
      transportChannel,
      routerParameter,
    });
    if (accessResult && accessResult.handled) {
      snapshot.brain = String(accessResult.brain || "");
      snapshot.brainReplyText = String(accessResult.replyText || "");
      snapshot.accessFacts = accessResult.accessFacts || null;
      snapshot.reservationId = String(accessResult.reservationId || "");
      snapshot.locationId = String(accessResult.locationId || "");
      snapshot.startAt = String(accessResult.startAt || "");
      snapshot.endAt = String(accessResult.endAt || "");
      const conversationId = agentTurn.conversationId || convBefore?.id || "";
      if (conversationId) {
        await recordTenantAgentAccessResult({
          conversationId,
          traceId,
          accessRun: {
            brain: snapshot.brain,
            replyText: snapshot.brainReplyText,
            reason: accessResult.reason || "",
            accessFacts: snapshot.accessFacts,
            reservationId: snapshot.reservationId,
            locationId: snapshot.locationId,
            startAt: snapshot.startAt,
            endAt: snapshot.endAt,
          },
        });
      }
    }
  }

  const convAfter = await loadTenantConversation(tenantActorKey, transportChannel);
  snapshot.conversation = convAfter
    ? {
        status: String(convAfter.status || ""),
        turnCount: Number(convAfter.turn_count || 0),
        partial: convAfter.partial_package || {},
      }
    : null;

  // Effective reply text — what the tenant would actually see.
  snapshot.replyText = snapshot.brainReplyText || snapshot.agentReplyText || "";
  return snapshot;
}

// ---- Expectation matcher ---------------------------------------------------

function matchExpectations(snapshot, expect, ctx) {
  const errors = [];
  function fail(msg) {
    errors.push(msg);
  }

  if (expect.phase != null && snapshot.phase !== expect.phase) {
    fail(`phase: expected ${JSON.stringify(expect.phase)}, got ${JSON.stringify(snapshot.phase)}`);
  }
  if (expect.brain != null && snapshot.brain !== expect.brain) {
    fail(`brain: expected ${JSON.stringify(expect.brain)}, got ${JSON.stringify(snapshot.brain)}`);
  }
  if (expect.handled != null && snapshot.handled !== !!expect.handled) {
    fail(`handled: expected ${expect.handled}, got ${snapshot.handled}`);
  }
  if (expect.replyContains) {
    const want = Array.isArray(expect.replyContains) ? expect.replyContains : [expect.replyContains];
    for (const w of want) {
      if (!snapshot.replyText.toLowerCase().includes(String(w).toLowerCase())) {
        fail(`replyContains: missing substring ${JSON.stringify(w)} in ${JSON.stringify(snapshot.replyText)}`);
      }
    }
  }
  if (expect.replyMatches) {
    const re = new RegExp(expect.replyMatches, "i");
    if (!re.test(snapshot.replyText)) {
      fail(`replyMatches: /${expect.replyMatches}/i did not match ${JSON.stringify(snapshot.replyText)}`);
    }
  }
  if (expect.kickbackIntent) {
    const k = snapshot.accessFacts?.kickbackIntent || "";
    if (k !== expect.kickbackIntent) {
      fail(`kickbackIntent: expected ${JSON.stringify(expect.kickbackIntent)}, got ${JSON.stringify(k)}`);
    }
  }
  if (expect.lane != null) {
    const lane = snapshot.conversation?.partial?._active_lane || null;
    if (lane !== expect.lane) {
      fail(`lane: expected ${JSON.stringify(expect.lane)}, got ${JSON.stringify(lane)}`);
    }
  }
  if (expect.hasLastBooking != null) {
    const hasBooking = !!(snapshot.conversation?.partial?._access_last_booking?.reservationId);
    if (hasBooking !== !!expect.hasLastBooking) {
      fail(`hasLastBooking: expected ${expect.hasLastBooking}, got ${hasBooking}`);
    }
  }
  if (expect.reservationsCount != null) {
    if (ctx.state.reservations.length !== expect.reservationsCount) {
      fail(
        `reservationsCount: expected ${expect.reservationsCount}, got ${ctx.state.reservations.length}`
      );
    }
  }
  if (expect.activeReservationsCount != null) {
    const active = ctx.state.reservations.filter((r) =>
      ["PENDING_APPROVAL", "CONFIRMED", "ACTIVE"].includes(String(r.status || "").toUpperCase())
    ).length;
    if (active !== expect.activeReservationsCount) {
      fail(`activeReservationsCount: expected ${expect.activeReservationsCount}, got ${active}`);
    }
  }

  if (errors.length > 0) {
    throw new assert.AssertionError({
      message: `[${ctx.fixtureName}] turn ${ctx.turnIdx + 1} ("${snapshot.userMessage}") failed:\n  - ${errors.join("\n  - ")}\n  snapshot: ${JSON.stringify({ phase: snapshot.phase, brain: snapshot.brain, replyText: snapshot.replyText }, null, 2)}`,
    });
  }
}

// ---- Top-level entrypoint --------------------------------------------------

/**
 * @typedef {object} ScenarioFixture
 * @property {string} name
 * @property {string} [description]
 * @property {string} frozenNow ISO instant; controls `new Date()` and all derived dates.
 * @property {string} [timezone] PROPERA_TZ override; defaults to America/New_York.
 * @property {object} tenant     `{ tenantId, propertyCode, unitLabel, residentName, phoneE164, transportChannel? }`.
 * @property {object[]} amenities `[{ id, slug, name, propertyCode, active }]`.
 * @property {object[]} [initialReservations] Pre-seeded bookings.
 * @property {object[]} turns    Per-turn `{ userMessage, llm, expect, lockedLane? }`.
 */

/**
 * @typedef {object} ScenarioState
 * @property {object[]} amenities
 * @property {object[]} reservations
 */

/**
 * Run a single fixture end-to-end. Idempotent and side-effect-free across calls.
 * Returns the array of per-turn snapshots so callers can inspect for richer
 * assertions if needed.
 *
 * @param {ScenarioFixture} fixture
 */
async function runScenario(fixture) {
  if (!fixture || typeof fixture !== "object") throw new Error("missing fixture");
  if (!fixture.name) throw new Error("fixture.name required");
  if (!fixture.frozenNow) throw new Error("fixture.frozenNow required");
  if (!fixture.tenant) throw new Error("fixture.tenant required");
  if (!Array.isArray(fixture.amenities)) throw new Error("fixture.amenities required");
  if (!Array.isArray(fixture.turns) || fixture.turns.length === 0) {
    throw new Error("fixture.turns required (non-empty array)");
  }

  process.env.PROPERA_TZ = String(fixture.timezone || "America/New_York");

  const unfreezeDate = freezeNow(fixture.frozenNow);

  const state = {
    amenities: fixture.amenities.map((a) => ({ active: true, ...a })),
    reservations: (fixture.initialReservations || []).map((r) => ({ ...r })),
    schedules: (fixture.initialSchedules || []).map((s) => ({ ...s })),
  };

  const uninstallStub = installAccessServiceStub(state);

  // setSupabaseClientForTests / clearSupabaseClientForTests are loaded AFTER the
  // stub is installed so any transitive require of tenantAccessService inside
  // the supabase module would still hit the stub (defensive — currently no such
  // dependency exists, but keeps the seam clean).
  const {
    setSupabaseClientForTests,
    clearSupabaseClientForTests,
  } = require("../../../src/db/supabase");
  const {
    setAccessAgentLlmForTests,
    clearAccessAgentLlmForTests,
  } = require("../../../src/adapters/tenantAgent/accessAgentLlmTurn");

  const sb = seedMemorySupabase(fixture);
  setSupabaseClientForTests(sb);

  const ctx = {
    fixtureName: fixture.name,
    state,
    activeTurnIdx: -1,
    llmCallCounts: {},
  };
  setAccessAgentLlmForTests(buildLlmResponder(fixture.turns, ctx));

  const snapshots = [];
  try {
    for (let i = 0; i < fixture.turns.length; i += 1) {
      const turn = fixture.turns[i];
      ctx.activeTurnIdx = i;
      const snap = await driveTurn({ fixture, turn, turnIdx: i });
      snapshots.push(snap);
      if (turn.expect) {
        matchExpectations(snap, turn.expect, { ...ctx, turnIdx: i });
      }
    }
  } finally {
    clearAccessAgentLlmForTests();
    clearSupabaseClientForTests();
    uninstallStub();
    unfreezeDate();
  }
  return snapshots;
}

module.exports = {
  runScenario,
  // Exported for ad-hoc tests / debugging fixtures.
  createAccessServiceStub,
  freezeNow,
  installAccessServiceStub,
  seedMemorySupabase,
};
