// =============================================================================
// LIFECYCLE_ENGINE.gs — PATCH V3 (FINAL)
// All 3 post-review cautions addressed:
// [C1] onWorkItemCreatedUnscheduled_ has defensive guards at lifecycle layer
// [C2] vars accepted as V1 (unit + property from WI object — issueSummary
//      requires Sheet1 lookup via ticketKey, not worth extra read for a ping)
// [C3] Outgate map patch restructured as explicit full-object instruction (not brittle anchor)
// =============================================================================


// ─────────────────────────────────────────────────────────────────────────────
// PATCH 1 — Allowed transitions: add UNSCHEDULED states
// FIND (exact):
// ─────────────────────────────────────────────────────────────────────────────
/*
var LIFECYCLE_ALLOWED_TRANSITIONS_ = {
  "STAFF_TRIAGE->WAIT_STAFF_UPDATE": true,
  "WAIT_STAFF_UPDATE->INHOUSE_WORK": true,
  "WAIT_STAFF_UPDATE->WAIT_PARTS": true,
  "WAIT_STAFF_UPDATE->VENDOR_DISPATCH": true,
  "WAIT_STAFF_UPDATE->WAIT_STAFF_UPDATE": true,
  "INHOUSE_WORK->VERIFYING_RESOLUTION": true,
  "INHOUSE_WORK->WAIT_STAFF_UPDATE": true,
  "INHOUSE_WORK->DONE": true,
  "WAIT_PARTS->INHOUSE_WORK": true,
  "VERIFYING_RESOLUTION->DONE": true,
  "VERIFYING_RESOLUTION->INHOUSE_WORK": true,
  "ACTIVE_WORK->WAIT_STAFF_UPDATE": true,
  "ACTIVE_WORK->VERIFYING_RESOLUTION": true,
  "ACTIVE_WORK->DONE": true,
  "VENDOR_DISPATCH->INHOUSE_WORK": true,
  "VENDOR_DISPATCH->WAIT_STAFF_UPDATE": true
};
*/
// REPLACE WITH:
var LIFECYCLE_ALLOWED_TRANSITIONS_ = {
  "STAFF_TRIAGE->WAIT_STAFF_UPDATE": true,
  "WAIT_STAFF_UPDATE->INHOUSE_WORK": true,
  "WAIT_STAFF_UPDATE->WAIT_PARTS": true,
  "WAIT_STAFF_UPDATE->VENDOR_DISPATCH": true,
  "WAIT_STAFF_UPDATE->WAIT_STAFF_UPDATE": true,
  "INHOUSE_WORK->VERIFYING_RESOLUTION": true,
  "INHOUSE_WORK->WAIT_STAFF_UPDATE": true,
  "INHOUSE_WORK->DONE": true,
  "WAIT_PARTS->INHOUSE_WORK": true,
  "VERIFYING_RESOLUTION->DONE": true,
  "VERIFYING_RESOLUTION->INHOUSE_WORK": true,
  "ACTIVE_WORK->WAIT_STAFF_UPDATE": true,
  "ACTIVE_WORK->VERIFYING_RESOLUTION": true,
  "ACTIVE_WORK->DONE": true,
  "VENDOR_DISPATCH->INHOUSE_WORK": true,
  "VENDOR_DISPATCH->WAIT_STAFF_UPDATE": true,
  // UNSCHEDULED — ticket created with owner but no schedule
  // UNSCHEDULED->ACTIVE_WORK intentionally excluded:
  // schedule reply must go through the real scheduling path (ScheduledEndAt written,
  // onWorkItemActiveWork_ called) — lifecycle cannot shortcut that truth.
  "UNSCHEDULED->WAIT_STAFF_UPDATE": true,    // staff replied delayed / not resolved yet
  "UNSCHEDULED->INHOUSE_WORK": true,          // staff replied in progress
  "UNSCHEDULED->VERIFYING_RESOLUTION": true,  // staff replied done + verify required
  "UNSCHEDULED->DONE": true,                  // staff replied done + no verify
  "UNSCHEDULED->VENDOR_DISPATCH": true,       // staff replied needs vendor
  "UNSCHEDULED->WAIT_PARTS": true,            // staff replied waiting on parts
  "UNSCHEDULED->UNSCHEDULED": true            // re-ping (timer restart, same state)
};


// ─────────────────────────────────────────────────────────────────────────────
// PATCH 2 — Timer types: add PING_UNSCHEDULED
// FIND (exact):
// ─────────────────────────────────────────────────────────────────────────────
/*
var LIFECYCLE_TIMER_TYPES_ = { PING_STAFF_UPDATE: true, TIMER_ESCALATE: true, AUTO_CLOSE: true, SEND_TENANT_VERIFY: true };
*/
// REPLACE WITH:
var LIFECYCLE_TIMER_TYPES_ = { PING_STAFF_UPDATE: true, PING_UNSCHEDULED: true, TIMER_ESCALATE: true, AUTO_CLOSE: true, SEND_TENANT_VERIFY: true };


// ─────────────────────────────────────────────────────────────────────────────
// PATCH 3 — New public entry point: onWorkItemCreatedUnscheduled_
// INSERT immediately after the closing brace of onWorkItemActiveWork_()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call from ticket creation when OwnerId is set but no ScheduledEndAt exists.
 * Enters UNSCHEDULED lifecycle state and arms first check-in timer.
 *
 * Call site must only invoke this when:
 *   - OwnerId is set on the WI
 *   - ScheduledEndAt is null / not set
 *   - Ticket is NOT an emergency (emergency WIs have substate="EMERGENCY")
 *
 * Lifecycle layer also guards defensively — see below.
 *
 * @param {string} wiId - WorkItem id
 * @param {string} propertyId - Property code/id (canonical)
 */
function onWorkItemCreatedUnscheduled_(wiId, propertyId) {
  if (!wiId) return;
  var prop = String(propertyId || "").trim().toUpperCase() || "GLOBAL";
  if (!lifecycleEnabled_(prop)) return;

  // Defensive guards at lifecycle layer — do not rely on call site comments alone
  var wi = typeof workItemGetById_ === "function" ? workItemGetById_(wiId) : null;
  if (!wi) {
    lifecycleLog_("LIFECYCLE_SIGNAL_BAD", prop, wiId, { reason: "WI_NOT_FOUND", source: "onWorkItemCreatedUnscheduled_" });
    return;
  }
  // Guard 1: no owner — nothing to ping
  if (!String(wi.ownerId || "").trim()) {
    lifecycleLog_("LIFECYCLE_UNSCHEDULED_SKIPPED", prop, wiId, { reason: "NO_OWNER" });
    return;
  }
  // Guard 2: emergency — emergency WIs have substate="EMERGENCY"; lifecycle must not touch them
  if (String(wi.substate || "").trim().toUpperCase() === "EMERGENCY") {
    lifecycleLog_("LIFECYCLE_UNSCHEDULED_SKIPPED", prop, wiId, { reason: "IS_EMERGENCY" });
    return;
  }
  // Guard 3: already terminal — do not re-enter lifecycle on a completed or done WI
  var terminalStates = { "DONE": true, "COMPLETED": true };
  if (terminalStates[String(wi.state || "").trim().toUpperCase()] || String(wi.status || "").trim().toUpperCase() === "COMPLETED") {
    lifecycleLog_("LIFECYCLE_UNSCHEDULED_SKIPPED", prop, wiId, { reason: "ALREADY_TERMINAL", state: wi.state, status: wi.status });
    return;
  }

  handleLifecycleSignal_({
    eventType: "WI_CREATED_UNSCHEDULED",
    wiId: String(wiId).trim(),
    propertyId: prop,
    actorType: "SYSTEM",
    actorId: "TICKET_CREATE",
    reasonCode: "NO_SCHEDULE_ON_CREATE"
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// PATCH 4 — Contact hours: give PING_UNSCHEDULED its own policy key
// FIND (exact):
// ─────────────────────────────────────────────────────────────────────────────
/*
function lifecycleTimerRespectsContactHours_(propCode, timerType) {
  var prop = String(propCode || "").trim().toUpperCase() || "GLOBAL";
  if (timerType === "PING_STAFF_UPDATE") return !!lifecyclePolicyGet_(prop, "PING_STAFF_UPDATE_RESPECT_CONTACT_HOURS", false);
  if (timerType === "TIMER_ESCALATE") return !!lifecyclePolicyGet_(prop, "TIMER_ESCALATE_RESPECT_CONTACT_HOURS", false);
  if (timerType === "AUTO_CLOSE" || timerType === "SEND_TENANT_VERIFY") return false;
  return false;
}
*/
// REPLACE WITH:
function lifecycleTimerRespectsContactHours_(propCode, timerType) {
  var prop = String(propCode || "").trim().toUpperCase() || "GLOBAL";
  if (timerType === "PING_STAFF_UPDATE") return !!lifecyclePolicyGet_(prop, "PING_STAFF_UPDATE_RESPECT_CONTACT_HOURS", false);
  if (timerType === "PING_UNSCHEDULED")  return !!lifecyclePolicyGet_(prop, "PING_UNSCHEDULED_RESPECT_CONTACT_HOURS", false);
  if (timerType === "TIMER_ESCALATE")    return !!lifecyclePolicyGet_(prop, "TIMER_ESCALATE_RESPECT_CONTACT_HOURS", false);
  if (timerType === "AUTO_CLOSE" || timerType === "SEND_TENANT_VERIFY") return false;
  return false;
}


// ─────────────────────────────────────────────────────────────────────────────
// PATCH 5 — evaluateLifecyclePolicy_: add WI_CREATED_UNSCHEDULED handler
// INSERT the block BEFORE the existing "if (eventType === "ACTIVE_WORK_ENTERED")" line
// FIND (exact, just the opening line of ACTIVE_WORK_ENTERED block):
// ─────────────────────────────────────────────────────────────────────────────
/*
  if (eventType === "ACTIVE_WORK_ENTERED") {
*/
// INSERT BEFORE (keep ACTIVE_WORK_ENTERED block unchanged):
  if (eventType === "WI_CREATED_UNSCHEDULED") {
    var firstPingH = lifecyclePolicyGet_(prop, "UNSCHEDULED_FIRST_PING_HOURS", null);
    if (firstPingH == null || (typeof firstPingH === "number" && !isFinite(firstPingH))) {
      lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "UNSCHEDULED_FIRST_PING_HOURS" });
      return { decision: "HOLD" };
    }
    var fH = Number(firstPingH);
    if (!isFinite(fH)) fH = 24;
    return {
      decision: "PROCEED",
      action: "ENTER_UNSCHEDULED",
      timerType: "PING_UNSCHEDULED",
      runAt: new Date(facts.now.getTime() + fH * 3600000)
    };
  }


// ─────────────────────────────────────────────────────────────────────────────
// PATCH 6 — evaluateLifecyclePolicy_: add PING_UNSCHEDULED timer fire handler
// INSERT the block BEFORE the existing "if (timerType === "SEND_TENANT_VERIFY")" line
// FIND (exact):
// ─────────────────────────────────────────────────────────────────────────────
/*
    if (timerType === "SEND_TENANT_VERIFY") {
*/
// INSERT BEFORE (keep SEND_TENANT_VERIFY block unchanged):
    if (timerType === "PING_UNSCHEDULED") {
      var maxAttU = lifecyclePolicyGet_(prop, "UNSCHEDULED_MAX_ATTEMPTS", null);
      if (maxAttU == null) {
        lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "UNSCHEDULED_MAX_ATTEMPTS" });
        return { decision: "HOLD" };
      }
      var repeatHU = lifecyclePolicyGet_(prop, "UNSCHEDULED_REPEAT_PING_HOURS", null);
      if (repeatHU == null || (typeof repeatHU === "number" && !isFinite(repeatHU))) {
        lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "UNSCHEDULED_REPEAT_PING_HOURS" });
        return { decision: "HOLD" };
      }
      repeatHU = Number(repeatHU) || 24;
      // attempts confirmed hydrated: processLifecycleTimers_ → signal.payload → facts.timerPayload
      var attU = (facts.timerPayload && typeof facts.timerPayload.attempts === "number") ? facts.timerPayload.attempts : 0;
      if (attU < Number(maxAttU)) {
        return {
          decision: "PROCEED",
          action: "PING_AND_RESTART_UNSCHEDULED",
          nextState: "UNSCHEDULED",
          timerType: "PING_UNSCHEDULED",
          attempts: attU + 1,
          runAt: new Date(facts.now.getTime() + repeatHU * 3600000)
        };
      }
      // Max attempts exhausted: log escalation only.
      // PM SMS notification deferred to Phase 3B (requires PM recipient type in Outgate).
      return { decision: "PROCEED", action: "LOG_ESCALATE", logEventType: "UNSCHEDULED_ESCALATED", logNote: "UNSCHEDULED_MAX_ATTEMPTS_PHASE3B_PM_NOTIFY_PENDING" };
    }


// ─────────────────────────────────────────────────────────────────────────────
// PATCH 7 — executeLifecycleDecision_: add ENTER_UNSCHEDULED and PING_AND_RESTART_UNSCHEDULED
// FIND (exact, the full WRITE_TIMER block):
// ─────────────────────────────────────────────────────────────────────────────
/*
  if (decision.action === "WRITE_TIMER") {
    lifecycleCancelTimersForWi_(wiId);
    lifecycleWriteTimer_(wiId, prop, decision.timerType || "PING_STAFF_UPDATE", decision.runAt, {});
    lifecycleLog_("TIMER_WRITTEN", prop, wiId, Object.assign(getActorFacts_(signal) || {}, { timerType: decision.timerType, runAt: decision.runAt }));
    return true;
  }
*/
// REPLACE WITH (append two new blocks immediately after WRITE_TIMER, before the next existing block):
  if (decision.action === "WRITE_TIMER") {
    lifecycleCancelTimersForWi_(wiId);
    lifecycleWriteTimer_(wiId, prop, decision.timerType || "PING_STAFF_UPDATE", decision.runAt, {});
    lifecycleLog_("TIMER_WRITTEN", prop, wiId, Object.assign(getActorFacts_(signal) || {}, { timerType: decision.timerType, runAt: decision.runAt }));
    return true;
  }

  if (decision.action === "ENTER_UNSCHEDULED") {
    // cancelTimers: true — safe no-op on new WI; protects against edge cases where timers exist unexpectedly
    var okEU = wiEnterState_(wiId, "UNSCHEDULED", "", {
      cancelTimers: true,
      writeTimer: decision.timerType && decision.runAt ? {
        timerType: decision.timerType,
        runAt: decision.runAt,
        payload: { attempts: 0 }
      } : null,
      actor: getActorFacts_(signal),
      signal: signal
    });
    return !!okEU;
  }

  if (decision.action === "PING_AND_RESTART_UNSCHEDULED") {
    // Re-enter UNSCHEDULED (same state), reset timer, ping staff owner.
    // Uses REQUEST_UNSCHEDULED_UPDATE intent — distinct from post-appointment REQUEST_STAFF_UPDATE.
    // vars: unit + property from WI object. issueSummary would require Sheet1 lookup via ticketKey —
    // not worth extra read for a ping message. Acceptable V1 limitation.
    var okPU = wiEnterState_(wiId, "UNSCHEDULED", "", {
      cancelTimers: true,
      writeTimer: decision.timerType && decision.runAt ? {
        timerType: decision.timerType,
        runAt: decision.runAt,
        payload: { attempts: decision.attempts }
      } : null,
      actor: getActorFacts_(signal),
      signal: signal
    });
    if (okPU && wi && wi.ownerId && typeof dispatchOutboundIntent_ === "function") {
      dispatchOutboundIntent_({
        intentType: "REQUEST_UNSCHEDULED_UPDATE",
        templateKey: "STAFF_UNSCHEDULED_REMINDER",
        recipientType: "STAFF",
        recipientRef: String(wi.ownerId).trim(),
        propertyId: facts.propertyId || "",
        workItemId: wiId || "",
        vars: {
          unit: String(wi.unitId || "").trim(),
          property: String(facts.propertyId || "").trim()
        },
        deliveryPolicy: "DIRECT_SEND",
        meta: { reasonCode: "UNSCHEDULED_PING", actorType: "SYSTEM", actorId: "", sourceModule: "LIFECYCLE_ENGINE" }
      });
    }
    return !!okPU;
  }


// =============================================================================
// OUTGATE.gs — OG_INTENT_TEMPLATE_MAP_ update
// This is NOT a find/replace patch. Replace the entire OG_INTENT_TEMPLATE_MAP_
// object with the version below (adds one entry at the end).
// =============================================================================

/*
var OG_INTENT_TEMPLATE_MAP_ = {
  "TICKET_CREATED_ASK_SCHEDULE": "ASK_WINDOW_SIMPLE",
  "CONFIRM_RECORDED_SCHEDULE": "CONF_WINDOW_SET",
  "ASK_FOR_MISSING_UNIT": "ASK_UNIT",
  "CONFIRM_CONTEXT_MISMATCH": "CONFIRM_CONTEXT_MISMATCH",
  "CONFIRM_CONTEXT_NEEDS_CONFIRM": "CONFIRM_CONTEXT_NEEDS_CONFIRM",
  "CONFIRM_CONTEXT_YESNO_REPROMPT": "CONFIRM_CONTEXT_YESNO_REPROMPT",
  "TICKET_CREATED_COMMON_AREA": "TICKET_CREATED_COMMON_AREA",
  "ASK_FOR_ISSUE": "ASK_ISSUE_GENERIC",
  "ASK_PROPERTY_CHOICE": "ASK_PROPERTY_MENU",
  "MULTI_CREATED_CONFIRM": "MULTI_CREATED_CONFIRM",
  "SCHEDULE_DRAFT_REASK": "ASK_WINDOW_SIMPLE",
  "SCHEDULE_DRAFT_FAIL": "ASK_WINDOW_SIMPLE",
  "ERROR_TRY_AGAIN": "ERR_GENERIC_TRY_AGAIN",
  "ERROR_NO_PROPERTIES": "ERR_NO_PROPERTIES_CONFIGURED",
  "ERROR_LOST_REQUEST": "ERR_LOST_OPEN_REQUEST",
  "ERROR_CRASH_FALLBACK": "ERR_CRASH_FALLBACK",
  "ERROR_DRAFT_FINALIZE_FAILED": "ERR_DRAFT_FINALIZE_FAILED",
  "EMERGENCY_CONFIRMED": "EMERGENCY_CONFIRMED_DISPATCHED",
  "EMERGENCY_CONFIRMED_WITH_TICKET": "EMERGENCY_CONFIRMED_DISPATCHED_WITH_TID",
  "EMERGENCY_UPDATE_ACK": "EMERGENCY_UPDATE_ACK",
  "TENANT_ACK_NO_PENDING": "TENANT_ACK_NO_PENDING",
  "SHOW_HELP": "HELP_INTRO",
  "SHOW_OPTIONS": "INTENT_PICK",
  "DUPLICATE_REQUEST_ACK": "DUPLICATE_REQUEST_ACK",
  "CLEANING_WORKITEM_ACK": "CLEANING_WORKITEM_ACK",
  "VISIT_CONFIRM": "VISIT_CONFIRM_MULTI",
  "STAFF_CLARIFICATION": "STAFF_CLARIFICATION",
  "STAFF_UPDATE_ACK": "STAFF_UPDATE_ACK",
  "REQUEST_UNSCHEDULED_UPDATE": "STAFF_UNSCHEDULED_REMINDER"   // added: unscheduled check-in ping
};
*/
// Replace the entire existing OG_INTENT_TEMPLATE_MAP_ object with the version above.
// The only change is the final line: "REQUEST_UNSCHEDULED_UPDATE": "STAFF_UNSCHEDULED_REMINDER"


// =============================================================================
// POLICY KEY ADDITIONS — PropertyPolicy sheet (data only, no code)
// Add to GLOBAL scope:
// =============================================================================
/*
  Key: PING_UNSCHEDULED_RESPECT_CONTACT_HOURS
  Value: true
  Type: BOOL
  Description: Snap unscheduled check-in pings to contact window

  Key: UNSCHEDULED_FIRST_PING_HOURS
  Value: 24
  Type: NUMBER
  Description: Hours after unscheduled ticket creation before first check-in

  Key: UNSCHEDULED_REPEAT_PING_HOURS
  Value: 24
  Type: NUMBER
  Description: Hours between subsequent unscheduled pings

  Key: UNSCHEDULED_MAX_ATTEMPTS
  Value: 3
  Type: NUMBER
  Description: Max pings before escalation log (PM notify wired in Phase 3B)
*/


// =============================================================================
// TEMPLATES SHEET — Add one new key before go-live
// =============================================================================
/*
  Key: STAFF_UNSCHEDULED_REMINDER
  Used for: REQUEST_UNSCHEDULED_UPDATE intent — unscheduled ticket check-in
  Vars available: {unit}, {property}
  Suggested text (EN):
    "Hi, quick check-in on unit {unit} at {property} — any update?
     Reply: done / in progress / waiting on parts / needs vendor.
     If you have a date, just reply with it."
  Note: Intentionally distinct from STAFF_UPDATE_REMINDER (post-appointment).
        Different operational context — do not merge these templates.
*/
