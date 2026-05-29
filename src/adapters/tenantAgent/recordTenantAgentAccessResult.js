/**
 * After access engine runs on tenant-agent handoff — persist reply and reset session state.
 */
const { appendMessage, saveTenantConversation } = require("./conversationStore");
const { narrateAccessBrainResult } = require("../../access/accessBrainResult");
const { stampAccessLane } = require("./accessGatherRules");
const {
  readAccessRequest,
  recordAccessBookingSuccess,
  recordAccessBrainRejection,
} = require("./conversationState");

/**
 * @param {object} o
 * @param {string} o.conversationId
 * @param {string} o.traceId
 * @param {object | null} o.accessRun
 * @param {string} [o.bodyText]
 */
async function recordTenantAgentAccessResult(o) {
  const conversationId = String(o.conversationId || "").trim();
  if (!conversationId) return;

  const accessRun = o.accessRun || {};
  const accessFacts = accessRun.accessFacts || null;
  const replyText =
    String(accessRun.replyText || "").trim() ||
    narrateAccessBrainResult(accessFacts);
  if (!replyText) return;

  const sb = require("../../db/supabase").getSupabase();
  if (!sb) return;

  const { data: row } = await sb
    .from("tenant_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();

  if (!row) return;

  const accessRequest = { ...(readAccessRequest(row.partial_package) || {}) };
  const brain = String(accessRun.brain || "").trim();
  const succeeded = brain === "access_reserved";

  let messages = row.messages;
  if (Array.isArray(messages)) {
    messages = appendMessage({ messages }, "assistant", replyText).messages;
  }

  const needsWindow =
    brain === "access_needs_window" || String(accessRun.reason || "").trim() === "needs_window";

  let partial;
  if (succeeded) {
    partial = recordAccessBookingSuccess(row.partial_package, {
      reservationId: String(accessRun.reservationId || "").trim(),
      locationId: String(accessRun.locationId || accessRequest.locationId || "").trim(),
      locationHint: String(accessRequest.locationHint || "").trim(),
      dateForDay: String(accessRequest.dateForDay || "").trim(),
      startAt: String(accessRun.startAt || accessRequest.startAt || "").trim(),
      endAt: String(accessRun.endAt || accessRequest.endAt || "").trim(),
    });
  } else {
    partial = recordAccessBrainRejection(
      row.partial_package,
      accessRequest,
      {
        brain,
        code: String(accessRun.reason || "").trim(),
        replyText,
        accessFacts: accessFacts || null,
      },
      { stripWindow: needsWindow }
    );
  }

  const lanePartial = stampAccessLane(partial);

  await saveTenantConversation({
    ...row,
    status: "gathering",
    handoff_trace_id: null,
    partial_package: lanePartial,
    messages,
    last_brain_result: {
      brain: brain || "access_reply",
      replyText,
      accessFacts: accessFacts || null,
    },
  });
}

module.exports = {
  recordTenantAgentAccessResult,
};
