const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

describe("accessBroadcastSms", () => {
  const prevFrom = process.env.TWILIO_BROADCAST_FROM;

  before(() => {
    process.env.TWILIO_BROADCAST_FROM = "+15551234567";
  });

  after(() => {
    if (prevFrom === undefined) delete process.env.TWILIO_BROADCAST_FROM;
    else process.env.TWILIO_BROADCAST_FROM = prevFrom;
  });

  it("uses communication engine broadcast from number", () => {
    const { accessBroadcastSmsFrom } = require("../../src/access/accessBroadcastSms");
    assert.equal(accessBroadcastSmsFrom(), "+15551234567");
  });
});
