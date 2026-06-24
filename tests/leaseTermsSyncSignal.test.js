const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateLeaseTermsSyncSignal,
  buildLeaseTermsIdempotencyKey,
  LEASE_TERMS_SYNC_KIND,
} = require("../src/brain/financial/leaseTermsSyncSignal");
const { normalizeLeaseholdFactToLeaseTermsSync } = require("../src/adapters/leasehold/normalizeLeaseholdFactToLeaseTermsSync");

const VALID_BODY = {
  rent_cents: 240600,
  lease_start: "2025-06-01",
  lease_end: "2026-05-31",
  security_deposit_cents: 240600,
  key_deposit_cents: 5000,
  charge_lines: [
    { type: "water", mode: "variable", amount_cents: 4500 },
    { type: "pet_fee", mode: "fixed", amount_cents: 5000 },
  ],
};

function baseSignal(overrides = {}) {
  return {
    kind: LEASE_TERMS_SYNC_KIND,
    source_channel: "leasehold_import",
    property_code: "WESTFIELD",
    unit_catalog_id: "unit-uuid-412",
    unit_label: "412",
    idempotency_key: buildLeaseTermsIdempotencyKey({
      sourceSystem: "leasehold",
      propertyCode: "WESTFIELD",
      unitLabel: "412",
      effectiveAt: "2026-06-15T12:00:00.000Z",
      body: VALID_BODY,
    }),
    effective_at: "2026-06-15T12:00:00.000Z",
    body: VALID_BODY,
    ...overrides,
  };
}

test("validateLeaseTermsSyncSignal — accepts valid signal", () => {
  const out = validateLeaseTermsSyncSignal(baseSignal());
  assert.equal(out.ok, true);
  assert.equal(out.signal.kind, LEASE_TERMS_SYNC_KIND);
  assert.equal(out.signal.property_code, "WESTFIELD");
  assert.ok(Array.isArray(out.signal.asserted_fields));
  assert.ok(out.signal.asserted_fields.includes("rent_cents"));
  assert.ok(out.signal.asserted_fields.includes("security_deposit_cents"));
  assert.ok(!out.signal.asserted_fields.includes("other_deposit_cents"));
});

test("validateLeaseTermsSyncSignal — rejects invalid kind", () => {
  const out = validateLeaseTermsSyncSignal(baseSignal({ kind: "payment_received" }));
  assert.equal(out.ok, false);
  assert.equal(out.error, "invalid_kind");
});

test("validateLeaseTermsSyncSignal — rejects bad idempotency key", () => {
  const out = validateLeaseTermsSyncSignal(baseSignal({ idempotency_key: "short" }));
  assert.equal(out.ok, false);
  assert.equal(out.error, "invalid_idempotency_key_format");
});

test("validateLeaseTermsSyncSignal — rejects invalid date range", () => {
  const out = validateLeaseTermsSyncSignal(
    baseSignal({
      body: { ...VALID_BODY, lease_start: "2026-06-01", lease_end: "2025-01-01" },
    })
  );
  assert.equal(out.ok, false);
  assert.equal(out.error, "invalid_lease_date_range");
});

test("validateLeaseTermsSyncSignal — rejects vacant body", () => {
  const out = validateLeaseTermsSyncSignal(
    baseSignal({
      body: { rent_cents: null, charge_lines: [] },
    })
  );
  assert.equal(out.ok, false);
  assert.equal(out.error, "vacant_lease_terms");
});

test("validateLeaseTermsSyncSignal — accepts portal_lease_edit channel", () => {
  const out = validateLeaseTermsSyncSignal(
    baseSignal({ source_channel: "portal_lease_edit" })
  );
  assert.equal(out.ok, true);
  assert.equal(out.signal.source_channel, "portal_lease_edit");
});

test("normalizeLeaseholdFactToLeaseTermsSync — builds signal from LH fact", () => {
  const signal = normalizeLeaseholdFactToLeaseTermsSync({
    propertyCode: "WESTFIELD",
    unitId: "unit-uuid-412",
    unitLabel: "412",
    syncedAt: "2026-06-15T12:00:00.000Z",
    fact: {
      unit_label: "412",
      tenant_name: "Smith",
      rent_cents: 240600,
      lease_start: "2025-06-01",
      lease_end: "2026-05-31",
      security_deposit_cents: 240600,
      key_deposit_cents: 5000,
      payload: {
        ancillary_charges: [
          {
            category: "pet",
            label: "Pet",
            amount_cents: 5000,
            recurring: true,
            last_posted_at: "2026-06-01",
          },
        ],
      },
    },
  });

  assert.ok(signal);
  assert.equal(signal.kind, LEASE_TERMS_SYNC_KIND);
  assert.equal(signal.source_channel, "leasehold_import");
  assert.equal(signal.body.rent_cents, 240600);
  assert.equal(signal.body.key_deposit_cents, 5000);
  assert.ok(String(signal.idempotency_key).includes(":lease_terms:"));

  const validated = validateLeaseTermsSyncSignal(signal);
  assert.equal(validated.ok, true);
});

test("buildLeaseTermsIdempotencyKey — changes when rent changes", () => {
  const a = buildLeaseTermsIdempotencyKey({
    propertyCode: "WESTFIELD",
    unitLabel: "412",
    effectiveAt: "2026-06-15",
    body: VALID_BODY,
  });
  const b = buildLeaseTermsIdempotencyKey({
    propertyCode: "WESTFIELD",
    unitLabel: "412",
    effectiveAt: "2026-06-15",
    body: { ...VALID_BODY, rent_cents: 255000 },
  });
  assert.notEqual(a, b);
});
