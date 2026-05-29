/**
 * Non-maintenance tenant message — polite deflect + staff contact (maintenance-only lane).
 */
const { appendEventLog } = require("../../dal/appendEventLog");
const { parseMediaJson } = require("../../brain/shared/mediaPayload");
const { isGatheringGreetingOnly } = require("./gatherGreetingReply");
const { isNonMaintenanceRequest } = require("./classifyNonMaintenanceRequest");
const { resolveMaintenanceIntentForTurn } = require("./resolveMaintenanceIntentForTurn");
const { resolvePropertyStaffContact } = require("./resolvePropertyStaffContact");
const { buildStaffContactDeflectReply } = require("./buildStaffContactDeflectReply");
const { appendMessage, saveTenantConversation } = require("./conversationStore");

/**
 * @param {object} o
 * @param {object | null} [o.conv]
 * @param {object} [o.partial]
 * @param {string} o.bodyText
 * @param {Record<string, string>} [o.routerParameter]
 * @returns {boolean}
 */
function shouldApplyMaintenanceOnlyGate(o) {
  const conv = o.conv || null;
  const partial = o.partial || (conv && conv.partial_package) || {};
  const bodyText = String(o.bodyText || "").trim();
  const mediaItems = parseMediaJson(String((o.routerParameter && o.routerParameter._mediaJson) || ""));

  if (mediaItems.length) return false;
  if (isGatheringGreetingOnly(bodyText, partial)) return false;
  if (conv && String(conv.status || "").trim() === "handoff_pending") return false;
  const { readAccessLastBooking } = require("./conversationState");
  if (readAccessLastBooking(conv?.partial_package)) return false;
  if (String(conv?.last_brain_result?.brain || "").trim() === "access_reserved") return false;
  if (
    conv &&
    conv.partial_package &&
    Array.isArray(conv.partial_package._related_ticket_candidates) &&
    conv.partial_package._related_ticket_candidates.length
  ) {
    return false;
  }

  const issue = String(partial.issue || "").trim();
  const convStatus = String((conv && conv.status) || "").trim();

  // Maintenance issue in an active gathering flow → skip gate, tenant is mid-flow.
  // Post-complete conversations are NOT protected: a billing pivot after ticket
  // completion must still be deflected even if the old issue slot is non-empty.
  if (
    issue.length >= 2 &&
    convStatus === "gathering" &&
    !isNonMaintenanceRequest(issue)
  ) {
    return false;
  }

  const bodyNonMaint = isNonMaintenanceRequest(bodyText);
  const issueNonMaint = isNonMaintenanceRequest(issue);
  if (bodyNonMaint || issueNonMaint) return true;

  if (issue.length >= 2) return false;

  return true;
}

/**
 * @param {object} o
 * @returns {Promise<boolean>}
 */
async function shouldDeflectNonMaintenanceTurn(o) {
  const partial = o.partial || (o.conv && o.conv.partial_package) || {};
  const bodyText = String(o.bodyText || "").trim();
  if (isNonMaintenanceRequest(bodyText)) return true;
  const issue = String(partial.issue || "").trim();
  if (issue.length >= 2 && isNonMaintenanceRequest(issue)) return true;

  if (!shouldApplyMaintenanceOnlyGate(o)) return false;

  const resolved = await resolveMaintenanceIntentForTurn({
    bodyText,
    conv: o.conv || null,
    partial,
    traceId: o.traceId,
  });
  return resolved.intent === "non_maintenance";
}

/**
 * @param {object} o
 * @param {'non_maintenance' | 'maintenance_repair'} [o.forceIntent]
 * @returns {Promise<{ handled: boolean, phase?: string, replyText?: string, conversationId?: string, tenantLocale?: string } | null>}
 */
async function maybeDeflectNonMaintenanceTurn(o) {
  const bodyText = String(o.bodyText || "").trim();
  if (!bodyText) return null;

  const forceIntent = String(o.forceIntent || "").trim();
  let shouldDeflect = false;
  if (forceIntent === "non_maintenance") {
    shouldDeflect = shouldApplyMaintenanceOnlyGate(o);
  } else {
    shouldDeflect = await shouldDeflectNonMaintenanceTurn(o);
  }
  if (!shouldDeflect) return null;
  if (forceIntent !== "non_maintenance" && !shouldApplyMaintenanceOnlyGate(o)) return null;

  const conv = o.conv || null;
  const partial = o.partial || (conv && conv.partial_package) || {};
  const propertyCode = String(partial.property || "").trim().toUpperCase();
  const contact = await resolvePropertyStaffContact({
    propertyCode,
    tenantActorKey: o.tenantActorKey,
  });

  const replyText = buildStaffContactDeflectReply({
    phoneE164: contact.phoneE164,
    propertyCode: contact.propertyCode || propertyCode,
    propertiesList: o.propertiesList,
  });

  const turnCount = conv ? Number(conv.turn_count || 0) + 1 : 1;
  let messages = conv
    ? appendMessage(conv, "user", bodyText)
    : appendMessage({ messages: [] }, "user", bodyText);
  messages = appendMessage({ messages }, "assistant", replyText);

  let conversationId = conv && conv.id ? conv.id : "";
  const tenantLocale = (conv && conv.tenant_locale) || "en";

  if (conv) {
    await saveTenantConversation({
      ...conv,
      status: "closed",
      turn_count: turnCount,
      partial_package: {},
      messages,
    });
  } else {
    const row = await saveTenantConversation({
      tenant_actor_key: o.tenantActorKey,
      transport_channel: o.transportChannel,
      status: "closed",
      partial_package: {},
      messages,
      turn_count: turnCount,
      tenant_locale: tenantLocale,
    });
    conversationId = row && row.id ? row.id : "";
  }

  await appendEventLog({
    traceId: String(o.traceId || "").trim(),
    event: "TENANT_AGENT_NON_MAINTENANCE_DEFLECT",
    payload: {
      tenant_actor_key: String(o.tenantActorKey || "").trim(),
      conversation_id: conversationId,
      property_code: contact.propertyCode || propertyCode,
      contact_source: contact.source,
      intent_source: forceIntent === "non_maintenance" ? "llm_gather" : "gate",
    },
  });

  return {
    handled: true,
    phase: "non_maintenance_deflect",
    replyText,
    conversationId,
    tenantLocale,
  };
}

module.exports = {
  shouldApplyMaintenanceOnlyGate,
  shouldDeflectNonMaintenanceTurn,
  maybeDeflectNonMaintenanceTurn,
};
