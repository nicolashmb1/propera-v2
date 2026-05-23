"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { buildTicketDayCurve, isOpenForOpsStatus } = require("../src/portal/ticketDayCurveCore");
const { endOfHourUtcMs } = require("../src/portal/ticketDayCurveTime");

const TZ = "UTC";

describe("ticketDayCurveCore", () => {
  test("8am open includes carryover; 7am completion counts at 8am cumulative", () => {
    const date = "2026-05-23";
    const tickets = [
      {
        id: "t1",
        status: "Open",
        created_at: "2026-05-22T10:00:00.000Z",
        closed_at: null,
      },
      {
        id: "t2",
        status: "Completed",
        created_at: "2026-05-23T05:00:00.000Z",
        closed_at: "2026-05-23T07:00:00.000Z",
      },
    ];
    const eventsByTicketId = {
      t2: [
        {
          occurred_at: "2026-05-23T07:00:00.000Z",
          event_kind: "resolved_closed",
          headline: "Ticket Completed",
          detail: "",
        },
      ],
    };

    const nowMs = endOfHourUtcMs(date, 12, TZ);
    const out = buildTicketDayCurve({
      date,
      timeZone: TZ,
      tickets,
      eventsByTicketId,
      nowMs,
    });

    const h8 = out.hours.find((h) => h.hour === 8);
    assert.ok(h8);
    assert.equal(h8.open, 1, "t1 open at 8am");
    assert.equal(h8.completedCumulative, 1, "t2 completed 7am counts by 8am");
  });

  test("completion after 8pm counts in footer not in 8pm cumulative line only", () => {
    const date = "2026-05-23";
    const tickets = [
      {
        id: "t1",
        status: "Completed",
        created_at: "2026-05-23T08:00:00.000Z",
        closed_at: "2026-05-23T15:00:00.000Z",
      },
      {
        id: "t2",
        status: "Completed",
        created_at: "2026-05-23T08:00:00.000Z",
        closed_at: "2026-05-23T21:30:00.000Z",
      },
    ];
    const eventsByTicketId = {};

    const nowMs = endOfHourUtcMs(date, 22, TZ);
    const out = buildTicketDayCurve({
      date,
      timeZone: TZ,
      tickets,
      eventsByTicketId,
      nowMs,
    });

    const h20 = out.hours.find((h) => h.hour === 20);
    assert.equal(h20.completedCumulative, 1, "only 3pm close by 8pm line");
    assert.equal(out.summary.completedTotal, 2);
    assert.equal(out.summary.completedAfterDisplayWindow, 1);
  });

  test("open count can drop when tickets complete", () => {
    const date = "2026-05-23";
    const tickets = [
      {
        id: "a",
        status: "Open",
        created_at: "2026-05-23T08:00:00.000Z",
        closed_at: null,
      },
      {
        id: "b",
        status: "Open",
        created_at: "2026-05-23T08:30:00.000Z",
        closed_at: null,
      },
      {
        id: "c",
        status: "Completed",
        created_at: "2026-05-23T08:00:00.000Z",
        closed_at: "2026-05-23T10:30:00.000Z",
      },
    ];
    const eventsByTicketId = {};

    const nowMs = endOfHourUtcMs(date, 12, TZ);
    const out = buildTicketDayCurve({
      date,
      timeZone: TZ,
      tickets,
      eventsByTicketId,
      nowMs,
    });

    const h9 = out.hours.find((h) => h.hour === 9);
    const h11 = out.hours.find((h) => h.hour === 11);
    assert.ok(h9.open >= h11.open || h11.open <= h9.open);
    assert.equal(h9.open, 3);
    assert.equal(h11.open, 2);
  });

  test("openNow matches open deck when closed_at is set but status is non-terminal", () => {
    const date = "2026-05-23";
    const tickets = [
      {
        id: "stale",
        status: "Open",
        created_at: "2026-05-20T08:00:00.000Z",
        closed_at: "2026-05-22T12:00:00.000Z",
      },
      {
        id: "live",
        status: "Open",
        created_at: "2026-05-23T08:00:00.000Z",
        closed_at: null,
      },
    ];
    const nowMs = endOfHourUtcMs(date, 12, TZ);
    const out = buildTicketDayCurve({
      date,
      timeZone: TZ,
      tickets,
      eventsByTicketId: {},
      nowMs,
    });
    assert.equal(isOpenForOpsStatus("Open"), true);
    assert.equal(out.summary.openNow, 2);
    const lastPlotted = out.hours.filter((h) => !h.isFuture).pop();
    assert.ok(lastPlotted, "expected a plotted hour");
    assert.equal(
      lastPlotted.open,
      out.summary.openNow,
      "rightmost open point matches open deck count"
    );
  });
});
