/**
 * Low-risk mechanical helpers for `handleInboundCore` (Phase 2 refactor).
 * No new policy — same call order and payloads as inlined code.
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const { emitTimed } = require("../../logging/structuredLog");
const { finalizeMaintenanceDraft } = require("../../dal/finalizeMaintenance");
const {
  setPendingExpectedSchedule,
} = require("../../dal/conversationCtxSchedule");
const { setWorkItemSubstate } = require("../../dal/workItemSubstate");

/** Outgate hints — templateKey is stable; text still built by brain until MessageSpec bind. */
function outgateMeta(templateKey, extra) {
  return { outgate: { templateKey, ...(extra || {}) } };
}

/**
 * @param {() => object} staffMetaFn
 * @param {string} templateKey
 * @param {object} [outgateExtra]
 * @param {object} payload — ok, brain, replyText, draft, etc.
 */
function coreInboundResult(staffMetaFn, templateKey, outgateExtra, payload) {
  return {
    ...payload,
    ...staffMetaFn(),
    ...outgateMeta(templateKey, outgateExtra || {}),
  };
}

/**
 * @param {object} o
 * @param {Array<object>} o.groups — finalize row groups from `reconcileFinalizeTicketRows`
 * @param {(g: object) => object} o.buildFinalizeParams — spread into `finalizeMaintenanceDraft`
 * @param {() => object} o.staffMetaFn
 * @param {object} o.draftOnError — `draft` field on failure result
 * @param {'fast'|'multi_turn'} o.path
 * @returns {Promise<{ error: object } | { fins: object[], fin: object }>}
 */
async function finalizeTicketRowGroups(o) {
  const { groups, buildFinalizeParams, staffMetaFn, draftOnError, path } = o;
  const fins = [];
  for (const g of groups) {
    const f = await finalizeMaintenanceDraft(buildFinalizeParams(g));
    if (!f.ok) {
      return {
        error: {
          ok: false,
          brain: "core_finalize_failed",
          draft: draftOnError,
          replyText: "Could not save ticket: " + (f.error || "error"),
          ...staffMetaFn(),
          ...outgateMeta("MAINTENANCE_ERROR_FINALIZE", { path }),
        },
      };
    }
    fins.push(f);
  }
  return { fins, fin: fins[0] };
}

/**
 * @param {string} traceId
 * @param {number | null} traceStartMs
 * @param {object[]} fins
 * @param {'fast'|'multi_turn'} path
 * @param {'core_finalized_fast'|'core_finalized_multi'} crumbOk
 */
async function appendCoreFinalizedFlightRecorder(
  traceId,
  traceStartMs,
  fins,
  path,
  crumbOk
) {
  const fin = fins[0];
  await appendEventLog({
    traceId,
    event: fin.ok ? "CORE_FINALIZED" : "CORE_FINALIZE_FAILED",
    payload: fin.ok
      ? {
          ticket_id: fin.ticketId,
          ticket_ids: fins.map((x) => x.ticketId),
          work_item_id: fin.workItemId,
          work_item_ids: fins.map((x) => x.workItemId),
          ticket_key: fin.ticketKey,
          ticket_keys: fins.map((x) => x.ticketKey),
          path,
        }
      : { error: fin.error },
  });
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: fin.ok ? "CORE_FINALIZED" : "CORE_FINALIZE_FAILED",
    data: fin.ok
      ? {
          ticket_id: fin.ticketId,
          ticket_ids: fins.map((x) => x.ticketId),
          work_item_id: fin.workItemId,
          path,
          crumb: crumbOk,
        }
      : { error: fin.error, crumb: "core_finalize_failed" },
  });
}

/**
 * Post-finalize tenant schedule wait: session/draft + conversation_ctx + work_item substate + flight recorder.
 * @param {object} o
 * @param {(opts: object) => Promise<unknown>} o.setScheduleWaitLike
 * @param {string} o.canonicalBrainActorKey
 * @param {{ ticketKey: string, workItemId: string }} o.fin
 * @param {object} o.waitOpts — `ticketKey`, `draft_issue`, `draft_property`, `draft_unit`, optional `issue_buf_json`
 * @param {string} o.traceId
 * @param {number | null} o.traceStartMs
 * @param {'fast'|'multi_turn'} o.path
 */
async function enterScheduleWaitAndLogTicketCreatedAskSchedule(o) {
  const {
    setScheduleWaitLike,
    canonicalBrainActorKey,
    fin,
    waitOpts,
    traceId,
    traceStartMs,
    path,
  } = o;
  await setScheduleWaitLike(waitOpts);
  await setPendingExpectedSchedule(canonicalBrainActorKey, fin.workItemId);
  await setWorkItemSubstate(fin.workItemId, "SCHEDULE");

  await appendEventLog({
    traceId,
    event: "TICKET_CREATED_ASK_SCHEDULE",
    payload: { ticket_key: fin.ticketKey, path },
  });
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: "TICKET_CREATED_ASK_SCHEDULE",
    data: {
      ticket_key: fin.ticketKey,
      path,
      crumb: "ticket_created_ask_schedule",
    },
  });
}

module.exports = {
  outgateMeta,
  coreInboundResult,
  finalizeTicketRowGroups,
  appendCoreFinalizedFlightRecorder,
  enterScheduleWaitAndLogTicketCreatedAskSchedule,
};
