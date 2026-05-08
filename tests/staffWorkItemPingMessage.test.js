"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clipIssueFirstLine,
  formatStaffWorkItemPingBody,
} = require("../src/brain/lifecycle/staffWorkItemPingMessage");

test("clipIssueFirstLine takes first line and truncates", () => {
  assert.equal(clipIssueFirstLine("Leak under sink\nMore text", 100), "Leak under sink");
  const long = "x".repeat(150);
  const c = clipIssueFirstLine(long, 20);
  assert.equal(c.length, 20);
  assert.ok(c.endsWith("…"));
});

test("formatStaffWorkItemPingBody STAFF_UNSCHEDULED_REMINDER includes ticket, property, unit, issue", () => {
  const body = formatStaffWorkItemPingBody("STAFF_UNSCHEDULED_REMINDER", {
    workItemId: "WI_1",
    humanTicketId: "PENN-010126-0001",
    propertyLabel: "The Grand at Murray",
    unitLabel: "304",
    issueShort: "Leak under kitchen sink",
  });
  assert.ok(body.includes("PENN-010126-0001"));
  assert.ok(body.includes("The Grand at Murray"));
  assert.ok(body.includes("apt 304"));
  assert.ok(body.includes("Leak under kitchen sink"));
  assert.ok(body.includes("scheduling"));
});

test("formatStaffWorkItemPingBody falls back to work item id without ticket", () => {
  const body = formatStaffWorkItemPingBody("STAFF_UNSCHEDULED_REMINDER", {
    workItemId: "WI_ORPHAN",
    humanTicketId: "",
    propertyLabel: "Test Prop",
    unitLabel: "12",
    issueShort: "",
  });
  assert.ok(body.includes("WI_ORPHAN"));
  assert.ok(body.includes("open maintenance request"));
});
