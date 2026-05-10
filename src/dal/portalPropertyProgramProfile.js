/**
 * Portal-only updates to `properties.program_expansion_profile` (PM/Task V1 smart build).
 * @see docs/PM_PROGRAM_ENGINE_V1.md
 */
const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");
const { normalizeExpansionProfile } = require("../pm/expandProgramLines");
const { syncCommonAreaLocationsFromLabels } = require("./propertyLocations");

const MAX_ARRAY_LEN = 50;
const MAX_LABEL_LEN = 120;

/**
 * @param {unknown} raw
 * @returns {{ floor_paint_scopes?: string[]; common_paint_scopes?: string[] }}
 */
function programExpansionProfileForApi(raw) {
  const prof = normalizeExpansionProfile(raw);
  const floor = prof.floor_paint_scopes;
  const common = prof.common_paint_scopes;
  const out = {};
  if (Array.isArray(floor)) {
    out.floor_paint_scopes = floor
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, MAX_ARRAY_LEN);
  } else {
    out.floor_paint_scopes = [];
  }
  if (Array.isArray(common)) {
    out.common_paint_scopes = common
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, MAX_ARRAY_LEN);
  } else {
    out.common_paint_scopes = [];
  }
  return out;
}

/**
 * @param {unknown} arr
 * @returns {{ ok: boolean; list?: string[]; error?: string }}
 */
function sanitizeLabelArray(arr) {
  if (arr == null) return { ok: true, list: undefined };
  if (!Array.isArray(arr)) return { ok: false, error: "invalid_array" };
  if (arr.length > MAX_ARRAY_LEN) return { ok: false, error: "array_too_long" };
  const list = [];
  for (const x of arr) {
    const s = String(x == null ? "" : x)
      .trim()
      .slice(0, MAX_LABEL_LEN);
    if (!s) continue;
    list.push(s);
  }
  return { ok: true, list };
}

/**
 * PATCH body: optional `floor_paint_scopes` and/or `common_paint_scopes`.
 * @param {object} body
 * @returns {{ ok: boolean; patch?: Record<string, unknown>; keysChanged?: string[]; error?: string }}
 */
function parseProgramExpansionProfilePatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_body" };
  }
  const keysChanged = [];
  const patch = {};

  if (Object.prototype.hasOwnProperty.call(body, "floor_paint_scopes")) {
    const r = sanitizeLabelArray(body.floor_paint_scopes);
    if (!r.ok) return { ok: false, error: r.error || "bad_floor_paint_scopes" };
    patch.floor_paint_scopes = r.list != null ? r.list : [];
    keysChanged.push("floor_paint_scopes");
  }
  if (Object.prototype.hasOwnProperty.call(body, "common_paint_scopes")) {
    const r = sanitizeLabelArray(body.common_paint_scopes);
    if (!r.ok) return { ok: false, error: r.error || "bad_common_paint_scopes" };
    patch.common_paint_scopes = r.list != null ? r.list : [];
    keysChanged.push("common_paint_scopes");
  }

  if (!keysChanged.length) return { ok: false, error: "no_fields" };

  return { ok: true, patch, keysChanged };
}

/**
 * @param {string} propertyCode
 * @param {object} body
 * @param {string} [traceId]
 * @returns {Promise<{ ok: boolean; programExpansionProfile?: object; error?: string }>}
 */
async function patchPropertyProgramExpansionProfile(propertyCode, body, traceId) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const code = String(propertyCode || "")
    .trim()
    .toUpperCase();
  if (!code || code === "GLOBAL") return { ok: false, error: "invalid_property_code" };

  const parsed = parseProgramExpansionProfilePatch(body);
  if (!parsed.ok) return { ok: false, error: parsed.error || "parse_failed" };

  const { data: row, error: fetchErr } = await sb
    .from("properties")
    .select("code, program_expansion_profile")
    .eq("code", code)
    .maybeSingle();

  if (fetchErr) return { ok: false, error: fetchErr.message || "fetch_failed" };
  if (!row) return { ok: false, error: "unknown_property" };

  const prev = normalizeExpansionProfile(row.program_expansion_profile);
  const merged = { ...prev, ...parsed.patch };

  const { error: upErr } = await sb
    .from("properties")
    .update({
      program_expansion_profile: merged,
    })
    .eq("code", code);

  if (upErr) return { ok: false, error: upErr.message || "update_failed" };

  if (parsed.keysChanged.includes("common_paint_scopes")) {
    await syncCommonAreaLocationsFromLabels(
      sb,
      code,
      Array.isArray(merged.common_paint_scopes) ? merged.common_paint_scopes : []
    );
  }

  await appendEventLog({
    traceId: String(traceId || ""),
    log_kind: "portal",
    event: "PROGRAM_EXPANSION_PROFILE_UPDATED",
    payload: {
      property_code: code,
      keys_changed: parsed.keysChanged,
    },
  });

  return {
    ok: true,
    programExpansionProfile: programExpansionProfileForApi(merged),
  };
}

module.exports = {
  programExpansionProfileForApi,
  patchPropertyProgramExpansionProfile,
  parseProgramExpansionProfilePatch,
};
