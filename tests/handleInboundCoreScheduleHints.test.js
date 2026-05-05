/**
 * Characterization tests for pure schedule-hint helpers (handleInboundCore extraction).
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  isPortalCreateTicketRouter,
  extractScheduleHintStaffCapture,
  extractScheduleHintStaffCaptureFromTurn,
  extractScheduleHintPortalStaff,
  extractScheduleHintPortalStaffMulti,
} = require("../src/brain/core/handleInboundCoreScheduleHints");

describe("handleInboundCoreScheduleHints", () => {
  test("isPortalCreateTicketRouter — false when missing or wrong", () => {
    assert.equal(isPortalCreateTicketRouter(undefined), false);
    assert.equal(isPortalCreateTicketRouter({}), false);
    assert.equal(isPortalCreateTicketRouter({ _portalAction: "other" }), false);
    assert.equal(isPortalCreateTicketRouter({ _portalAction: "  " }), false);
  });

  test("isPortalCreateTicketRouter — true for create_ticket (case-insensitive)", () => {
    assert.equal(isPortalCreateTicketRouter({ _portalAction: "create_ticket" }), true);
    assert.equal(isPortalCreateTicketRouter({ _portalAction: "Create_Ticket" }), true);
    assert.equal(isPortalCreateTicketRouter({ _portalAction: "  CREATE_TICKET  " }), true);
  });

  test("extractScheduleHintStaffCapture — scheduleRaw wins when long enough", () => {
    assert.equal(
      extractScheduleHintStaffCapture({ scheduleRaw: "tomorrow 9am" }, ""),
      "tomorrow 9am"
    );
  });

  test("extractScheduleHintStaffCapture — Preferred line when scheduleRaw short", () => {
    assert.equal(
      extractScheduleHintStaffCapture(
        { scheduleRaw: "x" },
        "issue text\nPreferred: next Tuesday 2pm to 4pm\nthanks"
      ),
      "next Tuesday 2pm to 4pm"
    );
  });

  test("extractScheduleHintStaffCapture — empty when nothing usable", () => {
    assert.equal(extractScheduleHintStaffCapture(null, "no preferred line"), "");
    assert.equal(extractScheduleHintStaffCapture({ scheduleRaw: "" }, ""), "");
  });

  test("extractScheduleHintStaffCaptureFromTurn — merged draft_schedule_raw wins", () => {
    assert.equal(
      extractScheduleHintStaffCaptureFromTurn(
        { draft_schedule_raw: "Mon 10-2" },
        { scheduleRaw: "Sun all day" },
        ""
      ),
      "Mon 10-2"
    );
  });

  test("extractScheduleHintStaffCaptureFromTurn — falls back to staff capture", () => {
    assert.equal(
      extractScheduleHintStaffCaptureFromTurn(
        { draft_schedule_raw: "" },
        { scheduleRaw: "Friday noon" },
        ""
      ),
      "Friday noon"
    );
  });

  test("extractScheduleHintPortalStaff — portal JSON preferredWindow", () => {
    const rp = {
      _portalPayloadJson: JSON.stringify({ preferredWindow: "Sat morning 8-12" }),
    };
    assert.equal(
      extractScheduleHintPortalStaff({ scheduleRaw: "" }, "", rp),
      "Sat morning 8-12"
    );
  });

  test("extractScheduleHintPortalStaff — invalid JSON ignored", () => {
    assert.equal(
      extractScheduleHintPortalStaff({ scheduleRaw: "" }, "", {
        _portalPayloadJson: "{not json",
      }),
      ""
    );
  });

  test("extractScheduleHintPortalStaffMulti — merged schedule wins", () => {
    assert.equal(
      extractScheduleHintPortalStaffMulti(
        { draft_schedule_raw: "merged window" },
        "Preferred: ignored\n",
        {}
      ),
      "merged window"
    );
  });

  test("extractScheduleHintPortalStaffMulti — delegates with blank fastDraft scheduleRaw", () => {
    const rp = {
      _portalPayloadJson: JSON.stringify({ preferredWindow: "from json only" }),
    };
    assert.equal(
      extractScheduleHintPortalStaffMulti({ draft_schedule_raw: "" }, "", rp),
      "from json only"
    );
  });
});
