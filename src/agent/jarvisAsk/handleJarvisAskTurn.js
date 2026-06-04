/**
 * Jarvis Ask — portal read-only Q&A using Operational Scope + fact pack.
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const {
  jarvisAskEnabled,
  jarvisAskLlmEnabled,
} = require("../../config/env");
const { compileOperationalScope } = require("../operationalScope/compileOperationalScope");
const { gatherJarvisFacts } = require("./gatherJarvisFacts");
const { formatJarvisAskReply } = require("./formatJarvisAskReply");
const { maybeJarvisAskLlmReply } = require("./maybeJarvisAskLlmReply");

/**
 * @param {object} opts
 * @param {string} opts.traceId
 * @param {Record<string, string | undefined>} opts.routerParameter
 * @param {{ isStaff?: boolean, staff?: { staff_id?: string }, staffActorKey?: string }} opts.staffContext
 */
async function handleJarvisAskTurn(opts) {
  const traceId = String(opts.traceId || "");
  const routerParameter = opts.routerParameter || {};
  const staffContext = opts.staffContext || {};
  const question = String(routerParameter.Body || "").trim();

  if (!jarvisAskEnabled()) {
    return {
      ok: true,
      brain: "jarvis_ask",
      replyText:
        "Jarvis Ask is not enabled on this server. Set JARVIS_ASK_ENABLED=1 on propera-v2.",
    };
  }

  const staffId =
    staffContext.staff && staffContext.staff.staff_id
      ? String(staffContext.staff.staff_id).trim()
      : "";
  let scope = null;
  try {
    const raw = routerParameter._operationalScopeJson;
    if (raw) {
      scope = typeof raw === "string" ? JSON.parse(raw) : raw;
    }
  } catch (_) {
    scope = null;
  }

  if (!scope || !scope.version) {
    scope = await compileOperationalScope({
      routerParameter,
      actorRole: staffContext.isStaff ? "staff" : "owner",
      staffId,
      actorKey: String(staffContext.staffActorKey || "").trim(),
      transportChannel: "portal",
    });
  }

  const facts = await gatherJarvisFacts(scope, question);
  let replyText = formatJarvisAskReply(facts, question);
  let usedLlm = false;

  if (!facts.serviceHistory?.ok && jarvisAskLlmEnabled() && question) {
    const llm = await maybeJarvisAskLlmReply({
      question,
      facts,
      deterministicReply: replyText,
    });
    if (llm.ok && llm.reply) {
      replyText = llm.reply;
      usedLlm = true;
    }
  }

  await appendEventLog({
    traceId,
    log_kind: "agent",
    event: "JARVIS_ASK_ANSWERED",
    payload: {
      question_len: question.length,
      used_llm: usedLlm,
      has_focus_ticket: !!facts.focusTicket,
      resolved_from_question: facts.resolvedFromQuestion === true,
      question_resolution: facts.questionResolution?.reason || "",
      open_property_ticket_count: (facts.openTicketsAtProperty || []).length,
      active_work_count: (facts.activeWork || []).length,
      service_history_count: facts.serviceHistory?.ok ? facts.serviceHistory.count : null,
      story: scope.story || "",
    },
  });

  return {
    ok: true,
    brain: "jarvis_ask",
    replyText,
    resolution: {
      mode: "ask",
      readOnly: true,
      usedLlm,
    },
  };
}

module.exports = { handleJarvisAskTurn };
