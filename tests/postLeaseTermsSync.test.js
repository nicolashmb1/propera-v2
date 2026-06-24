const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLeaseTermsUpdatePatch } = require("../src/brain/financial/postLeaseTermsSync");
const { validateLeaseTermsSyncSignal } = require("../src/brain/financial/leaseTermsSyncSignal");

const EXISTING_314 = {
  rent_cents: 240600,
  security_deposit_cents: 240600,
  other_deposit_cents: 70000,
  pet_deposit_cents: null,
  key_deposit_cents: null,
  lease_start: "2025-06-01",
  lease_end: "2026-05-31",
  charge_lines: [],
  tenant_net_rent_cents: null,
  rent_subsidy_cents: null,
  rent_subsidy_label: null,
  net_rent_derived_at: null,
  deposits_derived_at: null,
};

function lhSignal(body) {
  const validated = validateLeaseTermsSyncSignal({
    kind: "lease_terms_sync",
    source_channel: "leasehold_import",
    property_code: "WESTFIELD",
    unit_catalog_id: "unit-314",
    unit_label: "314",
    idempotency_key: "leasehold:WESTFIELD:314:lease_terms:abc12345678901234567890123456789012",
    effective_at: "2026-06-15T12:00:00.000Z",
    body,
  });
  assert.equal(validated.ok, true);
  return validated.signal;
}

test("buildLeaseTermsUpdatePatch — LH sync omits other deposit → preserve staff $700", () => {
  const signal = lhSignal({
    rent_cents: 240600,
    lease_start: "2025-06-01",
    lease_end: "2026-05-31",
    security_deposit_cents: 240600,
    charge_lines: [],
  });

  assert.ok(!signal.asserted_fields.includes("other_deposit_cents"));

  const patch = buildLeaseTermsUpdatePatch(signal, EXISTING_314);
  assert.ok(!Object.prototype.hasOwnProperty.call(patch, "other_deposit_cents"));
  assert.equal(patch.rent_cents, 240600);
});

test("buildLeaseTermsUpdatePatch — explicit zero clears other deposit", () => {
  const signal = lhSignal({
    rent_cents: 240600,
    lease_start: "2025-06-01",
    lease_end: "2026-05-31",
    security_deposit_cents: 240600,
    other_deposit_cents: 0,
    charge_lines: [],
  });

  assert.ok(signal.asserted_fields.includes("other_deposit_cents"));

  const patch = buildLeaseTermsUpdatePatch(signal, EXISTING_314);
  assert.equal(patch.other_deposit_cents, 0);
});

test("buildLeaseTermsUpdatePatch — portal edit still full patch", () => {
  const validated = validateLeaseTermsSyncSignal({
    kind: "lease_terms_sync",
    source_channel: "portal_lease_edit",
    property_code: "WESTFIELD",
    unit_catalog_id: "unit-314",
    unit_label: "314",
    idempotency_key: "portal:WESTFIELD:314:lease_terms:abc12345678901234567890123456789012",
    effective_at: "2026-06-15T12:00:00.000Z",
    body: {
      rent_cents: 255000,
      lease_start: "2025-06-01",
      lease_end: "2026-05-31",
      security_deposit_cents: 240600,
      charge_lines: [],
    },
  });
  assert.equal(validated.ok, true);

  const patch = buildLeaseTermsUpdatePatch(validated.signal, EXISTING_314);
  assert.equal(patch.rent_cents, 255000);
});

test("buildLeaseTermsUpdatePatch — insert uses full body", () => {
  const signal = lhSignal({
    rent_cents: 240600,
    lease_start: "2025-06-01",
    lease_end: "2026-05-31",
    security_deposit_cents: 240600,
    charge_lines: [],
  });

  const patch = buildLeaseTermsUpdatePatch(signal, null);
  assert.equal(patch.rent_cents, 240600);
  assert.equal(patch.security_deposit_cents, 240600);
});
