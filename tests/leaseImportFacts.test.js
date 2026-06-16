const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildLeaseShellLhPatch,
  isOccupiedSnapshotUnit,
  leaseShellLhPatchChanged,
} = require("../src/brain/financial/leaseImportFacts");

test("isOccupiedSnapshotUnit — tenant name", () => {
  assert.equal(isOccupiedSnapshotUnit({ unit_label: "101", tenant_name: "Diego Cardona" }), true);
});

test("isOccupiedSnapshotUnit — rent only", () => {
  assert.equal(isOccupiedSnapshotUnit({ unit_label: "101", rent_cents: 240600 }), true);
});

test("isOccupiedSnapshotUnit — vacant", () => {
  assert.equal(isOccupiedSnapshotUnit({ unit_label: "101" }), false);
});

test("buildLeaseShellLhPatch — insert shell from snapshot", () => {
  const fact = {
    unit_label: "412",
    tenant_name: "Smith",
    rent_cents: 240600,
    lease_start: "2025-06-01",
    lease_end: "2026-05-31",
    security_deposit_cents: 240600,
    payload: {
      ancillary_charges: [
        {
          category: "water",
          label: "Water",
          amount_cents: 4500,
          recurring: true,
          last_posted_at: "2026-06-01",
        },
        {
          category: "pet",
          label: "Pet",
          amount_cents: 5000,
          recurring: true,
          last_posted_at: "2026-06-01",
        },
      ],
    },
  };

  const built = buildLeaseShellLhPatch(fact, null, "2026-06-15T12:00:00.000Z");
  assert.ok(built);
  assert.equal(built.patch.rent_cents, 240600);
  assert.equal(built.patch.lease_start, "2025-06-01");
  assert.equal(built.patch.lease_end, "2026-05-31");
  assert.equal(built.patch.security_deposit_cents, 240600);

  const lines = built.patch.charge_lines;
  const water = lines.find((l) => l.type === "water");
  const pet = lines.find((l) => l.type === "pet_fee");
  assert.equal(water?.mode, "variable");
  assert.equal(water?.amount_cents, 4500);
  assert.equal(pet?.mode, "fixed");
  assert.equal(pet?.amount_cents, 5000);
});

test("buildLeaseShellLhPatch — skips invalid date pair", () => {
  const fact = {
    unit_label: "412",
    tenant_name: "Smith",
    rent_cents: 100000,
    lease_start: "2026-06-01",
    lease_end: "2025-01-01",
  };
  const existing = {
    rent_cents: 90000,
    security_deposit_cents: null,
    other_deposit_cents: null,
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
  const built = buildLeaseShellLhPatch(fact, existing, "2026-06-15T12:00:00.000Z");
  assert.ok(built);
  assert.equal(built.patch.lease_start, "2025-06-01");
  assert.equal(built.patch.lease_end, "2026-05-31");
});

test("leaseShellLhPatchChanged — detects rent change", () => {
  const existing = {
    rent_cents: 240600,
    security_deposit_cents: null,
    other_deposit_cents: null,
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
  assert.equal(
    leaseShellLhPatchChanged(existing, {
      rent_cents: 255000,
      lease_start: "2025-06-01",
      lease_end: "2026-05-31",
      charge_lines: [],
    }),
    true
  );
  assert.equal(
    leaseShellLhPatchChanged(existing, {
      rent_cents: 240600,
      lease_start: "2025-06-01",
      lease_end: "2026-05-31",
      charge_lines: [],
    }),
    false
  );
});

test("buildLeaseShellLhPatch — vacant fact returns null", () => {
  assert.equal(buildLeaseShellLhPatch({ unit_label: "999" }, null, "2026-06-15T12:00:00.000Z"), null);
});
