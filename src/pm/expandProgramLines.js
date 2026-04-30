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
 * @param {object} template — row from program_templates
 * @param {{ unit_label?: string }[]} unitRows — from tenant_roster for property (active only)
 * @returns {{ scope_type: string, scope_label: string, sort_order: number }[]}
 */
function expandProgramLines(template, unitRows) {
  const expansionType = String(template?.expansion_type || "").trim();
  const defaults = template?.default_scope_labels;

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
    out.push({
      scope_type: "COMMON_AREA",
      scope_label: "Common Area",
      sort_order: order++,
    });
    return out;
  }

  if (expansionType === "FLOOR_BASED") {
    let labels = [];
    if (Array.isArray(defaults)) {
      labels = defaults.map((x) => String(x));
    }
    if (!labels.length) {
      labels = ["1st Floor", "2nd Floor", "3rd Floor", "Stairwell"];
    }
    return labels.map((scope_label, i) => ({
      scope_type: "FLOOR",
      scope_label,
      sort_order: i,
    }));
  }

  if (expansionType === "COMMON_AREA_ONLY") {
    let labels = [];
    if (Array.isArray(defaults) && defaults.length) {
      labels = defaults.map((x) => String(x));
    } else {
      labels = ["Common Area"];
    }
    return labels.map((scope_label, i) => ({
      scope_type: "SITE",
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
};
