/**
 * Brain entry for tenant-agent `find_related_ticket` operation (Phase 6).
 */
const { isFindRelatedTicketOperation } = require("../../contracts/portalOperation");
const { findRelatedTenantTickets } = require("../../dal/findRelatedTenantTickets");
const { outgateMeta } = require("./handleInboundCoreMechanics");

/**
 * @param {object} o
 * @param {Record<string, string>} o.p — routerParameter
 * @param {string} o.canonicalBrainActorKey
 * @param {string} o.traceId
 * @returns {Promise<{ handled: boolean, result?: object }>}
 */
async function tryHandleTenantFindRelatedTicket(o) {
  const p = o.p || {};
  if (!isFindRelatedTicketOperation(p)) {
    return { handled: false };
  }

  let j = {};
  try {
    j = JSON.parse(String(p._portalPayloadJson || "{}"));
  } catch (_) {
    return {
      handled: true,
      result: {
        ok: false,
        brain: "tenant_find_related_invalid",
        replyText: "We could not read that request. Please try again.",
        ...outgateMeta("MAINTENANCE_ERROR_PORTAL_VALIDATION", {}),
      },
    };
  }

  const hints = j.hints && typeof j.hints === "object" ? j.hints : {};
  const lookup = await findRelatedTenantTickets({
    tenantPhoneE164: o.canonicalBrainActorKey,
    hints,
    traceId: o.traceId,
  });

  if (!lookup.ok) {
    return {
      handled: true,
      result: {
        ok: false,
        brain: lookup.brain || "tenant_find_related_failed",
        replyText: "We could not look up your requests right now. Please describe your issue.",
        ...outgateMeta("MAINTENANCE_ERROR_PORTAL_VALIDATION", {}),
      },
    };
  }

  return {
    handled: true,
    result: {
      ok: true,
      brain: lookup.brain,
      findRelated: {
        matchStatus: lookup.matchStatus,
        ticket: lookup.ticket || null,
        tickets: lookup.tickets || [],
        allowedOperations: lookup.allowedOperations || [],
      },
      replyText: "",
      ...outgateMeta("MAINTENANCE_TENANT_FIND_RELATED_OK", {}),
    },
  };
}

module.exports = { tryHandleTenantFindRelatedTicket };
