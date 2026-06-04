const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveOrgPropertyScopeForQuery,
  assertPropertyInOrgScope,
} = require("../src/portal/portalOrgScope");

test("resolveOrgPropertyScopeForQuery fails closed without orgId", () => {
  const out = resolveOrgPropertyScopeForQuery({ propertyCodes: ["PENN"] });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.error, "org_context_required");
});

test("resolveOrgPropertyScopeForQuery fails closed with empty property list", () => {
  const out = resolveOrgPropertyScopeForQuery({ orgId: "grand", propertyCodes: [] });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.error, "org_has_no_properties");
});

test("assertPropertyInOrgScope rejects cross-org property", () => {
  const out = assertPropertyInOrgScope("OTHER", {
    orgId: "grand",
    propertyCodes: ["PENN", "MORRIS"],
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.error, "property_code_not_in_org_scope");
});

test("assertPropertyInOrgScope accepts in-scope property (normalized)", () => {
  const out = assertPropertyInOrgScope(" penn ", {
    orgId: "grand",
    propertyCodes: ["PENN", "MORRIS"],
  });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.propertyCode, "PENN");
});
