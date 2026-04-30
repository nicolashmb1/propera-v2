const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizePhoneE164 } = require("../src/utils/phone");

describe("portal roster helpers", () => {
  test("normalizePhoneE164 formats US 10-digit for tenant_roster", () => {
    assert.equal(normalizePhoneE164("9085550101"), "+19085550101");
  });
});
