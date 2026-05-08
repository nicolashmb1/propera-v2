/**
 * Target work item resolution — parity core of lifecycleResolveTargetWiForStaff_
 * @see 25_STAFF_RESOLVER.gs ~1201–1282
 */

const {
  extractUnitFromBody,
  extractPropertyHintFromBody,
  extractWorkItemIdHintFromBody,
  buildSuggestedPromptsForCandidates,
  scoreCandidatesByIssueHints,
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
 * @param {Array<{ code: string, display_name?: string, ticket_prefix?: string, short_name?: string, address?: string, aliases?: string[] }>} [opts.propertiesList] — `listPropertiesForMenu()` so "Murray" / short names resolve like tenant intake
 * @param {string} [opts.staffId] — for CTX fallback owner check when pending WI not in openWis
 * @param {{ status?: string, owner_id?: string } | null} [opts.ctxPendingWi] — DB row when pending id missing from open list
 */
function resolveTargetWorkItemForStaff(opts) {
  const openWis = opts.openWis || [];
  const body = String(opts.bodyTrim || "").trim();
  const ctx = opts.ctx || null;
  const known = opts.knownPropertyCodesUpper || new Set();
  const staffId = String(opts.staffId || "").trim();
  const ctxPendingWi = opts.ctxPendingWi || null;
  const propertiesList = Array.isArray(opts.propertiesList) ? opts.propertiesList : [];

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
  const propertyHint = extractPropertyHintFromBody(body, known, propertiesList);

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
    const scored = scoreCandidatesByIssueHints(candidates, body);
    if (scored.best) {
      return {
        wiId: scored.best.workItemId,
        reason: "ISSUE_HINT_MATCH",
      };
    }
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

  /**
   * Property + unit filters can yield **zero** rows when `property_id` on a WI is empty/legacy
   * or does not match menu-detected code, while **unit** (and issue text) still identify the row.
   * Without this, `unitFromBody && !propertyHint` never runs and staff NL amends stall on clarify.
   */
  if (candidates.length === 0 && (propertyHint || unitFromBody)) {
    const unitNorm = unitFromBody ? normUnit(unitFromBody) : "";
    let relaxed = openWis;
    if (unitFromBody) {
      relaxed = openWis.filter((w) => normUnit(w.unitId) === unitNorm);
    }
    if (propertyHint && relaxed.length > 1) {
      const byProp = relaxed.filter(
        (w) => String(w.propertyId || "").toUpperCase() === propertyHint
      );
      if (byProp.length >= 1) relaxed = byProp;
    }
    if (relaxed.length === 1) {
      return {
        wiId: relaxed[0].workItemId,
        reason: "UNIT_MATCH_RELAXED_PROPERTY",
      };
    }
    if (relaxed.length > 1) {
      const scored = scoreCandidatesByIssueHints(relaxed, body);
      if (scored.best) {
        return {
          wiId: scored.best.workItemId,
          reason: "ISSUE_HINT_MATCH",
        };
      }
      const prompts = buildSuggestedPromptsForCandidates(relaxed, relaxed);
      if (prompts.length === 1) {
        return { wiId: relaxed[0].workItemId, reason: "SINGLE_PROMPT_AUTO_PICK" };
      }
      return {
        wiId: "",
        reason: "CLARIFICATION_MULTI_MATCH",
        suggestedPrompts: prompts,
      };
    }
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
    /** @see 25_STAFF_RESOLVER.gs workItemGetById_ + status !== COMPLETED */
    if (ctxPendingWi) {
      const st = String(ctxPendingWi.status || "").toUpperCase();
      if (st !== "COMPLETED") {
        const owner = String(ctxPendingWi.owner_id || "").trim();
        if (!staffId || owner === staffId) {
          return { wiId: pending, reason: "CTX" };
        }
      }
    }
  }

  return { wiId: "", reason: "CLARIFICATION", suggestedPrompts: [] };
}

module.exports = { resolveTargetWorkItemForStaff };
