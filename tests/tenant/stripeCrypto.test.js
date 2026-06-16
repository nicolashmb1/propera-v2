const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  encryptStripeSecret,
  decryptStripeSecret,
  maskStripeSecret,
} = require("../../src/tenant/stripeCrypto");

describe("stripeCrypto", () => {
  it("round-trips secret in dev base64 mode", () => {
    const enc = encryptStripeSecret("sk_test_abc123");
    assert.ok(enc.startsWith("v1:"));
    assert.equal(decryptStripeSecret(enc), "sk_test_abc123");
  });

  it("masks secret keys for settings display", () => {
    assert.equal(maskStripeSecret("sk_test_1234567890"), "sk_test…7890");
  });
});
