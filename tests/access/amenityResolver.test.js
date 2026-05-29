const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveAmenity,
  resolveAmenityById,
  resolveAmenityFromText,
  listAmenitiesForProperty,
  normalizeAmenityText,
  AMENITY_ERROR,
} = require("../../src/access/amenityResolver");

const GAMEROOM = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "Game Room",
  slug: "game-room",
};

const GYM = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "Fitness Center",
  slug: "gym",
};

const POOL = {
  id: "99999999-8888-7777-6666-555555555555",
  name: "Pool",
  slug: "pool",
};

describe("amenityResolver — text normalization", () => {
  it("collapses punctuation, case, and whitespace", () => {
    assert.equal(normalizeAmenityText("Game Room"), "game room");
    assert.equal(normalizeAmenityText("game-room"), "game room");
    assert.equal(normalizeAmenityText("game_room"), "game room");
    assert.equal(normalizeAmenityText("GAMEROOM"), "gameroom");
    assert.equal(normalizeAmenityText("  the  Game ROOM!  "), "the game room");
  });

  it("drops apostrophes so possessives match the base form", () => {
    assert.equal(normalizeAmenityText("kid's room"), "kids room");
    assert.equal(normalizeAmenityText("kids room"), "kids room");
    assert.equal(normalizeAmenityText("game's room"), "games room");
  });

  it("returns empty string for null / undefined / empty", () => {
    assert.equal(normalizeAmenityText(null), "");
    assert.equal(normalizeAmenityText(undefined), "");
    assert.equal(normalizeAmenityText(""), "");
  });
});

describe("amenityResolver — listAmenitiesForProperty", () => {
  it("trims and drops rows without id", () => {
    const out = listAmenitiesForProperty([
      { id: "u1", name: " A ", slug: " a " },
      { id: "", name: "skip", slug: "skip" },
      { name: "no-id" },
      { id: "u2", name: "B" },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "u1");
    assert.equal(out[0].name, "A");
    assert.equal(out[0].slug, "a");
    assert.equal(out[1].slug, "");
  });

  it("returns [] for non-array / empty", () => {
    assert.deepEqual(listAmenitiesForProperty(null), []);
    assert.deepEqual(listAmenitiesForProperty(undefined), []);
    assert.deepEqual(listAmenitiesForProperty([]), []);
    assert.deepEqual(listAmenitiesForProperty("not-array"), []);
  });
});

describe("amenityResolver — empty property", () => {
  it("returns empty_property when the catalog is empty", () => {
    const r = resolveAmenity("game room", []);
    assert.equal(r.ok, false);
    assert.equal(r.error, AMENITY_ERROR.EMPTY_PROPERTY);
    assert.deepEqual(r.available, []);
  });

  it("returns empty_property even when hint is empty", () => {
    const r = resolveAmenity("", []);
    assert.equal(r.ok, false);
    assert.equal(r.error, AMENITY_ERROR.EMPTY_PROPERTY);
  });
});

describe("amenityResolver — empty hint", () => {
  it("auto-selects when exactly one amenity is available", () => {
    const r = resolveAmenity("", [GAMEROOM]);
    assert.equal(r.ok, true);
    assert.equal(r.location.id, GAMEROOM.id);
  });

  it("returns ambiguous when multiple amenities and no hint", () => {
    const r = resolveAmenity("", [GAMEROOM, GYM]);
    assert.equal(r.ok, false);
    assert.equal(r.error, AMENITY_ERROR.AMBIGUOUS);
    assert.equal(r.candidates.length, 2);
    assert.equal(r.available.length, 2);
  });
});

describe("amenityResolver — exact match wins", () => {
  it("exact slug match", () => {
    const r = resolveAmenity("game-room", [GAMEROOM, GYM]);
    assert.equal(r.ok, true);
    assert.equal(r.location.id, GAMEROOM.id);
  });

  it("exact name match", () => {
    const r = resolveAmenity("Game Room", [GAMEROOM, GYM]);
    assert.equal(r.ok, true);
    assert.equal(r.location.id, GAMEROOM.id);
  });

  it("exact match is case- and punctuation-insensitive", () => {
    assert.equal(resolveAmenity("game room", [GAMEROOM, GYM]).location.id, GAMEROOM.id);
    assert.equal(resolveAmenity("Game-Room", [GAMEROOM, GYM]).location.id, GAMEROOM.id);
    assert.equal(resolveAmenity("Game_Room", [GAMEROOM, GYM]).location.id, GAMEROOM.id);
    assert.equal(resolveAmenity("GAME ROOM", [GAMEROOM, GYM]).location.id, GAMEROOM.id);
  });

  it("single-word 'gameroom' is NOT exact for two-word 'Game Room' (falls to not_set_up)", () => {
    // Intentional: tokenization is preserved so "gameroom" and "game room" are
    // distinct user inputs. The LLM gather loop normalizes these in
    // conversation before handing off; the resolver does not auto-merge them.
    const r = resolveAmenity("gameroom", [GAMEROOM, GYM]);
    assert.equal(r.ok, false);
    assert.equal(r.error, AMENITY_ERROR.NOT_SET_UP);
  });
});

describe("amenityResolver — substring matching", () => {
  it("resolves multi-word free-text hint", () => {
    const r = resolveAmenity("the game room", [GAMEROOM, GYM]);
    assert.equal(r.ok, true);
    assert.equal(r.location.id, GAMEROOM.id);
  });

  it("resolves slug-with-extra-words hint", () => {
    const r = resolveAmenity("can I use the game-room", [GAMEROOM, GYM]);
    assert.equal(r.ok, true);
    assert.equal(r.location.id, GAMEROOM.id);
  });

  it("returns ambiguous when hint matches multiple", () => {
    const r = resolveAmenity("room", [GAMEROOM, { id: "u3", name: "Party Room", slug: "party-room" }]);
    assert.equal(r.ok, false);
    assert.equal(r.error, AMENITY_ERROR.AMBIGUOUS);
    assert.equal(r.candidates.length, 2);
  });
});

describe("amenityResolver — not_set_up (the substitution bug)", () => {
  it("does NOT silently substitute when single amenity available and hint mismatches", () => {
    // This is the exact bug: tenant says "terrace", property has only Game Room.
    // Old code returned Game Room. New code returns not_set_up + available list.
    const r = resolveAmenity("terrace", [GAMEROOM]);
    assert.equal(r.ok, false);
    assert.equal(r.error, AMENITY_ERROR.NOT_SET_UP);
    assert.equal(r.available.length, 1);
    assert.equal(r.available[0].id, GAMEROOM.id);
  });

  it("returns not_set_up for unknown amenity with multi-amenity property", () => {
    const r = resolveAmenity("rooftop", [GAMEROOM, GYM, POOL]);
    assert.equal(r.ok, false);
    assert.equal(r.error, AMENITY_ERROR.NOT_SET_UP);
    assert.equal(r.available.length, 3);
  });

  it("not_set_up includes the normalized hint so callers can echo it", () => {
    const r = resolveAmenity("The TERRACE!", [GAMEROOM]);
    assert.equal(r.error, AMENITY_ERROR.NOT_SET_UP);
    assert.equal(r.hint, "the terrace");
  });
});

describe("amenityResolver — UUID hint path", () => {
  it("resolves a UUID that exists in the catalog", () => {
    const r = resolveAmenity(GAMEROOM.id, [GAMEROOM, GYM]);
    assert.equal(r.ok, true);
    assert.equal(r.location.id, GAMEROOM.id);
  });

  it("returns not_set_up for a UUID that is not in the catalog", () => {
    const r = resolveAmenity("00000000-0000-0000-0000-000000000000", [GAMEROOM, GYM]);
    assert.equal(r.ok, false);
    assert.equal(r.error, AMENITY_ERROR.NOT_SET_UP);
  });

  it("UUID match is case-insensitive", () => {
    const r = resolveAmenity(GAMEROOM.id.toUpperCase(), [GAMEROOM, GYM]);
    assert.equal(r.ok, true);
    assert.equal(r.location.id, GAMEROOM.id);
  });
});

describe("amenityResolver — resolveAmenityFromText (deterministic supplement)", () => {
  it("finds amenity referenced in free-form text", () => {
    const r = resolveAmenityFromText(
      "thinking about a BBQ at the game room tomorrow",
      [GAMEROOM, GYM]
    );
    assert.equal(r.ok, true);
    assert.equal(r.location.id, GAMEROOM.id);
  });

  it("returns not_set_up when text mentions an amenity not in catalog", () => {
    const r = resolveAmenityFromText(
      "is the terrace available?",
      [GAMEROOM]
    );
    assert.equal(r.ok, false);
    assert.equal(r.error, AMENITY_ERROR.NOT_SET_UP);
  });

  it("returns ambiguous when text mentions multiple amenities", () => {
    const r = resolveAmenityFromText(
      "i want to use game room and gym",
      [GAMEROOM, GYM]
    );
    assert.equal(r.ok, false);
    assert.equal(r.error, AMENITY_ERROR.AMBIGUOUS);
    assert.equal(r.candidates.length, 2);
  });
});

describe("amenityResolver — resolveAmenityById", () => {
  it("returns location for a valid UUID", () => {
    assert.equal(resolveAmenityById(GAMEROOM.id, [GAMEROOM, GYM]).id, GAMEROOM.id);
  });

  it("returns null for unknown UUID", () => {
    assert.equal(resolveAmenityById("00000000-0000-0000-0000-000000000000", [GAMEROOM, GYM]), null);
  });

  it("returns null for empty id", () => {
    assert.equal(resolveAmenityById("", [GAMEROOM, GYM]), null);
  });
});
