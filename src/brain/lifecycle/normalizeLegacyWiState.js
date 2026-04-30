/**
 * Map pre-lifecycle V2 `work_items.state` values onto GAS lifecycle states for policy evaluation.
 */
function normalizeLegacyWiStateForLifecycle(state) {
  const s = String(state || "").trim().toUpperCase();
  if (s === "OPEN" || s === "INTAKE") return "UNSCHEDULED";
  if (s === "IN_PROGRESS") return "INHOUSE_WORK";
  return s;
}

module.exports = { normalizeLegacyWiStateForLifecycle };
