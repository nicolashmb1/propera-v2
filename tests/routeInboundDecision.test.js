"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getEffectiveCompliance,
  computeCanEnterCore,
  laneAllowsMaintenanceCore,
  buildNonMaintenanceLaneStub,
  shouldShowNonMaintenanceLaneStub,
  shouldEvaluateSmsSuppress,
  shouldRunSmsComplianceBranch,
  resolveDefaultBrain,
  isStaffCaptureHash,
} = require("../src/inbound/routeInboundDecision");

test("getEffectiveCompliance is SMS-only", () => {
  assert.equal(
    getEffectiveCompliance(true, { compliance: "STOP" }),
    "STOP"
  );
  assert.equal(
    getEffectiveCompliance(false, { compliance: "STOP" }),
    null
  );
});

const tenantLane = { lane: "tenantLane", reason: "default", mode: "TENANT", trace: "lane_v1" };

test("laneAllowsMaintenanceCore", () => {
  assert.equal(laneAllowsMaintenanceCore({ lane: "tenantLane" }), true);
  assert.equal(laneAllowsMaintenanceCore({ lane: "managerLane" }), true);
  assert.equal(laneAllowsMaintenanceCore({ lane: "staffCapture" }), true);
  assert.equal(laneAllowsMaintenanceCore({ lane: "vendorLane" }), false);
  assert.equal(laneAllowsMaintenanceCore({ lane: "systemLane" }), false);
});

test("buildNonMaintenanceLaneStub", () => {
  assert.ok(String(buildNonMaintenanceLaneStub("vendorLane").replyText).includes("Vendor"));
  assert.ok(String(buildNonMaintenanceLaneStub("systemLane").replyText).length > 10);
  assert.equal(buildNonMaintenanceLaneStub("tenantLane"), null);
});

test("computeCanEnterCore — happy path tenant", () => {
  const precursor = { outcome: "PRECURSOR_EVALUATED", tenantCommand: null };
  assert.equal(
    computeCanEnterCore({
      laneDecision: tenantLane,
      coreEnabledFlag: true,
      dbConfigured: true,
      staffRun: null,
      complianceRun: null,
      suppressedRun: null,
      effectiveCompliance: null,
      precursor,
      transportChannel: "sms",
      staffContext: { isStaff: false },
    }),
    true
  );
});

test("computeCanEnterCore — staff never enters tenant maintenance core", () => {
  const precursor = { outcome: "PRECURSOR_EVALUATED", tenantCommand: null };
  assert.equal(
    computeCanEnterCore({
      laneDecision: tenantLane,
      coreEnabledFlag: true,
      dbConfigured: true,
      staffRun: null,
      complianceRun: null,
      suppressedRun: null,
      effectiveCompliance: null,
      precursor,
      transportChannel: "telegram",
      staffContext: { isStaff: true },
    }),
    false
  );
});

test("computeCanEnterCore — portal skips maintenance core (no LLM) except # staff capture", () => {
  const staffCaptureLane = {
    lane: "staffCapture",
    reason: "hash_prefix",
    mode: "MANAGER",
    trace: "lane_v1",
  };
  assert.equal(
    computeCanEnterCore({
      laneDecision: staffCaptureLane,
      coreEnabledFlag: true,
      dbConfigured: true,
      staffRun: null,
      complianceRun: null,
      suppressedRun: null,
      effectiveCompliance: null,
      precursor: {
        outcome: "STAFF_CAPTURE_HASH",
        staffCapture: { stripped: "penn 303 leak" },
        tenantCommand: null,
      },
      transportChannel: "portal",
      staffContext: { isStaff: true },
    }),
    true
  );
  assert.equal(
    computeCanEnterCore({
      laneDecision: tenantLane,
      coreEnabledFlag: true,
      dbConfigured: true,
      staffRun: null,
      complianceRun: null,
      suppressedRun: null,
      effectiveCompliance: null,
      precursor: { outcome: "PRECURSOR_EVALUATED", tenantCommand: null },
      transportChannel: "portal",
      staffContext: { isStaff: false },
    }),
    false
  );
});

test("computeCanEnterCore — blocked by compliance keyword on SMS", () => {
  const precursor = { outcome: "PRECURSOR_EVALUATED", tenantCommand: null };
  assert.equal(
    computeCanEnterCore({
      laneDecision: tenantLane,
      coreEnabledFlag: true,
      dbConfigured: true,
      staffRun: null,
      complianceRun: null,
      suppressedRun: null,
      effectiveCompliance: "STOP",
      precursor,
      staffContext: { isStaff: false },
    }),
    false
  );
});

test("computeCanEnterCore — staff lifecycle ran", () => {
  const precursor = { outcome: "PRECURSOR_EVALUATED", tenantCommand: null };
  assert.equal(
    computeCanEnterCore({
      laneDecision: tenantLane,
      coreEnabledFlag: true,
      dbConfigured: true,
      staffRun: { brain: "x" },
      complianceRun: null,
      suppressedRun: null,
      effectiveCompliance: null,
      precursor,
      staffContext: { isStaff: false },
    }),
    false
  );
});

test("computeCanEnterCore — blocked on vendor lane (20-C)", () => {
  const precursor = { outcome: "PRECURSOR_EVALUATED", tenantCommand: null };
  assert.equal(
    computeCanEnterCore({
      laneDecision: { lane: "vendorLane", reason: "isVendor_", mode: "VENDOR", trace: "lane_v1" },
      coreEnabledFlag: true,
      dbConfigured: true,
      staffRun: null,
      complianceRun: null,
      suppressedRun: null,
      effectiveCompliance: null,
      precursor,
      staffContext: { isStaff: false },
    }),
    false
  );
});

test("shouldShowNonMaintenanceLaneStub", () => {
  assert.equal(
    shouldShowNonMaintenanceLaneStub({
      precursor: { outcome: "PRECURSOR_EVALUATED" },
      laneDecision: { lane: "vendorLane" },
      staffRun: null,
      complianceRun: null,
      suppressedRun: null,
    }),
    true
  );
  assert.equal(
    shouldShowNonMaintenanceLaneStub({
      precursor: { outcome: "PRECURSOR_EVALUATED" },
      laneDecision: { lane: "tenantLane" },
      staffRun: null,
      complianceRun: null,
      suppressedRun: null,
    }),
    false
  );
});

test("shouldEvaluateSmsSuppress", () => {
  assert.equal(
    shouldEvaluateSmsSuppress({
      smsCompliance: true,
      staffRun: null,
      complianceRun: null,
      precursor: { outcome: "PRECURSOR_EVALUATED", tenantCommand: null },
      actorFrom: "+1",
    }),
    true
  );
  assert.equal(
    shouldEvaluateSmsSuppress({
      smsCompliance: true,
      staffRun: null,
      complianceRun: null,
      precursor: { outcome: "STAFF_LIFECYCLE_GATE", tenantCommand: null },
      actorFrom: "+1",
    }),
    false
  );
});

test("shouldRunSmsComplianceBranch", () => {
  assert.equal(
    shouldRunSmsComplianceBranch(true, null, { compliance: "STOP" }, "+1"),
    true
  );
  assert.equal(
    shouldRunSmsComplianceBranch(true, { brain: "s" }, { compliance: "STOP" }, "+1"),
    false
  );
});

test("resolveDefaultBrain fallbacks", () => {
  assert.equal(
    resolveDefaultBrain({
      staffRun: null,
      complianceRun: null,
      suppressedRun: null,
      stubRun: { brain: "lane_stub_vendor", replyText: "x" },
      coreRun: null,
      precursor: { outcome: "PRECURSOR_EVALUATED" },
      staffContext: {},
    }),
    "lane_stub_vendor"
  );
  assert.equal(
    resolveDefaultBrain({
      staffRun: null,
      complianceRun: null,
      suppressedRun: null,
      stubRun: null,
      coreRun: null,
      precursor: { outcome: "PRECURSOR_EVALUATED" },
      staffContext: {},
    }),
    "tenant_path"
  );
  assert.equal(
    resolveDefaultBrain({
      staffRun: null,
      complianceRun: null,
      suppressedRun: null,
      coreRun: null,
      precursor: { outcome: "STAFF_CAPTURE_HASH" },
      staffContext: {},
    }),
    "staff_capture_pending_core"
  );
});

test("isStaffCaptureHash", () => {
  assert.equal(isStaffCaptureHash({ outcome: "STAFF_CAPTURE_HASH" }), true);
  assert.equal(isStaffCaptureHash({ outcome: "PRECURSOR_EVALUATED" }), false);
});
