/**
 * Resolve ticket for append_service_note Plan draft.
 */

const crypto = require("crypto");
const { getSupabase } = require("../../db/supabase");
const { resolveProposalTicketTarget } = require("../proposals/resolveProposalTicketTarget");
const { compileOperationalScope } = require("../operationalScope/compileOperationalScope");
const { buildAppendServiceNoteProposal } = require("../proposals/appendServiceNote");

/**
 * @param {object} parsed — from parseProposeAppendServiceNote
 * @param {object} ctx
 * @param {Record<string, string | undefined>} ctx.routerParameter
 * @param {string} ctx.actorLabel
 * @param {object | null} [ctx.scope]
 */
async function resolveProposeAppendServiceNoteDraft(parsed, ctx) {
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, message: "Database is not configured." };
  }

  let scope = ctx.scope || null;
  if (!scope) {
    try {
      scope = await compileOperationalScope({
        routerParameter: ctx.routerParameter || {},
        actorRole: "staff",
        staffId: String(ctx.staffId || "").trim(),
        actorKey: String(ctx.staffActorKey || "").trim(),
        transportChannel: "portal",
      });
    } catch (_) {
      scope = null;
    }
  }

  const pageCtx = (() => {
    try {
      const raw = String(ctx.routerParameter?._portalPageContextJson || "").trim();
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  })();

  const resolved = await resolveProposalTicketTarget({
    scope,
    pageContext: pageCtx,
    humanTicketId: parsed.humanTicketId,
    unitLabel: parsed.unit,
    propertyCode: parsed.propertyCode,
    issueHint: "",
  });

  if (!resolved.ok) {
    const candidates = (resolved.candidates || [])
      .slice(0, 4)
      .map((c) => c.humanTicketId)
      .filter(Boolean)
      .join(", ");
    return {
      ok: false,
      message: candidates
        ? `${resolved.message} (${candidates})`
        : resolved.message || "Could not find ticket.",
      error: resolved.error,
    };
  }

  const target = resolved.target;
  const humanId = String(target.humanTicketId || "").trim();
  const actorLabel = String(ctx.actorLabel || "Staff").trim() || "Staff";
  const summary = `Append service note to ${humanId}${target.unitLabel ? ` (unit ${target.unitLabel})` : ""}: ${parsed.noteText.slice(0, 120)}${parsed.noteText.length > 120 ? "…" : ""}`;

  const built = buildAppendServiceNoteProposal(
    {
      proposal_id: crypto.randomUUID(),
      ticketRowId: target.ticketRowId,
      humanTicketId: humanId,
      propertyCode: target.propertyCode,
      unitLabel: target.unitLabel,
      noteText: parsed.noteText,
      actorLabel,
    },
    summary
  );

  return {
    ok: true,
    summary,
    proposal: built.proposal,
    confirmToken: built.confirmToken,
    scopeSnapshot: {
      anchor: {
        humanTicketId: humanId,
        ticketRowId: target.ticketRowId,
        unit: target.unitLabel,
        propertyCode: target.propertyCode,
      },
    },
  };
}

module.exports = { resolveProposeAppendServiceNoteDraft };
