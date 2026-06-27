const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeTenantName,
  buildTenantNameDriftIdempotencyKey,
  normalizeTenantNameDrifts,
  recordOccupancyTenantNameDrifts,
} = require("../src/brain/financial/occupancyTenantNameDrift");

test("normalizeTenantName collapses whitespace and case", () => {
  assert.equal(normalizeTenantName("  jessica   paola  "), "JESSICA PAOLA");
});

test("buildTenantNameDriftIdempotencyKey is stable", () => {
  const key = buildTenantNameDriftIdempotencyKey(
    "westfield",
    "305",
    "Old Tenant",
    "New Tenant",
    "2026-06-26T12:00:00.000Z"
  );
  assert.equal(
    key,
    "leasehold:WESTFIELD:305:occupancy_drift:tenant_name:OLD TENANT:NEW TENANT:2026-06-26"
  );
});

test("normalizeTenantNameDrifts accepts snake and camel case", () => {
  const drifts = normalizeTenantNameDrifts({
    tenant_name_drifts: [
      {
        unitCatalogId: "11111111-1111-1111-1111-111111111111",
        unitLabel: "305",
        previousTenantName: "A",
        newTenantName: "B",
      },
    ],
  });
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0].unit_catalog_id, "11111111-1111-1111-1111-111111111111");
  assert.equal(drifts[0].previous_tenant_name, "A");
});

test("recordOccupancyTenantNameDrifts skips non-pilot property", async () => {
  const out = await recordOccupancyTenantNameDrifts(
    {},
    "MURRAY",
    [
      {
        unit_catalog_id: "11111111-1111-1111-1111-111111111111",
        unit_label: "101",
        previous_tenant_name: "A",
        new_tenant_name: "B",
      },
    ],
    "2026-06-26T12:00:00.000Z"
  );
  assert.equal(out.drift_created, 0);
});

test("recordOccupancyTenantNameDrifts inserts open flag for PENN", async () => {
  const inserts = [];
  const sb = {
    from(table) {
      if (table === "occupancy_drift_flags") {
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

  const out = await recordOccupancyTenantNameDrifts(
    sb,
    "PENN",
    [
      {
        unit_catalog_id: "11111111-1111-1111-1111-111111111111",
        unit_label: "203",
        previous_tenant_name: "Old Name",
        new_tenant_name: "New Name",
      },
    ],
    "2026-06-26T12:00:00.000Z"
  );

  assert.equal(out.drift_created, 1);
  assert.equal(inserts[0].property_code, "PENN");
});

test("recordOccupancyTenantNameDrifts inserts open flag for WESTFIELD", async () => {
  const inserts = [];
  const sb = {
    from(table) {
      if (table === "occupancy_drift_flags") {
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

  const out = await recordOccupancyTenantNameDrifts(
    sb,
    "WESTFIELD",
    [
      {
        unit_catalog_id: "11111111-1111-1111-1111-111111111111",
        unit_label: "305",
        previous_tenant_name: "Old Name",
        new_tenant_name: "New Name",
      },
    ],
    "2026-06-26T12:00:00.000Z"
  );

  assert.equal(out.drift_created, 1);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].status, "open");
  assert.equal(inserts[0].drift_kind, "tenant_name_change");
});

test("recordOccupancyTenantNameDrifts dedupes duplicate key", async () => {
  const sb = {
    from() {
      return {
        insert() {
          return Promise.resolve({
            error: { message: "duplicate key value violates unique constraint" },
          });
        },
      };
    },
  };

  const out = await recordOccupancyTenantNameDrifts(
    sb,
    "WESTFIELD",
    [
      {
        unit_catalog_id: "11111111-1111-1111-1111-111111111111",
        unit_label: "305",
        previous_tenant_name: "A",
        new_tenant_name: "B",
      },
    ],
    "2026-06-26T12:00:00.000Z"
  );
  assert.equal(out.drift_skipped_existing, 1);
});
