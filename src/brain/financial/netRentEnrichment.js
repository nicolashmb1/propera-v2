const { parseAccountingPostedTransactions } = require("./accountingLedgerParse");

const MIN_RECURRING_ADJ_MONTHS = 3;

function monthKey(date) {
  const key = String(date ?? "").trim().slice(0, 7);
  return /^\d{4}-\d{2}$/.test(key) ? key : null;
}

function adjCreditCents(tx) {
  if (tx.kind !== "adjustment") return 0;
  const label = String(tx.description ?? "").trim().toUpperCase();
  if (label !== "ADJ") return 0;
  if (tx.amount_cents == null || tx.amount_cents === 0) return 0;
  return tx.amount_cents < 0 ? Math.abs(tx.amount_cents) : 0;
}

/** Detect standing gross rent + recurring ADJ credit from imported posted lines. */
function deriveNetRentFromAccountingPosted(txs, fallbackGrossRentCents = null) {
  const byMonth = new Map();

  for (const tx of txs) {
    const key = monthKey(tx.date);
    if (!key) continue;
    const row = byMonth.get(key) ?? { billed: 0, adjCredit: 0 };

    if (tx.kind === "billing" && tx.amount_cents != null && tx.amount_cents > 0) {
      row.billed = Math.max(row.billed, tx.amount_cents);
    }
    const credit = adjCreditCents(tx);
    if (credit > 0) row.adjCredit = Math.max(row.adjCredit, credit);

    byMonth.set(key, row);
  }

  const samples = [...byMonth.entries()]
    .filter(([, row]) => row.billed > 0 && row.adjCredit > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  if (samples.length < MIN_RECURRING_ADJ_MONTHS) {
    return {
      grossRentCents: fallbackGrossRentCents,
      subsidyCents: null,
      tenantNetRentCents: null,
      sampleMonths: samples.length,
    };
  }

  let latestBillingMonth = null;
  for (const [key, row] of byMonth) {
    if (row.billed <= 0) continue;
    if (!latestBillingMonth || key.localeCompare(latestBillingMonth) > 0) {
      latestBillingMonth = key;
    }
  }

  const current = latestBillingMonth ? byMonth.get(latestBillingMonth) : null;
  if (!current || current.adjCredit <= 0 || current.billed <= 0) {
    return {
      grossRentCents: fallbackGrossRentCents,
      subsidyCents: null,
      tenantNetRentCents: null,
      sampleMonths: samples.length,
    };
  }

  const grossRentCents = current.billed;
  const subsidyCents = current.adjCredit;
  const tenantNetRentCents = Math.max(0, grossRentCents - subsidyCents);

  return {
    grossRentCents,
    subsidyCents,
    tenantNetRentCents,
    sampleMonths: samples.length,
  };
}

function deriveNetRentFromSnapshotPayload(payload, fallbackGrossRentCents = null) {
  const posted = parseAccountingPostedTransactions(payload);
  if (!posted.length) {
    return {
      grossRentCents: fallbackGrossRentCents,
      subsidyCents: null,
      tenantNetRentCents: null,
      sampleMonths: 0,
    };
  }
  return deriveNetRentFromAccountingPosted(posted, fallbackGrossRentCents);
}

module.exports = {
  deriveNetRentFromAccountingPosted,
  deriveNetRentFromSnapshotPayload,
};
