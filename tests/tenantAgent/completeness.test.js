"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { completenessCheck } = require("../../src/adapters/tenantAgent/completeness");

test("completenessCheck — requires property, unit, issue; schedule is post-create optional", () => {
  const known = new Set(["PENN"]);
  assert.deepEqual(completenessCheck({}, known), { ready: false, missing: "property" });
  assert.deepEqual(completenessCheck({ property: "PENN" }, known), {
    ready: false,
    missing: "unit",
  });
  assert.deepEqual(
    completenessCheck({ property: "PENN", unit: "410" }, known),
    { ready: false, missing: "issue" }
  );
  assert.deepEqual(
    completenessCheck({ property: "PENN", unit: "410", issue: "heat out" }, known),
    { ready: true, missing: null }
  );
});

test("completenessCheck — common_area skips unit and schedule", () => {
  const known = new Set(["PENN"]);
  assert.deepEqual(
    completenessCheck(
      {
        property: "PENN",
        issue: "lobby light",
        location_kind: "common_area",
      },
      known
    ),
    { ready: true, missing: null }
  );
});
