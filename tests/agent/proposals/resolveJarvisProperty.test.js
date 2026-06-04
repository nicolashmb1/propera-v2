const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveFromHints } = require("../../../src/agent/proposals/resolveJarvisProperty");
const {
  resolvePropertyByAddressHint,
  resolvePropertyFromDatabaseText,
} = require("../../../src/agent/proposals/resolvePropertyFromDatabaseText");

const GRAND_PORTFOLIO = [
  {
    code: "MORRIS",
    display_name: "The Grand at Morris",
    short_name: "Morris",
    address: "540 Morris ave, Elizabeth - NJ",
  },
  {
    code: "MURRAY",
    display_name: "The Grand at Murray",
    short_name: "Murray",
    address: "57 Murray st. Elizabeth - NJ",
  },
  {
    code: "PENN",
    display_name: "The Grand at Penn",
    short_name: "Penn",
    address: "702 Pennsylvania ave, Elizabeth - NJ",
  },
  {
    code: "WESTFIELD",
    display_name: "The Grand at Westfield",
    short_name: "Westfield",
    address: "618 Westfield ave, Elizabeth - NJ",
  },
  {
    code: "WESTGRAND",
    display_name: "The Grand at Westgrand",
    short_name: "Westgrand",
    address: "318 Westgrand ave, Elizabeth - NJ",
  },
];

const menu = {
  known: new Set(GRAND_PORTFOLIO.map((p) => p.code)),
  list: GRAND_PORTFOLIO,
};

describe("resolveFromHints", () => {
  it("resolves code token PENN", () => {
    const r = resolveFromHints(["PENN"], menu);
    assert.equal(r.ok, true);
    assert.equal(r.propertyCode, "PENN");
  });

  it("resolves spoken penn via name on search text", () => {
    const r = resolveFromHints([], menu, "402 penn refrigerator");
    assert.equal(r.ok, true);
    assert.equal(r.propertyCode, "PENN");
  });
});

describe("resolvePropertyByAddressHint", () => {
  it("resolves 702 pennsylvania to PENN", () => {
    const r = resolvePropertyByAddressHint("at 702 pennsylvania", GRAND_PORTFOLIO);
    assert.equal(r.status, "RESOLVED");
    assert.equal(r.property_code, "PENN");
  });

  it("resolves bare 618 to WESTFIELD", () => {
    const r = resolvePropertyByAddressHint("i am at 618", GRAND_PORTFOLIO);
    assert.equal(r.status, "RESOLVED");
    assert.equal(r.property_code, "WESTFIELD");
  });

  it("resolves 318 westgrand to WESTGRAND", () => {
    const r = resolvePropertyByAddressHint("318 westgrand", GRAND_PORTFOLIO);
    assert.equal(r.status, "RESOLVED");
    assert.equal(r.property_code, "WESTGRAND");
  });

  it("handles typo pennsyvalnia with street number", () => {
    const r = resolvePropertyFromDatabaseText(
      "702 pennsyvalnia",
      GRAND_PORTFOLIO,
      menu.known
    );
    assert.equal(r.status, "RESOLVED");
    assert.equal(r.property_code, "PENN");
  });
});
