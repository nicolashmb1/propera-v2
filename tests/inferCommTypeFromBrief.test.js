const test = require("node:test");
const assert = require("node:assert/strict");
const { inferCommTypeFromBrief } = require("../src/agent/proposals/inferCommTypeFromBrief");

test("inferCommTypeFromBrief — parking / belongings → POLICY_REMINDER", () => {
  assert.equal(
    inferCommTypeFromBrief("tenants must remove all belongings from the parking spot"),
    "POLICY_REMINDER"
  );
});

test("inferCommTypeFromBrief — maintenance shutoff → MAINTENANCE_NOTICE", () => {
  assert.equal(
    inferCommTypeFromBrief("water shutoff tomorrow for pipe repair"),
    "MAINTENANCE_NOTICE"
  );
});

test("inferCommTypeFromBrief — default → BUILDING_UPDATE", () => {
  assert.equal(inferCommTypeFromBrief("lobby will close early on Friday"), "BUILDING_UPDATE");
});

test("inferCommTypeFromBrief — explicit override wins", () => {
  assert.equal(
    inferCommTypeFromBrief("parking rules", "EMERGENCY_ALERT"),
    "EMERGENCY_ALERT"
  );
});
