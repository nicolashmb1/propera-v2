const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveFinalizeLocationFromProgramLine,
  unitLabelFromScope,
} = require("../src/pm/createTicketFromProgramLine");

test("unitLabelFromScope strips Unit prefix", () => {
  assert.equal(unitLabelFromScope("Unit 101"), "101");
  assert.equal(unitLabelFromScope("2A"), "2A");
});

test("resolveFinalizeLocationFromProgramLine maps UNIT scope", async () => {
  const loc = await resolveFinalizeLocationFromProgramLine(null, "PENN", {
    scope_type: "UNIT",
    scope_label: "Unit 4B",
  });
  assert.equal(loc.locationType, "UNIT");
  assert.equal(loc.unitLabel, "4B");
});

test("resolveFinalizeLocationFromProgramLine maps FLOOR to common area label", async () => {
  const loc = await resolveFinalizeLocationFromProgramLine(null, "PENN", {
    scope_type: "FLOOR",
    scope_label: "2nd Floor",
  });
  assert.equal(loc.locationType, "COMMON_AREA");
  assert.equal(loc.locationLabelSnapshot, "2nd Floor");
});
