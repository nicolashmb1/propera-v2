const test = require("node:test");
const assert = require("node:assert/strict");
const {
  stripePaymentCoversBalanceDue,
  stripeLedgerPostAction,
  applyStripeCheckoutReminderPolicy,
} = require("../src/brain/financial/paymentReminderPolicy");

function paymentRow(overrides = {}) {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    property_code: "WESTFIELD",
    unit_catalog_id: "11111111-1111-1111-1111-111111111111",
    tenant_roster_id: "22222222-2222-2222-2222-222222222222",
    base_cents: 185000,
    payment_method: "ach",
    ...overrides,
  };
}

test("stripeLedgerPostAction maps ledger results", () => {
  assert.equal(stripeLedgerPostAction({ ok: true, ledgerEntryId: "abc" }), "created");
  assert.equal(
    stripeLedgerPostAction({ ok: true, skipped: true, ledgerEntryId: "abc" }),
    "skipped_existing"
  );
  assert.equal(stripeLedgerPostAction({ ok: false }), null);
});

test("stripePaymentCoversBalanceDue when payment covers snapshot", async () => {
  const sb = {
    from(table) {
      assert.equal(table, "tenant_account_snapshots");
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { balance_cents: 185000 }, error: null }),
            }),
          }),
        }),
      };
    },
  };
  const out = await stripePaymentCoversBalanceDue(sb, paymentRow());
  assert.equal(out.paidUp, true);
  assert.equal(out.reason, "covers_snapshot_balance");
});

test("stripePaymentCoversBalanceDue skips partial payment", async () => {
  const sb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { balance_cents: 250000 }, error: null }),
          }),
        }),
      }),
    }),
  };
  const out = await stripePaymentCoversBalanceDue(sb, paymentRow({ base_cents: 100000 }));
  assert.equal(out.paidUp, false);
  assert.equal(out.reason, "partial_vs_snapshot");
});

test("applyStripeCheckoutReminderPolicy creates suppression", async () => {
  const inserts = [];
  const sb = {
    from(table) {
      if (table === "tenant_account_snapshots") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { balance_cents: 185000 }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "balance_reminder_suppressions") {
        return {
          insert(row) {
            inserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  const out = await applyStripeCheckoutReminderPolicy(
    sb,
    paymentRow(),
    { ok: true, ledgerEntryId: "ledger-1" }
  );

  assert.equal(out.ok, true);
  assert.equal(out.policy, "payment_received_reminder_suppression");
  assert.equal(out.created, 1);
  assert.equal(inserts[0].source_type, "stripe_checkout");
  assert.equal(
    inserts[0].source_ref,
    "stripe_checkout:33333333-3333-3333-3333-333333333333"
  );
  assert.equal(inserts[0].reason, "stripe_checkout_paid_up");
});
