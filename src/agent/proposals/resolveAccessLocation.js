/**
 * Resolve access_locations row for Jarvis amenity proposals.
 */
const { listAccessLocationsForPortal } = require("../../dal/accessEngine");

function normalizeHint(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function scoreLocationMatch(loc, hint) {
  const h = normalizeHint(hint);
  if (!h) return 0;
  const name = normalizeHint(loc.name);
  const slug = normalizeHint(String(loc.slug || "").replace(/-/g, " "));
  const hCompact = h.replace(/\s+/g, "");
  const nameCompact = name.replace(/\s+/g, "");
  const slugCompact = slug.replace(/\s+/g, "");
  if (name === h || slug === h || nameCompact === hCompact || slugCompact === hCompact) return 100;
  if (name.includes(h) || h.includes(name) || nameCompact.includes(hCompact)) return 80;
  if (slug.includes(h) || h.includes(slug) || slugCompact.includes(hCompact)) return 70;
  const hintTokens = h.split(/\s+/).filter(Boolean);
  const nameTokens = new Set(name.split(/\s+/).filter(Boolean));
  let hits = 0;
  for (const t of hintTokens) {
    if (nameTokens.has(t)) hits += 1;
  }
  if (hits > 0 && hits >= hintTokens.length) return 60 + hits;
  return 0;
}

/**
 * @param {object} opts
 * @param {string} opts.propertyCode
 * @param {string} opts.locationHint — amenity name, e.g. gameroom, sauna
 */
async function resolveAccessLocation(opts) {
  const propertyCode = String(opts?.propertyCode || "")
    .trim()
    .toUpperCase();
  const locationHint = String(opts?.locationHint || opts?.amenityName || opts?.amenity_name || "").trim();

  if (!propertyCode) {
    return { ok: false, error: "missing_property", message: "Need property code for the amenity." };
  }
  if (!locationHint) {
    return { ok: false, error: "missing_location", message: "Which amenity — gameroom, sauna, terrace?" };
  }

  const locations = await listAccessLocationsForPortal({ propertyCode, activeOnly: true });
  if (!locations.length) {
    return {
      ok: false,
      error: "no_locations",
      message: `No amenities configured at ${propertyCode}.`,
    };
  }

  const scored = locations
    .map((loc) => ({ loc, score: scoreLocationMatch(loc, locationHint) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score + 10)) {
    return { ok: true, location: scored[0].loc, via: "name_match" };
  }

  if (scored.length > 1) {
    const names = scored
      .slice(0, 4)
      .map((x) => x.loc.name)
      .join(", ");
    return {
      ok: false,
      error: "ambiguous_location",
      message: `Which amenity — ${names}?`,
      candidates: scored.map((x) => x.loc),
    };
  }

  const fallback = locations.slice(0, 4).map((l) => l.name).join(", ");
  return {
    ok: false,
    error: "location_not_found",
    message: `No amenity matching "${locationHint}" at ${propertyCode}. Available: ${fallback}.`,
    candidates: locations,
  };
}

module.exports = { resolveAccessLocation, scoreLocationMatch };
