/**
 * Explicit inbound route graph — GAS `handleInboundRouter_` / orchestrator slice (Phase 20-A).
 * Pure decision helpers only; I/O (DB, core, staff, outgate) stays in `runInboundPipeline.js`.
 */

const { decideLane } = require("../brain/router/decideLane");

/**
 * TCPA-style compliance applies only on SMS transport (`transportCompliance.complianceSmsOnly`).
 * @param {boolean} smsCompliance
 * @param {{ compliance?: string | null }} precursor
 * @returns {string | null}
 */
function getEffectiveCompliance(smsCompliance, precursor) {
  return smsCompliance ? precursor.compliance : null;
}

/**
 * Lane: staff # capture, staff operational gate, or `decideLane(inbound)`.
 * @param {{ outcome: string, staffCapture?: object }} precursor
 * @param {object} inbound — normalized inbound event
 * @returns {{ lane: string, reason: string, mode: string, trace: string }}
 */
function buildLaneDecision(precursor, inbound) {
  if (precursor.outcome === "STAFF_CAPTURE_HASH") {
    return {
      lane: "staffCapture",
      reason: "hash_prefix",
      mode: "MANAGER",
      trace: "lane_v1",
    };
  }
  if (precursor.outcome === "STAFF_LIFECYCLE_GATE") {
    return {
      lane: "staffOperational",
      reason: "staff_intercept_before_lane",
      mode: "STAFF",
      trace: "lane_v1",
    };
  }
  return decideLane(inbound);
}

/**
 * Whether to run `handleStaffLifecycleCommand` (staff row must exist).
 */
function shouldInvokeStaffLifecycle(precursor, staffContext) {
  return precursor.outcome === "STAFF_LIFECYCLE_GATE" && !!staffContext.staff;
}

/**
 * Preconditions for SMS STOP/START/HELP handling (side effects in pipeline).
 */
function shouldRunSmsComplianceBranch(smsCompliance, staffRun, precursor, actorFrom) {
  return !!(smsCompliance && !staffRun && precursor.compliance && actorFrom);
}

/**
 * Preconditions for opted-out SMS suppress check (`isSmsOptedOut`).
 */
function shouldEvaluateSmsSuppress(o) {
  const {
    smsCompliance,
    staffRun,
    complianceRun,
    precursor,
    actorFrom,
  } = o || {};
  return (
    !!smsCompliance &&
    !staffRun &&
    !complianceRun &&
    precursor &&
    precursor.outcome === "PRECURSOR_EVALUATED" &&
    !precursor.tenantCommand &&
    !!actorFrom
  );
}

/**
 * Maintenance core (`handleInboundCore`) is only valid for tenant/manager-style lanes.
 * Vendor / system lanes get a stub reply (Phase 20-C) — do not open maintenance intake.
 * @param {{ lane?: string }} laneDecision — from `buildLaneDecision`
 * @returns {boolean}
 */
function laneAllowsMaintenanceCore(laneDecision) {
  const lane = laneDecision && String(laneDecision.lane || "");
  if (lane === "staffCapture") return true;
  if (lane === "tenantLane") return true;
  if (lane === "managerLane") return true;
  return false;
}

/**
 * When `decideLane` yields vendor/system, return a deterministic stub (no core).
 * @param {string} lane
 * @returns {{ brain: string, replyText: string } | null}
 */
function buildNonMaintenanceLaneStub(lane) {
  const L = String(lane || "");
  if (L === "vendorLane") {
    return {
      brain: "lane_stub_vendor",
      replyText:
        "Vendor routing is not available on this Propera endpoint yet. For maintenance, use the tenant line or contact your property team.",
    };
  }
  if (L === "systemLane") {
    return {
      brain: "lane_stub_system",
      replyText:
        "System/automated messages are not handled on this endpoint in V2 yet.",
    };
  }
  return null;
}

/**
 * Whether maintenance core may run (`handleInboundCore`).
 * @param {object} o
 * @param {{ lane?: string }} o.laneDecision
 * @param {boolean} o.coreEnabledFlag — `coreEnabled()`
 * @param {boolean} o.dbConfigured — `isDbConfigured()`
 * @param {object | null} o.staffRun
 * @param {object | null} o.complianceRun
 * @param {object | null} o.suppressedRun
 * @param {string | null | undefined} o.effectiveCompliance — blocks core when truthy (SMS keyword matched)
 * @param {{ outcome: string, tenantCommand?: string | null }} o.precursor
 */
function computeCanEnterCore(o) {
  const {
    laneDecision,
    coreEnabledFlag,
    dbConfigured,
    staffRun,
    complianceRun,
    suppressedRun,
    effectiveCompliance,
    precursor,
  } = o;
  if (!laneAllowsMaintenanceCore(laneDecision)) return false;
  return (
    !!coreEnabledFlag &&
    !!dbConfigured &&
    !staffRun &&
    !complianceRun &&
    !suppressedRun &&
    !effectiveCompliance &&
    !precursor.tenantCommand &&
    (precursor.outcome === "STAFF_CAPTURE_HASH" ||
      precursor.outcome === "PRECURSOR_EVALUATED")
  );
}

/**
 * `precursor.outcome === "STAFF_CAPTURE_HASH"` → MANAGER strip mode for core body.
 */
function isStaffCaptureHash(precursor) {
  return precursor.outcome === "STAFF_CAPTURE_HASH";
}

/**
 * Default `brain` string when no handler returned a brain (matches legacy pipeline).
 */
function resolveDefaultBrain(o) {
  const {
    staffRun,
    complianceRun,
    suppressedRun,
    stubRun,
    coreRun,
    precursor,
    staffContext,
  } = o || {};
  if (staffRun && staffRun.brain) return staffRun.brain;
  if (complianceRun && complianceRun.brain) return complianceRun.brain;
  if (suppressedRun && suppressedRun.brain) return suppressedRun.brain;
  if (stubRun && stubRun.brain) return stubRun.brain;
  if (coreRun && coreRun.brain) return coreRun.brain;
  if (precursor.outcome === "STAFF_CAPTURE_HASH") return "staff_capture_pending_core";
  if (precursor.outcome === "STAFF_LIFECYCLE_GATE") {
    return staffContext.staff ? "staff_gate_no_handler" : "staff_gate_missing_staff_row";
  }
  return "tenant_path";
}

/**
 * Precursor evaluated + non-maintenance lane + no higher-priority branch → show lane stub.
 */
function shouldShowNonMaintenanceLaneStub(o) {
  const { precursor, laneDecision, staffRun, complianceRun, suppressedRun } = o || {};
  if (!precursor || precursor.outcome !== "PRECURSOR_EVALUATED") return false;
  if (laneAllowsMaintenanceCore(laneDecision || {})) return false;
  if (staffRun || complianceRun || suppressedRun) return false;
  return true;
}

module.exports = {
  getEffectiveCompliance,
  buildLaneDecision,
  laneAllowsMaintenanceCore,
  buildNonMaintenanceLaneStub,
  shouldShowNonMaintenanceLaneStub,
  shouldInvokeStaffLifecycle,
  shouldRunSmsComplianceBranch,
  shouldEvaluateSmsSuppress,
  computeCanEnterCore,
  isStaffCaptureHash,
  resolveDefaultBrain,
};
