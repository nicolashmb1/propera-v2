"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  readPostCreateScheduleMode,
  shouldSkipScheduleAfterStructuredCreate,
  SCHEDULE_MODE_ASK_OPTIONAL,
  SCHEDULE_MODE_NONE,
} = require("../src/contracts/postCreateContract");

test("readPostCreateScheduleMode — ASK_OPTIONAL from payload", () => {
  const rp = {
    _portalPayloadJson: JSON.stringify({
      postCreate: { scheduleMode: "ASK_OPTIONAL" },
    }),
  };
  assert.equal(readPostCreateScheduleMode(rp), SCHEDULE_MODE_ASK_OPTIONAL);
});

test("readPostCreateScheduleMode — defaults NONE", () => {
  assert.equal(readPostCreateScheduleMode({ _portalPayloadJson: "{}" }), SCHEDULE_MODE_NONE);
});

test("shouldSkipScheduleAfterStructuredCreate — PM NONE skips", () => {
  const rp = {
    _portalPayloadJson: JSON.stringify({ postCreate: { scheduleMode: "NONE" } }),
  };
  assert.equal(shouldSkipScheduleAfterStructuredCreate(true, rp), true);
});

test("shouldSkipScheduleAfterStructuredCreate — agent ASK_OPTIONAL does not skip", () => {
  const rp = {
    _portalPayloadJson: JSON.stringify({
      postCreate: { scheduleMode: "ASK_OPTIONAL" },
    }),
  };
  assert.equal(shouldSkipScheduleAfterStructuredCreate(true, rp), false);
});
