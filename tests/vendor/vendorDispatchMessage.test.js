"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildVendorDispatchRequestText } = require("../../src/outgate/vendorMessageSpecs");

test("buildVendorDispatchRequestText includes ticket and issue", () => {
  const body = buildVendorDispatchRequestText({
    propertyName: "The Grand",
    unit: "305",
    category: "Plumbing",
    issue: "Leak under sink",
    ticketId: "PENN-012626-0001",
  });
  assert.match(body, /The Grand/);
  assert.match(body, /305/);
  assert.match(body, /Plumbing/);
  assert.match(body, /PENN-012626-0001/);
  assert.match(body, /YES/);
});
