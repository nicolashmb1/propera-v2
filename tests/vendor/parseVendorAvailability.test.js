"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractVendorAvailabilityText } = require("../../src/vendor/parseVendorAvailability");
const { isActiveVendorTicketRow } = require("../../src/vendor/listActiveVendorTickets");

test("extractVendorAvailabilityText — recognizes day + time range", () => {
  assert.equal(
    extractVendorAvailabilityText("tomorrow 9-11am"),
    "tomorrow 9-11am"
  );
});

test("extractVendorAvailabilityText — recognizes day + part of day", () => {
  assert.equal(
    extractVendorAvailabilityText("Thursday afternoon"),
    "Thursday afternoon"
  );
});

test("extractVendorAvailabilityText — rejects vague text", () => {
  assert.equal(extractVendorAvailabilityText("call me"), "");
  assert.equal(extractVendorAvailabilityText("yes"), "");
});

test("isActiveVendorTicketRow — assigned vendor contacted", () => {
  assert.equal(
    isActiveVendorTicketRow(
      {
        assigned_type: "VENDOR",
        assigned_id: "PLUMB-1",
        vendor_status: "Contacted",
        status: "Open",
      },
      "PLUMB-1"
    ),
    true
  );
});

test("isActiveVendorTicketRow — declined excluded", () => {
  assert.equal(
    isActiveVendorTicketRow(
      {
        assigned_type: "VENDOR",
        assigned_id: "PLUMB-1",
        vendor_status: "Declined",
        status: "Open",
      },
      "PLUMB-1"
    ),
    false
  );
});
