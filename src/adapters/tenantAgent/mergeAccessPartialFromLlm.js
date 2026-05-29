/**
 * Merge LLM access slot updates — grounded to tenant amenity list only.
 */
const { ACCESS_INTENT_TYPES } = require("../../access/parseAccessIntent");
const { reinterpretLlmUtcIsoAsLocalWallClock } = require("../../access/accessLocalTime");
const { resolveAmenity } = require("../../access/amenityResolver");

const INTENT_MAP = {
  reserve: ACCESS_INTENT_TYPES.RESERVE,
  access_reserve: ACCESS_INTENT_TYPES.RESERVE,
  list_slots: ACCESS_INTENT_TYPES.LIST_SLOTS,
  access_list_slots: ACCESS_INTENT_TYPES.LIST_SLOTS,
  cancel: ACCESS_INTENT_TYPES.CANCEL,
  access_cancel: ACCESS_INTENT_TYPES.CANCEL,
  status: ACCESS_INTENT_TYPES.STATUS,
  access_status: ACCESS_INTENT_TYPES.STATUS,
  clarify: "ACCESS_CLARIFY",
  close: "ACCESS_CLOSE",
  access_close: "ACCESS_CLOSE",
  switch_maintenance: "ACCESS_SWITCH_MAINTENANCE",
  access_switch_maintenance: "ACCESS_SWITCH_MAINTENANCE",
  maintenance: "ACCESS_SWITCH_MAINTENANCE",
  continue: "",
};

/**
 * Resolve the LLM's amenity hint (slug OR name) against the property catalog.
 * Returns the matched location or null. Never silently substitutes — if the
 * LLM emitted "terrace" but the property only has Game Room, returns null
 * and the merge code skips populating locationId; the schema validator
 * (Piece 1) then kicks back with need_location so the LLM can re-ask.
 *
 * @param {Array<{ id?: string, name?: string, slug?: string }>} locations
 * @param {{ location_slug?: string, location_name?: string }} updates
 * @returns {{ id: string, name: string, slug: string } | null}
 */
function resolveLocationFromAmenityList(locations, updates) {
  const slugHint = String(updates?.location_slug || "").trim();
  const nameHint = String(updates?.location_name || "").trim();
  // Prefer slug (more specific), fall back to name. Empty hint with single
  // amenity auto-selects (resolveAmenity handles that case).
  const hint = slugHint || nameHint;
  const r = resolveAmenity(hint, locations);
  return r.ok ? r.location : null;
}

function parseIsoField(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const normalized = /Z$/i.test(s) ? reinterpretLlmUtcIsoAsLocalWallClock(s) : s;
  const d = new Date(normalized);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toISOString();
}

/**
 * @param {object} prev
 * @param {object} updates
 * @param {Array<{ id?: string, name?: string, slug?: string }>} locations
 * @returns {object}
 */
function mergeAccessPartialFromLlm(prev, updates, locations) {
  const p = { ...(prev || {}) };
  const u = updates && typeof updates === "object" ? updates : {};

  const loc = resolveLocationFromAmenityList(locations, u);
  if (loc) {
    p.locationId = String(loc.id || "").trim();
    p.locationHint = String(loc.name || loc.slug || "").trim();
  }

  const startAt = parseIsoField(u.start_at || u.startAt);
  const endAt = parseIsoField(u.end_at || u.endAt);
  if (startAt && endAt) {
    p.startAt = startAt;
    p.endAt = endAt;
  }

  const day = String(u.date_for_day || u.dateForDay || "").trim();
  if (day) p.dateForDay = day;

  return p;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeAccessIntent(raw) {
  const key = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z_]+/g, "_");
  return INTENT_MAP[key] || "";
}

/**
 * @param {unknown} json
 * @returns {boolean}
 */
function isValidAccessLlmTurnJson(json) {
  if (!json || typeof json !== "object") return false;
  const reply = String(json.reply || "").trim();
  if (!reply) return false;
  const updates = json.partial_updates;
  if (updates != null && (typeof updates !== "object" || Array.isArray(updates))) return false;
  return true;
}

/**
 * @param {unknown} json
 * @returns {{ reply: string, accessIntent: string, partialUpdates: object, handoffReady: boolean }}
 */
function normalizeAccessLlmTurn(json) {
  const reply = String(json.reply || "").trim();
  const partialUpdates =
    json.partial_updates && typeof json.partial_updates === "object"
      ? json.partial_updates
      : {};
  const accessIntent = normalizeAccessIntent(json.access_intent || json.accessIntent);
  return {
    reply,
    accessIntent,
    partialUpdates,
    handoffReady: json.handoff_ready === true,
  };
}

module.exports = {
  mergeAccessPartialFromLlm,
  resolveLocationFromAmenityList,
  isValidAccessLlmTurnJson,
  normalizeAccessLlmTurn,
  normalizeAccessIntent,
};
