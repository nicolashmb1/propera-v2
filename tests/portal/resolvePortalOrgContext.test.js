"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveAllowlistFromJwt,
} = require("../../src/portal/resolvePortalOrgContext");
const { filterRowsByOrgPropertyScope } = require("../../src/portal/portalOrgScope");

function memorySb(seed) {
  const tables = {
    portal_auth_allowlist: [...(seed.portal_auth_allowlist || [])],
    organizations: [...(seed.organizations || [])],
    properties: [...(seed.properties || [])],
  };

  return {
    auth: {
      getUser: async (tok) => {
        if (tok === "valid-jwt") {
          return {
            data: { user: { id: "uid-1", email: "ops@example.com" } },
            error: null,
          };
        }
        return { data: { user: null }, error: new Error("invalid") };
      },
    },
    from(table) {
      const rows = tables[table] || [];
      const state = { filters: [] };
      const api = {
        select() {
          return api;
        },
        eq(col, val) {
          state.filters.push([col, val]);
          return api;
        },
        maybeSingle: async () => {
          const match = rows.find((r) =>
            state.filters.every(([c, v]) => String(r[c]) === String(v))
          );
          return { data: match || null, error: null };
        },
      };
      return api;
    },
  };
}

test("resolveAllowlistFromJwt returns org_id from allowlist", async () => {
  const sb = memorySb({
    portal_auth_allowlist: [
      {
        auth_user_id: "uid-1",
        email_lower: "ops@example.com",
        org_id: "grand",
        portal_role: "Owner",
        staff_id: "STAFF_NICK",
        active: true,
      },
    ],
  });
  const out = await resolveAllowlistFromJwt(sb, "valid-jwt");
  assert.equal(out.ok, true);
  assert.equal(out.orgId, "grand");
  assert.equal(out.portalRole, "Owner");
});

test("filterRowsByOrgPropertyScope drops other-org tickets", () => {
  const scope = { propertyCodesUpper: new Set(["PENN"]) };
  const rows = [
    { property_code: "PENN", ticket_id: "1" },
    { property_code: "MORRIS", ticket_id: "2" },
  ];
  const out = filterRowsByOrgPropertyScope(rows, scope);
  assert.equal(out.length, 1);
  assert.equal(out[0].ticket_id, "1");
});
