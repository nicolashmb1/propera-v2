/**
 * Amenity resolver (Piece 4 of the access foundation).
 *
 * Single source of truth for "tenant says 'game room' → which Location entity
 * is that?". Before this file, three different call sites each had their own
 * matching rules, and the brain-side resolver auto-selected the only location
 * when the property had a single amenity — even when the tenant's hint
 * clearly didn't match. That's the "terrace → silently booked game room"
 * substitution bug.
 *
 * Rules (closed-fail, never silently substitute):
 *  - empty hint AND exactly one amenity available → return that one.
 *  - empty hint AND multiple available → ambiguous (caller must ask).
 *  - hint is a UUID → must be in the property's list; otherwise not_set_up.
 *  - hint is text → exact-then-substring match (case- and punctuation-insensitive).
 *  - hint matches multiple → ambiguous, with candidates returned.
 *  - hint matches none → not_set_up, with the property's available list
 *    returned so the caller can offer alternatives.
 *
 * Doctrine:
 *  - Principle 2 (Interpret once)
 *  - Guardrail 22 (Make everything explicit) — closed-set error discriminator.
 *  - Guardrail 15 (Preserve strict separation of layers) — name → UUID is
 *    a property-catalog responsibility, not an LLM responsibility.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AMENITY_ERROR = Object.freeze({
  /** Property has zero configured amenities. */
  EMPTY_PROPERTY: "empty_property",
  /** Hint did not match anything in the property's amenity list. */
  NOT_SET_UP: "not_set_up",
  /** Hint matched more than one amenity (or no hint and multiple amenities). */
  AMBIGUOUS: "ambiguous",
});

/**
 * @typedef {object} CatalogLocation
 * @property {string} id
 * @property {string} name
 * @property {string} [slug]
 */

/**
 * @typedef {object} ResolveSuccess
 * @property {true} ok
 * @property {CatalogLocation} location
 * @property {CatalogLocation[]} available
 */

/**
 * @typedef {object} ResolveFailure
 * @property {false} ok
 * @property {string} error           One of AMENITY_ERROR values.
 * @property {CatalogLocation[]} available    Always present — what the property has.
 * @property {CatalogLocation[]} [candidates] When error is "ambiguous".
 * @property {string} hint            Echo of the (normalized) hint the caller sent.
 */

/**
 * Normalize a string for amenity matching — lowercase, drop apostrophes
 * (so "kid's room" matches "kids room"), replace other punctuation with
 * whitespace, then collapse whitespace.
 *
 *   "Game Room" / "game-room" / "game_room"  →  "game room"
 *   "kid's room" / "kids room"               →  "kids room"
 *
 * Note: this is intentionally NOT a tokenizer that strips all whitespace.
 * "gameroom" (one word) and "game room" (two words) are different tokens
 * to a person, and the resolver should respect that — substring matching
 * handles the cross-token cases.
 *
 * @param {unknown} value
 */
function normalizeAmenityText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Project a property's amenity list to the catalog shape (filters out rows
 * missing an `id`).
 *
 * @param {Array<{id?: string, name?: string, slug?: string}>} locations
 * @returns {CatalogLocation[]}
 */
function listAmenitiesForProperty(locations) {
  return (Array.isArray(locations) ? locations : [])
    .map((l) => ({
      id: String(l.id || "").trim(),
      name: String(l.name || "").trim(),
      slug: String(l.slug || "").trim(),
    }))
    .filter((l) => l.id);
}

/**
 * Resolve a tenant amenity hint into a canonical Location entity.
 *
 * @param {string} hint
 * @param {Array<{id?: string, name?: string, slug?: string}>} locations
 * @returns {ResolveSuccess | ResolveFailure}
 */
function resolveAmenity(hint, locations) {
  const available = listAmenitiesForProperty(locations);
  const rawHint = String(hint || "").trim();
  const normHint = normalizeAmenityText(rawHint);

  if (!available.length) {
    return {
      ok: false,
      error: AMENITY_ERROR.EMPTY_PROPERTY,
      available: [],
      hint: normHint,
    };
  }

  if (!rawHint) {
    if (available.length === 1) {
      return { ok: true, location: available[0], available };
    }
    return {
      ok: false,
      error: AMENITY_ERROR.AMBIGUOUS,
      available,
      candidates: available,
      hint: normHint,
    };
  }

  if (UUID_RE.test(rawHint)) {
    const hit = available.find(
      (l) => l.id.toLowerCase() === rawHint.toLowerCase()
    );
    if (hit) return { ok: true, location: hit, available };
    return {
      ok: false,
      error: AMENITY_ERROR.NOT_SET_UP,
      available,
      hint: normHint,
    };
  }

  // Exact slug or name match — wins outright.
  const exact = available.find((l) => {
    const s = normalizeAmenityText(l.slug);
    const n = normalizeAmenityText(l.name);
    return (s && s === normHint) || (n && n === normHint);
  });
  if (exact) return { ok: true, location: exact, available };

  // Substring match (either direction). Filters out hint-vs-itself by
  // requiring at least one of slug/name to be non-empty.
  const candidates = available.filter((l) => {
    const s = normalizeAmenityText(l.slug);
    const n = normalizeAmenityText(l.name);
    return (
      (!!s && (s.includes(normHint) || normHint.includes(s))) ||
      (!!n && (n.includes(normHint) || normHint.includes(n)))
    );
  });

  if (candidates.length === 1) {
    return { ok: true, location: candidates[0], available };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: AMENITY_ERROR.AMBIGUOUS,
      available,
      candidates,
      hint: normHint,
    };
  }

  return {
    ok: false,
    error: AMENITY_ERROR.NOT_SET_UP,
    available,
    hint: normHint,
  };
}

/**
 * Convenience — given a UUID, return the catalog row or null. Used by the
 * brain when the agent has already resolved (the validator will have
 * verified the UUID format).
 *
 * @param {string} id
 * @param {Array<{id?: string, name?: string, slug?: string}>} locations
 * @returns {CatalogLocation | null}
 */
function resolveAmenityById(id, locations) {
  const r = resolveAmenity(id, locations);
  return r.ok ? r.location : null;
}

/**
 * Scan free-form text for an amenity reference. Used by the deterministic
 * (LLM-off) supplement path — when there's no `location_name` hint from the
 * LLM, look in the tenant's raw message.
 *
 * Matches when the normalized message contains the amenity's normalized slug
 * or name as a substring. If multiple amenities match, returns ambiguous.
 *
 * @param {string} text
 * @param {Array<{id?: string, name?: string, slug?: string}>} locations
 * @returns {ResolveSuccess | ResolveFailure}
 */
function resolveAmenityFromText(text, locations) {
  const available = listAmenitiesForProperty(locations);
  const normText = normalizeAmenityText(text);

  if (!available.length) {
    return {
      ok: false,
      error: AMENITY_ERROR.EMPTY_PROPERTY,
      available: [],
      hint: normText,
    };
  }

  if (!normText) {
    return {
      ok: false,
      error: AMENITY_ERROR.NOT_SET_UP,
      available,
      hint: "",
    };
  }

  const candidates = available.filter((l) => {
    const s = normalizeAmenityText(l.slug);
    const n = normalizeAmenityText(l.name);
    return (!!s && normText.includes(s)) || (!!n && normText.includes(n));
  });

  if (candidates.length === 1) {
    return { ok: true, location: candidates[0], available };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: AMENITY_ERROR.AMBIGUOUS,
      available,
      candidates,
      hint: normText,
    };
  }

  return {
    ok: false,
    error: AMENITY_ERROR.NOT_SET_UP,
    available,
    hint: normText,
  };
}

module.exports = {
  resolveAmenity,
  resolveAmenityById,
  resolveAmenityFromText,
  listAmenitiesForProperty,
  normalizeAmenityText,
  AMENITY_ERROR,
};
