const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildPaymentUrl, isValidEmail } = require("../../src/tenant/buildPaymentUrl");

describe("buildPaymentUrl", () => {
  it("locks email and prefills amount in cents", () => {
    const out = buildPaymentUrl("https://buy.stripe.com/test_abc", {
      amountCents: 185000,
      email: "Tenant@Example.com",
      unitCode: "PENN-4B",
      month: "2026-06",
    });
    assert.ok(out);
    const u = new URL(out);
    assert.equal(u.searchParams.get("prefilled_amount"), "185000");
    assert.equal(u.searchParams.get("locked_prefilled_email"), "tenant@example.com");
    assert.equal(u.searchParams.get("client_reference_id"), "PENN-4B-2026-06");
    assert.equal(u.searchParams.get("prefilled_email"), null);
  });

  it("skips invalid email", () => {
    const out = buildPaymentUrl("https://buy.stripe.com/test_abc", {
      amountCents: 100,
      email: "not-an-email",
    });
    assert.ok(out);
    const u = new URL(out);
    assert.equal(u.searchParams.get("locked_prefilled_email"), null);
  });

  it("omits amount when zero", () => {
    const out = buildPaymentUrl("https://buy.stripe.com/test_abc", { amountCents: 0 });
    assert.ok(out);
    assert.equal(new URL(out).searchParams.get("prefilled_amount"), null);
  });
});

describe("isValidEmail", () => {
  it("accepts normal addresses", () => {
    assert.equal(isValidEmail("a@b.co"), true);
  });
  it("rejects garbage", () => {
    assert.equal(isValidEmail("nope"), false);
  });
});
