/**
 * Brain entry for tenant-agent `append_to_ticket` operation (Phase 5 slice in Phase 4 PR).
 */
const { isAppendToTicketOperation } = require("../../contracts/portalOperation");
const { appendToTenantTicket } = require("../../dal/tenantTicketAppend");
const { outgateMeta } = require("./handleInboundCoreMechanics");

/**
 * @param {object} o
 * @param {Record<string, string>} o.p — routerParameter
 * @param {string} o.canonicalBrainActorKey
 * @param {string} o.traceId
 * @returns {Promise<{ handled: boolean, result?: object }>}
 */
async function tryHandleTenantAppendToTicket(o) {
  const p = o.p || {};
  if (!isAppendToTicketOperation(p)) {
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
        brain: "tenant_append_invalid",
        replyText: "We could not read that update. Please try again.",
        ...outgateMeta("MAINTENANCE_ERROR_PORTAL_VALIDATION", {}),
      },
    };
  }

  const ticketKey = String(j.ticket_key || j.ticketKey || "").trim();
  const message = String(j.message != null ? j.message : "").trim();
  const attachmentUrls = Array.isArray(j.attachmentUrls)
    ? j.attachmentUrls
    : Array.isArray(j.attachment_urls)
      ? j.attachment_urls
      : [];

  const applied = await appendToTenantTicket({
    ticketKey,
    tenantPhoneE164: o.canonicalBrainActorKey,
    message,
    attachmentUrls,
    traceId: o.traceId,
  });

  if (!applied.ok) {
    return {
      handled: true,
      result: {
        ok: applied.brain !== "tenant_append_forbidden",
        brain: applied.brain || "tenant_append_failed",
        replyText: applied.replyText || "We could not add that update.",
        ...outgateMeta("MAINTENANCE_ERROR_PORTAL_VALIDATION", {}),
      },
    };
  }

  return {
    handled: true,
    result: {
      ok: true,
      brain: applied.brain,
      replyText: applied.replyText,
      append: { ticketId: applied.ticketId, ticketKey },
      ...outgateMeta("MAINTENANCE_TENANT_APPEND_OK", {}),
    },
  };
}

module.exports = { tryHandleTenantAppendToTicket };
