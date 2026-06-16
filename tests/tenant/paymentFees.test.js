const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  computePaymentFees,
  computePaymentTotals,
  computeAchTotalForNetBase,
  computeCardTotalForNetBase,
  ownerNetAfterAch,
  ownerNetAfterCard,
} = require("../../src/tenant/paymentFees");

describe("computePaymentFees", () => {
  it("caps ACH at $5 flat", () => {
    const { achFeeCents } = computePaymentFees(100_000_00);
    assert.equal(achFeeCents, 500);
  });

  it("computes card as 2.9% + $0.30", () => {
    const { cardFeeCents } = computePaymentFees(10_000_00);
    assert.equal(cardFeeCents, Math.round(10_000_00 * 0.029) + 30);
  });

  it("returns zero ACH and fixed card minimum for $0 balance", () => {
    const { achFeeCents, cardFeeCents } = computePaymentFees(0);
    assert.equal(achFeeCents, 0);
    assert.equal(cardFeeCents, 30);
  });
});

describe("computeAchTotalForNetBase", () => {
  it("nets exact rent when ACH fee hits $5 cap", () => {
    const { totalCents, feeCents } = computeAchTotalForNetBase(185_000);
    assert.equal(totalCents, 185_500);
    assert.equal(feeCents, 500);
    assert.equal(ownerNetAfterAch(totalCents), 185_000);
  });

  it("nets exact rent for small amounts under cap", () => {
    const { totalCents } = computeAchTotalForNetBase(10_000);
    assert.equal(ownerNetAfterAch(totalCents), 10_000);
  });
});

describe("computeCardTotalForNetBase", () => {
  it("nets exact rent for $1,850 card charge", () => {
    const { totalCents, feeCents } = computeCardTotalForNetBase(185_000);
    assert.equal(ownerNetAfterCard(totalCents), 185_000);
    assert.equal(feeCents, totalCents - 185_000);
    assert.equal(totalCents, 190_556);
  });
});

describe("computePaymentTotals", () => {
  it("grosses up ACH and card when tenant pays fees (default)", () => {
    const totals = computePaymentTotals(185_000);
    assert.equal(totals.tenantPaysStripeFees, true);
    assert.equal(totals.achTotalCents, 185_500);
    assert.equal(ownerNetAfterAch(totals.achTotalCents), 185_000);
    assert.equal(ownerNetAfterCard(totals.cardTotalCents), 185_000);
  });

  it("charges rent only when tenant pays fees is off", () => {
    const totals = computePaymentTotals(185_000, { tenantPaysStripeFees: false });
    assert.equal(totals.tenantPaysStripeFees, false);
    assert.equal(totals.achTotalCents, 185_000);
    assert.equal(totals.cardTotalCents, 185_000);
    assert.equal(totals.achFeeCents, 0);
    assert.equal(totals.cardFeeCents, 0);
  });

  it("returns zero totals when base is zero", () => {
    const totals = computePaymentTotals(0);
    assert.equal(totals.achTotalCents, 0);
    assert.equal(totals.cardTotalCents, 0);
  });
});
