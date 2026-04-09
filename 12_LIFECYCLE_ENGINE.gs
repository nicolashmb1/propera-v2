/**
 * LIFECYCLE_ENGINE.gs — Propera Phase 2 Lifecycle Engine
 * Policy-driven overlay on WorkItems. Single gateway, no parallel evaluators.
 * Lifecycle overlay states: WAIT_STAFF_UPDATE, WAIT_PARTS, VERIFYING_RESOLUTION.
 * Base states unchanged: STAFF_TRIAGE, INHOUSE_WORK, VENDOR_DISPATCH, WAIT_TENANT, ACTIVE_WORK, DONE.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS — Allowed state transitions (from -> to)
// ─────────────────────────────────────────────────────────────────────────────

var LIFECYCLE_ALLOWED_TRANSITIONS_ = {
  "STAFF_TRIAGE->WAIT_STAFF_UPDATE": true,
  "STAFF_TRIAGE->UNSCHEDULED": true,
  "STAFF_TRIAGE->DONE": true,
  "STAFF_TRIAGE->VERIFYING_RESOLUTION": true,
  "STAFF_TRIAGE->INHOUSE_WORK": true,
  "STAFF_TRIAGE->WAIT_PARTS": true,
  "STAFF_TRIAGE->VENDOR_DISPATCH": true,
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
  // UNSCHEDULED — ticket created with owner but no schedule. UNSCHEDULED->ACTIVE_WORK intentionally excluded:
  // schedule reply must go through the real scheduling path (ScheduledEndAt written, onWorkItemActiveWork_ called).
  "UNSCHEDULED->WAIT_STAFF_UPDATE": true,
  "UNSCHEDULED->INHOUSE_WORK": true,
  "UNSCHEDULED->VERIFYING_RESOLUTION": true,
  "UNSCHEDULED->DONE": true,
  "UNSCHEDULED->VENDOR_DISPATCH": true,
  "UNSCHEDULED->WAIT_PARTS": true,
  "UNSCHEDULED->UNSCHEDULED": true
};

var LIFECYCLE_TIMERS_SHEET_ = "PolicyTimers";
var LIFECYCLE_EVENT_TYPE_ = "LIFECYCLE";
var LIFECYCLE_TIMER_TYPES_ = { PING_STAFF_UPDATE: true, PING_UNSCHEDULED: true, TIMER_ESCALATE: true, AUTO_CLOSE: true, SEND_TENANT_VERIFY: true };

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION — Called when ticket enters ACTIVE_WORK (e.g. from scheduling)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call from scheduling code when a ticket enters ACTIVE_WORK. Sends ACTIVE_WORK_ENTERED to lifecycle gateway.
 * @param {string} wiId - WorkItem id
 * @param {string} propertyId - Property code/id (canonical)
 * @param {Object} [opts] - { scheduledEndAt: Date } (required for timer; if missing, lifecycle will HOLD and log)
 */
function onWorkItemActiveWork_(wiId, propertyId, opts) {
  if (!wiId) return;
  var prop = String(propertyId || "").trim().toUpperCase() || "GLOBAL";
  if (!lifecycleEnabled_(prop)) return;
  opts = opts || {};
  handleLifecycleSignal_({
    eventType: "ACTIVE_WORK_ENTERED",
    wiId: String(wiId).trim(),
    propertyId: String(propertyId || "").trim().toUpperCase(),
    scheduledEndAt: opts.scheduledEndAt || null
  });
}

/**
 * Call from ticket creation when OwnerId is set but no ScheduledEndAt exists.
 * Enters UNSCHEDULED lifecycle state and arms first check-in timer.
 * Call site must only invoke when: OwnerId set, ScheduledEndAt absent, ticket not emergency.
 * Lifecycle layer guards defensively below. (WI object in this file has no scheduledEndAt field — schedule truth at call site/sheet.)
 * @param {string} wiId - WorkItem id
 * @param {string} propertyId - Property code/id (canonical)
 */
function onWorkItemCreatedUnscheduled_(wiId, propertyId) {
  if (!wiId) return;
  var prop = String(propertyId || "").trim().toUpperCase() || "GLOBAL";
  if (!lifecycleEnabled_(prop)) return;

  var wi = typeof workItemGetById_ === "function" ? workItemGetById_(wiId) : null;
  if (!wi) {
    lifecycleLog_("LIFECYCLE_SIGNAL_BAD", prop, wiId, { reason: "WI_NOT_FOUND", source: "onWorkItemCreatedUnscheduled_" });
    return;
  }
  if (!String(wi.ownerId || "").trim()) {
    lifecycleLog_("LIFECYCLE_UNSCHEDULED_SKIPPED", prop, wiId, { reason: "NO_OWNER" });
    return;
  }
  if (String(wi.substate || "").trim().toUpperCase() === "EMERGENCY") {
    lifecycleLog_("LIFECYCLE_UNSCHEDULED_SKIPPED", prop, wiId, { reason: "IS_EMERGENCY" });
    return;
  }
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
// SINGLE GATEWAY — All lifecycle triggers must go through this
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single entry point for all lifecycle events.
 * @param {Object} signal - { eventType, wiId?, propertyId?, outcome?, scheduledEndAt?, timerType?, payload?, phone? }
 * @returns {string} "OK" | "HOLD" | "REJECTED" | "CRASH"
 */
function handleLifecycleSignal_(signal) {
  if (!signal || typeof signal !== "object") {
    lifecycleLog_("LIFECYCLE_SIGNAL_BAD", "", "", { reason: "signal missing or invalid" });
    return "REJECTED";
  }
  var eventType = String(signal.eventType || "").trim().toUpperCase();
  if (!eventType) {
    lifecycleLog_("LIFECYCLE_SIGNAL_BAD", "", "", { reason: "eventType missing" });
    return "REJECTED";
  }
  try {
    var wiId = String(signal.wiId || "").trim();
    var propertyId = String(signal.propertyId || "").trim().toUpperCase();
    var wi = null;
    if (wiId && typeof workItemGetById_ === "function") {
      wi = workItemGetById_(wiId);
      if (wi) propertyId = propertyId || String(wi.propertyId || "").trim().toUpperCase();
    }
    var prop = propertyId || "GLOBAL";
    if (!lifecycleEnabled_(prop)) {
      lifecycleLog_("LIFECYCLE_DISABLED", prop, wiId, { eventType: eventType });
      return "HOLD";
    }
    var now = new Date();
    var facts = buildLifecycleFacts_(wi, signal, now);
    var decision = evaluateLifecyclePolicy_(facts, signal, eventType);
    if (decision.decision === "HOLD") return "HOLD";
    if (decision.decision === "REJECT") return "REJECTED";
    var execOk = executeLifecycleDecision_(decision, facts, signal);
    if (execOk === false) return "REJECTED";
    return "OK";
  } catch (e) {
    try {
      lifecycleLog_("LIFECYCLE_CRASH", propertyId || "", wiId || "", {
        eventType: eventType,
        error: String(e && e.message ? e.message : e)
      });
    } catch (_) {}
    return "CRASH";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTS — Build context for policy evaluation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build lifecycle facts from WI and signal. No hardcoded columns; use WI object and signal payload.
 */
function buildLifecycleFacts_(wi, signal, now) {
  var facts = {
    now: now,
    eventType: String(signal && signal.eventType || "").trim().toUpperCase(),
    wiId: String(signal && signal.wiId || "").trim(),
    propertyId: String(signal && signal.propertyId || "").trim().toUpperCase(),
    scheduledEndAt: null,
    currentState: null,
    substate: null,
    phoneE164: null,
    ticketRow: null,
    ticketKey: null,
    metadataJson: null
  };
  if (wi) {
    var rawState = String(wi.state || "").trim().toUpperCase();
    facts.currentState = rawState || null;
    facts.substate = String(wi.substate || "").trim();
    facts.phoneE164 = String(wi.phoneE164 || "").trim();
    facts.metadataJson = wi.metadataJson;
    if (wi.ticketKey && String(wi.ticketKey).trim() && typeof findTicketRowByTicketKey_ === "function" && typeof getLogSheet_ === "function") {
      try {
        var sheet = getLogSheet_();
        if (sheet) {
          var row = findTicketRowByTicketKey_(sheet, wi.ticketKey);
          if (row >= 2) facts.ticketRow = row;
        }
      } catch (_) {}
    }
    if (facts.ticketRow == null) {
      facts.ticketRow = wi.ticketRow;
      if (wi.ticketRow != null && wi.ticketRow !== "" && typeof lifecycleLog_ === "function") {
        try { lifecycleLog_("WI_LEGACY_ROW_FALLBACK_USED", String(wi.propertyId || ""), String(wi.workItemId || ""), { context: "buildLifecycleFacts_" }); } catch (_) {}
      }
    }
    if (wi.ticketKey != null && String(wi.ticketKey || "").trim()) facts.ticketKey = String(wi.ticketKey).trim();
  }
  if (signal && signal.scheduledEndAt) {
    facts.scheduledEndAt = signal.scheduledEndAt instanceof Date ? signal.scheduledEndAt : new Date(signal.scheduledEndAt);
  }
  if (signal && signal.outcome) facts.outcome = String(signal.outcome || "").trim().toUpperCase();
  if (signal && signal.timerType) facts.timerType = String(signal.timerType || "").trim().toUpperCase();
  if (signal && signal.payload) facts.timerPayload = signal.payload;
  if (signal && signal.partsEtaAt != null) {
    facts.partsEtaAt = signal.partsEtaAt instanceof Date ? signal.partsEtaAt : (typeof signal.partsEtaAt === "string" || typeof signal.partsEtaAt === "number") ? new Date(signal.partsEtaAt) : null;
    if (facts.partsEtaAt && !isFinite(facts.partsEtaAt.getTime())) facts.partsEtaAt = null;
  }
  if (signal && signal.partsEtaText != null) facts.partsEtaText = String(signal.partsEtaText || "").trim();
  return facts;
}

// ─────────────────────────────────────────────────────────────────────────────
// POLICY — All operational decisions from PropertyPolicy (ppGet_)
// ─────────────────────────────────────────────────────────────────────────────

function lifecyclePolicyGet_(propCode, key, fallback) {
  if (typeof ppGet_ !== "function") return fallback;
  return ppGet_(propCode || "GLOBAL", key, fallback);
}

/**
 * Whether Phase 2 lifecycle overlay is enabled for the given property.
 * Reads LIFECYCLE_ENABLED: property-specific first, then GLOBAL. Missing -> false (safe rollout default).
 */
function lifecycleEnabled_(propCode) {
  var prop = String(propCode || "").trim().toUpperCase() || "GLOBAL";
  var v = lifecyclePolicyGet_(prop, "LIFECYCLE_ENABLED", null);
  if (v == null || (typeof v === "string" && String(v).trim() === "")) {
    v = lifecyclePolicyGet_("GLOBAL", "LIFECYCLE_ENABLED", false);
  }
  if (v === true) return true;
  if (v === false) return false;
  var s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT HOURS — Policy-driven human-facing communication windows (no SCHED_*)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the given date falls inside an allowed contact window for the property.
 * Uses CONTACT_EARLIEST_HOUR, CONTACT_LATEST_HOUR, CONTACT_SAT_ALLOWED, CONTACT_SAT_LATEST_HOUR, CONTACT_SUN_ALLOWED.
 */
function lifecycleIsInsideContactWindow_(propCode, date) {
  if (!(date instanceof Date) || !isFinite(date.getTime())) return false;
  var prop = String(propCode || "").trim().toUpperCase() || "GLOBAL";
  var earliest = Number(lifecyclePolicyGet_(prop, "CONTACT_EARLIEST_HOUR", 9));
  var latest = Number(lifecyclePolicyGet_(prop, "CONTACT_LATEST_HOUR", 18));
  var satAllowed = !!lifecyclePolicyGet_(prop, "CONTACT_SAT_ALLOWED", false);
  var satLatest = Number(lifecyclePolicyGet_(prop, "CONTACT_SAT_LATEST_HOUR", 13));
  var sunAllowed = !!lifecyclePolicyGet_(prop, "CONTACT_SUN_ALLOWED", false);
  if (!isFinite(earliest)) earliest = 9;
  if (!isFinite(latest)) latest = 18;
  if (!isFinite(satLatest)) satLatest = 13;
  var d = date.getDay();
  if (d === 0 && !sunAllowed) return false;
  if (d === 6 && !satAllowed) return false;
  var hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  var latestHour = (d === 6) ? satLatest : latest;
  return hour >= earliest && hour <= latestHour;
}

/**
 * Snap a requested time forward to the next valid contact window.
 * If desiredAt is already inside an allowed window, return it unchanged.
 * Uses CONTACT_* policy keys only; does not use SCHED_*.
 * @param {string} propCode - Property code
 * @param {Date} desiredAt - Requested time
 * @returns {Date} Adjusted time within contact window
 */
function lifecycleSnapToContactWindow_(propCode, desiredAt) {
  var d = desiredAt instanceof Date ? desiredAt : new Date(desiredAt);
  if (!isFinite(d.getTime())) return d;
  var prop = String(propCode || "").trim().toUpperCase() || "GLOBAL";
  var earliest = Number(lifecyclePolicyGet_(prop, "CONTACT_EARLIEST_HOUR", 9));
  var latest = Number(lifecyclePolicyGet_(prop, "CONTACT_LATEST_HOUR", 18));
  var satAllowed = !!lifecyclePolicyGet_(prop, "CONTACT_SAT_ALLOWED", false);
  var satLatest = Number(lifecyclePolicyGet_(prop, "CONTACT_SAT_LATEST_HOUR", 13));
  var sunAllowed = !!lifecyclePolicyGet_(prop, "CONTACT_SUN_ALLOWED", false);
  if (!isFinite(earliest)) earliest = 9;
  if (!isFinite(latest)) latest = 18;
  if (!isFinite(satLatest)) satLatest = 13;

  function dayAllowed(day) {
    if (day === 0) return sunAllowed;
    if (day === 6) return satAllowed;
    return true;
  }
  function latestHourForDay(day) {
    if (day === 6 && satAllowed) return satLatest;
    if (day === 0 && sunAllowed) return latest;
    if (day >= 1 && day <= 5) return latest;
    return -1;
  }

  if (lifecycleIsInsideContactWindow_(prop, d)) return d;

  var hour = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  var day = d.getDay();
  var lat = latestHourForDay(day);

  if (dayAllowed(day) && lat >= 0 && hour < earliest) {
    var out = new Date(d);
    out.setHours(Math.floor(earliest), 0, 0, 0);
    return out;
  }

  var next = new Date(d);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + 1);
  for (var i = 0; i < 8; i++) {
    var nd = next.getDay();
    if (dayAllowed(nd)) {
      next.setHours(Math.floor(earliest), 0, 0, 0);
      return next;
    }
    next.setDate(next.getDate() + 1);
  }
  next.setHours(Math.floor(earliest), 0, 0, 0);
  return next;
}

/**
 * Whether the given timer type should have its runAt snapped to contact hours when writing.
 * AUTO_CLOSE never snaps (operational truth); SEND_TENANT_VERIFY is already scheduled in-window.
 */
function lifecycleTimerRespectsContactHours_(propCode, timerType) {
  var prop = String(propCode || "").trim().toUpperCase() || "GLOBAL";
  if (timerType === "PING_STAFF_UPDATE") return !!lifecyclePolicyGet_(prop, "PING_STAFF_UPDATE_RESPECT_CONTACT_HOURS", false);
  if (timerType === "PING_UNSCHEDULED") return !!lifecyclePolicyGet_(prop, "PING_UNSCHEDULED_RESPECT_CONTACT_HOURS", false);
  if (timerType === "TIMER_ESCALATE") return !!lifecyclePolicyGet_(prop, "TIMER_ESCALATE_RESPECT_CONTACT_HOURS", false);
  if (timerType === "AUTO_CLOSE" || timerType === "SEND_TENANT_VERIFY") return false;
  return false;
}

/**
 * Whether an immediate outbound intent (e.g. tenant verify on state enter) should be deferred if outside contact window.
 */
function lifecycleImmediateIntentRespectsContactHours_(propCode, intentType) {
  var prop = String(propCode || "").trim().toUpperCase() || "GLOBAL";
  if (intentType === "TENANT_VERIFY_RESOLUTION") return !!lifecyclePolicyGet_(prop, "TENANT_VERIFY_RESPECT_CONTACT_HOURS", false);
  return false;
}

/**
 * Evaluate lifecycle policy. Returns { decision: "PROCEED"|"HOLD"|"REJECT", action?, nextState?, timerType?, ... }.
 * Missing policy key -> log POLICY_KEY_MISSING, HOLD.
 */
function evaluateLifecyclePolicy_(facts, signal, eventType) {
  var prop = facts.propertyId || "GLOBAL";

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

  if (eventType === "ACTIVE_WORK_ENTERED") {
    if (!facts.scheduledEndAt) {
      lifecycleLog_("LIFECYCLE_MISSING_SCHEDULE_END", facts.propertyId, facts.wiId, {});
      return { decision: "HOLD" };
    }
    var bufferHours = lifecyclePolicyGet_(prop, "SCHEDULE_BUFFER_HOURS", null);
    if (bufferHours == null || (typeof bufferHours === "number" && !isFinite(bufferHours))) {
      lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "SCHEDULE_BUFFER_HOURS" });
      return { decision: "HOLD" };
    }
    // Write PING_STAFF_UPDATE at scheduledEndAt + buffer so when it fires it is a supported timer type
    return {
      decision: "PROCEED",
      action: "WRITE_TIMER",
      timerType: "PING_STAFF_UPDATE",
      runAt: new Date(facts.scheduledEndAt.getTime() + Number(bufferHours) * 3600000)
    };
  }

  if (eventType === "SCHEDULE_SET") {
    var stateNow = facts.currentState ? String(facts.currentState).trim().toUpperCase() : "";
    var scheduleAllowedState =
      stateNow === "UNSCHEDULED" ||
      stateNow === "WAIT_STAFF_UPDATE" ||
      stateNow === "ACTIVE_WORK";
    if (!scheduleAllowedState) {
      lifecycleLog_("SCHEDULE_SET_BAD_STATE", prop, facts.wiId, { currentState: stateNow, allowed: "UNSCHEDULED|WAIT_STAFF_UPDATE|ACTIVE_WORK" });
      return { decision: "HOLD" };
    }
    if (!(facts.scheduledEndAt instanceof Date) || !isFinite(facts.scheduledEndAt.getTime())) {
      lifecycleLog_("SCHEDULE_SET_MISSING_SCHEDULE_END", prop, facts.wiId, { scheduledEndAt: facts.scheduledEndAt });
      return { decision: "HOLD" };
    }
    var scheduleLabel = signal && signal.scheduleLabel != null ? String(signal.scheduleLabel || "").trim() : "";
    return { decision: "PROCEED", action: "APPLY_SCHEDULE_SET", scheduleLabel: scheduleLabel };
  }

  if (eventType === "STAFF_UPDATE") {
    if (!facts.currentState) {
      lifecycleLog_("LIFECYCLE_SIGNAL_BAD", prop, facts.wiId, { reason: "missing_wi_state_for_staff_update" });
      return { decision: "HOLD" };
    }
    var outcome = facts.outcome;
    if (!outcome) return { decision: "HOLD" };
    var nextState = null;
    var timerType = null;
    var runAt = null;
    var tenantVerify = null;

    if (outcome === "COMPLETED") {
      tenantVerify = lifecyclePolicyGet_(prop, "TENANT_VERIFY_REQUIRED", null);
      if (tenantVerify === null) {
        lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "TENANT_VERIFY_REQUIRED" });
        return { decision: "HOLD" };
      }
      if (tenantVerify) {
        var tenantVerifyHours = lifecyclePolicyGet_(prop, "TENANT_VERIFY_HOURS", null);
        if (tenantVerifyHours == null || (typeof tenantVerifyHours === "number" && !isFinite(tenantVerifyHours))) {
          lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "TENANT_VERIFY_HOURS" });
          return { decision: "HOLD" };
        }
        var tvH = Number(tenantVerifyHours);
        if (!isFinite(tvH)) tvH = 24;
        nextState = "VERIFYING_RESOLUTION";
        timerType = "AUTO_CLOSE";
        runAt = new Date(facts.now.getTime() + tvH * 3600000);
      } else {
        nextState = "DONE";
      }
    } else if (outcome === "IN_PROGRESS") {
      nextState = "INHOUSE_WORK";
    } else if (outcome === "WAITING_PARTS") {
      var partsEtaAt = (facts.partsEtaAt instanceof Date && isFinite(facts.partsEtaAt.getTime())) ? facts.partsEtaAt : null;
      if (partsEtaAt) {
        var etaBufferHours = lifecyclePolicyGet_(prop, "PARTS_ETA_BUFFER_HOURS", null);
        if (etaBufferHours == null || (typeof etaBufferHours === "number" && !isFinite(etaBufferHours))) {
          lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "PARTS_ETA_BUFFER_HOURS" });
          return { decision: "HOLD" };
        }
        var bufH = Number(etaBufferHours);
        if (!isFinite(bufH)) bufH = 24;
        nextState = "WAIT_PARTS";
        timerType = "TIMER_ESCALATE";
        runAt = new Date(partsEtaAt.getTime() + bufH * 3600000);
      } else {
        var partsMaxHours = lifecyclePolicyGet_(prop, "PARTS_WAIT_MAX_HOURS", null);
        if (partsMaxHours == null || (typeof partsMaxHours === "number" && !isFinite(partsMaxHours))) {
          lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "PARTS_WAIT_MAX_HOURS" });
          return { decision: "HOLD" };
        }
        var pMH = Number(partsMaxHours);
        if (!isFinite(pMH)) pMH = 72;
        nextState = "WAIT_PARTS";
        timerType = "TIMER_ESCALATE";
        runAt = new Date(facts.now.getTime() + pMH * 3600000);
      }
    } else if (outcome === "NEEDS_VENDOR") {
      nextState = "VENDOR_DISPATCH";
    } else if (outcome === "DELAYED") {
      var pingHours = lifecyclePolicyGet_(prop, "STAFF_UPDATE_PING_HOURS", null);
      if (pingHours == null || (typeof pingHours === "number" && !isFinite(pingHours))) {
        lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "STAFF_UPDATE_PING_HOURS" });
        return { decision: "HOLD" };
      }
      var pH = Number(pingHours);
      if (!isFinite(pH)) pH = 24;
      nextState = "WAIT_STAFF_UPDATE";
      timerType = "PING_STAFF_UPDATE";
      runAt = new Date(facts.now.getTime() + pH * 3600000);
    } else if (outcome === "ACCESS_ISSUE") {
      return { decision: "PROCEED", action: "LOG_ONLY", logEventType: "STAFF_ACCESS_ISSUE", logNote: "ACCESS_ISSUE" };
    } else {
      return { decision: "HOLD" };
    }
    // tenantVerify is set only in COMPLETED branch; for all other outcomes it remains null → treat as false for return.
    if (tenantVerify === null) tenantVerify = false;
    return {
      decision: "PROCEED",
      action: "TRANSITION",
      nextState: nextState,
      timerType: timerType,
      runAt: runAt,
      tenantVerify: !!tenantVerify
    };
  }

  if (eventType === "TIMER_FIRE") {
    var timerType = facts.timerType;
    if (!timerType || !LIFECYCLE_TIMER_TYPES_[timerType]) return { decision: "REJECT" };
    if (!facts.currentState) {
      lifecycleLog_("LIFECYCLE_SIGNAL_BAD", prop, facts.wiId, { reason: "missing_wi_state_for_timer_fire" });
      return { decision: "HOLD" };
    }

    if (timerType === "PING_STAFF_UPDATE") {
      var maxAttempts = lifecyclePolicyGet_(prop, "STAFF_UPDATE_MAX_ATTEMPTS", null);
      if (maxAttempts == null) {
        lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "STAFF_UPDATE_MAX_ATTEMPTS" });
        return { decision: "HOLD" };
      }
      var pingH = lifecyclePolicyGet_(prop, "STAFF_UPDATE_PING_HOURS", null);
      if (pingH == null || (typeof pingH === "number" && !isFinite(pingH))) {
        lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "STAFF_UPDATE_PING_HOURS" });
        return { decision: "HOLD" };
      }
      pingH = Number(pingH) || 24;
      var attempts = (facts.timerPayload && typeof facts.timerPayload.attempts === "number") ? facts.timerPayload.attempts : 0;
      // Phase 2 v1: same-state re-entry is intentional (reminder + timer reset), not an accidental duplicate transition.
      if (attempts < Number(maxAttempts)) {
        return {
          decision: "PROCEED",
          action: "PING_AND_RESTART",
          nextState: "WAIT_STAFF_UPDATE",
          timerType: "PING_STAFF_UPDATE",
          attempts: attempts + 1,
          runAt: new Date(facts.now.getTime() + pingH * 3600000)
        };
      }
      return { decision: "PROCEED", action: "LOG_ESCALATE", logEventType: "STAFF_UPDATE_ESCALATED", logNote: "STAFF_UPDATE_MAX_ATTEMPTS" };
    }

    if (timerType === "TIMER_ESCALATE") {
      return { decision: "PROCEED", action: "LOG_ESCALATE", logEventType: "PARTS_ESCALATED", logNote: "PARTS_ESCALATE" };
    }

    if (timerType === "AUTO_CLOSE") {
      return { decision: "PROCEED", action: "TRANSITION", nextState: "DONE" };
    }

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
      return { decision: "PROCEED", action: "LOG_ESCALATE", logEventType: "UNSCHEDULED_ESCALATED", logNote: "UNSCHEDULED_MAX_ATTEMPTS_PHASE3B_PM_NOTIFY_PENDING" };
    }

    if (timerType === "SEND_TENANT_VERIFY") {
      var recipientPhone = (facts.timerPayload && facts.timerPayload.recipientPhone) ? String(facts.timerPayload.recipientPhone).trim() : "";
      if (!recipientPhone) {
        lifecycleLog_("LIFECYCLE_SIGNAL_BAD", prop, facts.wiId, { reason: "SEND_TENANT_VERIFY missing recipientPhone" });
        return { decision: "HOLD" };
      }
      return { decision: "PROCEED", action: "SEND_TENANT_VERIFY", recipientPhone: recipientPhone };
    }

    return { decision: "REJECT" };
  }

  if (eventType === "TENANT_REPLY") {
    if (facts.currentState !== "VERIFYING_RESOLUTION") return { decision: "REJECT" };
    // Contract: upstream must set signal.positive (true/false) and supply actorType, actorId, reasonCode, rawText for audit.
    var sentiment = (signal && signal.positive !== undefined) ? !!signal.positive : null;
    if (sentiment === true) return { decision: "PROCEED", action: "TRANSITION", nextState: "DONE" };
    if (sentiment === false) {
      var pingH = lifecyclePolicyGet_(prop, "STAFF_UPDATE_PING_HOURS", null);
      if (pingH == null || (typeof pingH === "number" && !isFinite(pingH))) {
        lifecycleLog_("POLICY_KEY_MISSING", prop, facts.wiId, { key: "STAFF_UPDATE_PING_HOURS" });
        return { decision: "HOLD" };
      }
      pingH = Number(pingH) || 24;
      return {
        decision: "PROCEED",
        action: "TRANSITION_AND_TIMER",
        nextState: "INHOUSE_WORK",
        timerType: "PING_STAFF_UPDATE",
        runAt: new Date(facts.now.getTime() + pingH * 3600000),
        sendStaffUpdateRequest: true
      };
    }
    lifecycleLog_("TENANT_REPLY_AMBIGUOUS", prop, facts.wiId, Object.assign({}, getActorFacts_(signal)));
    return { decision: "PROCEED", action: "LOG_ONLY", logEventType: "TENANT_REPLY_AMBIGUOUS" };
  }

  return { decision: "REJECT" };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION — Apply decision via wiEnterState_ and centralized timer writes
// ─────────────────────────────────────────────────────────────────────────────

function executeLifecycleDecision_(decision, facts, signal) {
  var wiId = facts.wiId;
  var prop = facts.propertyId || "GLOBAL";
  var wi = wiId && typeof workItemGetById_ === "function" ? workItemGetById_(wiId) : null;

  if (decision.action === "LOG_ONLY" || decision.action === "LOG_ESCALATE") {
    var logEventType = decision.logEventType || (decision.action === "LOG_ESCALATE" ? "STAFF_UPDATE_ESCALATED" : "LIFECYCLE_LOG_ONLY");
    lifecycleLog_(logEventType, prop, wiId, Object.assign({ note: decision.logNote || "" }, getActorFacts_(signal)));
    return true;
  }

  if (decision.action === "SEND_TENANT_VERIFY" && decision.recipientPhone) {
    var wiForVerify = wiId && typeof workItemGetById_ === "function" ? workItemGetById_(wiId) : null;
    var stateNow = wiForVerify ? String(wiForVerify.state || "").trim().toUpperCase() : "";
    if (stateNow !== "VERIFYING_RESOLUTION") {
      lifecycleLog_("SEND_TENANT_VERIFY_SKIPPED", prop, wiId, { reason: "state_changed_or_tenant_replied", stateNow: stateNow });
      return true;
    }
    if (typeof dispatchOutboundIntent_ === "function") {
      dispatchOutboundIntent_({
        intentType: "TENANT_VERIFY_RESOLUTION",
        templateKey: "TENANT_VERIFY_RESOLUTION",
        recipientType: "TENANT",
        recipientRef: decision.recipientPhone,
        vars: {},
        deliveryPolicy: "DIRECT_SEND",
        meta: { reasonCode: "CONTACT_WINDOW_SEND", actorType: "SYSTEM", actorId: "", sourceModule: "LIFECYCLE_ENGINE" }
      });
    }
    lifecycleLog_("TIMER_FIRED", prop, wiId, { timerType: "SEND_TENANT_VERIFY", action: "SEND_TENANT_VERIFY" });
    return true;
  }

  if (decision.action === "WRITE_TIMER") {
    lifecycleCancelTimersForWi_(wiId);
    lifecycleWriteTimer_(wiId, prop, decision.timerType || "PING_STAFF_UPDATE", decision.runAt, {});
    lifecycleLog_("TIMER_WRITTEN", prop, wiId, Object.assign(getActorFacts_(signal) || {}, { timerType: decision.timerType, runAt: decision.runAt }));
    return true;
  }

  if (decision.action === "APPLY_SCHEDULE_SET") {
    if (!wi || !wiId) return false;

    lifecycleCancelTimersForWi_(wiId);

    var fromState = String(wi.state || "").trim().toUpperCase();
    var toState = "ACTIVE_WORK";

    var resolved = lifecycleResolveTicketRowForSync_(wi);
    var ticketRow = resolved && typeof resolved.row === "number" ? resolved.row : 0;

    var sheet = (typeof getLogSheet_ === "function") ? getLogSheet_() : null;
    if (!sheet && typeof getSheetSafe_ === "function") sheet = getSheetSafe_("Sheet1");
    if (!sheet && typeof SpreadsheetApp !== "undefined") {
      try {
        var ss = typeof LOG_SHEET_ID !== "undefined" ? SpreadsheetApp.openById(LOG_SHEET_ID) : SpreadsheetApp.getActive();
        sheet = ss ? ss.getSheetByName("Sheet1") : null;
      } catch (_) {}
    }

    if (!sheet || ticketRow < 2 || typeof COL === "undefined" || !COL.PREF_WINDOW || !COL.SCHEDULED_END_AT || !COL.STATUS) {
      lifecycleLog_("SCHEDULE_SET_APPLY_FAIL", prop, wiId, {
        ticketRow: ticketRow,
        fromState: fromState
      });
      return false;
    }

    var now = new Date();
    var scheduleEndAt = facts.scheduledEndAt;
    var scheduleLabel = String(decision.scheduleLabel || (signal && signal.scheduleLabel) || "").trim();

    try {
      if (typeof withWriteLock_ === "function") {
        withWriteLock_("LIFECYCLE_APPLY_SCHEDULE_SET", function () {
          sheet.getRange(ticketRow, COL.PREF_WINDOW).setValue(scheduleLabel);
          sheet.getRange(ticketRow, COL.SCHEDULED_END_AT).setValue(scheduleEndAt);
          sheet.getRange(ticketRow, COL.STATUS).setValue("Scheduled");
          if (COL.LAST_UPDATE) sheet.getRange(ticketRow, COL.LAST_UPDATE).setValue(now);
        });
      } else {
        sheet.getRange(ticketRow, COL.PREF_WINDOW).setValue(scheduleLabel);
        sheet.getRange(ticketRow, COL.SCHEDULED_END_AT).setValue(scheduleEndAt);
        sheet.getRange(ticketRow, COL.STATUS).setValue("Scheduled");
        if (COL.LAST_UPDATE) sheet.getRange(ticketRow, COL.LAST_UPDATE).setValue(now);
      }
    } catch (e) {
      lifecycleLog_("SCHEDULE_SET_APPLY_WRITE_FAIL", prop, wiId, { error: String(e && e.message ? e.message : e) });
      return false;
    }

    var okWi = typeof workItemUpdate_ === "function" ? workItemUpdate_(wiId, { state: toState, substate: "" }) : false;
    lifecycleLog_("SCHEDULE_SET_APPLIED", prop, wiId, Object.assign(getActorFacts_(signal), {
      fromState: fromState,
      toState: toState,
      scheduledEndAt: scheduleEndAt,
      scheduleLabel: scheduleLabel
    }));

    if (okWi && typeof onWorkItemActiveWork_ === "function") {
      try { onWorkItemActiveWork_(wiId, prop, { scheduledEndAt: scheduleEndAt }); } catch (_) {}
    }

    return !!okWi;
  }

  if (decision.action === "ENTER_UNSCHEDULED") {
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

  if (decision.action === "TRANSITION" || decision.action === "TRANSITION_AND_TIMER" || decision.action === "PING_AND_RESTART") {
    var nextState = decision.nextState;
    if (!nextState) return true;
    var tenantPhone = (wi && wi.phoneE164) || (signal && signal.phone) || "";
    var ok = wiEnterState_(wiId, nextState, "", {
      cancelTimers: true,
      writeTimer: decision.timerType && decision.runAt ? {
        timerType: decision.timerType,
        runAt: decision.runAt,
        payload: decision.attempts !== undefined ? { attempts: decision.attempts } : {}
      } : null,
      sendTenantVerify: decision.tenantVerify && nextState === "VERIFYING_RESOLUTION",
      sendStaffUpdateRequest: decision.sendStaffUpdateRequest,
      phone: tenantPhone,
      actor: getActorFacts_(signal),
      signal: signal
    });
    // Staff reminder must go to assigned staff phone, not tenant (wi.phoneE164). Outgate V1.
    if (ok && decision.action === "PING_AND_RESTART" && wi && wi.ownerId && typeof dispatchOutboundIntent_ === "function") {
      dispatchOutboundIntent_({
        intentType: "REQUEST_STAFF_UPDATE",
        templateKey: "STAFF_UPDATE_REMINDER",
        recipientType: "STAFF",
        recipientRef: String(wi.ownerId).trim(),
        propertyId: facts.propertyId || "",
        workItemId: wiId || "",
        vars: {},
        deliveryPolicy: "DIRECT_SEND",
        meta: { reasonCode: "TIMER_PING", actorType: "SYSTEM", actorId: "", sourceModule: "LIFECYCLE_ENGINE" }
      });
    }
    return !!ok;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE — Validated transitions, centralized timer cancel + write
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate transition, cancel existing timers for WI, write state, write new timer if required, log.
 */
function wiEnterState_(wiId, newState, substate, opts) {
  opts = opts || {};
  if (!wiId) return false;
  var wi = typeof workItemGetById_ === "function" ? workItemGetById_(wiId) : null;
  var fromState = wi ? String(wi.state || "").trim().toUpperCase() : "";
  var toState = String(newState || "").trim().toUpperCase();
  var key = fromState + "->" + toState;
  if (!fromState) key = "->" + toState;

  if (!LIFECYCLE_ALLOWED_TRANSITIONS_[key] && fromState !== "") {
    lifecycleLog_("WI_TRANSITION_REJECTED", wi ? String(wi.propertyId || "").trim().toUpperCase() : "", wiId, {
      from: fromState,
      to: toState,
      reason: "illegal transition"
    });
    return false;
  }

  var prop = (wi && wi.propertyId) ? String(wi.propertyId).trim().toUpperCase() : "GLOBAL";

  if (opts.cancelTimers !== false) lifecycleCancelTimersForWi_(wiId);

  var patch = { state: toState, substate: String(substate || "").trim() };
  if (toState === "DONE") patch.status = "COMPLETED";
  var ok = typeof workItemUpdate_ === "function" && workItemUpdate_(wiId, patch);
  if (!ok) return false;

  // When WI reaches terminal DONE in lifecycle, sync Sheet1 ticket status using TicketKey→TicketRow resolution.
  if (toState === "DONE") {
    try {
      lifecycleSyncTicketOnDone_(wi, wiId, patch.status || "COMPLETED");
    } catch (_) {}
  }

  var actor = (opts && opts.actor && typeof opts.actor === "object") ? opts.actor : getActorFacts_(opts && opts.signal ? opts.signal : {});
  lifecycleLog_("WI_TRANSITION", prop, wiId, Object.assign({ from: fromState, to: toState }, actor));

  if (opts.writeTimer && opts.writeTimer.timerType && opts.writeTimer.runAt) {
    lifecycleWriteTimer_(wiId, prop, opts.writeTimer.timerType, opts.writeTimer.runAt, opts.writeTimer.payload || {});
    lifecycleLog_("TIMER_WRITTEN", prop, wiId, Object.assign({ timerType: opts.writeTimer.timerType }, actor));
  }

  if (opts.sendTenantVerify && opts.phone) {
    var now = new Date();
    var sendNow = !lifecycleImmediateIntentRespectsContactHours_(prop, "TENANT_VERIFY_RESOLUTION") || lifecycleIsInsideContactWindow_(prop, now);
    if (sendNow && typeof dispatchOutboundIntent_ === "function") {
      dispatchOutboundIntent_({
        intentType: "TENANT_VERIFY_RESOLUTION",
        templateKey: "TENANT_VERIFY_RESOLUTION",
        recipientType: "TENANT",
        recipientRef: opts.phone,
        vars: {},
        deliveryPolicy: "DIRECT_SEND",
        meta: { reasonCode: "STATE_TRANSITION", actorType: "SYSTEM", actorId: "", sourceModule: "LIFECYCLE_ENGINE" }
      });
    } else if (lifecycleImmediateIntentRespectsContactHours_(prop, "TENANT_VERIFY_RESOLUTION")) {
      var sendAt = lifecycleSnapToContactWindow_(prop, now);
      lifecycleWriteTimer_(wiId, prop, "SEND_TENANT_VERIFY", sendAt, { recipientPhone: opts.phone });
      lifecycleLog_("TIMER_WRITTEN", prop, wiId, { timerType: "SEND_TENANT_VERIFY", runAt: sendAt, reason: "DEFERRED_CONTACT_HOURS" });
    }
  }
  if (opts.sendStaffUpdateRequest) {
    lifecycleLog_("STAFF_UPDATE_REQUESTED", prop, wiId, Object.assign({}, (opts.actor || {})));
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// TICKET SYNC — Sheet1 status/closedAt when WI enters DONE
// ─────────────────────────────────────────────────────────────────────────────

function lifecycleResolveTicketRowForSync_(wi) {
  if (!wi || typeof wi !== "object") return { row: 0, mode: "NONE" };

  var ticketSheet = (typeof getLogSheet_ === "function") ? getLogSheet_() : null;
  if (!ticketSheet && typeof getSheetSafe_ === "function") ticketSheet = getSheetSafe_("Sheet1");
  if (!ticketSheet && typeof SpreadsheetApp !== "undefined") {
    try {
      var ss = typeof LOG_SHEET_ID !== "undefined" ? SpreadsheetApp.openById(LOG_SHEET_ID) : SpreadsheetApp.getActive();
      ticketSheet = ss ? ss.getSheetByName("Sheet1") : null;
    } catch (_) {
      ticketSheet = null;
    }
  }
  if (!ticketSheet) return { row: 0, mode: "NONE" };

  var key = wi.ticketKey != null ? String(wi.ticketKey || "").trim() : "";
  if (key && typeof findTicketRowByTicketKey_ === "function") {
    try {
      var rowByKey = Number(findTicketRowByTicketKey_(ticketSheet, key)) || 0;
      if (rowByKey >= 2) return { row: rowByKey, mode: "TICKET_KEY" };
    } catch (_) {}
  }

  var legacyRow = wi.ticketRow != null ? Number(wi.ticketRow) || 0 : 0;
  if (legacyRow >= 2) return { row: legacyRow, mode: "TICKET_ROW" };

  return { row: 0, mode: "NONE" };
}

function lifecycleSyncTicketOnDone_(wi, wiId, wiStatus) {
  var workItemId = String(wiId || (wi && wi.workItemId) || "").trim();
  var prop = wi && wi.propertyId ? String(wi.propertyId).trim().toUpperCase() : "GLOBAL";

  if (!wi || typeof wi !== "object") {
    lifecycleLog_("TICKET_STATUS_SYNC_UNRESOLVED", prop, workItemId, {
      reason: "missing_wi",
      workItemId: workItemId || "",
      ticketKey: "",
      ticketRow: "",
      prevStatus: "",
      newStatus: "Completed"
    });
    return;
  }

  var resolved = lifecycleResolveTicketRowForSync_(wi);
  var ticketRow = resolved.row;
  var mode = resolved.mode;

  var ticketKey = wi.ticketKey != null ? String(wi.ticketKey || "").trim() : "";

  if (ticketRow < 2) {
    lifecycleLog_("TICKET_STATUS_SYNC_UNRESOLVED", prop, workItemId, {
      reason: "no_ticket_row",
      workItemId: workItemId || "",
      ticketKey: ticketKey,
      ticketRow: wi.ticketRow != null ? wi.ticketRow : "",
      prevStatus: "",
      newStatus: "Completed"
    });
    return;
  }

  var sheet = (typeof getLogSheet_ === "function") ? getLogSheet_() : null;
  if (!sheet && typeof getSheetSafe_ === "function") sheet = getSheetSafe_("Sheet1");
  if (!sheet && typeof SpreadsheetApp !== "undefined") {
    try {
      var ss = typeof LOG_SHEET_ID !== "undefined" ? SpreadsheetApp.openById(LOG_SHEET_ID) : SpreadsheetApp.getActive();
      sheet = ss ? ss.getSheetByName("Sheet1") : null;
    } catch (_) {
      sheet = null;
    }
  }
  if (!sheet || sheet.getLastRow() < ticketRow || typeof COL === "undefined" || !COL.STATUS) {
    lifecycleLog_("TICKET_STATUS_SYNC_UNRESOLVED", prop, workItemId, {
      reason: "sheet_missing_or_row_out_of_range",
      workItemId: workItemId || "",
      ticketKey: ticketKey,
      ticketRow: ticketRow,
      prevStatus: "",
      newStatus: "Completed"
    });
    return;
  }

  var now = new Date();
  var prevStatus = "";
  try {
    prevStatus = String(sheet.getRange(ticketRow, COL.STATUS).getValue() || "").trim();
  } catch (_) {}

  var newStatus = "Completed";

  try {
    if (typeof withWriteLock_ === "function") {
      withWriteLock_("LIFECYCLE_TICKET_STATUS_SYNC", function () {
        sheet.getRange(ticketRow, COL.STATUS).setValue(newStatus);
        if (COL.CLOSED_AT) sheet.getRange(ticketRow, COL.CLOSED_AT).setValue(now);
        if (COL.LAST_UPDATE) sheet.getRange(ticketRow, COL.LAST_UPDATE).setValue(now);
      });
    } else {
      sheet.getRange(ticketRow, COL.STATUS).setValue(newStatus);
      if (COL.CLOSED_AT) sheet.getRange(ticketRow, COL.CLOSED_AT).setValue(now);
      if (COL.LAST_UPDATE) sheet.getRange(ticketRow, COL.LAST_UPDATE).setValue(now);
    }
  } catch (e) {
    lifecycleLog_("TICKET_STATUS_SYNC_UNRESOLVED", prop, workItemId, {
      reason: "write_failed",
      workItemId: workItemId || "",
      ticketKey: ticketKey,
      ticketRow: ticketRow,
      prevStatus: prevStatus,
      newStatus: newStatus,
      error: String(e && e.message ? e.message : e)
    });
    return;
  }

  var eventType = "TICKET_STATUS_SYNC_FROM_WI_DONE";
  if (mode === "TICKET_ROW") eventType = "TICKET_STATUS_SYNC_FALLBACK_ROW";

  lifecycleLog_(eventType, prop, workItemId, {
    workItemId: workItemId || "",
    ticketKey: ticketKey,
    ticketRow: ticketRow,
    mode: mode,
    prevStatus: prevStatus,
    newStatus: newStatus
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMERS — Centralized write/cancel; no scatter
// ─────────────────────────────────────────────────────────────────────────────

function lifecycleCancelTimersForWi_(wiId) {
  if (!wiId) return;
  try {
    var sh = typeof getActiveSheetByNameCached_ === "function" ? getActiveSheetByNameCached_(LIFECYCLE_TIMERS_SHEET_) : null;
    if (!sh) return;
    var map = typeof getHeaderMap_ === "function" ? getHeaderMap_(sh) : {};
    var colWi = (map["WorkItemId"] || 3) - 1;
    var colEnabled = (map["Enabled"] || 2) - 1;
    var colEvent = (map["EventType"] || 5) - 1;
    var lastRow = sh.getLastRow();
    var numRows = lastRow - 1;
    if (numRows < 1) return;
    var colStatus = (map["Status"] || 9) - 1;
    var colUpdatedAt = (map["UpdatedAt"] || 13) - 1;
    var numCols = Math.max(colWi, colEnabled, colEvent, colStatus, colUpdatedAt) + 1;
    var data = sh.getRange(2, 1, numRows, numCols).getValues();
    var id = String(wiId).trim();
    var now = new Date();
    var hasUpdatedAt = (map["UpdatedAt"] != null && map["UpdatedAt"] >= 1);
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      if (String(row[colWi] || "").trim() !== id) continue;
      if (String(row[colEvent] || "").trim() !== LIFECYCLE_EVENT_TYPE_) continue;
      if (row[colEnabled] === false || String(row[colEnabled]).toLowerCase() === "false") continue;
      if (String(row[colStatus] || "").trim().toUpperCase() !== "PENDING") continue;
      var rowNum = i + 2;
      if (typeof withWriteLock_ === "function") {
        (function (r, cE, cS, cU, t) {
          withWriteLock_("LIFECYCLE_CANCEL_TIMER", function () {
            sh.getRange(r, cE).setValue(false);
            sh.getRange(r, cS).setValue("CANCELLED");
            if (hasUpdatedAt) sh.getRange(r, cU).setValue(t);
          });
        })(rowNum, colEnabled + 1, colStatus + 1, colUpdatedAt + 1, now);
      } else {
        sh.getRange(rowNum, colEnabled + 1).setValue(false);
        sh.getRange(rowNum, colStatus + 1).setValue("CANCELLED");
        if (hasUpdatedAt) sh.getRange(rowNum, colUpdatedAt + 1).setValue(now);
      }
      lifecycleLog_("TIMER_CANCELLED", "", wiId, { row: rowNum });
    }
  } catch (e) {
    try { lifecycleLog_("LIFECYCLE_CRASH", "", wiId || "", { phase: "cancelTimers", error: String(e && e.message ? e.message : e) }); } catch (_) {}
  }
}

function lifecycleWriteTimer_(wiId, prop, timerType, runAt, payload) {
  try {
    var sh = typeof getActiveSheetByNameCached_ === "function" ? getActiveSheetByNameCached_(LIFECYCLE_TIMERS_SHEET_) : null;
    if (!sh) return;
    var runAtDate = runAt instanceof Date ? runAt : new Date(runAt);
    if (lifecycleTimerRespectsContactHours_(prop, timerType)) {
      var runAtRequested = runAtDate.getTime();
      runAtDate = lifecycleSnapToContactWindow_(prop, runAtDate);
      if (runAtDate.getTime() !== runAtRequested) {
        lifecycleLog_("CONTACT_WINDOW_SNAPPED", prop, wiId || "", { runAtRequested: new Date(runAtRequested), runAtSnapped: runAtDate, timerType: timerType });
      }
    }
    var p = Object.assign({}, payload, { timerType: timerType });
    var row = [
      "LCT_" + (typeof Utilities !== "undefined" && Utilities.getUuid ? Utilities.getUuid().slice(0, 8) : "x") + "_" + Date.now(),
      true,
      String(wiId || "").trim(),
      String(prop || "").trim(),
      LIFECYCLE_EVENT_TYPE_,
      runAtDate,
      JSON.stringify(p),
      "LIFECYCLE:" + String(wiId) + ":" + timerType,
      "PENDING",
      0,
      "",
      new Date(),
      new Date()
    ];
    if (typeof withWriteLock_ === "function") {
      withWriteLock_("LIFECYCLE_WRITE_TIMER", function () { sh.appendRow(row); });
    } else {
      sh.appendRow(row);
    }
  } catch (e) {
    try { lifecycleLog_("LIFECYCLE_CRASH", prop || "", wiId || "", { phase: "writeTimer", error: String(e && e.message ? e.message : e) }); } catch (_) {}
  }
}

/**
 * Process due lifecycle timers. Mark FIRED under lock before emitting to prevent duplicate fire.
 */
function processLifecycleTimers_() {
  try {
    var sh = typeof getActiveSheetByNameCached_ === "function" ? getActiveSheetByNameCached_(LIFECYCLE_TIMERS_SHEET_) : null;
    if (!sh) return;
    var map = typeof getHeaderMap_ === "function" ? getHeaderMap_(sh) : {};
    var colWi = (map["WorkItemId"] || 3) - 1;
    var colProp = (map["Prop"] || 4) - 1;
    var colEvent = (map["EventType"] || 5) - 1;
    var colRunAt = (map["RunAt"] || 6) - 1;
    var colPayload = (map["PayloadJson"] || 7) - 1;
    var colEnabled = (map["Enabled"] || 2) - 1;
    var colStatus = (map["Status"] || 9) - 1;
    var colAttempts = (map["Attempts"] || 10) - 1;
    var colUpdatedAt = (map["UpdatedAt"] || 13) - 1;
    var now = new Date();
    var lastRow = sh.getLastRow();
    var numRows = lastRow - 1;
    if (numRows < 1) return;
    var numCols = sh.getLastColumn();
    var data = sh.getRange(2, 1, numRows, numCols).getValues();
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (String(r[colEvent] || "").trim() !== LIFECYCLE_EVENT_TYPE_) continue;
      if (r[colEnabled] === false || String(r[colEnabled]).toLowerCase() === "false") continue;
      if (String(r[colStatus] || "").trim().toUpperCase() !== "PENDING") continue;
      var runAt = r[colRunAt];
      if (!(runAt instanceof Date)) runAt = new Date(runAt);
      if (runAt.getTime() > now.getTime()) continue;
      var payload = {};
      try { payload = JSON.parse(String(r[colPayload] || "{}")); } catch (_) {}
      var wiId = String(r[colWi] || "").trim();
      var prop = String(r[colProp] || "").trim();
      var rowNum = i + 2;
      if (!lifecycleEnabled_(prop)) {
        try {
          lifecycleLog_("LIFECYCLE_DISABLED", prop, wiId, { timerRow: rowNum, timerType: (payload && payload.timerType) || "" });
          if (typeof withWriteLock_ === "function") {
            (function (r, cS, cU, t) {
              withWriteLock_("LIFECYCLE_TIMER_SKIP_DISABLED", function () {
                sh.getRange(r, cS).setValue("SKIPPED");
                if (cU >= 1) sh.getRange(r, cU).setValue(t);
              });
            })(rowNum, colStatus + 1, colUpdatedAt + 1, now);
          } else {
            sh.getRange(rowNum, colStatus + 1).setValue("SKIPPED");
          }
        } catch (_) {}
        continue;
      }
      // Dedupe first: mark FIRED under lock, then emit (freeze per-iteration values to avoid loop capture)
      var attemptsVal = Number(r[colAttempts] || 0) + 1;
      if (typeof withWriteLock_ === "function") {
        (function (r, cS, cA, cU, t, attempts) {
          withWriteLock_("LIFECYCLE_TIMER_MARK_FIRED", function () {
            sh.getRange(r, cS).setValue("FIRED");
            sh.getRange(r, cA).setValue(attempts);
            if (cU >= 1) sh.getRange(r, cU).setValue(t);
          });
        })(rowNum, colStatus + 1, colAttempts + 1, colUpdatedAt + 1, now, attemptsVal);
      } else {
        sh.getRange(rowNum, colStatus + 1).setValue("FIRED");
        sh.getRange(rowNum, colAttempts + 1).setValue(attemptsVal);
      }
      var signalResult = handleLifecycleSignal_({
        eventType: "TIMER_FIRE",
        wiId: wiId,
        propertyId: prop,
        timerType: payload.timerType || "",
        payload: payload,
        actorType: "TIMER",
        actorId: "LIFECYCLE_CRON",
        reasonCode: "TIMER_FIRED"
      });
      lifecycleLog_("TIMER_FIRED", prop, wiId, { timerType: payload.timerType || "", actorType: "TIMER", signalResult: signalResult });
    }
  } catch (e) {
    try { lifecycleLog_("LIFECYCLE_CRASH", "", "", { phase: "processLifecycleTimers", error: String(e && e.message ? e.message : e) }); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTOR — Extract actor metadata from signal for audit
// ─────────────────────────────────────────────────────────────────────────────

function getActorFacts_(signal) {
  if (!signal || typeof signal !== "object") return {};
  return {
    actorType: String(signal.actorType || "").trim() || undefined,
    actorId: String(signal.actorId || "").trim() || undefined,
    reasonCode: String(signal.reasonCode || "").trim() || undefined,
    rawText: signal.rawText != null ? String(signal.rawText).slice(0, 500) : undefined
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING — PolicyEventLog via policyLogEventRow_
// ─────────────────────────────────────────────────────────────────────────────

function lifecycleLog_(eventType, propCode, workItemId, facts) {
  try {
    if (typeof policyLogEventRow_ !== "function") return;
    policyLogEventRow_(
      eventType,
      String(propCode || ""),
      String(workItemId || ""),
      "",
      eventType,
      facts || {},
      {},
      "",
      "LIFECYCLE_ENGINE",
      ""
    );
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND INTENT — Build intent for Outgate (STAFF when staffId present, else TENANT by phone)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build outbound intent for lifecycle staff-facing messages. Uses STAFF when staffId present, else TENANT (phone).
 * @param {string} staffId - Resolved staff id or null
 * @param {string} phone - Staff phone (fallback recipientRef when staffId missing)
 * @param {string} intentType - intentType for Outgate
 * @param {string} templateKey - templateKey for renderer
 * @param {Object} vars - Template vars
 * @param {string} deliveryPolicy - REPLY_SAME_CHANNEL | DIRECT_SEND
 * @param {string} reasonCode - meta.reasonCode
 * @param {string} [replyChannel] - Inbound adapter channel to mirror for staff replies ("SMS"|"WA"|"TELEGRAM"). Outgate uses intent.channel for STAFF delivery.
 * @param {string} [telegramReplyChatId] - When staff inbound is Telegram, Bot API chat id to reply to (private chat usually equals user id).
 * @returns {Object} Intent for dispatchOutboundIntent_
 */
function lifecycleOutboundIntent_(staffId, phone, intentType, templateKey, vars, deliveryPolicy, reasonCode, replyChannel, telegramReplyChatId) {
  var isStaff = staffId && String(staffId).trim();
  var intent = {
    intentType: intentType,
    templateKey: templateKey,
    recipientType: isStaff ? "STAFF" : "TENANT",
    recipientRef: isStaff ? String(staffId).trim() : (phone || ""),
    vars: vars || {},
    deliveryPolicy: deliveryPolicy || "REPLY_SAME_CHANNEL",
    meta: { reasonCode: reasonCode || "", actorType: "SYSTEM", actorId: "", sourceModule: "LIFECYCLE_ENGINE" }
  };
  if (replyChannel != null && String(replyChannel).trim()) {
    var ch = String(replyChannel).trim().toUpperCase();
    if (ch === "WA" || ch === "TELEGRAM" || ch === "SMS") intent.channel = ch;
  }
  if (isStaff && telegramReplyChatId != null && String(telegramReplyChatId).trim()) {
    var ch2 = String(replyChannel || intent.channel || "").trim().toUpperCase();
    if (ch2 === "TELEGRAM") intent.telegramChatId = String(telegramReplyChatId).trim();
  }
  return intent;
}