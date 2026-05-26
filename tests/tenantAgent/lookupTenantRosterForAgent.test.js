"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pickUniqueRosterRow,
  applyRosterGatherContext,
  buildRosterAwareGreeting,
  buildRosterMissingFieldPrompt,
  formatResidentSalutation,
} = require("../../src/adapters/tenantAgent/lookupTenantRosterForAgent");

const KNOWN = new Set(["PENN"]);

test("pickUniqueRosterRow — single active row", () => {
  const row = pickUniqueRosterRow(
    [
      {
        property_code: "PENN",
        unit_label: "502",
        active: true,
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    KNOWN
  );
  assert.equal(row.property_code, "PENN");
  assert.equal(row.unit_label, "502");
});

test("pickUniqueRosterRow — ambiguous two units", () => {
  const row = pickUniqueRosterRow(
    [
      { property_code: "PENN", unit_label: "502", active: true },
      { property_code: "PENN", unit_label: "410", active: true },
    ],
    KNOWN
  );
  assert.equal(row, null);
});

test("applyRosterGatherContext seeds property and unit", () => {
  const next = applyRosterGatherContext(
    {},
    {
      matched: true,
      row: {
        property_code: "PENN",
        unit_label: "502",
        resident_name: "Nicolas Martinez",
        phone_e164: "+15551234001",
      },
    }
  );
  assert.equal(next.property, "PENN");
  assert.equal(next.unit, "502");
  assert.equal(next._roster_context.resident_name, "Nicolas Martinez");
});

test("buildRosterAwareGreeting — personalized open", () => {
  const msg = buildRosterAwareGreeting(
    {
      _roster_context: {
        property_code: "PENN",
        unit_label: "502",
        resident_name: "Nicolas Martinez",
      },
    },
    [{ code: "PENN", display_name_short: "The Grand at Penn" }]
  );
  assert.match(msg, /Hi Nicolas/i);
  assert.match(msg, /Grand at Penn/i);
  assert.match(msg, /unit 502/i);
});

test("buildRosterMissingFieldPrompt — hey have an issue path", () => {
  const msg = buildRosterMissingFieldPrompt(
    "issue",
    {
      _roster_context: {
        property_code: "PENN",
        unit_label: "502",
        resident_name: "Nicolas",
      },
      property: "PENN",
      unit: "502",
    },
    [{ code: "PENN", display_name_short: "The Grand at Penn" }]
  );
  assert.match(msg, /Hi Nicolas/i);
  assert.match(msg, /Grand at Penn/i);
  assert.match(msg, /help you with today/i);
});

test("formatResidentSalutation — first name", () => {
  assert.equal(formatResidentSalutation("Nicolas Martinez"), "Nicolas");
});
