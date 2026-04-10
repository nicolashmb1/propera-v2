/**
 * Real staff operational path: resolve target WI → normalize outcome → update work_items + event_log.
 * Schedule-window parsing from GAS is not replicated here yet (explicit branch).
 */
const { getSupabase } = require("../../db/supabase");
const { appendEventLog } = require("../../dal/appendEventLog");
const { getConversationCtx } = require("../../dal/conversationCtx");
const {
  listOpenWorkItemsForOwner,
  applyStaffOutcomeUpdate,
} = require("../../dal/workItems");
const { resolveTargetWorkItemForStaff } = require("./resolveTargetWorkItemForStaff");
const { normalizeStaffOutcome } = require("./normalizeStaffOutcome");

async function loadPropertyCodesUpper(sb) {
  const { data, error } = await sb.from("properties").select("code");
  if (error || !data) return new Set();
  const set = new Set();
  data.forEach((r) => {
    if (r && r.code) set.add(String(r.code).toUpperCase());
  });
  return set;
}

function looksLikeScheduleOnlyWithoutStatus(body) {
  const lower = String(body || "").toLowerCase();
  const hasStatus =
    /\b(done|complete|completed|finished|fixed|resolved|in progress|working on it|parts|vendor|access)\b/.test(
      lower
    );
  if (hasStatus) return false;
  return /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}:\d|\bam\b|\bpm\b|morning|afternoon|evening)\b/.test(
    lower
  );
}

function formatClarification(resolved) {
  if (resolved.suggestedPrompts && resolved.suggestedPrompts.length > 0) {
    return (
      "Which ticket? Reply using one of these patterns, or include the work item id:\n" +
      resolved.suggestedPrompts.map((p) => "• " + p).join("\n")
    );
  }
  return (
    "No matching open ticket. Add a property code + unit, work item id (WI_…), or clarify which building/unit."
  );
}

function formatOutcomeReply(wiId, norm, update) {
  if (!update.ok) return "Could not save update for " + wiId + ". Try again.";
  if (norm === "COMPLETED") return "Saved: " + wiId + " marked completed.";
  if (norm === "IN_PROGRESS") return "Saved: " + wiId + " marked in progress.";
  if (typeof norm === "object" && norm.outcome === "WAITING_PARTS") {
    return "Saved: " + wiId + " waiting on parts" + (norm.partsEtaText ? " (" + norm.partsEtaText + ")." : ".");
  }
  if (typeof norm === "string") return "Saved: " + wiId + " — " + norm + ".";
  return "Updated " + wiId + ".";
}

/**
 * @param {object} o
 * @param {string} o.traceId
 * @param {string} o.staffActorKey
 * @param {{ staff_id: string }} o.staffRow
 * @param {Record<string, string | undefined>} o.routerParameter
 */
async function handleStaffLifecycleCommand(o) {
  const traceId = o.traceId || "";
  const staffActorKey = String(o.staffActorKey || "").trim();
  const staffRow = o.staffRow;
  const body = String((o.routerParameter && o.routerParameter.Body) || "").trim();
  const staffId = staffRow && staffRow.staff_id ? String(staffRow.staff_id).trim() : "";

  const sb = getSupabase();
  if (!sb || !staffId) {
    await appendEventLog({
      traceId,
      event: "STAFF_LIFECYCLE_SKIP",
      payload: { reason: !sb ? "no_db" : "no_staff_id" },
    });
    return {
      ok: false,
      brain: "staff_skip",
      replyText: "Staff identity is not available (database or roster).",
    };
  }

  await appendEventLog({
    traceId,
    event: "STAFF_LIFECYCLE_ENTER",
    payload: { staff_id: staffId, body_len: body.length },
  });

  const known = await loadPropertyCodesUpper(sb);
  const ctx = await getConversationCtx(staffActorKey);
  const rawRows = await listOpenWorkItemsForOwner(staffId);
  const openWis = rawRows.map((r) => ({
    workItemId: r.work_item_id,
    unitId: r.unit_id,
    propertyId: r.property_id,
    metadata_json: r.metadata_json,
  }));

  const resolved = resolveTargetWorkItemForStaff({
    openWis,
    bodyTrim: body,
    ctx,
    knownPropertyCodesUpper: known,
  });

  if (!resolved.wiId) {
    await appendEventLog({
      traceId,
      event: "STAFF_TARGET_UNRESOLVED",
      payload: {
        reason: resolved.reason,
        suggestedPrompts: resolved.suggestedPrompts || [],
        staff_id: staffId,
      },
    });
    return {
      ok: true,
      brain: "staff_clarification",
      replyText: formatClarification(resolved),
      resolution: resolved,
    };
  }

  await appendEventLog({
    traceId,
    event: "STAFF_TARGET_RESOLVED",
    payload: { wi_id: resolved.wiId, reason: resolved.reason, staff_id: staffId },
  });

  if (looksLikeScheduleOnlyWithoutStatus(body)) {
    await appendEventLog({
      traceId,
      event: "STAFF_SCHEDULE_DEFERRED",
      payload: { wi_id: resolved.wiId, note: "v2_schedule_parser_not_enabled" },
    });
    return {
      ok: true,
      brain: "staff_schedule_deferred",
      replyText:
        "Ticket " +
        resolved.wiId +
        " selected. Scheduling windows from staff chat are not enabled in V2 yet — send a status update (done, in progress, waiting on parts, …).",
      resolution: resolved,
    };
  }

  const norm = normalizeStaffOutcome(body);
  if (norm === "UNRESOLVED") {
    await appendEventLog({
      traceId,
      event: "STAFF_OUTCOME_UNRESOLVED",
      payload: { wi_id: resolved.wiId },
    });
    return {
      ok: true,
      brain: "staff_need_outcome",
      replyText:
        "Ticket " +
        resolved.wiId +
        " selected. Reply with a status: done, in progress, waiting on parts, needs vendor, delayed, or access issue.",
      resolution: resolved,
    };
  }

  const update = await applyStaffOutcomeUpdate(resolved.wiId, norm, body);
  await appendEventLog({
    traceId,
    event: "STAFF_OUTCOME_APPLIED",
    payload: {
      wi_id: resolved.wiId,
      normalized:
        typeof norm === "object" ? norm.outcome || norm : norm,
      db_ok: update.ok,
    },
  });

  return {
    ok: true,
    brain: "staff_update_applied",
    replyText: formatOutcomeReply(resolved.wiId, norm, update),
    resolution: resolved,
    outcome: norm,
    db: update,
  };
}

module.exports = { handleStaffLifecycleCommand };
