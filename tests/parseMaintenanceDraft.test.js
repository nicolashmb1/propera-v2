const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseMaintenanceDraft,
  isMaintenanceDraftComplete,
} = require("../src/brain/core/parseMaintenanceDraft");

describe("parseMaintenanceDraft", () => {
  test("sink leaking 303 penn", () => {
    const known = new Set(["PENN", "MORRIS"]);
    const d = parseMaintenanceDraft(
      "my sink is leaking uni 303 penn",
      known
    );
    assert.equal(d.propertyCode, "PENN");
    assert.equal(d.unitLabel, "303");
    assert.ok(d.issueText.length >= 2);
    assert.equal(isMaintenanceDraftComplete(d), true);
  });

  test("incomplete without property", () => {
    const known = new Set(["PENN"]);
    const d = parseMaintenanceDraft("sink broken unit 12", known);
    assert.equal(isMaintenanceDraftComplete(d), false);
  });

  test("property name token resolves code (detectPropertyFromBody parity slice)", () => {
    const known = new Set(["PENN", "MORRIS"]);
    const props = [
      { code: "PENN", display_name: "Property PENN", aliases: ["penn building"] },
      { code: "MORRIS", display_name: "Property MORRIS", aliases: ["morris tower"] },
    ];
    const d = parseMaintenanceDraft("leak in 303 at morris", known, props);
    assert.equal(d.propertyCode, "MORRIS");
  });

  test("property alias resolves code (database-driven alias list)", () => {
    const known = new Set(["PENN", "MORRIS"]);
    const props = [
      { code: "PENN", display_name: "Property PENN", aliases: ["penn building"] },
      { code: "MORRIS", display_name: "Property MORRIS", aliases: ["morris tower"] },
    ];
    const d = parseMaintenanceDraft("heater issue at penn building unit 303", known, props);
    assert.equal(d.propertyCode, "PENN");
  });
});
