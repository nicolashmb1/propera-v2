/**
 * Target work item resolution — parity core of lifecycleResolveTargetWiForStaff_
 * @see 25_STAFF_RESOLVER.gs ~1201–1282
 */

const {
  extractUnitFromBody,
  extractPropertyHintFromBody,
  extractWorkItemIdHintFromBody,
  buildSuggestedPromptsForCandidates,
} = require("./lifecycleExtract");

function normUnit(u) {
  return String(u || "")
    .toLowerCase()
    .replace(/\s/g, "");
}

/**
 * @param {object} opts
 * @param {Array<{ workItemId: string, unitId?: string, propertyId?: string, metadata_json?: object }>} opts.openWis
 * @param {string} opts.bodyTrim
 * @param {{ pending_work_item_id?: string, active_work_item_id?: string } | null} opts.ctx
 * @param {Set<string>} opts.knownPropertyCodesUpper
 */
function resolveTargetWorkItemForStaff(opts) {
  const openWis = opts.openWis || [];
  const body = String(opts.bodyTrim || "").trim();
  const ctx = opts.ctx || null;
  const known = opts.knownPropertyCodesUpper || new Set();

  if (openWis.length === 0) {
    return { wiId: "", reason: "CLARIFICATION", suggestedPrompts: [] };
  }
  if (openWis.length === 1) {
    return { wiId: openWis[0].workItemId, reason: "OWNER_MATCH" };
  }

  const wiIdHint = extractWorkItemIdHintFromBody(body);
  if (wiIdHint) {
    const hintUpper = wiIdHint.toUpperCase();
    const byId = openWis.filter((w) => {
      const id = String(w.workItemId || "").toUpperCase();
      return (
        id === hintUpper ||
        id.indexOf(hintUpper) >= 0 ||
        id.lastIndexOf(hintUpper) === id.length - hintUpper.length
      );
    });
    if (byId.length === 1) return { wiId: byId[0].workItemId, reason: "WI_ID_MATCH" };
  }

  const unitFromBody = extractUnitFromBody(body);
  const propertyHint = extractPropertyHintFromBody(body, known);

  let candidates = openWis;
  if (propertyHint) {
    candidates = candidates.filter(
      (w) => String(w.propertyId || "").toUpperCase() === propertyHint
    );
  }
  if (unitFromBody) {
    const unitNorm = normUnit(unitFromBody);
    candidates = candidates.filter(
      (w) => normUnit(w.unitId) === unitNorm
    );
  }

  if (candidates.length === 1) {
    return {
      wiId: candidates[0].workItemId,
      reason: propertyHint ? "PROPERTY_UNIT_MATCH" : "UNIT_MATCH",
    };
  }
  if (candidates.length > 1) {
    const prompts = buildSuggestedPromptsForCandidates(candidates, candidates);
    if (prompts.length === 1) {
      return { wiId: candidates[0].workItemId, reason: "SINGLE_PROMPT_AUTO_PICK" };
    }
    return {
      wiId: "",
      reason: "CLARIFICATION_MULTI_MATCH",
      suggestedPrompts: prompts,
    };
  }

  if (unitFromBody && !propertyHint) {
    const unitNorm = normUnit(unitFromBody);
    const unitOnly = openWis.filter(
      (w) => normUnit(w.unitId) === unitNorm
    );
    if (unitOnly.length === 1) {
      return { wiId: unitOnly[0].workItemId, reason: "UNIT_MATCH_UNSCOPED_PROPERTY" };
    }
    if (unitOnly.length > 1) {
      const unitPrompts = buildSuggestedPromptsForCandidates(unitOnly, unitOnly);
      if (unitPrompts.length === 1) {
        return { wiId: unitOnly[0].workItemId, reason: "SINGLE_PROMPT_AUTO_PICK" };
      }
      return {
        wiId: "",
        reason: "CLARIFICATION_MULTI_PROPERTY",
        suggestedPrompts: unitPrompts,
      };
    }
  }

  const pending =
    ctx &&
    (String(ctx.pending_work_item_id || "").trim() ||
      String(ctx.active_work_item_id || "").trim());
  if (pending) {
    const found = openWis.find((w) => w.workItemId === pending);
    if (found) return { wiId: pending, reason: "CTX" };
  }

  return { wiId: "", reason: "CLARIFICATION", suggestedPrompts: [] };
}

module.exports = { resolveTargetWorkItemForStaff };
