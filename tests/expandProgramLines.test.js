const test = require("node:test");
const assert = require("node:assert/strict");
const {
  expandProgramLines,
  formatUnitScopeLabel,
  sortUnitRows,
} = require("../src/pm/expandProgramLines");

test("formatUnitScopeLabel prefixes Unit when missing", () => {
  assert.equal(formatUnitScopeLabel("101"), "Unit 101");
  assert.equal(formatUnitScopeLabel("Unit 2A"), "Unit 2A");
});

test("sortUnitRows sorts numerically where locale supports", () => {
  const sorted = sortUnitRows([
    { unit_label: "10" },
    { unit_label: "2" },
    { unit_label: "Unit 101" },
  ]);
  assert.equal(sorted.map((r) => r.unit_label).join(","), "2,10,Unit 101");
});

test("UNIT_PLUS_COMMON expands units + Common Area", () => {
  const template = {
    expansion_type: "UNIT_PLUS_COMMON",
    default_scope_labels: null,
  };
  const lines = expandProgramLines(template, [
    { unit_label: "101" },
    { unit_label: "102" },
  ]);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].scope_type, "UNIT");
  assert.equal(lines[0].scope_label, "Unit 101");
  assert.equal(lines[2].scope_type, "COMMON_AREA");
  assert.equal(lines[2].scope_label, "Common Area");
});

test("UNIT_PLUS_COMMON uses common_paint_scopes from profile when set", () => {
  const template = { expansion_type: "UNIT_PLUS_COMMON", default_scope_labels: null };
  const lines = expandProgramLines(
    template,
    [{ unit_label: "101" }],
    { expansionProfile: { common_paint_scopes: ["Gym", "Lobby"] } }
  );
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => ({ t: l.scope_type, s: l.scope_label })),
    [
      { t: "UNIT", s: "Unit 101" },
      { t: "COMMON_AREA", s: "Gym" },
      { t: "COMMON_AREA", s: "Lobby" },
    ]
  );
});

test("FLOOR_BASED uses template default_scope_labels", () => {
  const template = {
    expansion_type: "FLOOR_BASED",
    default_scope_labels: ["A", "B"],
  };
  const lines = expandProgramLines(template, []);
  assert.deepEqual(
    lines.map((l) => l.scope_label),
    ["A", "B"]
  );
  assert.ok(lines.every((l) => l.scope_type === "FLOOR"));
});

test("FLOOR_BASED falls back when defaults empty", () => {
  const template = { expansion_type: "FLOOR_BASED", default_scope_labels: null };
  const lines = expandProgramLines(template, []);
  assert.ok(lines.length >= 4);
  assert.ok(lines.some((l) => /1st Floor/i.test(l.scope_label)));
});

test("FLOOR_BASED uses properties.program_expansion_profile.floor_paint_scopes when set", () => {
  const template = {
    expansion_type: "FLOOR_BASED",
    default_scope_labels: ["Template", "Default"],
  };
  const lines = expandProgramLines(template, [], {
    expansionProfile: { floor_paint_scopes: ["Lobby", "Roof"] },
  });
  assert.deepEqual(
    lines.map((l) => l.scope_label),
    ["Lobby", "Roof"]
  );
});

test("FLOOR_BASED appends common_paint_scopes as COMMON_AREA lines after floors", () => {
  const template = { expansion_type: "FLOOR_BASED", default_scope_labels: null };
  const lines = expandProgramLines(template, [], {
    expansionProfile: {
      floor_paint_scopes: ["1st floor", "2nd floor"],
      common_paint_scopes: ["Gym", "Lobby"],
    },
  });
  assert.equal(lines.length, 4);
  assert.deepEqual(
    lines.map((l) => ({ t: l.scope_type, s: l.scope_label })),
    [
      { t: "FLOOR", s: "1st floor" },
      { t: "FLOOR", s: "2nd floor" },
      { t: "COMMON_AREA", s: "Gym" },
      { t: "COMMON_AREA", s: "Lobby" },
    ]
  );
  assert.deepEqual(lines.map((l) => l.sort_order), [0, 1, 2, 3]);
});

test("COMMON_AREA_ONLY uses common_paint_scopes when set", () => {
  const template = { expansion_type: "COMMON_AREA_ONLY", default_scope_labels: null };
  const lines = expandProgramLines(template, [], {
    expansionProfile: { common_paint_scopes: ["East stair", "Lobby"] },
  });
  assert.deepEqual(
    lines.map((l) => l.scope_label),
    ["East stair", "Lobby"]
  );
  assert.ok(lines.every((l) => l.scope_type === "COMMON_AREA"));
});

test("CUSTOM_MANUAL yields no lines", () => {
  const lines = expandProgramLines(
    { expansion_type: "CUSTOM_MANUAL" },
    [{ unit_label: "x" }]
  );
  assert.equal(lines.length, 0);
});
