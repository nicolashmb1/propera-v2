"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildMaintenanceReceipt,
  buildSingleMaintenanceReceipt,
  maintenanceReceiptTemplateKey,
} = require("../src/outgate/buildMaintenanceReceipt");
const { deriveIssuePhrase } = require("../src/outgate/deriveIssuePhrase");

test("deriveIssuePhrase — short cleaned phrases", () => {
  assert.equal(deriveIssuePhrase("yo heat broke"), "heat not working");
  assert.equal(deriveIssuePhrase("sink leaking"), "kitchen sink leak");
  assert.equal(deriveIssuePhrase("kitchen is on fire"), "fire");
});

test("buildSingleMaintenanceReceipt — routine three lines", () => {
  const body = buildSingleMaintenanceReceipt({
    ticketId: "PENN-052326-2930",
    issuePhrase: "heat not working",
    tier: "routine",
    commonArea: false,
    unitLabel: "410",
  });
  assert.match(body, /Ref #PENN-052326-2930 — we're on it\./);
  assert.match(body, /Heat not working confirmed for unit 410\./);
  assert.match(body, /We'll be in touch shortly\./);
  assert.doesNotMatch(body, /Ticket logged/i);
});

test("buildSingleMaintenanceReceipt — emergency", () => {
  const body = buildSingleMaintenanceReceipt({
    ticketId: "PENN-001",
    issuePhrase: "fire",
    tier: "emergency",
    commonArea: false,
    unitLabel: "303",
  });
  assert.match(body, /^We're treating this as an emergency\./m);
  assert.match(body, /Someone is being contacted now/);
  assert.match(body, /Please stay safe\./);
});

test("buildMaintenanceReceipt — multi ticket", () => {
  const { body, templateKey } = buildMaintenanceReceipt({
    fins: [{ ticketId: "PENN-001" }, { ticketId: "PENN-002" }],
    groups: [{ issueText: "heat broken" }, { issueText: "sink leak" }],
    commonArea: false,
    unitLabel: "410",
  });
  assert.equal(templateKey, "MAINTENANCE_RECEIPT_MULTI");
  assert.match(body, /Ref #PENN-001/);
  assert.match(body, /Ref #PENN-002/);
  assert.match(body, /Both are being handled/);
});

test("maintenanceReceiptTemplateKey", () => {
  assert.equal(maintenanceReceiptTemplateKey("routine", false), "MAINTENANCE_RECEIPT_ROUTINE");
  assert.equal(maintenanceReceiptTemplateKey("emergency", false), "MAINTENANCE_RECEIPT_EMERGENCY");
  assert.equal(maintenanceReceiptTemplateKey("routine", true), "MAINTENANCE_RECEIPT_MULTI");
});
