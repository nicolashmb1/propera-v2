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

  test("buildAutoResponse tells repliers the inbox is not monitored and points to the office", () => {
    const text = buildAutoResponse("MAINTENANCE_SIGNAL", {
      brandName: "The Grand",
      officeNumber: "(908) 555-0100",
    });
    assert.match(text, /not monitored/i);
    assert.match(text, /The Grand/);
    assert.match(text, /\(908\) 555-0100/);
  });

  test("buildAutoResponse confirms opt-out for STOP", () => {
    const text = buildAutoResponse("OPT_OUT", {
      brandName: "The Grand",
      officeNumber: "(908) 555-0100",
    });
    assert.match(text, /unsubscribed/i);
    assert.match(text, /The Grand/);
    assert.match(text, /\(908\) 555-0100/);
  });

  test("buildAutoResponse falls back to generic office copy without brand or number", () => {
    const text = buildAutoResponse("QUESTION", { brandName: "", officeNumber: "" });
    assert.match(text, /not monitored/i);
    assert.match(text, /building management office/i);
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
