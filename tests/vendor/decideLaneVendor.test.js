"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyLane } = require("../../src/brain/router/decideLane");
const { isVendorActorKey } = require("../../src/config/lanePolicy");

test("classifyLane uses actorIdentity.isVendor without env list", () => {
  const inbound = { actorId: "+15551234567", meta: {} };
  const c = classifyLane(inbound, { isVendor: true, vendor: { vendorId: "VND_TEST" } });
  assert.equal(c.lane, "vendorLane");
  assert.equal(c.reason, "vendor_directory");
});

test("classifyLane env fallback when no actorIdentity", () => {
  const prev = process.env.VENDOR_PHONE_LAST10_LIST;
  process.env.VENDOR_PHONE_LAST10_LIST = "5551234567";
  try {
    const inbound = { actorId: "+15551234567", meta: {} };
    const c = classifyLane(inbound, null);
    assert.equal(c.lane, "vendorLane");
    assert.equal(c.reason, "isVendor_");
  } finally {
    if (prev === undefined) delete process.env.VENDOR_PHONE_LAST10_LIST;
    else process.env.VENDOR_PHONE_LAST10_LIST = prev;
  }
});

test("isVendorActorKey prefers actorIdentity", () => {
  assert.equal(isVendorActorKey("+10000000000", { isVendor: true }), true);
  assert.equal(isVendorActorKey("+10000000000", { isVendor: false }), false);
});
