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

  test("ticket_prefix token resolves property code (GAS variant parity)", () => {
    const known = new Set(["PENN", "MORRIS"]);
    const props = [
      { code: "PENN", display_name: "Property PENN", ticket_prefix: "PENN", short_name: "Penn", address: "702 Pennsylvania ave", aliases: [] },
      { code: "MORRIS", display_name: "Property MORRIS", ticket_prefix: "MORR", short_name: "Morris", address: "540 Morris ave", aliases: [] },
    ];
    const d = parseMaintenanceDraft("water leak morr unit 402", known, props);
    assert.equal(d.propertyCode, "MORRIS");
  });

  test("short_name/address token resolves property code (GAS variant parity)", () => {
    const known = new Set(["PENN", "MORRIS"]);
    const props = [
      { code: "PENN", display_name: "Property PENN", ticket_prefix: "PENN", short_name: "Penn", address: "702 Pennsylvania ave", aliases: [] },
      { code: "MORRIS", display_name: "Property MORRIS", ticket_prefix: "MORR", short_name: "Morris", address: "540 Morris ave", aliases: [] },
    ];
    const byShortName = parseMaintenanceDraft("heater issue at penn", known, props);
    assert.equal(byShortName.propertyCode, "PENN");
    const byAddressToken = parseMaintenanceDraft("ac issue at pennsylvania ave unit 1", known, props);
    assert.equal(byAddressToken.propertyCode, "PENN");
  });

  test("common area text sets locationType COMMON_AREA", () => {
    const known = new Set(["PENN"]);
    const d = parseMaintenanceDraft("hallway light out at penn", known);
    assert.equal(d.locationType, "COMMON_AREA");
  });

  test("common area draft can finalize without unit", () => {
    const d = {
      propertyCode: "PENN",
      unitLabel: "",
      issueText: "hallway light out",
      locationType: "COMMON_AREA",
    };
    assert.equal(isMaintenanceDraftComplete(d), true);
  });
});
