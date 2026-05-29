"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { VENDOR_STATUS, normalizeVendorStatus } = require("../../src/vendor/vendorStatus");

test("normalizeVendorStatus accepts controlled vocabulary", () => {
  assert.equal(normalizeVendorStatus("contacted"), VENDOR_STATUS.CONTACTED);
  assert.equal(normalizeVendorStatus("Accepted"), VENDOR_STATUS.ACCEPTED);
  assert.equal(normalizeVendorStatus("DECLINED"), VENDOR_STATUS.DECLINED);
  assert.equal(normalizeVendorStatus("nope"), "");
});
