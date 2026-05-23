/**
 * Pure expansion for PM/Task V1 — template expansion_type → checklist line specs (no DB).
 * @see docs/PM_PROGRAM_ENGINE_V1.md
 */

/**
 * @param {string} unitLabel
 * @returns {string}
 */
function formatUnitScopeLabel(unitLabel) {
  const u = String(unitLabel || "").trim();
  if (!u) return "Unit";
  if (/^unit\s+/i.test(u)) return u;
  return `Unit ${u}`;
}

/**
 * @param {{ unit_label?: string }[]} unitRows — active roster rows for one property
 * @returns {{ unit_label: string }[]} sorted by unit_label
 */
function sortUnitRows(unitRows) {
  const rows = Array.isArray(unitRows) ? [...unitRows] : [];
  rows.sort((a, b) =>
    String(a.unit_label || "").localeCompare(String(b.unit_label || ""), undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
  return rows;
}

/**
 * Normalize `properties.program_expansion_profile` (jsonb) for expansion helpers.
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
/**
 * Merge Building structure labels with canonical `property_locations` (common_area).
 * Profile order wins; append active location labels not already present (case-insensitive).
 *
 * @param {string[]} [profileLabels] — `program_expansion_profile.common_paint_scopes`
 * @param {string[]} [canonicalLabels] — active `property_locations` labels for the property
 * @returns {string[]}
 */
function mergeCommonAreaScopeLabels(profileLabels, canonicalLabels) {
  const out = [];
  const seen = new Set();
  const push = (label) => {
    const s = String(label == null ? "" : label).trim();
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  if (Array.isArray(profileLabels)) {
    for (const x of profileLabels) push(x);
  }
  if (Array.isArray(canonicalLabels)) {
    for (const x of canonicalLabels) push(x);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} profile
 * @param {string[]} [canonicalCommonAreaLabels]
 * @returns {string[]}
 */
function resolveCommonAreaLabelsForExpansion(profile, canonicalCommonAreaLabels) {
  let fromProfile = [];
  const fromCommon = profile.common_paint_scopes;
  if (Array.isArray(fromCommon) && fromCommon.length) {
    fromProfile = fromCommon.map((x) => String(x).trim()).filter(Boolean);
  }
  const merged = mergeCommonAreaScopeLabels(fromProfile, canonicalCommonAreaLabels);
  return merged;
}

function normalizeExpansionProfile(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === "object" && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return /** @type {Record<string, unknown>} */ (raw);
  return {};
}

/**
 * @param {object} template — row from program_templates
 * @param {{ unit_label?: string }[]} unitRows — from tenant_roster for property (active only)
 * @param {{ expansionProfile?: unknown; canonicalCommonAreaLabels?: string[] }} [options]
 *   — `properties.program_expansion_profile` plus active `property_locations` common-area labels
 * @returns {{ scope_type: string, scope_label: string, sort_order: number }[]}
 */
function expandProgramLines(template, unitRows, options) {
  const expansionType = String(template?.expansion_type || "").trim();
  const defaults = template?.default_scope_labels;
  const profile = normalizeExpansionProfile(options && options.expansionProfile);
  const canonicalCommon =
    options && Array.isArray(options.canonicalCommonAreaLabels)
      ? options.canonicalCommonAreaLabels
      : [];

  if (expansionType === "UNIT_PLUS_COMMON") {
    const sorted = sortUnitRows(unitRows);
    const out = [];
    let order = 0;
    for (const row of sorted) {
      out.push({
        scope_type: "UNIT",
        scope_label: formatUnitScopeLabel(row.unit_label),
        sort_order: order++,
      });
    }
    /** Building structure + canonical locations; else legacy single "Common Area" line */
    let commonLabels = resolveCommonAreaLabelsForExpansion(profile, canonicalCommon);
    if (!commonLabels.length) {
      commonLabels = ["Common Area"];
    }
    for (const scope_label of commonLabels) {
      out.push({
        scope_type: "COMMON_AREA",
        scope_label,
        sort_order: order++,
      });
    }
    return out;
  }

  if (expansionType === "FLOOR_BASED") {
    let floorLabels = [];
    const fromFloors = profile.floor_paint_scopes;
    if (Array.isArray(fromFloors) && fromFloors.length) {
      floorLabels = fromFloors.map((x) => String(x).trim()).filter(Boolean);
    }
    if (!floorLabels.length && Array.isArray(defaults)) {
      floorLabels = defaults.map((x) => String(x));
    }
    if (!floorLabels.length) {
      floorLabels = ["1st Floor", "2nd Floor", "3rd Floor", "Stairwell"];
    }
    const floorLines = floorLabels.map((scope_label, i) => ({
      scope_type: "FLOOR",
      scope_label,
      sort_order: i,
    }));

    /** Same keys as property UI + canonical `property_locations` */
    const commonLabels = resolveCommonAreaLabelsForExpansion(profile, canonicalCommon);
    let order = floorLines.length;
    const commonLines = commonLabels.map((scope_label) => ({
      scope_type: "COMMON_AREA",
      scope_label,
      sort_order: order++,
    }));

    return [...floorLines, ...commonLines];
  }

  if (expansionType === "COMMON_AREA_ONLY") {
    let labels = resolveCommonAreaLabelsForExpansion(profile, canonicalCommon);
    if (!labels.length && Array.isArray(defaults) && defaults.length) {
      labels = defaults.map((x) => String(x));
    }
    if (!labels.length) {
      labels = ["Common Area"];
    }
    return labels.map((scope_label, i) => ({
      scope_type: "COMMON_AREA",
      scope_label,
      sort_order: i,
    }));
  }

  if (expansionType === "CUSTOM_MANUAL") {
    return [];
  }

  return [];
}

module.exports = {
  expandProgramLines,
  formatUnitScopeLabel,
  sortUnitRows,
  normalizeExpansionProfile,
  mergeCommonAreaScopeLabels,
  resolveCommonAreaLabelsForExpansion,
};
