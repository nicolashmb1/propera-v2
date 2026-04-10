const test = require("node:test");
const assert = require("node:assert/strict");
const { extractUnit } = require("../src/brain/shared/extractUnitGas");

test("GAS parity — 'not' in sentence yields no unit", () => {
  assert.equal(
    extractUnit(
      "my toilet is not flushing can someone come to check it please"
    ),
    ""
  );
});

test("explicit unit/apt pattern", () => {
  assert.equal(extractUnit("leaking in unit 303 please"), "303");
});

test("last-number fallback (303 penn)", () => {
  assert.equal(extractUnit("my sink is leaking uni 303 penn"), "303");
});
