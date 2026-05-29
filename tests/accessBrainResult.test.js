const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildListSlotsFacts,
  buildReserveRejectedFacts,
  narrateAccessBrainResult,
} = require("../src/access/accessBrainResult");

describe("accessBrainResult", () => {
  it("narrates open day with operating hours from list_slots facts", () => {
    const facts = buildListSlotsFacts({
      locationName: "Game Room",
      dayLabel: "5/28/2026",
      bookedRanges: [],
      operatingHoursLabel: "8:00 AM–11:00 PM",
    });
    const text = narrateAccessBrainResult(facts);
    assert.match(text, /nothing booked yet/i);
    assert.match(text, /8:00 AM/i);
    assert.match(text, /11:00 PM/i);
  });

  it("narrates closed day from list_slots facts", () => {
    const facts = buildListSlotsFacts({
      locationName: "Game Room",
      dayLabel: "5/28/2026",
      bookedRanges: [],
      closedDay: true,
    });
    const text = narrateAccessBrainResult(facts);
    assert.match(text, /closed on 5\/28\/2026/i);
  });

  it("narrates slot_full with booked ranges", () => {
    const facts = buildReserveRejectedFacts({
      locationName: "Game Room",
      dayLabel: "5/28/2026",
      reason: "slot_full",
      bookedRanges: [{ start: "3:00 PM", end: "5:00 PM" }],
    });
    const text = narrateAccessBrainResult(facts);
    assert.match(text, /3:00 PM-5:00 PM/);
    assert.match(text, /overlaps/i);
  });
});
