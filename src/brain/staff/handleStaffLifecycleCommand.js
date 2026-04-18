/**
 * Staff lifecycle — GAS `staffHandleLifecycleCommand_` parity:
 * resolve WI → optional schedule window (no status keywords) → normalize outcome → DB.
 *
 * @see 25_STAFF_RESOLVER.gs staffHandleLifecycleCommand_ ~1367–1550
 */
const { getSupabase } = require("../../db/supabase");
const { appendEventLog } = require("../../dal/appendEventLog");
const { getConversationCtx } = require("../../dal/conversationCtx");
const {
  listOpenWorkItemsForOwner,
  getWorkItemByWorkItemId,
  applyStaffOutcomeUpdate,
} = require("../../dal/workItems");
const {
  applyPreferredWindowByTicketKey,
  schedulePolicyRejectMessage,
  MIN_SCHEDULE_LEN,
} = require("../../dal/ticketPreferredWindow");
const { parsePreferredWindowShared } = require("../gas/parsePreferredWindowShared");
const { properaTimezone, scheduleLatestHour } = require("../../config/env");
const { resolveTargetWorkItemForStaff } = require("./resolveTargetWorkItemForStaff");
const { normalizeStaffOutcome } = require("./normalizeStaffOutcome");
const {
  extractUnitFromBody,
  extractPropertyHintFromBody,
  staffExtractScheduleRemainderFromTarget,
} = require("./lifecycleExtract");

async function loadPropertyCodesUpper(sb) {
  const { data, error } = await sb.from("properties").select("code");
  if (error || !data) return new Set();
  const set = new Set();
  data.forEach((r) => {
    if (r && r.code) set.add(String(r.code).toUpperCase());
  });
  return set;
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
    return (
      "Saved: " +
      wiId +
      " waiting on parts" +
      (norm.partsEtaText ? " (" + norm.partsEtaText + ")." : ".")
    );
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
 * @param {number} [o.traceStartMs]
 */
async function handleStaffLifecycleCommand(o) {
  const traceId = o.traceId || "";
  const traceStartMs =
    o.traceStartMs != null && isFinite(Number(o.traceStartMs))
      ? Number(o.traceStartMs)
      : null;
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
    ticketKey: r.ticket_key ? String(r.ticket_key).trim() : "",
  }));

  let ctxPendingWi = null;
  const pendingCtxId =
    ctx &&
    (String(ctx.pending_work_item_id || "").trim() ||
      String(ctx.active_work_item_id || "").trim());
  if (pendingCtxId && !openWis.some((w) => w.workItemId === pendingCtxId)) {
    ctxPendingWi = await getWorkItemByWorkItemId(pendingCtxId);
  }

  const resolved = resolveTargetWorkItemForStaff({
    openWis,
    bodyTrim: body,
    ctx,
    knownPropertyCodesUpper: known,
    staffId,
    ctxPendingWi,
  });

  if (!resolved.wiId) {
    await appendEventLog({
      traceId,
      event: "STAFF_TARGET_UNRESOLVED",
      payload: {
        reason: resolved.reason,
        suggestedPrompts: resolved.suggestedPrompts || [],
        staff_id: staffId,
        open_wi_count: openWis.length,
        summary:
          "No single ticket picked (" +
          String(resolved.reason || "") +
          ") · " +
          openWis.length +
          " open",
      },
    });
    return {
      ok: true,
      brain: "staff_clarification",
      replyText: formatClarification(resolved),
      resolution: resolved,
    };
  }

  let wiForOps = openWis.find(
    (w) => String(w.workItemId || "") === String(resolved.wiId || "")
  );
  if (!wiForOps) {
    const full = await getWorkItemByWorkItemId(resolved.wiId);
    if (full) {
      wiForOps = {
        workItemId: full.work_item_id,
        unitId: full.unit_id,
        propertyId: full.property_id,
        metadata_json: full.metadata_json,
        ticketKey: full.ticket_key ? String(full.ticket_key).trim() : "",
      };
    }
  }

  const propId = wiForOps ? String(wiForOps.propertyId || "").trim() : "";
  const unitId = wiForOps ? String(wiForOps.unitId || "").trim() : "";
  const ticketKey = wiForOps ? String(wiForOps.ticketKey || "").trim() : "";

  await appendEventLog({
    traceId,
    event: "STAFF_TARGET_RESOLVED",
    payload: {
      wi_id: resolved.wiId,
      reason: resolved.reason,
      staff_id: staffId,
      property_id: propId || null,
      unit_id: unitId || null,
      ticket_key: ticketKey || null,
      summary: [
        resolved.wiId,
        propId ? propId + (unitId ? " " + unitId : "") : "",
        String(resolved.reason || ""),
      ]
        .filter(Boolean)
        .join(" · "),
    },
  });

  const lower = body.toLowerCase();
  const hasDoneOrStatus =
    /\b(done|complete|completed|finished|fixed|resolved)\b/.test(lower) ||
    /\b(in progress|working on it|started|on it)\b/.test(lower) ||
    /\b(waiting on parts|parts ordered|waiting for parts|backorder)\b/.test(lower) ||
    /\b(vendor|contractor|need to send|dispatch)\b/.test(lower) ||
    /\b(access|key|entry|no access|couldn't get in)\b/.test(lower);

  if (!hasDoneOrStatus && ticketKey) {
    const unitFromBody = extractUnitFromBody(body);
    const propertyHint = extractPropertyHintFromBody(body, known);
    const scheduleRemainder = staffExtractScheduleRemainderFromTarget(
      body,
      unitFromBody,
      propertyHint
    );

    if (scheduleRemainder && scheduleRemainder.length >= MIN_SCHEDULE_LEN) {
      const opts = {
        now: new Date(),
        timeZone: properaTimezone(),
        scheduleLatestHour: scheduleLatestHour(),
      };
      let scheduleParsed = null;
      try {
        scheduleParsed = parsePreferredWindowShared(scheduleRemainder, null, opts);
      } catch (_) {
        scheduleParsed = null;
      }

      if (
        scheduleParsed &&
        scheduleParsed.end instanceof Date &&
        isFinite(scheduleParsed.end.getTime())
      ) {
        const { data: tick } = await sb
          .from("tickets")
          .select("scheduled_end_at, preferred_window")
          .eq("ticket_key", ticketKey)
          .maybeSingle();

        let currentScheduleEndAt = null;
        let currentScheduleLabel = "";
        if (tick) {
          currentScheduleLabel = String(tick.preferred_window || "").trim();
          if (tick.scheduled_end_at) {
            const d = new Date(tick.scheduled_end_at);
            if (isFinite(d.getTime())) currentScheduleEndAt = d;
          }
        }

        let sameWindow = false;
        if (
          currentScheduleEndAt instanceof Date &&
          isFinite(currentScheduleEndAt.getTime())
        ) {
          sameWindow =
            Math.abs(
              currentScheduleEndAt.getTime() - scheduleParsed.end.getTime()
            ) < 60000;
        }

        if (sameWindow) {
          const label =
            String(currentScheduleLabel || scheduleParsed.label || "").trim() ||
            "current window";
          await appendEventLog({
            traceId,
            event: "STAFF_SCHEDULE_DUPLICATE_WINDOW",
            payload: {
              wi_id: resolved.wiId,
              ticket_key: ticketKey,
              schedule_label: label,
            },
          });
          return {
            ok: true,
            brain: "staff_schedule_ack",
            replyText:
              "That visit window is already set for " +
              resolved.wiId +
              " (" +
              label +
              ").",
            resolution: resolved,
          };
        }

        const hadSchedule = !!(
          currentScheduleEndAt &&
          isFinite(currentScheduleEndAt.getTime())
        );
        const applyResult = await applyPreferredWindowByTicketKey({
          ticketKey,
          preferredWindow: scheduleRemainder,
          traceId,
          traceStartMs: traceStartMs != null ? traceStartMs : undefined,
        });

        if (applyResult.ok) {
          const label =
            applyResult.parsed && applyResult.parsed.label
              ? String(applyResult.parsed.label).trim()
              : scheduleRemainder;
          await appendEventLog({
            traceId,
            event: "STAFF_SCHEDULE_APPLIED",
            payload: {
              wi_id: resolved.wiId,
              ticket_key: ticketKey,
              schedule_label: label,
              status: hadSchedule ? "UPDATED" : "SET",
            },
          });
          return {
            ok: true,
            brain: "staff_schedule_applied",
            replyText:
              "Schedule " +
              (hadSchedule ? "updated" : "set") +
              " for " +
              resolved.wiId +
              ": " +
              label +
              ".",
            resolution: resolved,
            schedule: applyResult.parsed || null,
          };
        }

        await appendEventLog({
          traceId,
          event: "STAFF_SCHEDULE_REJECTED",
          payload: {
            wi_id: resolved.wiId,
            ticket_key: ticketKey,
            error: applyResult.error || "unknown",
            policy_key: applyResult.policyKey || null,
          },
        });

        if (applyResult.error === "policy") {
          return {
            ok: true,
            brain: "staff_schedule_policy_reject",
            replyText: schedulePolicyRejectMessage(
              applyResult.policyKey,
              applyResult.policyVars
            ),
            resolution: resolved,
          };
        }

        return {
          ok: true,
          brain: "staff_schedule_failed",
          replyText:
            "Could not save schedule for " +
            resolved.wiId +
            (applyResult.error ? " (" + applyResult.error + ")." : "."),
          resolution: resolved,
        };
      }
    }
  }

  if (!hasDoneOrStatus && !ticketKey) {
    const unitFromBody = extractUnitFromBody(body);
    const propertyHint = extractPropertyHintFromBody(body, known);
    const scheduleRemainder = staffExtractScheduleRemainderFromTarget(
      body,
      unitFromBody,
      propertyHint
    );
    if (scheduleRemainder && scheduleRemainder.length >= MIN_SCHEDULE_LEN) {
      const opts = {
        now: new Date(),
        timeZone: properaTimezone(),
        scheduleLatestHour: scheduleLatestHour(),
      };
      let scheduleParsed = null;
      try {
        scheduleParsed = parsePreferredWindowShared(scheduleRemainder, null, opts);
      } catch (_) {
        scheduleParsed = null;
      }
      if (
        scheduleParsed &&
        scheduleParsed.end instanceof Date &&
        isFinite(scheduleParsed.end.getTime())
      ) {
        await appendEventLog({
          traceId,
          event: "STAFF_SCHEDULE_NO_TICKET_KEY",
          payload: { wi_id: resolved.wiId },
        });
        return {
          ok: true,
          brain: "staff_schedule_no_ticket_link",
          replyText:
            "Work item " +
            resolved.wiId +
            " has no linked ticket row yet — schedule cannot be saved. Send a status update or use a ticket that was created from maintenance intake.",
          resolution: resolved,
        };
      }
    }
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
        " selected. Reply with a status: done, in progress, waiting on parts, needs vendor, delayed, or access issue — or a visit window (e.g. tomorrow 9–11am).",
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
