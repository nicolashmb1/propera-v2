"use strict";

process.env.TZ = "UTC";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parsePreferredWindowShared,
} = require("../src/brain/gas/parsePreferredWindowShared");

/** Fixed "now" — Thu Apr 9, 2026 15:00 UTC (matches ledger / GAS-style tests). */
const ANCHOR = new Date(Date.UTC(2026, 3, 9, 15, 0, 0));

describe("parsePreferredWindowShared (GAS port)", () => {
  it("tomorrow morning → DAYPART, 9–12 local", () => {
    const p = parsePreferredWindowShared("tomorrow morning", null, {
      now: ANCHOR,
      timeZone: "UTC",
      scheduleLatestHour: 17,
    });
    assert.ok(p);
    assert.equal(p.kind, "DAYPART");
    assert.ok(p.start && p.end);
    assert.equal(p.start.getUTCHours(), 9);
    assert.equal(p.end.getUTCHours(), 12);
    assert.match(p.label, /Fri/i);
  });

  it("tomorrow 9-11am → RANGE", () => {
    const p = parsePreferredWindowShared("tomorrow 9-11am", null, {
      now: ANCHOR,
      timeZone: "UTC",
    });
    assert.ok(p);
    assert.equal(p.kind, "RANGE");
    assert.ok(p.start && p.end);
  });

  it("ANYTIME has null ends", () => {
    const p = parsePreferredWindowShared("Friday anytime", null, {
      now: ANCHOR,
      timeZone: "UTC",
    });
    assert.ok(p);
    assert.equal(p.kind, "ANYTIME");
    assert.equal(p.start, null);
    assert.equal(p.end, null);
  });

  it("empty → null", () => {
    assert.equal(parsePreferredWindowShared("", null, { timeZone: "UTC" }), null);
  });

  it("Intl timeZone must match Node TZ for morning labels (mismatch shows 1–4 PM)", () => {
    const prevTz = process.env.TZ;
    const prevP = process.env.PROPERA_TZ;
    process.env.TZ = "America/New_York";
    process.env.PROPERA_TZ = "";
    const now = new Date(2026, 3, 10, 12, 0, 0);
    const wrong = parsePreferredWindowShared("tomorrow morning", "Tomorrow", {
      now,
      timeZone: "UTC",
      scheduleLatestHour: 17,
    });
    assert.ok(wrong && wrong.kind === "DAYPART");
    assert.match(String(wrong.label), /1:\d\d\s*PM/i, "UTC Intl on Eastern instants mimics the bad tenant copy");

    const right = parsePreferredWindowShared("tomorrow morning", "Tomorrow", {
      now,
      timeZone: "America/New_York",
      scheduleLatestHour: 17,
    });
    assert.match(String(right.label), /9:\d\d\s*AM/i);
    process.env.TZ = prevTz;
    process.env.PROPERA_TZ = prevP;
  });
});
