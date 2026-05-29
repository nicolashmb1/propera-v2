/**
 * Read portal proposal / confirm context from router parameter.
 */

function normStr(v) {
  return String(v || "").trim();
}

/**
 * @param {Record<string, string | undefined>} routerParameter
 */
function readPortalProposalContext(routerParameter) {
  const p = routerParameter || {};
  let raw = p._portalProposalContextJson;
  if (!raw) {
    try {
      const nest = JSON.parse(String(p._portalPayloadJson || "{}"));
      raw = nest.portal_proposal_context ?? nest.portalProposalContext;
      if (raw && typeof raw === "object") return raw;
    } catch (_) {
      return null;
    }
    return null;
  }
  try {
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    return j && typeof j === "object" ? j : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {Record<string, string | undefined>} routerParameter
 */
function readProposalConfirmTokenFromPortal(routerParameter) {
  const ctx = readPortalProposalContext(routerParameter);
  if (ctx) {
    const t = normStr(
      ctx.proposal_confirm_token ?? ctx.proposalConfirmToken ?? ""
    );
    if (t) return t;
  }
  try {
    const costCtx = JSON.parse(
      String(routerParameter._portalCostContextJson || "null")
    );
    if (costCtx && typeof costCtx === "object") {
      return normStr(
        costCtx.expense_confirm_token ?? costCtx.expenseConfirmToken
      );
    }
  } catch (_) {
    /* fall through */
  }
  return "";
}

module.exports = {
  readPortalProposalContext,
  readProposalConfirmTokenFromPortal,
};
