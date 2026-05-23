const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPropertyStructureScopeSpecs,
  validateManualLineAgainstStructure,
} = require("../src/pm/programLineScopeOptions");

test("buildPropertyStructureScopeSpecs merges units floors and common areas", () => {
  const specs = buildPropertyStructureScopeSpecs({
    expansionProfile: {
      floor_paint_scopes: ["1st Floor"],
      common_paint_scopes: ["Gym"],
    },
    canonicalCommonAreaLabels: ["Lobby"],
    unitRows: [{ unit_label: "101" }],
  });
  assert.ok(specs.some((s) => s.scope_type === "UNIT" && s.scope_label === "Unit 101"));
  assert.ok(specs.some((s) => s.scope_type === "FLOOR" && s.scope_label === "1st Floor"));
  assert.ok(specs.some((s) => s.scope_type === "COMMON_AREA" && s.scope_label === "Gym"));
  assert.ok(specs.some((s) => s.scope_type === "COMMON_AREA" && s.scope_label === "Lobby"));
});

test("validateManualLineAgainstStructure allows SITE custom always", () => {
  const allowed = [{ scope_type: "COMMON_AREA", scope_label: "Gym" }];
  assert.equal(
    validateManualLineAgainstStructure({
      allowedSpecs: allowed,
      scopeType: "SITE",
      scopeLabel: "Ad-hoc roof walk",
    }).ok,
    true
  );
});

test("validateManualLineAgainstStructure rejects unknown label when structure exists", () => {
  const allowed = [{ scope_type: "COMMON_AREA", scope_label: "Gym" }];
  const r = validateManualLineAgainstStructure({
    allowedSpecs: allowed,
    scopeType: "COMMON_AREA",
    scopeLabel: "Random room",
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "label_not_in_property_structure");
});

test("validateManualLineAgainstStructure allows any label when no structure", () => {
  assert.equal(
    validateManualLineAgainstStructure({
      allowedSpecs: [],
      scopeType: "COMMON_AREA",
      scopeLabel: "Anything",
    }).ok,
    true
  );
});
