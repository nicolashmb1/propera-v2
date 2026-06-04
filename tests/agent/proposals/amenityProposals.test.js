const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildBookAmenityProposal,
} = require("../../../src/agent/proposals/bookAmenityReservation");
const {
  buildSetAmenityScheduleProposal,
  formatScheduleSummary,
} = require("../../../src/agent/proposals/setAmenitySchedule");
const { PROPOSAL_OPS } = require("../../../src/agent/proposals/types");
const { verifyProposalConfirmToken } = require("../../../src/agent/proposals/proposalToken");
const { extractProposalPortalFields } = require("../../../src/agent/proposals/proposalPortalFields");
const {
  buildAmenityBookingTimes,
  parseClockTime,
} = require("../../../src/agent/access/parseAmenityBookingTimes");
const { scoreLocationMatch } = require("../../../src/agent/proposals/resolveAccessLocation");
const { buildCancelAmenityProposal } = require("../../../src/agent/proposals/cancelAmenityReservation");
const {
  buildUpdateAmenityPolicyProposal,
  pickPolicyPatch,
} = require("../../../src/agent/proposals/updateAmenityPolicy");

describe("amenity booking times", () => {
  it("parses clock times", () => {
    assert.deepEqual(parseClockTime("3pm"), { hour: 15, minute: 0 });
    assert.deepEqual(parseClockTime("15:00"), { hour: 15, minute: 0 });
  });

  it("builds ISO range from date + times", () => {
    const built = buildAmenityBookingTimes({
      bookingDate: "2026-06-05",
      startTime: "3pm",
      endTime: "5pm",
    });
    assert.equal(built.ok, true);
    assert.ok(built.startAt);
    assert.ok(built.endAt);
    assert.ok(built.label);
  });
});

describe("book_amenity_reservation proposal", () => {
  it("builds proposal with portal fields", () => {
    const { proposal, confirmToken } = buildBookAmenityProposal(
      {
        locationId: "loc-1",
        locationName: "Gameroom",
        propertyCode: "PENN",
        unitLabel: "502",
        tenantId: "tenant-1",
        tenantName: "Jane Doe",
        startAt: "2026-06-05T19:00:00.000Z",
        endAt: "2026-06-05T21:00:00.000Z",
        bookingLabel: "6/5/2026, 3:00 PM – 5:00 PM",
      },
      "Book Gameroom — PENN unit 502"
    );

    assert.equal(proposal.op, PROPOSAL_OPS.BOOK_AMENITY_RESERVATION);
    assert.equal(proposal.payload.location_name, "Gameroom");
    assert.ok(confirmToken);

    const verified = verifyProposalConfirmToken(confirmToken);
    const fields = extractProposalPortalFields("book_amenity_reservation", verified.payload);
    assert.equal(fields.amenityName, "Gameroom");
    assert.equal(fields.unitLabel, "502");
    assert.equal(fields.propertyCode, "PENN");
    assert.equal(fields.tenantName, "Jane Doe");
  });
});

describe("set_amenity_schedule proposal", () => {
  it("formats schedule summary and builds proposal", () => {
    const schedules = [
      { dayOfWeek: 1, openTime: "08:00", closeTime: "23:00" },
      { dayOfWeek: 2, openTime: "08:00", closeTime: "23:00" },
    ];
    assert.equal(formatScheduleSummary(schedules), "Mon 08:00–23:00, Tue 08:00–23:00");

    const { proposal, confirmToken } = buildSetAmenityScheduleProposal(
      {
        locationId: "loc-1",
        locationName: "Gameroom",
        propertyCode: "PENN",
        schedules,
      },
      "Set Gameroom hours"
    );

    assert.equal(proposal.op, PROPOSAL_OPS.SET_AMENITY_SCHEDULE);
    assert.equal(proposal.payload.schedules.length, 2);
    assert.ok(confirmToken);

    const verified = verifyProposalConfirmToken(confirmToken);
    const fields = extractProposalPortalFields("set_amenity_schedule", verified.payload);
    assert.equal(fields.amenityName, "Gameroom");
    assert.equal(fields.propertyCode, "PENN");
    assert.ok(fields.scheduleSummary);
  });
});

describe("resolveAccessLocation scoring", () => {
  it("scores gameroom name match", () => {
    const loc = { name: "Gameroom", slug: "gameroom" };
    assert.ok(scoreLocationMatch(loc, "game room") >= 60);
    assert.equal(scoreLocationMatch(loc, "gameroom"), 100);
  });
});

describe("cancel_amenity_reservation proposal", () => {
  it("builds cancel proposal with booking label", () => {
    const { proposal, confirmToken } = buildCancelAmenityProposal(
      {
        reservationId: "res-1",
        locationName: "Gameroom",
        propertyCode: "PENN",
        unitLabel: "216",
        bookingLabel: "6/1/2026, 3:00 PM – 5:00 PM",
        status: "CONFIRMED",
      },
      "Cancel Gameroom unit 216"
    );

    assert.equal(proposal.op, PROPOSAL_OPS.CANCEL_AMENITY_RESERVATION);
    assert.ok(confirmToken);
    const verified = verifyProposalConfirmToken(confirmToken);
    assert.equal(verified.payload.reservation_id, "res-1");
  });
});

describe("update_amenity_policy proposal", () => {
  it("builds policy update proposal", () => {
    const { proposal, confirmToken } = buildUpdateAmenityPolicyProposal(
      {
        locationId: "loc-1",
        locationName: "Gameroom",
        propertyCode: "PENN",
        policyPatch: { maxDurationMin: 180 },
        policySummary: "max block 180 min",
      },
      "Update Gameroom rules"
    );

    assert.equal(proposal.op, PROPOSAL_OPS.UPDATE_AMENITY_POLICY);
    assert.equal(proposal.payload.policy_patch.maxDurationMin, 180);
    assert.ok(confirmToken);

    const verified = verifyProposalConfirmToken(confirmToken);
    const fields = extractProposalPortalFields("update_amenity_policy", verified.payload);
    assert.equal(fields.amenityName, "Gameroom");
    assert.equal(fields.policySummary, "max block 180 min");
    assert.equal(fields.maxDurationMin, 180);
  });
});

describe("pickPolicyPatch", () => {
  it("accepts max block aliases", () => {
    const patch = pickPolicyPatch({ max_block_min: 120 });
    assert.equal(patch.maxDurationMin, 120);
  });
});
