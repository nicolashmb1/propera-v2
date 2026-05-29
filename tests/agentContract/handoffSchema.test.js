const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  validateAccessHandoff,
  primaryKickbackIntent,
  summarizeHandoffErrors,
  KICKBACK_INTENTS,
  isUuid,
  isDateHintToken,
  isIsoInstant,
} = require("../../src/adapters/agentContract/handoffSchema");
const { ACCESS_INTENT_TYPES } = require("../../src/access/parseAccessIntent");

const VALID_UUID = "11111111-2222-3333-4444-555555555555";

function validReservePayload(overrides = {}) {
  return {
    intentType: ACCESS_INTENT_TYPES.RESERVE,
    locationHint: "Game Room",
    locationId: VALID_UUID,
    startAt: "2026-05-31T14:00:00.000Z",
    endAt: "2026-05-31T16:00:00.000Z",
    dateForDay: "sunday",
    ...overrides,
  };
}

function validListPayload(overrides = {}) {
  return {
    intentType: ACCESS_INTENT_TYPES.LIST_SLOTS,
    locationHint: "Game Room",
    locationId: VALID_UUID,
    dateForDay: "tomorrow",
    startAt: "",
    endAt: "",
    ...overrides,
  };
}

describe("handoffSchema — primitives", () => {
  it("isUuid accepts a canonical UUID", () => {
    assert.equal(isUuid(VALID_UUID), true);
    assert.equal(isUuid("not-a-uuid"), false);
    assert.equal(isUuid(""), false);
    assert.equal(isUuid(undefined), false);
  });

  it("isDateHintToken accepts today/tomorrow/weekday/YYYY-MM-DD only", () => {
    assert.equal(isDateHintToken("today"), true);
    assert.equal(isDateHintToken("Tomorrow"), true);
    assert.equal(isDateHintToken("sunday"), true);
    assert.equal(isDateHintToken("SATURDAY"), true);
    assert.equal(isDateHintToken("2026-05-31"), true);
    assert.equal(isDateHintToken("next sunday"), false);
    assert.equal(isDateHintToken("the weekend"), false);
    assert.equal(isDateHintToken(""), false);
  });

  it("isIsoInstant requires explicit offset or Z", () => {
    assert.equal(isIsoInstant("2026-05-31T14:00:00.000Z"), true);
    assert.equal(isIsoInstant("2026-05-31T10:00:00-04:00"), true);
    assert.equal(isIsoInstant("2026-05-31T14:00:00"), false);
    assert.equal(isIsoInstant("2026-05-31"), false);
    assert.equal(isIsoInstant(""), false);
    assert.equal(isIsoInstant("garbage"), false);
  });
});

describe("handoffSchema — validateAccessHandoff: reserve", () => {
  it("accepts a fully resolved reserve package", () => {
    const r = validateAccessHandoff(validReservePayload());
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("rejects missing intentType with need_intent", () => {
    const r = validateAccessHandoff({ ...validReservePayload(), intentType: "" });
    assert.equal(r.ok, false);
    assert.equal(primaryKickbackIntent(r.errors), KICKBACK_INTENTS.NEED_INTENT);
  });

  it("rejects ACCESS_UNKNOWN as intent", () => {
    const r = validateAccessHandoff({ ...validReservePayload(), intentType: "ACCESS_UNKNOWN" });
    assert.equal(r.ok, false);
    assert.equal(primaryKickbackIntent(r.errors), KICKBACK_INTENTS.NEED_INTENT);
  });

  it("rejects locationId that is a name instead of a UUID", () => {
    const r = validateAccessHandoff({ ...validReservePayload(), locationId: "game-room" });
    assert.equal(r.ok, false);
    assert.equal(primaryKickbackIntent(r.errors), KICKBACK_INTENTS.NEED_LOCATION);
  });

  it("rejects empty locationId", () => {
    const r = validateAccessHandoff({ ...validReservePayload(), locationId: "" });
    assert.equal(r.ok, false);
    assert.equal(primaryKickbackIntent(r.errors), KICKBACK_INTENTS.NEED_LOCATION);
  });

  it("rejects ISO without offset (the ambiguous case Date() would accept)", () => {
    const r = validateAccessHandoff({
      ...validReservePayload(),
      startAt: "2026-05-31T14:00:00",
      endAt: "2026-05-31T16:00:00",
    });
    assert.equal(r.ok, false);
    assert.equal(primaryKickbackIntent(r.errors), KICKBACK_INTENTS.NEED_WINDOW);
  });

  it("rejects endAt that is not strictly after startAt", () => {
    const start = "2026-05-31T14:00:00.000Z";
    const r = validateAccessHandoff({
      ...validReservePayload(),
      startAt: start,
      endAt: start,
    });
    assert.equal(r.ok, false);
    assert.equal(primaryKickbackIntent(r.errors), KICKBACK_INTENTS.NEED_WINDOW);
  });

  it("rejects dateForDay that is a free-form phrase", () => {
    const r = validateAccessHandoff({ ...validReservePayload(), dateForDay: "next weekend" });
    assert.equal(r.ok, false);
    assert.equal(primaryKickbackIntent(r.errors), KICKBACK_INTENTS.NEED_DATE);
  });

  it("accepts a YYYY-MM-DD dateForDay (day pipeline canonicalizes either form)", () => {
    const r = validateAccessHandoff({ ...validReservePayload(), dateForDay: "2026-05-31" });
    assert.equal(r.ok, true);
  });
});

describe("handoffSchema — validateAccessHandoff: list_slots", () => {
  it("accepts a fully resolved list_slots package", () => {
    const r = validateAccessHandoff(validListPayload());
    assert.equal(r.ok, true);
  });

  it("does not require startAt/endAt for list_slots", () => {
    const r = validateAccessHandoff({
      ...validListPayload(),
      startAt: "",
      endAt: "",
    });
    assert.equal(r.ok, true);
  });

  it("rejects list_slots without locationId", () => {
    const r = validateAccessHandoff({ ...validListPayload(), locationId: "" });
    assert.equal(r.ok, false);
    assert.equal(primaryKickbackIntent(r.errors), KICKBACK_INTENTS.NEED_LOCATION);
  });

  it("rejects list_slots without dateForDay", () => {
    const r = validateAccessHandoff({ ...validListPayload(), dateForDay: "" });
    assert.equal(r.ok, false);
    assert.equal(primaryKickbackIntent(r.errors), KICKBACK_INTENTS.NEED_DATE);
  });
});

describe("handoffSchema — validateAccessHandoff: cancel/status", () => {
  it("accepts cancel with minimal fields (location optional)", () => {
    const r = validateAccessHandoff({ intentType: ACCESS_INTENT_TYPES.CANCEL });
    assert.equal(r.ok, true);
  });

  it("accepts status with minimal fields", () => {
    const r = validateAccessHandoff({ intentType: ACCESS_INTENT_TYPES.STATUS });
    assert.equal(r.ok, true);
  });
});

describe("handoffSchema — kickback ordering", () => {
  it("returns the first dependency-ordered kickback when multiple errors exist", () => {
    const r = validateAccessHandoff({
      intentType: ACCESS_INTENT_TYPES.RESERVE,
      locationId: "not-a-uuid",
      startAt: "",
      endAt: "",
      dateForDay: "",
    });
    assert.equal(r.ok, false);
    // need_location ranks above need_date and need_window.
    assert.equal(primaryKickbackIntent(r.errors), KICKBACK_INTENTS.NEED_LOCATION);
  });

  it("summarizes errors into a single string for logs", () => {
    const r = validateAccessHandoff({
      intentType: ACCESS_INTENT_TYPES.RESERVE,
      locationId: "",
      startAt: "",
      endAt: "",
      dateForDay: "",
    });
    const summary = summarizeHandoffErrors(r.errors);
    assert.match(summary, /locationId/);
    assert.match(summary, /dateForDay/);
    assert.match(summary, /startAt\/endAt/);
  });
});

describe("handoffSchema — boundary regressions", () => {
  it("rejects null / undefined / non-object payloads", () => {
    assert.equal(validateAccessHandoff(null).ok, false);
    assert.equal(validateAccessHandoff(undefined).ok, false);
    assert.equal(validateAccessHandoff("string").ok, false);
  });

  it("ignores unknown extra fields (forward-compatible)", () => {
    const r = validateAccessHandoff({
      ...validReservePayload(),
      cancelReservationId: "",
      _internalFlag: true,
      somethingElse: "x",
    });
    assert.equal(r.ok, true);
  });
});
