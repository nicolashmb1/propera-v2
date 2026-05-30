const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveAssignee,
  loadStaffIdsForRoleAtProperty,
  MAINTENANCE_DEFAULT_ROLE,
} = require("../src/responsibility/resolveAssignee");

function mockSupabase(tables) {
  const db = {
    properties: tables.properties || [],
    staff_property_roles: tables.staff_property_roles || [],
    staff: tables.staff || [],
  };

  return {
    from(table) {
      const rows = db[table] || [];
      const filters = [];
      const chain = {
        select() {
          return chain;
        },
        eq(col, val) {
          filters.push({ col, val });
          return chain;
        },
        maybeSingle() {
          const matched = rows.filter((row) =>
            filters.every((f) => String(row[f.col]) === String(f.val))
          );
          return Promise.resolve({ data: matched[0] || null, error: null });
        },
        then(resolve, reject) {
          const matched = rows.filter((row) =>
            filters.every((f) => String(row[f.col]) === String(f.val))
          );
          return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

describe("resolveAssignee — maintenance", () => {
  it("returns primary building_super for property", async () => {
    const sb = mockSupabase({
      properties: [{ code: "MORRIS", org_id: "grand", active: true }],
      staff_property_roles: [
        {
          org_id: "grand",
          property_code: "MORRIS",
          role_key: MAINTENANCE_DEFAULT_ROLE,
          staff_id: "STAFF_GEFF",
          is_primary: true,
          active: true,
        },
        {
          org_id: "grand",
          property_code: "MORRIS",
          role_key: MAINTENANCE_DEFAULT_ROLE,
          staff_id: "STAFF_NICK",
          is_primary: false,
          active: true,
        },
      ],
      staff: [
        {
          org_id: "grand",
          staff_id: "STAFF_GEFF",
          display_name: "Geff",
          active: true,
        },
      ],
    });

    const out = await resolveAssignee(sb, { propertyCode: "MORRIS", module: "maintenance" });
    assert.equal(out.ok, true);
    assert.equal(out.assigneeId, "STAFF_GEFF");
    assert.equal(out.assigneeName, "Geff");
    assert.equal(out.source, "TEAM_ROUTING");
    assert.equal(out.ruleId, "maintenance:building_super");
  });

  it("returns empty when no coverage row (team owns truth — no silent policy fallback)", async () => {
    const sb = mockSupabase({
      properties: [{ code: "PENN", org_id: "grand", active: true }],
      staff_property_roles: [],
      staff: [],
    });

    const out = await resolveAssignee(sb, { propertyCode: "PENN", module: "maintenance" });
    assert.equal(out.ok, true);
    assert.equal(out.assigneeId, "");
    assert.equal(out.empty, true);
  });

  it("ignores inactive staff rows", async () => {
    const sb = mockSupabase({
      properties: [{ code: "PENN", org_id: "grand", active: true }],
      staff_property_roles: [
        {
          org_id: "grand",
          property_code: "PENN",
          role_key: MAINTENANCE_DEFAULT_ROLE,
          staff_id: "STAFF_NICK",
          is_primary: true,
          active: true,
        },
      ],
      staff: [
        {
          org_id: "grand",
          staff_id: "STAFF_NICK",
          display_name: "Nick",
          active: false,
        },
      ],
    });

    const out = await resolveAssignee(sb, { propertyCode: "PENN", module: "maintenance" });
    assert.equal(out.ok, true);
    assert.equal(out.assigneeId, "");
    assert.equal(out.empty, true);
  });

  it("loadStaffIdsForRoleAtProperty picks primary", async () => {
    const sb = mockSupabase({
      staff_property_roles: [
        {
          org_id: "grand",
          property_code: "WESTGRAND",
          role_key: MAINTENANCE_DEFAULT_ROLE,
          staff_id: "STAFF_NICK",
          is_primary: true,
          active: true,
        },
      ],
    });

    const out = await loadStaffIdsForRoleAtProperty(
      sb,
      "grand",
      "WESTGRAND",
      MAINTENANCE_DEFAULT_ROLE
    );
    assert.equal(out.ok, true);
    assert.deepEqual(out.staffIds, ["STAFF_NICK"]);
  });
});
