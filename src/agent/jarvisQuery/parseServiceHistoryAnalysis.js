/**
 * Detect which unit-level analysis staff wants on a service history query.
 */

/** @typedef {'summary' | 'distinct_units' | 'repeat_units' | 'unit_breakdown'} ServiceHistoryAnalysisMode */

/**
 * @param {string} question
 * @returns {ServiceHistoryAnalysisMode}
 */
function parseServiceHistoryAnalysis(question) {
  const ql = String(question || "").trim().toLowerCase();
  if (!ql) return "summary";

  if (
    /repeat|recurring|multiple|more than one|several times|again|twice|2\+|two or more/.test(
      ql
    ) &&
    /unit|apartment|apt/.test(ql)
  ) {
    return "repeat_units";
  }

  if (
    /different units|distinct units|unique units|separate units|how many units|from how many units|across how many units|units involved|units affected/.test(
      ql
    )
  ) {
    return "distinct_units";
  }

  if (/breakdown|per unit|by unit|each unit|unit breakdown|split by unit/.test(ql)) {
    return "unit_breakdown";
  }

  return "summary";
}

module.exports = { parseServiceHistoryAnalysis };
