/**
 * Characterization tests for appendPortalStaffScheduleNote (injected deps).
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  appendPortalStaffScheduleNote,
} = require("../src/brain/core/appendPortalStaffScheduleNote");
const {
  schedulePolicyRejectMessage,
} = require("../src/dal/ticketPreferredWindow");

describe("appendPortalStaffScheduleNote", () => {
  test("1) ok with parsed.label — exact receipt; afterTenantScheduleApplied called", async () => {
    const lifecycleCalls = [];
    const applyPreferredWindowByTicketKey = async (o) => {
      assert.equal(o.ticketKey, "tk-uuid");
      assert.equal(o.preferredWindow, "tomorrow 9am");
      return { ok: true, parsed: { label: "Tue 9-11" } };
    };
    const getSupabase = () => ({ id: "sb-mock" });
    const afterTenantScheduleApplied = async (arg) => {
      lifecycleCalls.push(arg);
    };
    const schedulePolicyRejectMessage = () => {
      assert.fail("no policy path");
    };

    const out = await appendPortalStaffScheduleNote(
      "Ticket logged: X",
      "tomorrow 9am",
      "tk-uuid",
      "trace-1",
      555,
      { afterLifecycle: true, propertyCodeHint: "PENN" },
      {
        applyPreferredWindowByTicketKey,
        getSupabase,
        afterTenantScheduleApplied,
        schedulePolicyRejectMessage,
      }
    );

    assert.equal(out, "Ticket logged: X\n\nPreferred time noted: Tue 9-11.");
    assert.equal(lifecycleCalls.length, 1);
    assert.equal(lifecycleCalls[0].ticketKey, "tk-uuid");
    assert.equal(lifecycleCalls[0].propertyCodeHint, "PENN");
    assert.equal(lifecycleCalls[0].traceId, "trace-1");
    assert.equal(lifecycleCalls[0].traceStartMs, 555);
    assert.deepEqual(lifecycleCalls[0].parsed, { label: "Tue 9-11" });
    assert.equal(lifecycleCalls[0].sb.id, "sb-mock");
  });

  test("2) policy rejection — schedulePolicyRejectMessage passthrough; lifecycle not called", async () => {
    let lifecycleCalled = false;
    const applyPreferredWindowByTicketKey = async () => ({
      ok: false,
      policyKey: "SCHED_REJECT_WEEKEND",
      policyVars: {},
    });
    const getSupabase = () => assert.fail("getSupabase should not run on policy reject");
    const afterTenantScheduleApplied = async () => {
      lifecycleCalled = true;
    };

    const base = "Ticket logged: WF-1";
    const out = await appendPortalStaffScheduleNote(
      base,
      "Saturday 10am to noon",
      "key-z",
      "tr",
      null,
      undefined,
      {
        applyPreferredWindowByTicketKey,
        getSupabase,
        afterTenantScheduleApplied,
        schedulePolicyRejectMessage,
      }
    );

    const expectedSuffix = schedulePolicyRejectMessage("SCHED_REJECT_WEEKEND", {});
    assert.equal(out, `${base}\n\n${expectedSuffix}`);
    assert.equal(lifecycleCalled, false);
  });

  test("3) apply failure without policyKey — exact fallback receipt", async () => {
    const applyPreferredWindowByTicketKey = async () => ({ ok: false });
    const afterTenantScheduleApplied = async () =>
      assert.fail("lifecycle should not run");

    const base = "Ticket logged: Y";
    const out = await appendPortalStaffScheduleNote(
      base,
      "bad window text",
      "key2",
      "t2",
      100,
      undefined,
      {
        applyPreferredWindowByTicketKey,
        getSupabase: () => null,
        afterTenantScheduleApplied,
        schedulePolicyRejectMessage: () => assert.fail("no policy branch"),
      }
    );

    assert.equal(
      out,
      `${base}\n\n(Preferred time could not be saved; add it from the ticket when ready.)`
    );
  });

  test("4) schedule hint too short — receipt unchanged", async () => {
    const applyPreferredWindowByTicketKey = async () =>
      assert.fail("apply should not run");
    const out = await appendPortalStaffScheduleNote(
      "Receipt only",
      "x",
      "key3",
      "t",
      null,
      undefined,
      { applyPreferredWindowByTicketKey }
    );
    assert.equal(out, "Receipt only");
  });

  test("5) missing ticket key — receipt unchanged", async () => {
    const applyPreferredWindowByTicketKey = async () =>
      assert.fail("apply should not run");
    const out = await appendPortalStaffScheduleNote(
      "Receipt only",
      "tomorrow morning works",
      "",
      "t",
      null,
      undefined,
      { applyPreferredWindowByTicketKey }
    );
    assert.equal(out, "Receipt only");
  });

  test("afterLifecycle + scheduleOpts.sb — lifecycle runs even when deps.getSupabase is null", async () => {
    const lifecycleCalls = [];
    const fakeSb = { tag: "request-scoped-sb" };
    const applyPreferredWindowByTicketKey = async () => ({
      ok: true,
      parsed: { label: "L" },
    });

    const out = await appendPortalStaffScheduleNote(
      "R",
      "ab",
      "key4",
      "t",
      null,
      {
        afterLifecycle: true,
        propertyCodeHint: "PROP",
        sb: fakeSb,
      },
      {
        applyPreferredWindowByTicketKey,
        getSupabase: () => null,
        afterTenantScheduleApplied: async (arg) => lifecycleCalls.push(arg),
        schedulePolicyRejectMessage: () => "",
      }
    );

    assert.equal(out, "R\n\nPreferred time noted: L.");
    assert.equal(lifecycleCalls.length, 1);
    assert.equal(lifecycleCalls[0].sb.tag, "request-scoped-sb");
    assert.equal(lifecycleCalls[0].propertyCodeHint, "PROP");
  });

  test("afterLifecycle without sb on scheduleOpts — getSupabase null skips lifecycle", async () => {
    const lifecycleCalls = [];
    const applyPreferredWindowByTicketKey = async () => ({
      ok: true,
      parsed: { label: "L" },
    });

    const out = await appendPortalStaffScheduleNote(
      "R",
      "ab",
      "key4",
      "t",
      null,
      { afterLifecycle: true, propertyCodeHint: "PROP" },
      {
        applyPreferredWindowByTicketKey,
        getSupabase: () => null,
        afterTenantScheduleApplied: async () => lifecycleCalls.push(1),
        schedulePolicyRejectMessage: () => "",
      }
    );

    assert.equal(out, "R\n\nPreferred time noted: L.");
    assert.equal(lifecycleCalls.length, 0);
  });

  test("ok without parsed.label uses trimmed schedule hint", async () => {
    const applyPreferredWindowByTicketKey = async () => ({ ok: true, parsed: null });
    const out = await appendPortalStaffScheduleNote(
      "Base",
      "  custom hint  ",
      "k",
      "t",
      null,
      undefined,
      {
        applyPreferredWindowByTicketKey,
        getSupabase: () => null,
        afterTenantScheduleApplied: async () => {},
        schedulePolicyRejectMessage: () => "",
      }
    );
    assert.equal(out, "Base\n\nPreferred time noted: custom hint.");
  });
});
