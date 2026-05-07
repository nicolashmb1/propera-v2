"use strict";

/**
 * Lifecycle timer cancellation on terminal transitions + cron processor behavior (mock Supabase).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("crypto");

const { setSupabaseClientForTests, clearSupabaseClientForTests } = require("../src/db/supabase");
const {
  cancelPendingLifecycleTimersForWorkItem,
  cancelPendingLifecycleTimersForTicketKey,
  listDueLifecycleTimers,
  claimLifecycleTimer,
} = require("../src/dal/lifecycleTimers");
const { applyStaffOutcomeUpdate } = require("../src/dal/workItems");
const { processDueLifecycleTimers } = require("../src/jobs/processLifecycleTimers");

const PROP = "CRONTEST";

function applyLifecycleTimerFilters(rows, filters) {
  return rows.filter((row) =>
    filters.every((f) => {
      if (f.op === "eq") return String(row[f.col]) === String(f.val);
      if (f.op === "lte")
        return new Date(row[f.col]).getTime() <= new Date(f.val).getTime();
      return true;
    })
  );
}

function policiesLifecycleOn() {
  return [
    { property_code: PROP, policy_key: "LIFECYCLE_ENABLED", value: "true", value_type: "BOOL" },
  ];
}

/**
 * @param {{ lifecycleTimers: object[], wiById: Map<string, object>, policies?: object[] }} opts
 */
function createOpsMockSb(opts) {
  const lifecycleTimers = opts.lifecycleTimers;
  const wiById = opts.wiById;
  const policies = opts.policies || policiesLifecycleOn();

  return {
    from(table) {
      if (table === "property_policy") {
        return {
          select() {
            return this;
          },
          eq(_col, policyKey) {
            this._policyKey = policyKey;
            return this;
          },
          async in(_col, codes) {
            const rows = policies.filter(
              (r) => r.policy_key === this._policyKey && codes.includes(r.property_code)
            );
            return { data: rows, error: null };
          },
        };
      }

      if (table === "work_items") {
        return {
          select() {
            return this;
          },
          eq(col, val) {
            if (col === "work_item_id") {
              return {
                maybeSingle: async () => ({
                  data: wiById.get(String(val)) || null,
                  error: null,
                }),
              };
            }
            if (col === "ticket_key") {
              const rows = [];
              for (const w of wiById.values()) {
                if (String(w.ticket_key || "") === String(val)) rows.push(w);
              }
              return Promise.resolve({ data: rows, error: null });
            }
            return {
              maybeSingle: async () => ({ data: null, error: null }),
            };
          },
          update(patch) {
            return {
              eq(col, val) {
                if (col === "work_item_id" && wiById.has(String(val))) {
                  Object.assign(wiById.get(String(val)), patch);
                }
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }

      if (table === "lifecycle_timers") {
        return {
          select(_sel) {
            const filters = [];
            let orderOpts = { ascending: true };
            const chain = {
              eq(col, val) {
                filters.push({ op: "eq", col, val });
                return chain;
              },
              lte(col, val) {
                filters.push({ op: "lte", col, val });
                return chain;
              },
              order(_col, o) {
                orderOpts = o || { ascending: true };
                return chain;
              },
              limit(n) {
                let rows = applyLifecycleTimerFilters(lifecycleTimers, filters);
                rows = [...rows].sort((a, b) =>
                  orderOpts.ascending !== false
                    ? new Date(a.run_at).getTime() - new Date(b.run_at).getTime()
                    : new Date(b.run_at).getTime() - new Date(a.run_at).getTime()
                );
                const lim = Number(n) > 0 ? Number(n) : 25;
                return Promise.resolve({ data: rows.slice(0, lim), error: null });
              },
              maybeSingle() {
                const rows = applyLifecycleTimerFilters(lifecycleTimers, filters);
                return Promise.resolve({ data: rows[0] || null, error: null });
              },
              then(resolve, reject) {
                const rows = applyLifecycleTimerFilters(lifecycleTimers, filters);
                Promise.resolve({ data: rows, error: null }).then(resolve, reject);
              },
            };
            return chain;
          },
          update(patch) {
            return {
              eq(col1, v1) {
                return {
                  eq(col2, v2) {
                    let matched = null;
                    for (const t of lifecycleTimers) {
                      if (
                        String(t[col1]) === String(v1) &&
                        String(t[col2]) === String(v2)
                      ) {
                        Object.assign(t, patch);
                        matched = { ...t };
                      }
                    }
                    return {
                      select() {
                        return {
                          maybeSingle: async () => ({
                            data: matched,
                            error: null,
                          }),
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === "event_log") {
        return {
          insert() {
            return Promise.resolve({ error: null });
          },
        };
      }

      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: null, error: null }),
      };
    },
  };
}

test.beforeEach(() => {
  process.env.PROPERA_TEST_INJECT_SB = "1";
});

test.afterEach(() => {
  clearSupabaseClientForTests();
  delete process.env.PROPERA_TEST_INJECT_SB;
});

test("cancelPendingLifecycleTimersForWorkItem merges reason into payload; idempotent", async () => {
  const wid = "WI_CANCEL_1";
  const tid = randomUUID();
  const otherId = randomUUID();
  const lifecycleTimers = [
    {
      id: tid,
      work_item_id: wid,
      status: "pending",
      payload: { attempts: 1 },
      run_at: new Date(Date.now() - 1000).toISOString(),
      timer_type: "PING_UNSCHEDULED",
      property_code: PROP,
    },
    {
      id: otherId,
      work_item_id: "OTHER_WI",
      status: "pending",
      payload: {},
      run_at: new Date(Date.now() - 1000).toISOString(),
      timer_type: "PING_UNSCHEDULED",
      property_code: PROP,
    },
  ];
  const wiById = new Map([
    [
      wid,
      {
        work_item_id: wid,
        property_id: PROP,
        state: "UNSCHEDULED",
        status: "OPEN",
        ticket_key: "",
        metadata_json: {},
      },
    ],
  ]);
  const mockSb = createOpsMockSb({ lifecycleTimers, wiById });
  const r1 = await cancelPendingLifecycleTimersForWorkItem(
    mockSb,
    wid,
    "work_item_completed"
  );
  assert.equal(r1.cancelled, 1);
  const t1 = lifecycleTimers.find((x) => x.id === tid);
  assert.equal(t1.status, "cancelled");
  assert.equal(t1.payload.cancel_reason, "work_item_completed");
  assert.ok(t1.payload.cancelled_at);
  assert.equal(t1.payload.attempts, 1);

  const other = lifecycleTimers.find((x) => x.id === otherId);
  assert.equal(other.status, "pending");

  const r2 = await cancelPendingLifecycleTimersForWorkItem(
    mockSb,
    wid,
    "work_item_completed"
  );
  assert.equal(r2.cancelled, 0);

  const firedRow = {
    id: randomUUID(),
    work_item_id: wid,
    status: "fired",
    payload: {},
    run_at: new Date().toISOString(),
    timer_type: "X",
    property_code: PROP,
    fired_at: new Date().toISOString(),
  };
  lifecycleTimers.push(firedRow);
  const r3 = await cancelPendingLifecycleTimersForWorkItem(mockSb, wid, "x");
  assert.equal(r3.cancelled, 0);
  assert.equal(firedRow.status, "fired");
});

test("applyStaffOutcomeUpdate COMPLETED cancels pending timers for that work item", async () => {
  const wid = "WI_STAFF_DONE";
  const tid = randomUUID();
  const lifecycleTimers = [
    {
      id: tid,
      work_item_id: wid,
      status: "pending",
      payload: {},
      run_at: new Date(Date.now() - 1000).toISOString(),
      timer_type: "PING_UNSCHEDULED",
      property_code: PROP,
    },
  ];
  const wi = {
    work_item_id: wid,
    unit_id: "1",
    property_id: PROP,
    ticket_key: "tk",
    owner_id: "",
    phone_e164: "",
    status: "OPEN",
    state: "IN_PROGRESS",
    substate: "",
    metadata_json: {},
  };
  const wiById = new Map([[wid, { ...wi }]]);
  const mockSb = createOpsMockSb({ lifecycleTimers, wiById });
  setSupabaseClientForTests(mockSb);

  const out = await applyStaffOutcomeUpdate(wid, "COMPLETED", "done");
  assert.equal(out.ok, true);
  assert.equal(wiById.get(wid).status, "COMPLETED");

  const row = lifecycleTimers.find((x) => x.id === tid);
  assert.equal(row.status, "cancelled");
  assert.equal(row.payload.cancel_reason, "work_item_completed");
});

test("listDueLifecycleTimers excludes future run_at", async () => {
  const past = new Date(Date.now() - 3600000).toISOString();
  const future = new Date(Date.now() + 86400000).toISOString();
  const lifecycleTimers = [
    {
      id: randomUUID(),
      work_item_id: "W1",
      status: "pending",
      run_at: past,
      timer_type: "TIMER_ESCALATE",
      property_code: PROP,
      payload: {},
    },
    {
      id: randomUUID(),
      work_item_id: "W2",
      status: "pending",
      run_at: future,
      timer_type: "TIMER_ESCALATE",
      property_code: PROP,
      payload: {},
    },
  ];
  const mockSb = createOpsMockSb({
    lifecycleTimers,
    wiById: new Map([
      [
        "W1",
        {
          work_item_id: "W1",
          property_id: PROP,
          state: "UNSCHEDULED",
          status: "OPEN",
          ticket_key: "",
          metadata_json: {},
        },
      ],
    ]),
  });
  const due = await listDueLifecycleTimers(mockSb, 40);
  assert.equal(due.length, 1);
  assert.equal(due[0].work_item_id, "W1");
});

test("claimLifecycleTimer only transitions pending rows", async () => {
  const idPending = randomUUID();
  const idFired = randomUUID();
  const lifecycleTimers = [
    {
      id: idPending,
      work_item_id: "W",
      status: "pending",
      run_at: new Date().toISOString(),
      timer_type: "T",
      property_code: PROP,
      payload: {},
    },
    {
      id: idFired,
      work_item_id: "W",
      status: "fired",
      run_at: new Date().toISOString(),
      timer_type: "T",
      property_code: PROP,
      payload: {},
      fired_at: new Date().toISOString(),
    },
  ];
  const mockSb = createOpsMockSb({ lifecycleTimers, wiById: new Map() });
  const c1 = await claimLifecycleTimer(mockSb, idPending);
  assert.ok(c1);
  assert.equal(c1.status, "fired");
  const c2 = await claimLifecycleTimer(mockSb, idFired);
  assert.equal(c2, null);
});

test("processDueLifecycleTimers claims due TIMER_ESCALATE and logs handled", async () => {
  const wid = "WI_ESCALATE";
  const timerId = randomUUID();
  const lifecycleTimers = [
    {
      id: timerId,
      work_item_id: wid,
      status: "pending",
      run_at: new Date(Date.now() - 1000).toISOString(),
      timer_type: "TIMER_ESCALATE",
      property_code: PROP,
      payload: {},
      trace_id: "trace-timer-1",
    },
  ];
  const wiById = new Map([
    [
      wid,
      {
        work_item_id: wid,
        property_id: PROP,
        state: "UNSCHEDULED",
        status: "OPEN",
        ticket_key: "",
        metadata_json: {},
      },
    ],
  ]);
  const mockSb = createOpsMockSb({ lifecycleTimers, wiById });
  setSupabaseClientForTests(mockSb);

  const out = await processDueLifecycleTimers(mockSb, { traceId: "cron-trace" });
  assert.equal(out.due, 1);
  assert.equal(out.claimed, 1);
  assert.equal(out.processed, 1);
  assert.equal(out.skipped, 0);
  assert.equal(out.trace_id, "cron-trace");

  const row = lifecycleTimers.find((x) => x.id === timerId);
  assert.equal(row.status, "fired");
  assert.ok(row.fired_at);
});

test("cancelPendingLifecycleTimersForTicketKey clears each work item on ticket_key", async () => {
  const tk = "tk-shared";
  const w1 = "WI_A";
  const w2 = "WI_B";
  const lifecycleTimers = [
    {
      id: randomUUID(),
      work_item_id: w1,
      status: "pending",
      payload: {},
      run_at: new Date(Date.now() - 1000).toISOString(),
      timer_type: "T",
      property_code: PROP,
    },
    {
      id: randomUUID(),
      work_item_id: w2,
      status: "pending",
      payload: {},
      run_at: new Date(Date.now() - 1000).toISOString(),
      timer_type: "T",
      property_code: PROP,
    },
  ];
  const wiById = new Map([
    [
      w1,
      {
        work_item_id: w1,
        ticket_key: tk,
        property_id: PROP,
        state: "OPEN",
        status: "OPEN",
        metadata_json: {},
      },
    ],
    [
      w2,
      {
        work_item_id: w2,
        ticket_key: tk,
        property_id: PROP,
        state: "OPEN",
        status: "OPEN",
        metadata_json: {},
      },
    ],
  ]);
  const mockSb = createOpsMockSb({ lifecycleTimers, wiById });
  const r = await cancelPendingLifecycleTimersForTicketKey(mockSb, tk, "ticket_completed");
  assert.equal(r.cancelled, 2);
  assert.ok(lifecycleTimers.every((t) => t.status === "cancelled"));
});
