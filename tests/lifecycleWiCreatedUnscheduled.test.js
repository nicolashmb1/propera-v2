"use strict";

/**
 * Deterministic lifecycle tests with injected Supabase — no real DB.
 * WI_CREATED_UNSCHEDULED → PING_UNSCHEDULED; ACTIVE_WORK_ENTERED → replaces with PING_STAFF_UPDATE.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("crypto");

const { setSupabaseClientForTests, clearSupabaseClientForTests } = require("../src/db/supabase");
const { handleLifecycleSignal } = require("../src/brain/lifecycle/handleLifecycleSignal");

const PROP = "TESTPROP";

function policyRowsForProp() {
  return [
    { property_code: PROP, policy_key: "LIFECYCLE_ENABLED", value: "true", value_type: "BOOL" },
    {
      property_code: PROP,
      policy_key: "UNSCHEDULED_FIRST_PING_HOURS",
      value: "24",
      value_type: "NUMBER",
    },
    {
      property_code: PROP,
      policy_key: "PING_UNSCHEDULED_RESPECT_CONTACT_HOURS",
      value: "false",
      value_type: "BOOL",
    },
    {
      property_code: PROP,
      policy_key: "SCHEDULE_BUFFER_HOURS",
      value: "2",
      value_type: "NUMBER",
    },
  ];
}

/**
 * @param {{ wiRow: object, policies?: object[] }} opts
 */
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

function createMockSb(opts) {
  const wiRow = opts.wiRow;
  const policies = opts.policies || policyRowsForProp();
  /** @type {object[]} */
  const lifecycleTimers = [];

  const mockSb = {
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
            if (col === "work_item_id" || col === "ticket_key") {
              return {
                maybeSingle: async () => ({ data: wiRow, error: null }),
              };
            }
            return {
              maybeSingle: async () => ({ data: null, error: null }),
            };
          },
          update(_patch) {
            return {
              eq: async () => ({ error: null }),
            };
          },
        };
      }

      if (table === "lifecycle_timers") {
        return {
          insert(row) {
            lifecycleTimers.push({
              ...row,
              id: row.id || randomUUID(),
              status: row.status || "pending",
            });
            return Promise.resolve({ error: null });
          },
          select(_sel) {
            /** @type {{ op: string, col: string, val: unknown }[]} */
            const filters = [];
            /** @type {{ ascending?: boolean }} */
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
        insert() {
          return Promise.resolve({ error: null });
        },
        update() {
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };

  return { mockSb, lifecycleTimers };
}

test.beforeEach(() => {
  process.env.PROPERA_TEST_INJECT_SB = "1";
});

test.afterEach(() => {
  clearSupabaseClientForTests();
  delete process.env.PROPERA_TEST_INJECT_SB;
});

test("WI_CREATED_UNSCHEDULED inserts one pending PING_UNSCHEDULED", async () => {
  const wiRow = {
    work_item_id: "WI_UNSCHED_1",
    unit_id: "101",
    property_id: PROP,
    ticket_key: "tk-11111111-1111-1111-1111-111111111111",
    owner_id: "",
    phone_e164: "+15550001111",
    status: "OPEN",
    state: "UNSCHEDULED",
    substate: "",
    metadata_json: {},
  };
  const { mockSb, lifecycleTimers } = createMockSb({ wiRow });
  setSupabaseClientForTests(mockSb);

  const out = await handleLifecycleSignal(
    mockSb,
    {
      eventType: "WI_CREATED_UNSCHEDULED",
      wiId: "WI_UNSCHED_1",
      propertyId: PROP,
    },
    { traceId: "t-unsched-1" }
  );

  assert.equal(out.code, "OK");
  const pending = lifecycleTimers.filter((t) => t.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].timer_type, "PING_UNSCHEDULED");
  assert.equal(pending[0].work_item_id, "WI_UNSCHED_1");
});

test("second WI_CREATED_UNSCHEDULED cancels prior PING_UNSCHEDULED — single pending", async () => {
  const wiRow = {
    work_item_id: "WI_UNSCHED_2",
    unit_id: "102",
    property_id: PROP,
    ticket_key: "tk-22222222-2222-2222-2222-222222222222",
    owner_id: "",
    phone_e164: "+15550002222",
    status: "OPEN",
    state: "UNSCHEDULED",
    substate: "",
    metadata_json: {},
  };
  const { mockSb, lifecycleTimers } = createMockSb({ wiRow });
  setSupabaseClientForTests(mockSb);

  await handleLifecycleSignal(
    mockSb,
    { eventType: "WI_CREATED_UNSCHEDULED", wiId: "WI_UNSCHED_2", propertyId: PROP },
    { traceId: "t1" }
  );
  await handleLifecycleSignal(
    mockSb,
    { eventType: "WI_CREATED_UNSCHEDULED", wiId: "WI_UNSCHED_2", propertyId: PROP },
    { traceId: "t2" }
  );

  const pending = lifecycleTimers.filter((t) => t.status === "pending");
  const cancelled = lifecycleTimers.filter((t) => t.status === "cancelled");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].timer_type, "PING_UNSCHEDULED");
  assert.ok(cancelled.length >= 1);
});

test("ACTIVE_WORK_ENTERED replaces PING_UNSCHEDULED with PING_STAFF_UPDATE only", async () => {
  const wiRow = {
    work_item_id: "WI_SCHED_PATH",
    unit_id: "303",
    property_id: PROP,
    ticket_key: "tk-33333333-3333-3333-3333-333333333333",
    owner_id: "",
    phone_e164: "+15550003333",
    status: "OPEN",
    state: "UNSCHEDULED",
    substate: "",
    metadata_json: {},
  };
  const { mockSb, lifecycleTimers } = createMockSb({ wiRow });
  setSupabaseClientForTests(mockSb);

  await handleLifecycleSignal(
    mockSb,
    { eventType: "WI_CREATED_UNSCHEDULED", wiId: "WI_SCHED_PATH", propertyId: PROP },
    { traceId: "t-create" }
  );

  const scheduledEnd = new Date(Date.now() + 48 * 3600000);
  await handleLifecycleSignal(
    mockSb,
    {
      eventType: "ACTIVE_WORK_ENTERED",
      wiId: "WI_SCHED_PATH",
      propertyId: PROP,
      scheduledEndAt: scheduledEnd,
    },
    { traceId: "t-active" }
  );

  const pending = lifecycleTimers.filter((t) => t.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].timer_type, "PING_STAFF_UPDATE");
  assert.ok(!lifecycleTimers.some((t) => t.status === "pending" && t.timer_type === "PING_UNSCHEDULED"));
});

test("WI_CREATED_UNSCHEDULED holds when WI state is not UNSCHEDULED", async () => {
  const wiRow = {
    work_item_id: "WI_TRIAGE",
    unit_id: "404",
    property_id: PROP,
    ticket_key: "tk-44444444-4444-4444-4444-444444444444",
    owner_id: "",
    phone_e164: "+15550004444",
    status: "OPEN",
    state: "STAFF_TRIAGE",
    substate: "EMERGENCY",
    metadata_json: {},
  };
  const { mockSb, lifecycleTimers } = createMockSb({ wiRow });
  setSupabaseClientForTests(mockSb);

  const out = await handleLifecycleSignal(
    mockSb,
    { eventType: "WI_CREATED_UNSCHEDULED", wiId: "WI_TRIAGE", propertyId: PROP },
    { traceId: "t-triage" }
  );

  assert.equal(out.code, "HOLD");
  assert.match(String(out.reason || ""), /BAD_STATE/);
  assert.equal(lifecycleTimers.length, 0);
});
