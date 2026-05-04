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
 * @param {{ expansionProfile?: unknown }} [options] — `properties.program_expansion_profile` (per-property overrides)
 * @returns {{ scope_type: string, scope_label: string, sort_order: number }[]}
 */
function expandProgramLines(template, unitRows, options) {
  const expansionType = String(template?.expansion_type || "").trim();
  const defaults = template?.default_scope_labels;
  const profile = normalizeExpansionProfile(options && options.expansionProfile);

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
    /** Building structure common scopes (Gym, Lobby, …); else legacy single "Common Area" line */
    let commonLabels = [];
    const fromCommon = profile.common_paint_scopes;
    if (Array.isArray(fromCommon) && fromCommon.length) {
      commonLabels = fromCommon.map((x) => String(x).trim()).filter(Boolean);
    }
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

    /** Same keys as property UI — gym, lobby, terrace, etc. */
    let commonLabels = [];
    const fromCommon = profile.common_paint_scopes;
    if (Array.isArray(fromCommon) && fromCommon.length) {
      commonLabels = fromCommon.map((x) => String(x).trim()).filter(Boolean);
    }
    let order = floorLines.length;
    const commonLines = commonLabels.map((scope_label) => ({
      scope_type: "COMMON_AREA",
      scope_label,
      sort_order: order++,
    }));

    return [...floorLines, ...commonLines];
  }

  if (expansionType === "COMMON_AREA_ONLY") {
    let labels = [];
    const fromProfile = profile.common_paint_scopes;
    if (Array.isArray(fromProfile) && fromProfile.length) {
      labels = fromProfile.map((x) => String(x).trim()).filter(Boolean);
    }
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
};
