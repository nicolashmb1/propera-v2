/**
 * GAS `executeLifecycleDecision_` — LOG_ONLY, TRANSITION, APPLY_SCHEDULE_SET, WRITE_TIMER, ENTER_UNSCHEDULED, etc.
 */
const { appendEventLog } = require("../../dal/appendEventLog");
const { applyPreferredWindowByTicketKey } = require("../../dal/ticketPreferredWindow");
const { getWorkItemByWorkItemId } = require("../../dal/workItems");
const {
  insertLifecycleTimer,
  cancelPendingLifecycleTimersForWorkItem,
} = require("../../dal/lifecycleTimers");
const { wiEnterState } = require("./wiEnterState");
const { maybeSnapLifecycleTimerRunAt } = require("./lifecycleTimerRunAt");
const { dispatchLifecycleOutbound } = require("../../outgate/dispatchLifecycleOutbound");
const {
  dispatchStaffLifecycleReminder,
} = require("./staffLifecycleOutbound");
const { mergeTicketUpdateRespectingPmOverride } = require("../../dal/ticketAssignmentGuard");
const { mergeChangedByIntoTicketPatch, lifecycleTimerActor } = require("../../dal/ticketAuditPatch");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} decision — from evaluateLifecyclePolicy
 * @param {object} facts — buildLifecycleFacts
 * @param {object} signal
 * @param {{ traceId?: string, traceStartMs?: number }} o
 */
async function executeLifecycleDecision(sb, decision, facts, signal, o) {
  const traceId = o && o.traceId ? String(o.traceId) : "";
  const traceStartMs =
    o && o.traceStartMs != null && isFinite(Number(o.traceStartMs))
      ? Number(o.traceStartMs)
      : null;

  if (decision.action === "LOG_ONLY" || decision.action === "LOG_ESCALATE") {
    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: decision.logEventType || "LIFECYCLE_LOG_ONLY",
      payload: {
        note: decision.logNote || "",
        wi_id: facts.wiId,
        property_id: facts.propertyId,
      },
    });
    return true;
  }

  if (decision.action === "WRITE_TIMER") {
    await cancelPendingLifecycleTimersForWorkItem(
      sb,
      facts.wiId,
      "lifecycle_timer_replaced"
    );
    const tt = decision.timerType || "PING_STAFF_UPDATE";
    let runAtW = decision.runAt;
    if (runAtW) {
      runAtW = await maybeSnapLifecycleTimerRunAt(
        sb,
        facts.propertyId,
        tt,
        runAtW,
        { traceId, wiId: facts.wiId }
      );
    }
    const ok = await insertLifecycleTimer(sb, {
      workItemId: facts.wiId,
      propertyCode: facts.propertyId,
      timerType: tt,
      runAt: runAtW,
      payload: {},
      traceId,
    });
    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: ok ? "LIFECYCLE_TIMER_WRITTEN" : "LIFECYCLE_TIMER_WRITE_FAIL",
      payload: {
        wi_id: facts.wiId,
        timer_type: decision.timerType,
        run_at: decision.runAt ? decision.runAt.toISOString() : null,
      },
    });
    return ok;
  }

  if (decision.action === "ENTER_UNSCHEDULED") {
    const ok = await wiEnterState(sb, facts.wiId, "UNSCHEDULED", "", {
      traceId,
      signal,
      cancelTimers: true,
      timerType: decision.timerType,
      runAt: decision.runAt,
      timerPayload: { attempts: 0 },
    });
    return ok;
  }

  if (decision.action === "SEND_TENANT_VERIFY" && decision.recipientPhone) {
    const wiForVerify = await getWorkItemByWorkItemId(facts.wiId);
    const stateNow = wiForVerify
      ? String(wiForVerify.state || "").trim().toUpperCase()
      : "";
    if (stateNow !== "VERIFYING_RESOLUTION") {
      await appendEventLog({
        traceId,
        log_kind: "lifecycle",
        event: "SEND_TENANT_VERIFY_SKIPPED",
        payload: {
          wi_id: facts.wiId,
          state_now: stateNow || null,
        },
      });
      return true;
    }
    const phone = String(decision.recipientPhone || "").trim();
    await dispatchLifecycleOutbound({
      sb,
      traceId,
      templateKey: "TENANT_VERIFY_RESOLUTION",
      recipientPhoneE164: phone,
      correlationIds: {
        work_item_id: facts.wiId,
        property_code: facts.propertyId,
        ticket_key: wiForVerify.ticket_key
          ? String(wiForVerify.ticket_key)
          : "",
      },
    });
    return true;
  }

  if (decision.action === "PING_AND_RESTART_UNSCHEDULED") {
    const ok = await wiEnterState(sb, facts.wiId, "UNSCHEDULED", "", {
      traceId,
      signal,
      cancelTimers: true,
      timerType: decision.timerType,
      runAt: decision.runAt,
      timerPayload:
        decision.attempts != null
          ? { attempts: decision.attempts }
          : { attempts: 0 },
    });
    if (ok) {
      const wi2 = await getWorkItemByWorkItemId(facts.wiId);
      const owner = wi2 && String(wi2.owner_id || "").trim();
      if (owner) {
        await dispatchStaffLifecycleReminder(sb, {
          traceId,
          ownerId: owner,
          workItemId: facts.wiId,
          propertyCode: facts.propertyId,
          templateKey: "STAFF_UNSCHEDULED_REMINDER",
        });
      }
    }
    return ok;
  }

  if (decision.action === "APPLY_SCHEDULE_SET") {
    await cancelPendingLifecycleTimersForWorkItem(
      sb,
      facts.wiId,
      "lifecycle_schedule_apply"
    );
    const ticketKey = facts.ticketKey;
    const scheduleText = String(
      (signal && (signal.scheduleText || signal.rawText)) || ""
    ).trim();
    if (!ticketKey || !scheduleText) {
      await appendEventLog({
        traceId,
        log_kind: "lifecycle",
        event: "SCHEDULE_SET_APPLY_FAIL",
        payload: { wi_id: facts.wiId, reason: "missing_ticket_key_or_text" },
      });
      return false;
    }

    const applyResult = await applyPreferredWindowByTicketKey({
      ticketKey,
      preferredWindow: scheduleText,
      traceId,
      traceStartMs: traceStartMs != null ? traceStartMs : undefined,
      ticketChangedBy: lifecycleTimerActor(),
    });

    if (!applyResult.ok) {
      await appendEventLog({
        traceId,
        log_kind: "lifecycle",
        event: "SCHEDULE_SET_APPLY_FAIL",
        payload: {
          wi_id: facts.wiId,
          error: applyResult.error || "apply_failed",
          policy_key: applyResult.policyKey || null,
        },
      });
      return false;
    }

    const now = new Date().toISOString();
    const { error: wErr } = await sb
      .from("work_items")
      .update({
        state: "ACTIVE_WORK",
        substate: "",
        updated_at: now,
      })
      .eq("work_item_id", facts.wiId);

    if (wErr) {
      await appendEventLog({
        traceId,
        log_kind: "lifecycle",
        event: "SCHEDULE_SET_APPLY_WRITE_FAIL",
        payload: { wi_id: facts.wiId, error: wErr.message },
      });
      return false;
    }

    const { data: ticketLockRow } = await sb
      .from("tickets")
      .select("assignment_source")
      .eq("ticket_key", ticketKey)
      .maybeSingle();

    const scheduleStatusPatch = mergeChangedByIntoTicketPatch(
      mergeTicketUpdateRespectingPmOverride(ticketLockRow || {}, {
        status: "Scheduled",
        updated_at: now,
        last_activity_at: now,
      }),
      lifecycleTimerActor()
    );

    await sb
      .from("tickets")
      .update(scheduleStatusPatch)
      .eq("ticket_key", ticketKey);

    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: "SCHEDULE_SET_APPLIED",
      payload: {
        wi_id: facts.wiId,
        ticket_key: ticketKey,
        schedule_label: decision.scheduleLabel || "",
      },
    });

    const { handleLifecycleSignal } = require("./handleLifecycleSignal");
    await handleLifecycleSignal(
      sb,
      {
        eventType: "ACTIVE_WORK_ENTERED",
        wiId: facts.wiId,
        propertyId: facts.propertyId,
        scheduledEndAt: facts.scheduledEndAt,
      },
      { traceId, traceStartMs: traceStartMs != null ? traceStartMs : undefined }
    );
    return true;
  }

  if (
    decision.action === "TRANSITION" ||
    decision.action === "TRANSITION_AND_TIMER" ||
    decision.action === "PING_AND_RESTART"
  ) {
    const nextState = decision.nextState;
    if (!nextState) return true;

    const timerPayload =
      decision.attempts != null && isFinite(Number(decision.attempts))
        ? { attempts: Number(decision.attempts) }
        : {};

    const ok = await wiEnterState(sb, facts.wiId, nextState, "", {
      traceId,
      tenantVerify: decision.tenantVerify,
      timerType: decision.timerType,
      runAt: decision.runAt,
      timerPayload,
      signal,
      sendStaffUpdateRequest: !!decision.sendStaffUpdateRequest,
    });

    if (ok && decision.action === "PING_AND_RESTART") {
      const wi2 = await getWorkItemByWorkItemId(facts.wiId);
      const owner = wi2 && String(wi2.owner_id || "").trim();
      if (owner) {
        await dispatchStaffLifecycleReminder(sb, {
          traceId,
          ownerId: owner,
          workItemId: facts.wiId,
          propertyCode: facts.propertyId,
          templateKey: "STAFF_UPDATE_REMINDER",
        });
      }
    }
    return ok;
  }

  return true;
}

module.exports = { executeLifecycleDecision };
