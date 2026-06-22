const test = require("node:test");
const assert = require("node:assert/strict");
const {
  readBalanceAfterCents,
  applyPaymentReceivedReminderPolicy,
} = require("../src/brain/financial/accountingImportPolicies");
const { buildLedgerEventIdempotencyKey } = require("../src/brain/financial/ledgerEventSignal");

function basePaymentSignal(overrides = {}) {
  return {
    kind: "payment_received",
    source_channel: "leasehold_import",
    property_code: "WESTFIELD",
    unit_catalog_id: "11111111-1111-1111-1111-111111111111",
    unit_label: "101",
    idempotency_key: buildLedgerEventIdempotencyKey({
      propertyCode: "WESTFIELD",
      unitLabel: "101",
      effectiveDate: "2026-06-03",
      signalKind: "payment_received",
      amountCents: 253100,
      postedSequence: 45,
    }),
    effective_at: "2026-06-15T12:00:00.000Z",
    body: {
      effective_date: "2026-06-03",
      amount_cents: 253100,
      balance_after_cents: 0,
      description: "CK",
      posted_sequence: 45,
    },
    ...overrides,
  };
}

test("readBalanceAfterCents returns zero when paid up", () => {
  assert.equal(readBalanceAfterCents(basePaymentSignal()), 0);
});

test("readBalanceAfterCents returns positive partial balance", () => {
  assert.equal(
    readBalanceAfterCents(
      basePaymentSignal({ body: { ...basePaymentSignal().body, balance_after_cents: 50000 } })
    ),
    50000
  );
});

test("applyPaymentReceivedReminderPolicy skips non-payment signals", async () => {
  const out = await applyPaymentReceivedReminderPolicy(
    {},
    { kind: "late_fee" },
    { action: "created" }
  );
  assert.equal(out.skipped, "not_payment_received");
});

test("applyPaymentReceivedReminderPolicy skips partial payment", async () => {
  const out = await applyPaymentReceivedReminderPolicy(
    {},
    basePaymentSignal({
      body: { ...basePaymentSignal().body, balance_after_cents: 120000 },
    }),
    { action: "created" }
  );
  assert.equal(out.skipped, "partial_balance_remaining");
});

test("applyPaymentReceivedReminderPolicy skips when balance_after missing", async () => {
  const body = { ...basePaymentSignal().body };
  delete body.balance_after_cents;
  const out = await applyPaymentReceivedReminderPolicy({}, basePaymentSignal({ body }), {
    action: "created",
  });
  assert.equal(out.skipped, "missing_balance_after");
});

test("applyPaymentReceivedReminderPolicy creates suppressions when paid up", async () => {
  const inserts = [];
  const sb = {
    from(table) {
      if (table === "units") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { property_code: "WESTFIELD", unit_label: "101" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "tenant_roster") {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({
                data: [
                  {
                    id: "22222222-2222-2222-2222-222222222222",
                    property_code: "WESTFIELD",
                    unit_label: "101",
                  },
                ],
                error: null,
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

  const out = await applyPaymentReceivedReminderPolicy(sb, basePaymentSignal(), {
    action: "created",
  });

  assert.equal(out.ok, true);
  assert.equal(out.policy, "payment_received_reminder_suppression");
  assert.equal(out.created, 1);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].source_type, "accounting_import");
  assert.equal(inserts[0].reason, "payment_received_paid_up");
});
