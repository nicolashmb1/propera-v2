const FEES = {
  ACH_FLAT_CENTS: 500,
  ACH_RATE: 0.008,
  CARD_RATE: 0.029,
  CARD_FIXED_CENTS: 30,
};

/**
 * @param {number} balanceCents
 * @returns {{ achFeeCents: number, cardFeeCents: number }}
 */
function computePaymentFees(balanceCents) {
  const cents = Math.max(0, Math.round(Number(balanceCents) || 0));
  const achFee = Math.min(Math.round(cents * FEES.ACH_RATE), FEES.ACH_FLAT_CENTS);
  const cardFee = Math.round(cents * FEES.CARD_RATE) + FEES.CARD_FIXED_CENTS;
  return { achFeeCents: achFee, cardFeeCents: cardFee };
}

function stripeAchFeeOnTotal(totalCents) {
  return Math.min(Math.round(totalCents * FEES.ACH_RATE), FEES.ACH_FLAT_CENTS);
}

function stripeCardFeeOnTotal(totalCents) {
  return Math.round(totalCents * FEES.CARD_RATE) + FEES.CARD_FIXED_CENTS;
}

function ownerNetAfterAch(totalCents) {
  return totalCents - stripeAchFeeOnTotal(totalCents);
}

function ownerNetAfterCard(totalCents) {
  return totalCents - stripeCardFeeOnTotal(totalCents);
}

/**
 * Minimum charge so owner nets exactly base after Stripe ACH fees.
 * @param {number} baseCents
 */
function computeAchTotalForNetBase(baseCents) {
  const base = Math.max(0, Math.round(Number(baseCents) || 0));
  if (base <= 0) return { totalCents: 0, feeCents: 0 };

  const cappedTotal = base + FEES.ACH_FLAT_CENTS;
  if (ownerNetAfterAch(cappedTotal) === base) {
    return { totalCents: cappedTotal, feeCents: FEES.ACH_FLAT_CENTS };
  }

  let total = Math.ceil(base / (1 - FEES.ACH_RATE));
  while (ownerNetAfterAch(total) < base) total += 1;
  while (total > base + 1 && ownerNetAfterAch(total - 1) >= base) total -= 1;
  return { totalCents: total, feeCents: total - base };
}

/**
 * Minimum charge so owner nets at least base after Stripe card fees (2.9% + $0.30).
 * @param {number} baseCents
 */
function computeCardTotalForNetBase(baseCents) {
  const base = Math.max(0, Math.round(Number(baseCents) || 0));
  if (base <= 0) return { totalCents: 0, feeCents: 0 };

  let total = Math.ceil((base + FEES.CARD_FIXED_CENTS) / (1 - FEES.CARD_RATE));
  while (ownerNetAfterCard(total) < base) total += 1;
  while (total > base + 1 && ownerNetAfterCard(total - 1) >= base) total -= 1;
  return { totalCents: total, feeCents: total - base };
}

/**
 * Rent/base amount plus optional tenant-paid processing fee per rail.
 * When tenant pays fees, totals are grossed up so owner nets the base after Stripe takes its cut.
 * @param {number} baseCents — balance due or monthly rent
 * @param {{ tenantPaysStripeFees?: boolean }} [opts]
 */
function computePaymentTotals(baseCents, opts = {}) {
  const tenantPays = opts.tenantPaysStripeFees !== false;
  const base = Math.max(0, Math.round(Number(baseCents) || 0));

  if (base <= 0) {
    return {
      baseCents: 0,
      achFeeCents: 0,
      cardFeeCents: 0,
      achTotalCents: 0,
      cardTotalCents: 0,
      tenantPaysStripeFees: tenantPays,
    };
  }

  if (!tenantPays) {
    return {
      baseCents: base,
      achFeeCents: 0,
      cardFeeCents: 0,
      achTotalCents: base,
      cardTotalCents: base,
      tenantPaysStripeFees: false,
    };
  }

  const ach = computeAchTotalForNetBase(base);
  const card = computeCardTotalForNetBase(base);
  return {
    baseCents: base,
    achFeeCents: ach.feeCents,
    cardFeeCents: card.feeCents,
    achTotalCents: ach.totalCents,
    cardTotalCents: card.totalCents,
    tenantPaysStripeFees: true,
  };
}

module.exports = {
  computePaymentFees,
  computePaymentTotals,
  computeAchTotalForNetBase,
  computeCardTotalForNetBase,
  ownerNetAfterAch,
  ownerNetAfterCard,
  stripeAchFeeOnTotal,
  stripeCardFeeOnTotal,
  FEES,
};
