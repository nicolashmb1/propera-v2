"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  tenantConversationIsExpired,
  partialPackageSummary,
} = require("../../src/adapters/tenantAgent/conversationExpiry");

test("tenantConversationIsExpired — false within TTL", () => {
  const row = { updated_at: new Date().toISOString() };
  assert.equal(tenantConversationIsExpired(row, 48), false);
});

test("tenantConversationIsExpired — true after TTL", () => {
  const old = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
  assert.equal(tenantConversationIsExpired({ updated_at: old }, 48), true);
});

test("tenantConversationIsExpired — 0 disables", () => {
  const old = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
  assert.equal(tenantConversationIsExpired({ updated_at: old }, 0), false);
});

test("partialPackageSummary — slots only", () => {
  assert.deepEqual(
    partialPackageSummary({ property: "PENN", unit: "403", issue: "clog" }),
    { property: "PENN", unit: "403", issue: "clog", location_kind: undefined }
  );
});
