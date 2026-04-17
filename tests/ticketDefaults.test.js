const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatHumanTicketId,
  localCategoryFromText,
  inferEmergency,
  hardEmergency_,
  evaluateEmergencySignal_,
  detectEmergencyKind_,
} = require("../src/dal/ticketDefaults");

describe("ticketDefaults", () => {
  test("formatHumanTicketId shape", () => {
    const id = formatHumanTicketId("MURR");
    assert.match(id, /^MURR-\d{6}-\d{4}$/);
  });

  test("localCategoryFromText matches GAS 18_MESSAGING_ENGINE (examples)", () => {
    assert.equal(
      localCategoryFromText("Water pressure in kitchen sink is very slow"),
      "Plumbing"
    );
    assert.equal(localCategoryFromText("breaker tripped in kitchen"), "Electrical");
    assert.equal(
      localCategoryFromText("something is broken in the apartment"),
      "General"
    );
    assert.equal(
      localCategoryFromText("random gibberish xyzabc"),
      "",
      "GAS returns empty string when no keyword matches (line 702)"
    );
  });

  test("inferEmergency — GAS evaluateEmergencySignal_ / hardEmergency_", () => {
    assert.equal(inferEmergency("small scratch").emergency, "No");
    assert.equal(inferEmergency("gas leak in unit").emergency, "Yes");
    assert.match(inferEmergency("gas leak in unit").emergencyType, /GAS/);

    assert.equal(
      inferEmergency("smoke detector battery needs replacement").emergency,
      "No",
      "detector maintenance guard"
    );
    assert.equal(
      inferEmergency("smoke everywhere in the apartment").emergency,
      "Yes"
    );

    assert.equal(inferEmergency("active flooding in bathroom").emergency, "Yes");
    assert.equal(inferEmergency("sparks from outlet").emergency, "Yes");
  });

  test("hardEmergency_ structural parity", () => {
    assert.equal(hardEmergency_("").emergency, false);
    assert.equal(hardEmergency_("sewage backing up in basement").emergency, true);
  });

  test("detectEmergencyKind_ keywords", () => {
    assert.equal(detectEmergencyKind_("oven on fire"), "FIRE");
    assert.equal(detectEmergencyKind_("carbon monoxide alarm beeping"), "CO");
  });

  test("evaluateEmergencySignal_ secondary detectEmergencyKind_", () => {
    const r = evaluateEmergencySignal_("oven is on fire help");
    assert.equal(r.isEmergency, true);
    assert.equal(r.emergencyType, "FIRE");
  });
});
