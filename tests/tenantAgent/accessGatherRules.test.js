const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  mergeAccessPartial,
  accessHandoffReady,
  supplementAccessLocationAndDay,
  supplementAccessPartialDeterministic,
  shouldRouteToAccessTurn,
  alignAccessWindowToDateForDay,
} = require("../../src/adapters/tenantAgent/accessGatherRules");
const { ACCESS_INTENT_TYPES } = require("../../src/access/parseAccessIntent");
const { detectAccessIntent } = require("../../src/access/parseAccessIntent");

describe("accessGatherRules", () => {
  it("keeps location hint when follow-up does not mention amenity", () => {
    const merged = mergeAccessPartial(
      {
        intentType: ACCESS_INTENT_TYPES.RESERVE,
        locationId: "loc-1",
        locationHint: "Game Room",
        startAt: "2026-05-27T21:00:00.000Z",
        endAt: "2026-05-27T23:00:00.000Z",
      },
      { locationHint: "what times are available ?" }
    );
    assert.equal(merged.locationId, "loc-1");
    assert.equal(merged.locationHint, "Game Room");
  });

  it("detects list_slots in session without amenity keyword", () => {
    assert.equal(
      detectAccessIntent("what times are available?", {
        locationId: "loc-1",
        accessSessionActive: true,
      }),
      ACCESS_INTENT_TYPES.LIST_SLOTS
    );
  });

  it("handoff ready for reserve with location and window", () => {
    assert.equal(
      accessHandoffReady(
        {
          locationId: "loc-1",
          dateForDay: "tomorrow",
          startAt: "2026-05-27T21:00:00.000Z",
          endAt: "2026-05-27T23:00:00.000Z",
        },
        ACCESS_INTENT_TYPES.RESERVE
      ),
      true
    );
  });

  it("routes to access when session active", () => {
    assert.equal(
      shouldRouteToAccessTurn(
        {
          partial_package: {
            _access_request: { intentType: ACCESS_INTENT_TYPES.RESERVE },
          },
        },
        "why?"
      ),
      true
    );
  });

  // Day corrections are now handled by the sticky-lane dispatcher
  // (dispatchByActiveLane → maybeHandleAccessTurn with lockedLane=true).
  // `shouldRouteToAccessTurn` is only first-turn detection: should still
  // refuse hard maintenance signals so a stray "sink" doesn't bootstrap access.
  it("does not bootstrap access on maintenance text", () => {
    assert.equal(
      shouldRouteToAccessTurn({}, "send someone to check my sink, slow drip"),
      false
    );
  });

  it("parses time range with session dateForDay", () => {
    const out = supplementAccessPartialDeterministic(
      {
        intentType: ACCESS_INTENT_TYPES.RESERVE,
        locationId: "loc-1",
        dateForDay: "tomorrow",
      },
      "10-12 will work",
      [{ id: "loc-1", name: "Game Room", slug: "gameroom" }]
    );
    assert.equal(Boolean(out.startAt && out.endAt), true);
  });

  it("supplements window from inbound text", () => {
    const out = supplementAccessPartialDeterministic(
      { intentType: ACCESS_INTENT_TYPES.RESERVE, locationId: "loc-1" },
      "tomorrow 5-7 pm",
      [{ id: "loc-1", name: "Game Room", slug: "gameroom" }]
    );
    assert.equal(Boolean(out.startAt && out.endAt), true);
  });

  it("aligns reserve window onto dateForDay calendar day", () => {
    const out = alignAccessWindowToDateForDay(
      {
        dateForDay: "tomorrow",
        startAt: "2026-05-27T22:00:00.000Z",
        endAt: "2026-05-28T00:00:00.000Z",
      },
      new Date("2026-05-26T15:00:00Z")
    );
    const { zonedWallClock } = require("../../src/access/accessLocalTime");
    const start = zonedWallClock(out.startAt, "America/New_York");
    const end = zonedWallClock(out.endAt, "America/New_York");
    assert.equal(start.month, 5);
    assert.equal(start.day, 27);
    assert.equal(start.hour, 18);
    assert.equal(end.hour, 20);
  });

  it("location supplement does not parse times from text", () => {
    const llmStart = "2026-05-27T18:00:00.000Z";
    const llmEnd = "2026-05-27T20:00:00.000Z";
    const out = supplementAccessLocationAndDay(
      {
        intentType: ACCESS_INTENT_TYPES.RESERVE,
        locationId: "loc-1",
        startAt: llmStart,
        endAt: llmEnd,
        dateForDay: "tomorrow",
      },
      "2-4",
      [{ id: "loc-1", name: "Game Room", slug: "gameroom" }]
    );
    assert.equal(out.startAt, llmStart);
    assert.equal(out.endAt, llmEnd);
  });
});
