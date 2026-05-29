const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldConfirmReserveHandoff,
  affirmativeMeansListSlots,
  isAvailabilityQuestion,
} = require("../../src/adapters/tenantAgent/accessConversationSignals");

describe("accessConversationSignals", () => {
  it("does not confirm reserve when assistant offered availability check", () => {
    const messages = [
      { role: "assistant", content: "Would you like to check for other available times?" },
    ];
    assert.equal(shouldConfirmReserveHandoff("yes", messages), false);
    assert.equal(affirmativeMeansListSlots("yes", messages), true);
  });

  it("confirms reserve when assistant asked to confirm booking", () => {
    const messages = [
      {
        role: "assistant",
        content: "You want the game room tomorrow 3-6 pm — is that correct?",
      },
    ];
    assert.equal(shouldConfirmReserveHandoff("yes", messages), true);
    assert.equal(affirmativeMeansListSlots("yes", messages), false);
  });

  it("detects availability questions", () => {
    assert.equal(isAvailabilityQuestion("what times are available than?"), true);
  });

  it("detects booking time correction", () => {
    const { isAccessBookingCorrection } = require("../../src/adapters/tenantAgent/accessConversationSignals");
    assert.equal(
      isAccessBookingCorrection("11 to 1? i said 3-5", {
        last_brain_result: { brain: "access_reserved", replyText: "Booked Game Room" },
      }),
      true
    );
  });

  it("detects day correction after amenity booking", () => {
    const {
      isAccessBookingCorrection,
      extractDateForDayFromText,
    } = require("../../src/adapters/tenantAgent/accessConversationSignals");
    const conv = {
      partial_package: {
        _access_last_booking: {
          reservationId: "res-1",
          startAt: "2026-05-28T14:00:00.000Z",
          endAt: "2026-05-28T17:00:00.000Z",
        },
      },
      last_brain_result: { brain: "access_reserved", replyText: "Booked Game Room PIN: 1234" },
    };
    const msg = "oh sorry. my bad. the party will be saturday not sunday.";
    assert.equal(isAccessBookingCorrection(msg, conv), true);
    assert.equal(extractDateForDayFromText(msg), "saturday");
  });
});
