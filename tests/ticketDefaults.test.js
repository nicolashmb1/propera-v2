const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatHumanTicketId,
  localCategoryFromText,
  inferEmergency,
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
      "General",
      "deterministic fallback when no keyword matches"
    );

  });

  test("inferEmergency", () => {
    assert.equal(inferEmergency("small scratch").emergency, "No");
    assert.equal(inferEmergency("gas leak in unit").emergency, "Yes");
  });
});
