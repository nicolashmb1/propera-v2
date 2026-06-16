const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateLedgerEventSignal,
  buildLedgerEventIdempotencyKey,
  signalKindToEntryKind,
} = require("../src/brain/financial/ledgerEventSignal");

function baseSignal(overrides = {}) {
  return {
    schema_version: 1,
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
      description: "CK",
      posted_sequence: 45,
      confidence: "high",
    },
    ...overrides,
  };
}

test("validateLedgerEventSignal accepts payment_received", () => {
  const out = validateLedgerEventSignal(baseSignal());
  assert.equal(out.ok, true);
  assert.equal(out.signal.kind, "payment_received");
});

test("validateLedgerEventSignal rejects lease_terms idempotency key", () => {
  const out = validateLedgerEventSignal(
    baseSignal({ idempotency_key: "leasehold:WESTFIELD:101:2026-06-15:lease_terms:abc" })
  );
  assert.equal(out.ok, false);
  assert.equal(out.error, "invalid_idempotency_key_format");
});

test("validateLedgerEventSignal rejects zero amount", () => {
  const out = validateLedgerEventSignal(
    baseSignal({ body: { effective_date: "2026-06-03", amount_cents: 0 } })
  );
  assert.equal(out.ok, false);
  assert.equal(out.error, "invalid_amount_cents");
});

test("signalKindToEntryKind maps billing to charge", () => {
  assert.equal(signalKindToEntryKind("monthly_billing"), "charge");
  assert.equal(signalKindToEntryKind("payment_received"), "payment");
  assert.equal(signalKindToEntryKind("late_fee"), "fee");
});
