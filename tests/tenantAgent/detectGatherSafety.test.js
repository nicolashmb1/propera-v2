"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mergeGatherSafety,
  normalizeLlmSafetyAssessment,
  llmReplyAsksForSchedule,
} = require("../../src/adapters/tenantAgent/detectGatherSafety");
const { completenessCheck } = require("../../src/adapters/tenantAgent/completeness");
const { buildSafetyGatherReply } = require("../../src/adapters/tenantAgent/gatherSafetyReply");
const {
  buildHandoffRouterParameterFromAgent,
} = require("../../src/adapters/tenantAgent/buildHandoffRouterParameter");
const { resolveGatherReply } = require("../../src/adapters/tenantAgent/resolveGatherReply");
const { shapeBrainReplyForTenantAgent } = require("../../src/adapters/tenantAgent/shapeBrainReply");

const GAS_LLM_SAFETY = {
  is_emergency: true,
  emergency_type: "GAS",
  skip_scheduling: true,
  requires_immediate_instructions: true,
};

test("normalizeLlmSafetyAssessment — smoke detector beeping is not emergency", () => {
  const s = normalizeLlmSafetyAssessment({
    is_emergency: false,
    emergency_type: "",
  });
  assert.equal(s.isEmergency, false);
});

test("normalizeLlmSafetyAssessment — sewage is emergency tier", () => {
  const s = normalizeLlmSafetyAssessment({
    is_emergency: true,
    emergency_type: "SEWAGE",
    skip_scheduling: true,
  });
  assert.equal(s.receiptTier, "emergency");
});

test("normalizeLlmSafetyAssessment — no heat is emergency tier", () => {
  const s = normalizeLlmSafetyAssessment({
    is_emergency: true,
    emergency_type: "NO_HEAT",
    skip_scheduling: true,
  });
  assert.equal(s.receiptTier, "emergency");
});
test("normalizeLlmSafetyAssessment — gas smell is emergency", () => {
  const s = normalizeLlmSafetyAssessment(GAS_LLM_SAFETY);
  assert.equal(s.isEmergency, true);
  assert.equal(s.emergencyType, "GAS");
  assert.equal(s.skipScheduling, true);
  assert.equal(s.receiptTier, "emergency");
});

test("mergeGatherSafety — LLM emergency clears preferredWindow", () => {
  const next = mergeGatherSafety(
    { issue: "gas smell at stove", preferredWindow: "tomorrow morning" },
    "",
    GAS_LLM_SAFETY
  );
  assert.equal(next._safety.isEmergency, true);
  assert.equal(next.preferredWindow, undefined);
});

test("mergeGatherSafety — keyword text alone does not trigger emergency", () => {
  const next = mergeGatherSafety(
    { issue: "smoke detector beeping" },
    "smoke detector beeping every 30 seconds",
    undefined
  );
  assert.equal(next._safety, undefined);
});

test("mergeGatherSafety — tenant correction clears prior emergency", () => {
  const next = mergeGatherSafety(
    {
      issue: "smoke detector battery",
      _safety: { isEmergency: true, emergencyType: "SMOKE", skipScheduling: true },
      _safety_ack_sent: true,
    },
    "this is not a fire situation its a battery that needs to replace",
    { is_emergency: false }
  );
  assert.equal(next._safety, undefined);
  assert.equal(next._safety_ack_sent, undefined);
});

test("completenessCheck — safety issue ready without schedule", () => {
  const known = new Set(["PENN"]);
  assert.deepEqual(
    completenessCheck(
      {
        property: "PENN",
        unit: "502",
        issue: "potential gas smell when using stove",
        _safety: { isEmergency: true, skipScheduling: true },
      },
      known
    ),
    { ready: true, missing: null }
  );
});

test("buildSafetyGatherReply — property ask includes gas instructions", () => {
  const reply = buildSafetyGatherReply(
    "property",
    { _safety: { isEmergency: true, emergencyType: "GAS" } },
    [{ code: "PENN", display_name_short: "Penn" }]
  );
  assert.match(reply, /don't use the stove/i);
  assert.match(reply, /911/);
  assert.match(reply, /Which building/i);
});

test("resolveGatherReply — blocks LLM schedule ask under safety", () => {
  const reply = resolveGatherReply({
    llmGatherReply: "Is there a preferred time for maintenance to visit?",
    complete: { ready: false, missing: "unit" },
    partial: {
      property: "PENN",
      issue: "gas smell",
      _safety: { isEmergency: true, emergencyType: "GAS", skipScheduling: true },
    },
    propertiesList: [{ code: "PENN" }],
    bodyText: "502",
  });
  assert.doesNotMatch(reply, /preferred time/i);
  assert.match(reply, /unit/i);
});

test("buildHandoffRouterParameterFromAgent — safety marks emergency on payload", () => {
  const rp = buildHandoffRouterParameterFromAgent({
    partialPackage: {
      property: "PENN",
      unit: "502",
      issue: "potential gas smell when using the stove",
      _safety: {
        isEmergency: true,
        emergencyType: "GAS",
        skipScheduling: true,
      },
    },
    tenantActorKey: "+15551234001",
    transportChannel: "telegram",
    conversationId: "conv-1",
    traceId: "trace-1",
  });
  const payload = JSON.parse(rp._portalPayloadJson);
  assert.equal(payload.emergency, "Yes");
  assert.equal(payload.emergency_type, "GAS");
  assert.equal(payload.urgency, "URGENT");
  assert.equal(payload.preferredWindow, "");
});

test("shapeBrainReply — gas uses emergency receipt not shortly", () => {
  const shaped = shapeBrainReplyForTenantAgent({
    brain: "core_finalized",
    replyText: "Ref #PENN-1 — routine\nWe'll be in touch shortly.",
    draft: {
      propertyCode: "PENN",
      unitLabel: "502",
      issueText: "potential gas smell when using the stove",
      portalLocationKind: "unit",
    },
    finalize: { ticketId: "PENN-052426-4005" },
    outgate: { templateKey: "MAINTENANCE_RECEIPT_ROUTINE", emergency: false },
  });
  assert.match(shaped, /treating this as an emergency/i);
  assert.match(shaped, /911/);
  assert.doesNotMatch(shaped, /We'll be in touch shortly/i);
});

test("llmReplyAsksForSchedule", () => {
  assert.equal(
    llmReplyAsksForSchedule("Is there a preferred time for maintenance to visit?"),
    true
  );
});
