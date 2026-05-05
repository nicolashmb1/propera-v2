const test = require("node:test");
const assert = require("node:assert/strict");
const {
  inferLocationTypeFromText,
  normalizeLocationType,
  isCommonAreaLocation,
  resolveMaintenanceDraftLocationType,
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

test("resolveMaintenanceDraftLocationType uses effectiveBody when issueText strips common area", () => {
  const body =
    "elevator 2 on murray it's not working. Common area";
  const strippedIssue = "elevator 2 on murray it's not working";
  assert.equal(
    resolveMaintenanceDraftLocationType(
      { locationType: "UNIT", issueText: strippedIssue },
      body,
      strippedIssue,
      strippedIssue
    ),
    "COMMON_AREA"
  );
});

test("resolveMaintenanceDraftLocationType trusts parser COMMON_AREA over hint text", () => {
  assert.equal(
    resolveMaintenanceDraftLocationType(
      { locationType: "COMMON_AREA" },
      "sink in 101",
      "sink in 101"
    ),
    "COMMON_AREA"
  );
});

test("resolveMaintenanceDraftLocationType — elevator with property, no unit → COMMON_AREA", () => {
  assert.equal(
    resolveMaintenanceDraftLocationType(
      { locationType: "UNIT", unitLabel: "" },
      "Elevator on Murray not working",
      "Elevator on Murray not working"
    ),
    "COMMON_AREA"
  );
});

test("resolveMaintenanceDraftLocationType — elevator + explicit unit stays UNIT", () => {
  assert.equal(
    resolveMaintenanceDraftLocationType(
      { locationType: "UNIT", unitLabel: "305" },
      "elevator noise reported from unit 305",
      "elevator noise reported from unit 305"
    ),
    "UNIT"
  );
});
