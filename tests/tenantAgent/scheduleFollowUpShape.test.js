"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  bodyHasTimeWindowShape,
  isScheduleFollowUpContent,
} = require("../../src/adapters/tenantAgent/scheduleFollowUpShape");
const { leadingUnitFromBody } = require("../../src/adapters/tenantAgent/mergePartialFromInbound");

test("bodyHasTimeWindowShape — 9-10 brow is a time range not a unit", () => {
  assert.equal(bodyHasTimeWindowShape("9-10 brow tomorrow morning"), true);
  assert.equal(leadingUnitFromBody("9-10 brow tomorrow morning"), "");
});

test("isScheduleFollowUpContent — time-only follow-up", () => {
  assert.equal(isScheduleFollowUpContent("9-10 brow tomorrow morning"), true);
  assert.equal(isScheduleFollowUpContent("tomorrow morning 8-10am"), true);
});

test("isScheduleFollowUpContent — new issue is not schedule-only", () => {
  assert.equal(
    isScheduleFollowUpContent("New issue my bedroom door is broken"),
    false
  );
});
