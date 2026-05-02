/**
 * Shared heuristics for merge path (e.g. UNIT slot — suppress LLM fluff).
 *
 * **Finalize ticket boundaries** — GAS `reconcileTicketGroupsForFinalize_` — live in
 * `finalizeTicketGroups.js` (issue atoms + grouping + **`buildIssueTicketGroups`**),
 * **not** punctuation/`and` splitting.
 */

const { localCategoryFromText } = require("../../dal/ticketDefaults");

function hasProblemSignal(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  if (localCategoryFromText(t)) return true;
  return /\b(leak|leaking|broken|not working|does not|doesn't|wont|won't|no\b|clog|drain|filter|hot|cold|run)\b/i.test(
    t
  );
}

module.exports = {
  hasProblemSignal,
};
