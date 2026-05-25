"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { resolveGatherReply, FALSE_HANDOFF_RE } = require("../../src/adapters/tenantAgent/resolveGatherReply");
const {
  shouldApplyMaintenanceOnlyGate,
} = require("../../src/adapters/tenantAgent/handleNonMaintenanceDeflect");

describe("resolveGatherReply", () => {
  test("missing property — deterministic, not LLM fake handoff", () => {
    const reply = resolveGatherReply({
      llmGatherReply:
        "Thank you! I'll pass this along for maintenance. They'll be in touch soon.",
      complete: { ready: false, missing: "property" },
      partial: { unit: "502", issue: "front door not locking" },
    });
    assert.match(reply, /building/i);
    assert.doesNotMatch(reply, /pass this along/i);
  });

  test("FALSE_HANDOFF_RE catches pass-along language", () => {
    assert.equal(FALSE_HANDOFF_RE.test("I'll pass this along for maintenance"), true);
  });
});

describe("shouldApplyMaintenanceOnlyGate", () => {
  test("skips when issue already gathered", () => {
    assert.equal(
      shouldApplyMaintenanceOnlyGate({
        conv: { status: "gathering", partial_package: { issue: "heat out" } },
        bodyText: "need lease copy",
        partial: { issue: "heat out" },
      }),
      false
    );
  });
});
