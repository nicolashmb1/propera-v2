"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mergePartialFromLlm,
  isValidTenantAgentLlmTurnJson,
  normalizeTenantAgentLlmTurn,
} = require("../../src/adapters/tenantAgent/mergePartialFromLlm");

test("mergePartialFromLlm — only accepts known property codes", () => {
  const known = new Set(["PENN"]);
  const next = mergePartialFromLlm(
    { issue: "heat out" },
    { property: "FAKE", unit: "410", issue: "no heat" },
    known
  );
  assert.equal(next.property, undefined);
  assert.equal(next.unit, "410");
  assert.equal(next.issue, "no heat");
});

test("mergePartialFromLlm — common_area clears unit", () => {
  const known = new Set(["PENN"]);
  const next = mergePartialFromLlm(
    { property: "PENN", unit: "410" },
    { location_kind: "common_area", location_label_snapshot: "lobby" },
    known
  );
  assert.equal(next.location_kind, "common_area");
  assert.equal(next.unit, "");
  assert.equal(next.location_label_snapshot, "lobby");
});

test("isValidTenantAgentLlmTurnJson — requires reply string", () => {
  assert.equal(isValidTenantAgentLlmTurnJson(null), false);
  assert.equal(isValidTenantAgentLlmTurnJson({ reply: "" }), false);
  assert.equal(
    isValidTenantAgentLlmTurnJson({ reply: "Which building?", partial_updates: {} }),
    true
  );
});

test("normalizeTenantAgentLlmTurn — reads handoff_ready", () => {
  const n = normalizeTenantAgentLlmTurn({
    reply: "Got it.",
    partial_updates: { issue: "leak", tenant_locale: "es" },
    handoff_ready: true,
  });
  assert.equal(n.reply, "Got it.");
  assert.equal(n.partialUpdates.issue, "leak");
  assert.equal(n.handoffReady, true);
  assert.equal(n.tenantLocale, "es");
});
