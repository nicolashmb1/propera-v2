const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildOpeningIdempotencyKey,
  isNewLeaseCleanStart,
  resolveOpeningBalanceCents,
} = require("../src/brain/financial/ledgerOpeningBalance");

test("buildOpeningIdempotencyKey is stable per unit", () => {
  const key = buildOpeningIdempotencyKey("WESTFIELD", "101");
  assert.equal(key, "propera:WESTFIELD:101:opening_balance:v1");
});

test("isNewLeaseCleanStart when first activity on/after lease start", () => {
  assert.equal(isNewLeaseCleanStart("2025-06-01", "2025-06-01"), true);
  assert.equal(isNewLeaseCleanStart("2020-01-01", "2023-06-01"), false);
});

test("resolveOpeningBalanceCents uses first line prior for incumbent", () => {
  const resolved = resolveOpeningBalanceCents({
    standingBalanceCents: 50000,
    payload: {
      posted_transactions: [
        {
          date: "2023-04-01",
          amount_cents: 250000,
          prior_balance_cents: 1800000,
        },
      ],
    },
    mimicEntries: [{ entry_kind: "charge", amount_cents: 250000, status: "posted" }],
    leaseStart: "2020-01-01",
    firstEvent: "2023-04-01",
  });
  assert.equal(resolved.openingCents, 1800000);
  assert.equal(resolved.reason, "lh_first_line_prior");
});

test("resolveOpeningBalanceCents skips new lease clean start", () => {
  const resolved = resolveOpeningBalanceCents({
    standingBalanceCents: 250000,
    payload: {
      posted_transactions: [
        { date: "2025-06-01", amount_cents: 250000, prior_balance_cents: null },
      ],
    },
    mimicEntries: [{ entry_kind: "charge", amount_cents: 250000, status: "posted" }],
    leaseStart: "2025-06-01",
    firstEvent: "2025-06-01",
  });
  assert.equal(resolved.openingCents, null);
  assert.equal(resolved.reason, "new_lease_clean_start");
});
