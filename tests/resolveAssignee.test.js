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
    org_assignment_rules: tables.org_assignment_rules || null,
  };

  function matchRows(table, filters) {
    const rows = db[table] || [];
    return rows.filter((row) => filters.every((f) => String(row[f.col]) === String(f.val)));
  }

  return {
    from(table) {
      if (db[table] === null) {
        const missingErr = { code: "42P01", message: "missing" };
        const missingChain = {
          select() {
            return missingChain;
          },
          eq() {
            return missingChain;
          },
          order() {
            return missingChain;
          },
          maybeSingle() {
            return Promise.resolve({ data: null, error: missingErr });
          },
          then(resolve, reject) {
            return Promise.resolve({ data: null, error: missingErr }).then(resolve, reject);
          },
        };
        return missingChain;
      }

      const rows = db[table] || [];
      const filters = [];
      let orderCol = null;
      let orderAsc = true;
      const chain = {
        select() {
          return chain;
        },
        eq(col, val) {
          filters.push({ col, val });
          return chain;
        },
        order(col, opts) {
          orderCol = col;
          orderAsc = !(opts && opts.ascending === false);
          return chain;
        },
        maybeSingle() {
          const matched = matchRows(table, filters);
          return Promise.resolve({ data: matched[0] || null, error: null });
        },
        then(resolve, reject) {
          let matched = matchRows(table, filters);
          if (orderCol) {
            matched = matched.slice().sort((a, b) => {
              const av = a[orderCol];
              const bv = b[orderCol];
              if (av === bv) return 0;
              return (av < bv ? -1 : 1) * (orderAsc ? 1 : -1);
            });
          }
          return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

const DEFAULT_MAINTENANCE_RULES = [
  {
    org_id: "grand",
    rule_key: "maintenance:building_super",
    enabled: true,
    priority: 10,
    module: "maintenance",
    property_code: "*",
    category_match: "",
    target_kind: "primary_role",
    target_ref: "building_super",
    assign_mode: "staff",
  },
  {
    org_id: "grand",
    rule_key: "maintenance:maintenance_tech_fallback",
    enabled: true,
    priority: 20,
    module: "maintenance",
    property_code: "*",
    category_match: "",
    target_kind: "primary_role",
    target_ref: "maintenance_tech",
    assign_mode: "staff",
  },
];

describe("resolveAssignee — maintenance", () => {
  it("returns primary building_super for property via assignment rules", async () => {
    const sb = mockSupabase({
      properties: [{ code: "MORRIS", org_id: "grand", active: true }],
      org_assignment_rules: DEFAULT_MAINTENANCE_RULES,
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

  it("falls back to maintenance_tech rule when building super missing", async () => {
    const sb = mockSupabase({
      properties: [{ code: "PENN", org_id: "grand", active: true }],
      org_assignment_rules: DEFAULT_MAINTENANCE_RULES,
      staff_property_roles: [
        {
          org_id: "grand",
          property_code: "PENN",
          role_key: "maintenance_tech",
          staff_id: "STAFF_NICK",
          is_primary: false,
          active: true,
        },
      ],
      staff: [
        {
          org_id: "grand",
          staff_id: "STAFF_NICK",
          display_name: "Nick",
          active: true,
        },
      ],
    });

    const out = await resolveAssignee(sb, { propertyCode: "PENN", module: "maintenance" });
    assert.equal(out.ok, true);
    assert.equal(out.assigneeId, "STAFF_NICK");
    assert.equal(out.ruleId, "maintenance:maintenance_tech_fallback");
  });

  it("returns empty when no coverage row (team owns truth — no silent policy fallback)", async () => {
    const sb = mockSupabase({
      properties: [{ code: "PENN", org_id: "grand", active: true }],
      org_assignment_rules: DEFAULT_MAINTENANCE_RULES,
      staff_property_roles: [],
      staff: [],
    });

    const out = await resolveAssignee(sb, { propertyCode: "PENN", module: "maintenance" });
    assert.equal(out.ok, true);
    assert.equal(out.assigneeId, "");
    assert.equal(out.empty, true);
  });

  it("legacy path when org_assignment_rules table missing", async () => {
    const sb = mockSupabase({
      properties: [{ code: "MORRIS", org_id: "grand", active: true }],
      org_assignment_rules: null,
      staff_property_roles: [
        {
          org_id: "grand",
          property_code: "MORRIS",
          role_key: MAINTENANCE_DEFAULT_ROLE,
          staff_id: "STAFF_GEFF",
          is_primary: true,
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
    assert.equal(out.ruleId, "maintenance:building_super");
  });

  it("ignores inactive staff rows", async () => {
    const sb = mockSupabase({
      properties: [{ code: "PENN", org_id: "grand", active: true }],
      org_assignment_rules: DEFAULT_MAINTENANCE_RULES,
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
