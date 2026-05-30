"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseProposeVendorRequest } = require("../../src/agent/jarvisPlan/parseProposeVendorRequest");

test("parseProposeVendorRequest — schedule plumber unit property", () => {
  const p = parseProposeVendorRequest("schedule plumber for unit 303 PENN", {});
  assert.ok(p);
  assert.equal(p.kind, "propose_vendor");
  assert.equal(p.tradeKey, "plumber");
  assert.equal(p.unit, "303");
  assert.equal(p.propertyCode, "PENN");
  assert.equal(p.dispatch, true);
});

test("parseProposeVendorRequest — assign only", () => {
  const p = parseProposeVendorRequest("assign plumber to 305 penn assign only", {});
  assert.ok(p);
  assert.equal(p.dispatch, false);
});

test("parseProposeVendorRequest — rejects cost syntax", () => {
  assert.equal(parseProposeVendorRequest("$$42 homedepot", {}), null);
});

test("parseProposeVendorRequest — ticket id in message", () => {
  const p = parseProposeVendorRequest(
    "dispatch plumber for PENN-012626-0001",
    {}
  );
  assert.ok(p);
  assert.equal(p.humanTicketId, "PENN-012626-0001");
});
