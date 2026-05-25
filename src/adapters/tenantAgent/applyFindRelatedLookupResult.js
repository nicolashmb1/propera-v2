/**
 * Apply find_related_ticket brain result to tenant conversation (Phase 6).
 */
const { getSupabase } = require("../../db/supabase");
const { saveTenantConversation, appendMessage } = require("./conversationStore");
const { completenessCheck } = require("./completeness");
const { promptForMissingField } = require("./deterministicPrompts");
const { captureFollowUpPending } = require("./sameOrNewClarify");
const { STATUS_SAME_OR_NEW } = require("./postCompleteTurn");
const { loadPropertyCodesUpper } = require("../../brain/core/coreMaintenanceShared");
const { listPropertiesForMenu } = require("../../dal/intakeSession");
const {
  buildStrongMatchClarifyPrompt,
  buildMultipleMatchPrompt,
  buildWeakMatchClarifyPrompt,
} = require("./findRelatedPrompt");

/**
 * @param {object} o
 * @param {string} o.conversationId
 * @param {object} o.findRelated
 * @param {string} [o.bodyText]
 * @param {string} [o.mediaJson]
 * @param {Set<string>} [o.known]
 * @returns {Promise<{ brain: string, replyText: string }>}
 */
async function applyFindRelatedLookupResult(o) {
  const conversationId = String(o.conversationId || "").trim();
  const findRelated = o.findRelated || {};
  const matchStatus = String(findRelated.matchStatus || "no_match").trim();
  const bodyText = String(o.bodyText || "").trim();
  const mediaJson = String(o.mediaJson || "");

  const sb = getSupabase();
  if (!sb || !conversationId) {
    return {
      brain: "tenant_agent_find_related",
      replyText: "What's going on? Tell me your property, unit, and issue.",
    };
  }

  const known =
    o.known && typeof o.known.size === "number" && o.known.size > 0
      ? o.known
      : await loadPropertyCodesUpper(sb);
  const propertiesList = await listPropertiesForMenu();

  const { data: row } = await sb
    .from("tenant_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();

  if (!row) {
    return {
      brain: "tenant_agent_find_related",
      replyText: "What's going on? Tell me your property, unit, and issue.",
    };
  }

  const partial = { ...(row.partial_package || {}) };
  delete partial._related_ticket_candidates;
  const turnCount = Number(row.turn_count || 0);
  let messages = row.messages || [];
  if (bodyText) {
    messages = appendMessage({ messages }, "user", bodyText);
  }

  if (matchStatus === "no_match") {
    const complete = completenessCheck(partial, known);
    const replyText = promptForMissingField(
      complete.missing,
      partial,
      propertiesList
    );
    await saveTenantConversation({
      ...row,
      status: "gathering",
      turn_count: turnCount,
      partial_package: partial,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return { brain: "tenant_agent_find_related_no_match", replyText };
  }

  if (matchStatus === "multiple_matches") {
    const tickets = Array.isArray(findRelated.tickets) ? findRelated.tickets : [];
    const replyText = buildMultipleMatchPrompt(tickets);
    await saveTenantConversation({
      ...row,
      status: "gathering",
      turn_count: turnCount,
      partial_package: {
        ...partial,
        _related_ticket_candidates: tickets.map((t) => ({
          ticket_key: t.ticket_key,
          ticket_id: t.ticket_id,
          issueSnippet: t.issueSnippet,
          assigned_name: t.assigned_name,
          preferred_window: t.preferred_window,
        })),
      },
      messages: appendMessage({ messages }, "assistant", replyText),
      last_brain_result: { brain: "tenant_find_related_ticket", findRelated },
    });
    return { brain: "tenant_agent_find_related_multiple", replyText };
  }

  const ticket =
    findRelated.ticket ||
    (Array.isArray(findRelated.tickets) && findRelated.tickets[0]) ||
    null;

  if (!ticket || !ticket.ticket_key) {
    const complete = completenessCheck(partial, known);
    const replyText = promptForMissingField(
      complete.missing,
      partial,
      propertiesList
    );
    await saveTenantConversation({
      ...row,
      status: "gathering",
      turn_count: turnCount,
      partial_package: partial,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return { brain: "tenant_agent_find_related_no_match", replyText };
  }

  const replyText =
    matchStatus === "weak_match"
      ? buildWeakMatchClarifyPrompt(ticket)
      : buildStrongMatchClarifyPrompt(ticket);

  await saveTenantConversation({
    ...row,
    status: STATUS_SAME_OR_NEW,
    turn_count: turnCount,
    active_ticket_key: String(ticket.ticket_key || "").trim(),
    partial_package: {
      ...partial,
      _follow_up_pending: captureFollowUpPending({ bodyText, mediaJson }),
    },
    messages: appendMessage({ messages }, "assistant", replyText),
    last_brain_result: {
      brain: "tenant_find_related_ticket",
      findRelated,
      finalize: {
        ticketKey: ticket.ticket_key,
        ticketId: ticket.ticket_id,
      },
    },
  });

  return {
    brain: "tenant_agent_find_related_match",
    replyText,
  };
}

module.exports = { applyFindRelatedLookupResult };
