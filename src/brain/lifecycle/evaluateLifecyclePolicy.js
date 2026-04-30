/**
 * GAS `evaluateLifecyclePolicy_` — `12_LIFECYCLE_ENGINE.gs`.
 * Missing policy keys → HOLD (matches GAS).
 */
const { lifecyclePolicyGet } = require("../../dal/lifecyclePolicyDal");

/** GAS `LIFECYCLE_TIMER_TYPES_` */
const LIFECYCLE_TIMER_TYPES = {
  PING_STAFF_UPDATE: true,
  PING_UNSCHEDULED: true,
  TIMER_ESCALATE: true,
  AUTO_CLOSE: true,
  SEND_TENANT_VERIFY: true,
};

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} facts — from buildLifecycleFacts
 * @param {object} signal
 * @param {string} eventType
 */
async function evaluateLifecyclePolicy(sb, facts, signal, eventType) {
  const prop = facts.propertyId || "GLOBAL";
  const et = String(eventType || "").trim().toUpperCase();

  if (et === "WI_CREATED_UNSCHEDULED") {
    const firstPingH = await lifecyclePolicyGet(
      sb,
      prop,
      "UNSCHEDULED_FIRST_PING_HOURS",
      null
    );
    if (
      firstPingH == null ||
      (typeof firstPingH === "number" && !isFinite(firstPingH))
    ) {
      return {
        decision: "HOLD",
        reason: "POLICY_KEY_MISSING",
        key: "UNSCHEDULED_FIRST_PING_HOURS",
      };
    }
    let fH = Number(firstPingH);
    if (!isFinite(fH)) fH = 24;
    const stateNow = facts.currentState
      ? String(facts.currentState).trim().toUpperCase()
      : "";
    if (stateNow && stateNow !== "UNSCHEDULED") {
      return {
        decision: "HOLD",
        reason: "WI_CREATED_UNSCHEDULED_BAD_STATE",
        stateNow,
      };
    }
    return {
      decision: "PROCEED",
      action: "ENTER_UNSCHEDULED",
      timerType: "PING_UNSCHEDULED",
      runAt: new Date(facts.now.getTime() + fH * 3600000),
    };
  }

  if (et === "SCHEDULE_SET") {
    const stateNow = facts.currentState ? String(facts.currentState).trim().toUpperCase() : "";
    const scheduleAllowedState =
      stateNow === "UNSCHEDULED" ||
      stateNow === "WAIT_STAFF_UPDATE" ||
      stateNow === "ACTIVE_WORK";
    if (!scheduleAllowedState) {
      return { decision: "HOLD", reason: "SCHEDULE_SET_BAD_STATE", stateNow };
    }
    if (
      !(facts.scheduledEndAt instanceof Date) ||
      !isFinite(facts.scheduledEndAt.getTime())
    ) {
      return { decision: "HOLD", reason: "SCHEDULE_SET_MISSING_SCHEDULE_END" };
    }
    const scheduleLabel =
      signal && signal.scheduleLabel != null
        ? String(signal.scheduleLabel || "").trim()
        : "";
    return {
      decision: "PROCEED",
      action: "APPLY_SCHEDULE_SET",
      scheduleLabel,
    };
  }

  if (et === "STAFF_UPDATE") {
    if (!facts.currentState) {
      return { decision: "HOLD", reason: "missing_wi_state_for_staff_update" };
    }
    const outcome = facts.outcome;
    if (!outcome) return { decision: "HOLD", reason: "missing_outcome" };

    let nextState = null;
    let timerType = null;
    let runAt = null;
    let tenantVerify = null;

    if (outcome === "COMPLETED") {
      tenantVerify = await lifecyclePolicyGet(sb, prop, "TENANT_VERIFY_REQUIRED", null);
      if (tenantVerify === null) {
        return { decision: "HOLD", reason: "POLICY_KEY_MISSING", key: "TENANT_VERIFY_REQUIRED" };
      }
      if (tenantVerify) {
        let tenantVerifyHours = await lifecyclePolicyGet(
          sb,
          prop,
          "TENANT_VERIFY_HOURS",
          null
        );
        if (
          tenantVerifyHours == null ||
          (typeof tenantVerifyHours === "number" && !isFinite(tenantVerifyHours))
        ) {
          return { decision: "HOLD", reason: "POLICY_KEY_MISSING", key: "TENANT_VERIFY_HOURS" };
        }
        let tvH = Number(tenantVerifyHours);
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
      const partsEtaAt =
        facts.partsEtaAt instanceof Date && isFinite(facts.partsEtaAt.getTime())
          ? facts.partsEtaAt
          : null;
      if (partsEtaAt) {
        const etaBufferHours = await lifecyclePolicyGet(
          sb,
          prop,
          "PARTS_ETA_BUFFER_HOURS",
          null
        );
        if (
          etaBufferHours == null ||
          (typeof etaBufferHours === "number" && !isFinite(etaBufferHours))
        ) {
          return { decision: "HOLD", reason: "POLICY_KEY_MISSING", key: "PARTS_ETA_BUFFER_HOURS" };
        }
        const bufH = Number(etaBufferHours);
        const buf = isFinite(bufH) ? bufH : 24;
        nextState = "WAIT_PARTS";
        timerType = "TIMER_ESCALATE";
        runAt = new Date(partsEtaAt.getTime() + buf * 3600000);
      } else {
        const partsMaxHours = await lifecyclePolicyGet(
          sb,
          prop,
          "PARTS_WAIT_MAX_HOURS",
          null
        );
        if (
          partsMaxHours == null ||
          (typeof partsMaxHours === "number" && !isFinite(partsMaxHours))
        ) {
          return { decision: "HOLD", reason: "POLICY_KEY_MISSING", key: "PARTS_WAIT_MAX_HOURS" };
        }
        let pMH = Number(partsMaxHours);
        if (!isFinite(pMH)) pMH = 72;
        nextState = "WAIT_PARTS";
        timerType = "TIMER_ESCALATE";
        runAt = new Date(facts.now.getTime() + pMH * 3600000);
      }
    } else if (outcome === "NEEDS_VENDOR") {
      nextState = "VENDOR_DISPATCH";
    } else if (outcome === "DELAYED") {
      const pingHours = await lifecyclePolicyGet(sb, prop, "STAFF_UPDATE_PING_HOURS", null);
      if (
        pingHours == null ||
        (typeof pingHours === "number" && !isFinite(pingHours))
      ) {
        return { decision: "HOLD", reason: "POLICY_KEY_MISSING", key: "STAFF_UPDATE_PING_HOURS" };
      }
      const pH = Number(pingHours);
      const ph = isFinite(pH) ? pH : 24;
      nextState = "WAIT_STAFF_UPDATE";
      timerType = "PING_STAFF_UPDATE";
      runAt = new Date(facts.now.getTime() + ph * 3600000);
    } else if (outcome === "ACCESS_ISSUE") {
      return {
        decision: "PROCEED",
        action: "LOG_ONLY",
        logEventType: "STAFF_ACCESS_ISSUE",
        logNote: "ACCESS_ISSUE",
      };
    } else {
      return { decision: "HOLD", reason: "unknown_outcome" };
    }

    if (tenantVerify === null) tenantVerify = false;
    return {
      decision: "PROCEED",
      action: "TRANSITION",
      nextState,
      timerType,
      runAt,
      tenantVerify: !!tenantVerify,
    };
  }

  if (et === "ACTIVE_WORK_ENTERED") {
    if (!facts.scheduledEndAt) {
      return { decision: "HOLD", reason: "LIFECYCLE_MISSING_SCHEDULE_END" };
    }
    const bufferHours = await lifecyclePolicyGet(sb, prop, "SCHEDULE_BUFFER_HOURS", null);
    if (
      bufferHours == null ||
      (typeof bufferHours === "number" && !isFinite(bufferHours))
    ) {
      return { decision: "HOLD", reason: "POLICY_KEY_MISSING", key: "SCHEDULE_BUFFER_HOURS" };
    }
    return {
      decision: "PROCEED",
      action: "WRITE_TIMER",
      timerType: "PING_STAFF_UPDATE",
      runAt: new Date(
        facts.scheduledEndAt.getTime() + Number(bufferHours) * 3600000
      ),
    };
  }

  if (et === "TIMER_FIRE") {
    const timerType = facts.timerType;
    if (!timerType || !LIFECYCLE_TIMER_TYPES[timerType]) {
      return { decision: "REJECT" };
    }
    if (!facts.currentState) {
      return {
        decision: "HOLD",
        reason: "missing_wi_state_for_timer_fire",
      };
    }

    if (timerType === "PING_STAFF_UPDATE") {
      const maxAttempts = await lifecyclePolicyGet(
        sb,
        prop,
        "STAFF_UPDATE_MAX_ATTEMPTS",
        null
      );
      if (maxAttempts == null) {
        return {
          decision: "HOLD",
          reason: "POLICY_KEY_MISSING",
          key: "STAFF_UPDATE_MAX_ATTEMPTS",
        };
      }
      let pingH = await lifecyclePolicyGet(
        sb,
        prop,
        "STAFF_UPDATE_PING_HOURS",
        null
      );
      if (
        pingH == null ||
        (typeof pingH === "number" && !isFinite(pingH))
      ) {
        return {
          decision: "HOLD",
          reason: "POLICY_KEY_MISSING",
          key: "STAFF_UPDATE_PING_HOURS",
        };
      }
      pingH = Number(pingH) || 24;
      const attempts =
        facts.timerPayload &&
        typeof facts.timerPayload.attempts === "number"
          ? facts.timerPayload.attempts
          : 0;
      if (attempts < Number(maxAttempts)) {
        return {
          decision: "PROCEED",
          action: "PING_AND_RESTART",
          nextState: "WAIT_STAFF_UPDATE",
          timerType: "PING_STAFF_UPDATE",
          attempts: attempts + 1,
          runAt: new Date(facts.now.getTime() + pingH * 3600000),
        };
      }
      return {
        decision: "PROCEED",
        action: "LOG_ESCALATE",
        logEventType: "STAFF_UPDATE_ESCALATED",
        logNote: "STAFF_UPDATE_MAX_ATTEMPTS",
      };
    }

    if (timerType === "TIMER_ESCALATE") {
      return {
        decision: "PROCEED",
        action: "LOG_ESCALATE",
        logEventType: "PARTS_ESCALATED",
        logNote: "PARTS_ESCALATE",
      };
    }

    if (timerType === "AUTO_CLOSE") {
      return {
        decision: "PROCEED",
        action: "TRANSITION",
        nextState: "DONE",
      };
    }

    if (timerType === "PING_UNSCHEDULED") {
      const maxAttU = await lifecyclePolicyGet(
        sb,
        prop,
        "UNSCHEDULED_MAX_ATTEMPTS",
        null
      );
      if (maxAttU == null) {
        return {
          decision: "HOLD",
          reason: "POLICY_KEY_MISSING",
          key: "UNSCHEDULED_MAX_ATTEMPTS",
        };
      }
      let repeatHU = await lifecyclePolicyGet(
        sb,
        prop,
        "UNSCHEDULED_REPEAT_PING_HOURS",
        null
      );
      if (
        repeatHU == null ||
        (typeof repeatHU === "number" && !isFinite(repeatHU))
      ) {
        return {
          decision: "HOLD",
          reason: "POLICY_KEY_MISSING",
          key: "UNSCHEDULED_REPEAT_PING_HOURS",
        };
      }
      repeatHU = Number(repeatHU) || 24;
      const attU =
        facts.timerPayload &&
        typeof facts.timerPayload.attempts === "number"
          ? facts.timerPayload.attempts
          : 0;
      if (attU < Number(maxAttU)) {
        return {
          decision: "PROCEED",
          action: "PING_AND_RESTART_UNSCHEDULED",
          nextState: "UNSCHEDULED",
          timerType: "PING_UNSCHEDULED",
          attempts: attU + 1,
          runAt: new Date(facts.now.getTime() + repeatHU * 3600000),
        };
      }
      return {
        decision: "PROCEED",
        action: "LOG_ESCALATE",
        logEventType: "UNSCHEDULED_ESCALATED",
        logNote: "UNSCHEDULED_MAX_ATTEMPTS_PHASE3B_PM_NOTIFY_PENDING",
      };
    }

    if (timerType === "SEND_TENANT_VERIFY") {
      const recipientPhone =
        facts.timerPayload &&
        facts.timerPayload.recipientPhone != null
          ? String(facts.timerPayload.recipientPhone).trim()
          : "";
      if (!recipientPhone) {
        return {
          decision: "HOLD",
          reason: "SEND_TENANT_VERIFY_missing_recipientPhone",
        };
      }
      return {
        decision: "PROCEED",
        action: "SEND_TENANT_VERIFY",
        recipientPhone,
      };
    }

    return { decision: "REJECT" };
  }

  if (et === "TENANT_REPLY") {
    if (facts.currentState !== "VERIFYING_RESOLUTION") {
      return { decision: "REJECT" };
    }
    const sentiment =
      signal && signal.positive !== undefined ? !!signal.positive : null;
    if (sentiment === true) {
      return {
        decision: "PROCEED",
        action: "TRANSITION",
        nextState: "DONE",
      };
    }
    if (sentiment === false) {
      let pingH = await lifecyclePolicyGet(
        sb,
        prop,
        "STAFF_UPDATE_PING_HOURS",
        null
      );
      if (
        pingH == null ||
        (typeof pingH === "number" && !isFinite(pingH))
      ) {
        return {
          decision: "HOLD",
          reason: "POLICY_KEY_MISSING",
          key: "STAFF_UPDATE_PING_HOURS",
        };
      }
      pingH = Number(pingH) || 24;
      return {
        decision: "PROCEED",
        action: "TRANSITION_AND_TIMER",
        nextState: "INHOUSE_WORK",
        timerType: "PING_STAFF_UPDATE",
        runAt: new Date(facts.now.getTime() + pingH * 3600000),
        sendStaffUpdateRequest: true,
      };
    }
    return {
      decision: "PROCEED",
      action: "LOG_ONLY",
      logEventType: "TENANT_REPLY_AMBIGUOUS",
      logNote: "ambiguous_sentiment",
    };
  }

  return { decision: "HOLD", reason: "unsupported_event", eventType: et };
}

module.exports = { evaluateLifecyclePolicy, LIFECYCLE_TIMER_TYPES };
