const test = require("node:test");
const assert = require("node:assert/strict");
const { validateLedgerEventSignal } = require("../src/brain/financial/ledgerEventSignal");

const BASE = {
  kind: "payment_received",
  source_channel: "portal_payment",
  property_code: "WESTFIELD",
  unit_catalog_id: "unit-uuid-101",
  unit_label: "101",
  idempotency_key: "portal:WESTFIELD:101:2026-06-24:payment:320000:refCash",
  effective_at: "2026-06-24T12:00:00.000Z",
  body: {
    effective_date: "2026-06-24",
    amount_cents: 320000,
    description: "Rent payment — Cash",
    reference: null,
    balance_after_cents: 0,
    payment_method: "Cash",
  },
};

test("validateLedgerEventSignal — accepts portal_payment staff channel", () => {
  const out = validateLedgerEventSignal(BASE);
  assert.equal(out.ok, true);
  assert.equal(out.signal.source_channel, "portal_payment");
  assert.equal(out.signal.body.payment_method, "Cash");
});

test("validateLedgerEventSignal — rejects unknown channel", () => {
  const out = validateLedgerEventSignal({ ...BASE, source_channel: "unknown_channel" });
  assert.equal(out.ok, false);
  assert.equal(out.error, "invalid_source_channel");
});

test("validateLedgerEventSignal — accepts portal_ledger_edit staff channel", () => {
  const out = validateLedgerEventSignal({
    ...BASE,
    source_channel: "portal_ledger_edit",
    kind: "one_time_charge",
    idempotency_key: "portal:WESTFIELD:101:2026-06-24:charge:5000:refParking",
    body: {
      effective_date: "2026-06-24",
      amount_cents: 5000,
      description: "Parking fee",
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.signal.source_channel, "portal_ledger_edit");
});
