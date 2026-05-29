const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveDay,
  resolveToday,
  dayBoundsForInstant,
  DAY_RESOLVE_KIND,
} = require("../../src/access/dayResolver");

const TZ = "America/New_York";

// 2026-05-27 is a Wednesday. We use noon UTC so that EDT/EST conversion
// always stays on the same calendar day regardless of DST.
const WED_2026_05_27 = new Date("2026-05-27T16:00:00.000Z"); // 12:00 EDT
const FRI_2026_03_06 = new Date("2026-03-06T17:00:00.000Z"); // before US spring-forward
const SUN_2026_03_08 = new Date("2026-03-08T08:00:00.000Z"); // spring-forward day (2am->3am EDT)
const SUN_2026_11_01 = new Date("2026-11-01T07:00:00.000Z"); // fall-back day (2am->1am EST)

describe("dayResolver — closed-set hint resolution", () => {
  it("'today' returns today in property TZ", () => {
    const r = resolveDay("today", WED_2026_05_27, TZ);
    assert.equal(r.kind, DAY_RESOLVE_KIND.TODAY);
    assert.equal(r.isoDate, "2026-05-27");
    assert.equal(r.weekday, "wednesday");
  });

  it("'tomorrow' returns next calendar day", () => {
    const r = resolveDay("tomorrow", WED_2026_05_27, TZ);
    assert.equal(r.kind, DAY_RESOLVE_KIND.TOMORROW);
    assert.equal(r.isoDate, "2026-05-28");
    assert.equal(r.weekday, "thursday");
  });

  it("empty/undefined hint defaults to tomorrow (defensive)", () => {
    const r = resolveDay("", WED_2026_05_27, TZ);
    assert.equal(r.kind, DAY_RESOLVE_KIND.TOMORROW);
    assert.equal(r.isoDate, "2026-05-28");
  });

  it("weekday 'saturday' from Wednesday returns the upcoming Saturday", () => {
    const r = resolveDay("saturday", WED_2026_05_27, TZ);
    assert.equal(r.kind, DAY_RESOLVE_KIND.WEEKDAY);
    assert.equal(r.isoDate, "2026-05-30");
    assert.equal(r.weekday, "saturday");
  });

  it("weekday 'sunday' from Wednesday returns the upcoming Sunday (4 days)", () => {
    const r = resolveDay("sunday", WED_2026_05_27, TZ);
    assert.equal(r.kind, DAY_RESOLVE_KIND.WEEKDAY);
    assert.equal(r.isoDate, "2026-05-31");
    assert.equal(r.weekday, "sunday");
  });

  it("weekday same as today rolls to next week (never returns today)", () => {
    const r = resolveDay("wednesday", WED_2026_05_27, TZ);
    assert.equal(r.kind, DAY_RESOLVE_KIND.WEEKDAY);
    assert.equal(r.isoDate, "2026-06-03");
  });

  it("weekday name is case-insensitive", () => {
    const r = resolveDay("SATURDAY", WED_2026_05_27, TZ);
    assert.equal(r.isoDate, "2026-05-30");
  });

  it("YYYY-MM-DD passes through as the canonical day", () => {
    const r = resolveDay("2026-07-04", WED_2026_05_27, TZ);
    assert.equal(r.kind, DAY_RESOLVE_KIND.ISO_DATE);
    assert.equal(r.isoDate, "2026-07-04");
    assert.equal(r.weekday, "saturday");
  });

  it("malformed YYYY-MM-DD (month=13) falls back to tomorrow", () => {
    const r = resolveDay("2026-13-01", WED_2026_05_27, TZ);
    assert.equal(r.kind, DAY_RESOLVE_KIND.TOMORROW);
    assert.equal(r.isoDate, "2026-05-28");
  });

  it("unrecognized hint falls back to tomorrow", () => {
    const r = resolveDay("next weekend", WED_2026_05_27, TZ);
    assert.equal(r.kind, DAY_RESOLVE_KIND.TOMORROW);
    assert.equal(r.isoDate, "2026-05-28");
  });
});

describe("dayResolver — anchor + day bounds", () => {
  it("anchorIso is noon-local in property TZ on the resolved day", () => {
    const r = resolveDay("tomorrow", WED_2026_05_27, TZ);
    const labelFull = new Date(r.anchorIso).toLocaleString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
    assert.match(labelFull, /^12:00$/);
  });

  it("startIso is midnight-local in property TZ", () => {
    const r = resolveDay("2026-05-31", WED_2026_05_27, TZ);
    const startLocal = new Date(r.startIso).toLocaleString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
    assert.match(startLocal, /^(00:00|24:00)$/);
  });

  it("endIso = startIso + 24h on a normal day", () => {
    const r = resolveDay("2026-05-31", WED_2026_05_27, TZ);
    const ms = new Date(r.endIso).getTime() - new Date(r.startIso).getTime();
    assert.equal(ms, 24 * 60 * 60 * 1000);
  });

  it("startIso < anchorIso < endIso for every kind", () => {
    for (const hint of ["today", "tomorrow", "saturday", "2026-12-25"]) {
      const r = resolveDay(hint, WED_2026_05_27, TZ);
      const s = new Date(r.startIso).getTime();
      const a = new Date(r.anchorIso).getTime();
      const e = new Date(r.endIso).getTime();
      assert.ok(s < a, `${hint}: start < anchor`);
      assert.ok(a < e, `${hint}: anchor < end`);
    }
  });
});

describe("dayResolver — DST transitions (America/New_York)", () => {
  it("spring-forward day has 23h between midnight-local and next-midnight-local", () => {
    // 2026-03-08 is the US spring-forward day in the US.
    const r = resolveDay("2026-03-08", FRI_2026_03_06, TZ);
    assert.equal(r.isoDate, "2026-03-08");
    const ms = new Date(r.endIso).getTime() - new Date(r.startIso).getTime();
    assert.equal(ms, 23 * 60 * 60 * 1000);
  });

  it("fall-back day has 25h between midnight-local and next-midnight-local", () => {
    const r = resolveDay("2026-11-01", SUN_2026_11_01, TZ);
    assert.equal(r.isoDate, "2026-11-01");
    const ms = new Date(r.endIso).getTime() - new Date(r.startIso).getTime();
    assert.equal(ms, 25 * 60 * 60 * 1000);
  });

  it("weekday resolution across spring-forward boundary returns correct date", () => {
    // From Friday 2026-03-06, "sunday" should be 2026-03-08 (DST day itself).
    const r = resolveDay("sunday", FRI_2026_03_06, TZ);
    assert.equal(r.isoDate, "2026-03-08");
  });

  it("noon-local anchor lands on the correct calendar day even on DST day", () => {
    const r = resolveDay("2026-03-08", FRI_2026_03_06, TZ);
    const localDay = new Date(r.anchorIso).toLocaleDateString("en-US", { timeZone: TZ });
    assert.match(localDay, /3\/8\/2026/);
  });
});

describe("dayResolver — resolveToday + dayBoundsForInstant", () => {
  it("resolveToday returns kind=today", () => {
    const r = resolveToday(WED_2026_05_27, TZ);
    assert.equal(r.kind, DAY_RESOLVE_KIND.TODAY);
    assert.equal(r.isoDate, "2026-05-27");
  });

  it("dayBoundsForInstant matches resolveDay for the instant's calendar day", () => {
    const reservationStart = new Date("2026-05-31T17:30:00.000Z"); // 1:30 PM EDT
    const { startUtc, endUtc, resolved } = dayBoundsForInstant(reservationStart, TZ);
    assert.equal(resolved.isoDate, "2026-05-31");
    const fromHint = resolveDay("2026-05-31", WED_2026_05_27, TZ);
    assert.equal(startUtc.toISOString(), fromHint.startIso);
    assert.equal(endUtc.toISOString(), fromHint.endIso);
  });
});
