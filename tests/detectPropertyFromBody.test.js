/**
 * GAS `detectPropertyFromBody_` — `PROPERA_MAIN_BACKUP.gs` ~13348–13412
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectPropertyFromBody,
} = require("../src/brain/staff/lifecycleExtract");

describe("detectPropertyFromBody (GAS parity)", () => {
  const props = [
    {
      code: "PENN",
      display_name: "The Grand Penn",
      ticket_prefix: "PENN",
      short_name: "",
      address: "",
      aliases: [],
    },
    {
      code: "MORRIS",
      display_name: "Morris Heights",
      ticket_prefix: "MORR",
      short_name: "",
      address: "",
      aliases: [],
    },
  ];

  test("menu digit 1–5 selects property by index", () => {
    assert.equal(detectPropertyFromBody("2 sink leak", props, new Set()), "MORRIS");
  });

  test("menu digit 6 does not match (GAS [1-5] only)", () => {
    assert.equal(detectPropertyFromBody("6 sink leak", props, new Set()), "");
  });

  test("ticket_prefix compact match (GAS step 2)", () => {
    assert.equal(detectPropertyFromBody("morr 12 leak", props, new Set()), "MORRIS");
  });

  test("strong name token (step 3)", () => {
    assert.equal(
      detectPropertyFromBody("issue at morris heights closet", props, new Set()),
      "MORRIS"
    );
  });
});
