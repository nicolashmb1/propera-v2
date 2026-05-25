"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateHandoffPayload,
  isMetaIssueText,
  handoffRejectionPrompt,
} = require("../../src/adapters/tenantAgent/handoffContract");

test("handoffContract — rejects meta issue text", () => {
  assert.equal(isMetaIssueText("Request for clarification on a previous message."), true);
  assert.equal(isMetaIssueText("Kitchen sink is leaking"), false);

  const result = validateHandoffPayload({
    property: "PENN",
    unit: "410",
    issue: "Request for clarification on a previous message.",
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.rejectedFields, ["issue"]);
  assert.equal(result.cleanPayload.issue, undefined);
});

test("handoffContract — rejects unknown property code", () => {
  const known = new Set(["PENN"]);
  const result = validateHandoffPayload(
    { property: "FAKE", unit: "410", issue: "no heat" },
    { knownPropertyCodesUpper: known }
  );
  assert.equal(result.valid, false);
  assert.deepEqual(result.rejectedFields, ["property"]);
});

test("handoffContract — rejects ZIP-as-unit", () => {
  const result = validateHandoffPayload({
    property: "PENN",
    unit: "19104",
    issue: "no heat",
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.rejectedFields, ["unit"]);
});

test("handoffContract — clean payload strips underscore keys", () => {
  const result = validateHandoffPayload({
    property: "PENN",
    unit: "410",
    issue: "no heat",
    _awaiting: { type: "schedule_retry" },
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.cleanPayload, {
    property: "PENN",
    unit: "410",
    issue: "no heat",
  });
});

test("handoffContract — handoffRejectionPrompt maps fields", () => {
  assert.match(handoffRejectionPrompt("issue"), /maintenance issue/i);
  assert.match(handoffRejectionPrompt("property"), /property/i);
  assert.match(handoffRejectionPrompt("unit"), /unit/i);
});
