/**
 * Characterization tests for draft helper extraction from handleInboundCore.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  draftFlagsFromSlots,
  computePendingExpiresAtIso,
  issueTextForFinalize,
} = require("../src/brain/core/handleInboundCoreDraftHelpers");

describe("handleInboundCoreDraftHelpers", () => {
  describe("draftFlagsFromSlots", () => {
    test("issue needs length >= 2 unless buffer has a line", () => {
      assert.deepEqual(
        draftFlagsFromSlots({
          draft_issue: "a",
          draft_issue_buf_json: [],
          draft_property: "",
          draft_unit: "",
          draft_schedule_raw: "",
        }),
        { hasIssue: false, hasProperty: false, hasUnit: false, hasSchedule: false }
      );
      assert.deepEqual(
        draftFlagsFromSlots({
          draft_issue: "ab",
          draft_issue_buf_json: [],
          draft_property: "",
          draft_unit: "",
          draft_schedule_raw: "",
        }),
        { hasIssue: true, hasProperty: false, hasUnit: false, hasSchedule: false }
      );
      assert.deepEqual(
        draftFlagsFromSlots({
          draft_issue: "",
          draft_issue_buf_json: ["line"],
          draft_property: "",
          draft_unit: "",
          draft_schedule_raw: "",
        }),
        { hasIssue: true, hasProperty: false, hasUnit: false, hasSchedule: false }
      );
    });

    test("property, unit, schedule flags", () => {
      assert.deepEqual(
        draftFlagsFromSlots({
          draft_issue: "ok",
          draft_property: "PENN",
          draft_unit: "4B",
          draft_schedule_raw: "monday",
        }),
        { hasIssue: true, hasProperty: true, hasUnit: true, hasSchedule: true }
      );
    });
  });

  describe("computePendingExpiresAtIso", () => {
    test("empty or missing next => no expiry", () => {
      assert.equal(computePendingExpiresAtIso(""), "");
      assert.equal(computePendingExpiresAtIso("   "), "");
      assert.equal(computePendingExpiresAtIso(null), "");
    });

    test("non-schedule stage => 10 minutes from mocked now", (t) => {
      const anchor = new Date("2024-06-01T12:00:00.000Z").getTime();
      t.mock.timers.enable({ apis: ["Date"], now: anchor });
      const iso = computePendingExpiresAtIso("PROPERTY");
      assert.equal(iso, new Date(anchor + 10 * 60 * 1000).toISOString());
    });

    test("SCHEDULE => 30 minutes from mocked now", (t) => {
      const anchor = 1_700_000_000_000;
      t.mock.timers.enable({ apis: ["Date"], now: anchor });
      const iso = computePendingExpiresAtIso("SCHEDULE");
      assert.equal(iso, new Date(anchor + 30 * 60 * 1000).toISOString());
    });

    test("SCHEDULE_PRETICKET => 30 minutes", (t) => {
      const anchor = 1_700_000_000_000;
      t.mock.timers.enable({ apis: ["Date"], now: anchor });
      const iso = computePendingExpiresAtIso("SCHEDULE_PRETICKET");
      assert.equal(iso, new Date(anchor + 30 * 60 * 1000).toISOString());
    });
  });

  describe("issueTextForFinalize", () => {
    test("empty base and buffer", () => {
      assert.equal(issueTextForFinalize("", []), "");
      assert.equal(issueTextForFinalize("   ", null), "");
    });

    test("joins base and extras with dedupe by normalized compare key", () => {
      assert.equal(
        issueTextForFinalize("Leak under sink", ["leak under sink", "Other issue"]),
        "Leak under sink | Other issue"
      );
    });

    test("caps at 900 characters", () => {
      const extras = Array.from(
        { length: 80 },
        (_, i) => `Issue segment ${i} ${"z".repeat(25)}`
      );
      const out = issueTextForFinalize("", extras);
      assert.equal(out.length, 900);
      assert.ok(/^Issue segment \d/.test(out));
    });
  });
});
