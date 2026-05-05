const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractHumanTicketIdAnywhere,
  looksLikeStaffNaturalTicketAmend,
} = require("../src/dal/staffTicketAmendNl");

describe("extractHumanTicketIdAnywhere", () => {
  test("finds id mid-sentence", () => {
    assert.equal(
      extractHumanTicketIdAnywhere("please change unit on penn-050426-6362 apt 322"),
      "PENN-050426-6362"
    );
  });

  test("empty when absent", () => {
    assert.equal(extractHumanTicketIdAnywhere("change apt 322 to 323"), "");
  });
});

describe("looksLikeStaffNaturalTicketAmend", () => {
  test("verb + unit swap without human id", () => {
    assert.equal(looksLikeStaffNaturalTicketAmend("change apt 322 to 323"), true);
  });

  test("human id + issue label", () => {
    assert.equal(
      looksLikeStaffNaturalTicketAmend(
        "PENN-050426-6362 issue: smoke detector still loose after visit."
      ),
      true
    );
  });

  test("rejects leading staff capture hash", () => {
    assert.equal(looksLikeStaffNaturalTicketAmend("#d42 apt 322"), false);
  });

  test("rejects strict Update line (handled by portal parser)", () => {
    assert.equal(looksLikeStaffNaturalTicketAmend("Update PENN-050426-6362 apt 322"), false);
  });

  test("rejects bare pleasantries", () => {
    assert.equal(looksLikeStaffNaturalTicketAmend("thanks!"), false);
  });

  test("schedule-style body with window text triggers amend gate", () => {
    assert.equal(
      looksLikeStaffNaturalTicketAmend(
        "Westgrand 304 shower door schedule for Friday afternoon"
      ),
      true
    );
  });
});
