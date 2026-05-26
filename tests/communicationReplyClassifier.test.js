"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyReply,
  buildAutoResponse,
} = require("../src/communication/replyHandler");
const {
  mapTwilioRecipientStatus,
  shouldReplaceRecipientStatus,
} = require("../src/communication/deliveryTracker");

describe("communication reply classifier", () => {
  test("classifies STOP as OPT_OUT", () => {
    assert.equal(classifyReply("STOP"), "OPT_OUT");
  });

  test("classifies emergencies before general maintenance", () => {
    assert.equal(classifyReply("There is smoke coming from the outlet"), "EMERGENCY_SIGNAL");
  });

  test("classifies maintenance signal keywords", () => {
    assert.equal(classifyReply("There is a leak under the sink"), "MAINTENANCE_SIGNAL");
  });

  test("classifies questions", () => {
    assert.equal(classifyReply("When will this happen?"), "QUESTION");
  });

  test("buildAutoResponse redirects back to main number", () => {
    const text = buildAutoResponse("MAINTENANCE_SIGNAL");
    assert.match(text, /For maintenance or emergencies, call or text/i);
  });
});

describe("communication delivery tracker", () => {
  test("maps Twilio statuses to recipient statuses", () => {
    assert.equal(mapTwilioRecipientStatus("queued"), "SENT");
    assert.equal(mapTwilioRecipientStatus("sent"), "SENT");
    assert.equal(mapTwilioRecipientStatus("delivered"), "DELIVERED");
    assert.equal(mapTwilioRecipientStatus("undelivered"), "FAILED");
    assert.equal(mapTwilioRecipientStatus("failed"), "FAILED");
  });

  test("does not downgrade delivered rows back to sent", () => {
    assert.equal(shouldReplaceRecipientStatus("DELIVERED", "SENT"), false);
  });

  test("allows sent rows to advance to delivered or failed", () => {
    assert.equal(shouldReplaceRecipientStatus("SENT", "DELIVERED"), true);
    assert.equal(shouldReplaceRecipientStatus("SENT", "FAILED"), true);
  });
});
