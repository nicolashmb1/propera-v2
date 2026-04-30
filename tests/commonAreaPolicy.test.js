const test = require("node:test");
const assert = require("node:assert/strict");
const {
  inferLocationTypeFromText,
  normalizeLocationType,
  isCommonAreaLocation,
} = require("../src/brain/shared/commonArea");

test("inferLocationTypeFromText detects common-area keywords", () => {
  assert.equal(
    inferLocationTypeFromText("Hallway lights are out near apt 101"),
    "COMMON_AREA"
  );
});

test("inferLocationTypeFromText detects amenity / gym as common-area hint", () => {
  assert.equal(
    inferLocationTypeFromText("water leak in the gym bathroom ceiling"),
    "COMMON_AREA"
  );
});

test("inferLocationTypeFromText keeps unit default without common-area markers", () => {
  assert.equal(inferLocationTypeFromText("sink leaking in unit 101"), "UNIT");
});

test("mixed-scope text resolves to COMMON_AREA when hallway is explicit", () => {
  assert.equal(
    inferLocationTypeFromText("unit 101 reports hallway sink leak"),
    "COMMON_AREA"
  );
  assert.equal(isCommonAreaLocation("COMMON_AREA"), true);
  assert.equal(normalizeLocationType("foo"), "UNIT");
});
