const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  CONVERSATION_LANE,
  ACCESS_FIELD,
  normalizePartialPackage,
  readActiveLane,
  withActiveLane,
  withoutActiveLane,
  readAccessRequest,
  withAccessRequest,
  withoutAccessRequest,
  readAccessLastBooking,
  withAccessLastBooking,
  withoutAccessLastBooking,
  readAccessLastError,
  withAccessLastError,
  withoutAccessLastError,
  recordAccessBookingSuccess,
  recordAccessBrainRejection,
  clearAccessLane,
} = require("../../src/adapters/tenantAgent/conversationState");

describe("conversationState — normalize", () => {
  it("returns {} for null / undefined", () => {
    assert.deepEqual(normalizePartialPackage(null), {});
    assert.deepEqual(normalizePartialPackage(undefined), {});
  });

  it("preserves unknown keys (maintenance + dedupe state stay)", () => {
    const raw = {
      issue: "leaky sink",
      _related_ticket_candidates: ["t-1"],
      _follow_up_pending: { kind: "schedule" },
      _last_inbound_at: "2026-05-27T10:00:00.000Z",
    };
    const out = normalizePartialPackage(raw);
    assert.equal(out.issue, "leaky sink");
    assert.deepEqual(out._related_ticket_candidates, ["t-1"]);
    assert.deepEqual(out._follow_up_pending, { kind: "schedule" });
    assert.equal(out._last_inbound_at, "2026-05-27T10:00:00.000Z");
  });

  it("drops an invalid lane value", () => {
    const out = normalizePartialPackage({ _active_lane: "billing" });
    assert.equal(out._active_lane, undefined);
  });

  it("keeps a valid lane value", () => {
    const out = normalizePartialPackage({ _active_lane: "access" });
    assert.equal(out._active_lane, "access");
  });

  it("returns a fresh object (does not mutate input)", () => {
    const raw = { _active_lane: "access" };
    const out = normalizePartialPackage(raw);
    out._active_lane = "maintenance";
    assert.equal(raw._active_lane, "access");
  });
});

describe("conversationState — active lane helpers", () => {
  it("readActiveLane returns the lane when set to a valid value", () => {
    assert.equal(readActiveLane({ _active_lane: "access" }), "access");
    assert.equal(readActiveLane({ _active_lane: "maintenance" }), "maintenance");
  });

  it("readActiveLane returns empty string for missing / invalid lanes", () => {
    assert.equal(readActiveLane({}), "");
    assert.equal(readActiveLane(null), "");
    assert.equal(readActiveLane({ _active_lane: "" }), "");
    assert.equal(readActiveLane({ _active_lane: "billing" }), "");
  });

  it("withActiveLane returns a new partial with the lane set", () => {
    const base = { foo: 1 };
    const out = withActiveLane(base, CONVERSATION_LANE.ACCESS);
    assert.equal(out._active_lane, "access");
    assert.equal(out.foo, 1);
    assert.equal(base._active_lane, undefined);
  });

  it("withActiveLane('') clears the lane", () => {
    const out = withActiveLane({ _active_lane: "access" }, "");
    assert.equal(out._active_lane, undefined);
  });

  it("withActiveLane refuses to set an invalid lane (treats as clear)", () => {
    const out = withActiveLane({ _active_lane: "access" }, "billing");
    assert.equal(out._active_lane, undefined);
  });

  it("withoutActiveLane strips just the lane", () => {
    const out = withoutActiveLane({ _active_lane: "access", _access_request: { intentType: "ACCESS_RESERVE" } });
    assert.equal(out._active_lane, undefined);
    assert.deepEqual(out._access_request, { intentType: "ACCESS_RESERVE" });
  });
});

describe("conversationState — access request helpers", () => {
  it("readAccessRequest returns null when missing", () => {
    assert.equal(readAccessRequest({}), null);
    assert.equal(readAccessRequest(null), null);
  });

  it("readAccessRequest returns the object when set", () => {
    const r = readAccessRequest({ _access_request: { intentType: "ACCESS_RESERVE" } });
    assert.deepEqual(r, { intentType: "ACCESS_RESERVE" });
  });

  it("withAccessRequest stores a shallow copy (caller mutation does not leak)", () => {
    const req = { intentType: "ACCESS_RESERVE" };
    const out = withAccessRequest({}, req);
    req.intentType = "ACCESS_CANCEL";
    assert.equal(out._access_request.intentType, "ACCESS_RESERVE");
  });

  it("withAccessRequest(null) clears the field", () => {
    const out = withAccessRequest({ _access_request: { intentType: "ACCESS_RESERVE" } }, null);
    assert.equal(out._access_request, undefined);
  });

  it("withoutAccessRequest clears just the request", () => {
    const out = withoutAccessRequest({
      _access_request: { intentType: "ACCESS_RESERVE" },
      _active_lane: "access",
    });
    assert.equal(out._access_request, undefined);
    assert.equal(out._active_lane, "access");
  });
});

describe("conversationState — last booking helpers", () => {
  it("withAccessLastBooking auto-stamps `at` when missing", () => {
    const before = Date.now();
    const out = withAccessLastBooking({}, {
      reservationId: "r-1",
      locationId: "u-1",
    });
    const after = Date.now();
    assert.equal(out._access_last_booking.reservationId, "r-1");
    const at = new Date(out._access_last_booking.at).getTime();
    assert.ok(at >= before && at <= after, "stamped at within window");
  });

  it("withAccessLastBooking keeps caller's `at` if provided", () => {
    const out = withAccessLastBooking({}, {
      reservationId: "r-1",
      locationId: "u-1",
      at: "2026-05-27T10:00:00.000Z",
    });
    assert.equal(out._access_last_booking.at, "2026-05-27T10:00:00.000Z");
  });

  it("readAccessLastBooking round-trips", () => {
    const out = withAccessLastBooking({}, {
      reservationId: "r-1",
      locationId: "u-1",
      startAt: "2026-05-31T14:00:00.000Z",
      endAt: "2026-05-31T16:00:00.000Z",
    });
    const r = readAccessLastBooking(out);
    assert.equal(r.reservationId, "r-1");
    assert.equal(r.startAt, "2026-05-31T14:00:00.000Z");
  });
});

describe("conversationState — last error helpers", () => {
  it("withAccessLastError normalizes fields and stamps `at`", () => {
    const out = withAccessLastError({}, {
      brain: "access_needs_more",
      code: "need_window",
      replyText: "What time?",
      accessFacts: { kind: "needs_more", kickbackIntent: "need_window" },
    });
    const err = readAccessLastError(out);
    assert.equal(err.brain, "access_needs_more");
    assert.equal(err.code, "need_window");
    assert.equal(err.replyText, "What time?");
    assert.equal(err.accessFacts.kickbackIntent, "need_window");
    assert.ok(err.at);
  });

  it("withAccessLastError(null) clears the field", () => {
    const out = withAccessLastError({ _access_last_error: { brain: "x" } }, null);
    assert.equal(out._access_last_error, undefined);
  });
});

describe("conversationState — atomic transitions", () => {
  it("recordAccessBookingSuccess sets booking + clears request + clears error", () => {
    const before = {
      _active_lane: "access",
      _access_request: { intentType: "ACCESS_RESERVE", startAt: "x" },
      _access_last_error: { brain: "access_needs_more" },
    };
    const after = recordAccessBookingSuccess(before, {
      reservationId: "r-1",
      locationId: "u-1",
    });
    assert.equal(after._access_request, undefined);
    assert.equal(after._access_last_error, undefined);
    assert.equal(after._access_last_booking.reservationId, "r-1");
    assert.equal(after._active_lane, "access", "lane stays — booking does not auto-close lane");
  });

  it("recordAccessBrainRejection stamps the error and keeps the in-flight request", () => {
    const after = recordAccessBrainRejection({}, {
      intentType: "ACCESS_RESERVE",
      locationId: "u-1",
      startAt: "2026-05-31T14:00:00.000Z",
      endAt: "2026-05-31T16:00:00.000Z",
    }, {
      brain: "access_needs_more",
      code: "need_window",
    });
    assert.equal(after._access_request.intentType, "ACCESS_RESERVE");
    assert.equal(after._access_last_error.code, "need_window");
  });

  it("recordAccessBrainRejection with stripWindow:true drops the start/end", () => {
    const after = recordAccessBrainRejection({}, {
      intentType: "ACCESS_RESERVE",
      locationId: "u-1",
      startAt: "2026-05-31T14:00:00.000Z",
      endAt: "2026-05-31T16:00:00.000Z",
    }, {
      brain: "access_needs_window",
      code: "needs_window",
    }, { stripWindow: true });
    assert.equal(after._access_request.startAt, undefined);
    assert.equal(after._access_request.endAt, undefined);
    assert.equal(after._access_request.intentType, "ACCESS_RESERVE");
  });

  it("clearAccessLane strips lane + request + error but keeps last booking", () => {
    const before = {
      _active_lane: "access",
      _access_request: { intentType: "ACCESS_RESERVE" },
      _access_last_error: { brain: "x" },
      _access_last_booking: { reservationId: "r-1", locationId: "u-1" },
      _last_inbound_at: "2026-05-27T10:00:00.000Z",
    };
    const after = clearAccessLane(before);
    assert.equal(after._active_lane, undefined);
    assert.equal(after._access_request, undefined);
    assert.equal(after._access_last_error, undefined);
    assert.equal(after._access_last_booking.reservationId, "r-1");
    assert.equal(after._last_inbound_at, "2026-05-27T10:00:00.000Z", "non-access fields preserved");
  });
});

describe("conversationState — field keys exported", () => {
  it("ACCESS_FIELD constants match the underscore-prefixed JSON keys", () => {
    assert.equal(ACCESS_FIELD.ACTIVE_LANE, "_active_lane");
    assert.equal(ACCESS_FIELD.ACCESS_REQUEST, "_access_request");
    assert.equal(ACCESS_FIELD.ACCESS_LAST_BOOKING, "_access_last_booking");
    assert.equal(ACCESS_FIELD.ACCESS_LAST_ERROR, "_access_last_error");
  });
});
