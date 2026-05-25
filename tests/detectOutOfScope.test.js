"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectOutOfScopeIntent,
} = require("../src/brain/router/detectOutOfScope");
const {
  schedulePolicyRejectMessage,
} = require("../src/dal/ticketPreferredWindow");

describe("detectOutOfScopeIntent", () => {
  it("invoice request — billing deflect", () => {
    const oos = detectOutOfScopeIntent("can i get a copy of my invoice?");
    assert.ok(oos);
    assert.match(oos.deflectMessage, /billing or invoices/i);
  });

  it("gym hours — amenity deflect", () => {
    const oos = detectOutOfScopeIntent("hi what time is the gym open until?");
    assert.ok(oos);
    assert.match(oos.deflectMessage, /amenity hours/i);
  });

  it("sink leak — in scope (null)", () => {
    assert.equal(detectOutOfScopeIntent("502 sink is leaking"), null);
  });
});

describe("schedulePolicyRejectMessage", () => {
  it("weekend reject includes policy hours from vars", () => {
    const msg = schedulePolicyRejectMessage("SCHED_REJECT_WEEKEND", {
      earliestHour: 8,
      latestHour: 17,
      allowWeekends: false,
      schedSatAllowed: true,
      schedSunAllowed: false,
      schedSatLatestHour: 13,
    });
    assert.match(msg, /Monday–Friday 8am–5pm/i);
    assert.match(msg, /Saturday 8am–1pm/i);
    assert.match(msg, /within those hours/i);
  });
});
