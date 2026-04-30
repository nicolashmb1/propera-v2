const test = require("node:test");
const assert = require("node:assert/strict");

process.env.PROPERA_TEST_INJECT_SB = "1";

const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../src/db/supabase");
const { finalizeMaintenanceDraft } = require("../src/dal/finalizeMaintenance");

function createFinalizeMemorySupabase() {
  const state = {
    properties: [
      {
        code: "PENN",
        display_name: "The Grand at Penn",
        ticket_prefix: "PENN",
        legacy_property_id: "PROP_PENN",
      },
    ],
    property_policy: [],
    tickets: [],
    work_items: [],
    conversation_ctx: [],
  };

  function runSelect(tableName, filters, mode) {
    const rows = state[tableName] || [];
    let out = rows;
    for (const f of filters) {
      if (f.op === "eq") out = out.filter((r) => String(r[f.col]) === String(f.val));
      if (f.op === "in") out = out.filter((r) => f.vals.includes(String(r[f.col])));
    }
    if (mode === "maybeSingle") {
      if (!out.length) return { data: null, error: null };
      return { data: out[0], error: null };
    }
    return { data: out, error: null };
  }

  function selectChain(tableName) {
    const filters = [];
    const api = {
      eq(col, val) {
        filters.push({ op: "eq", col, val });
        return api;
      },
      in(col, vals) {
        filters.push({ op: "in", col, vals: vals.map((v) => String(v)) });
        return api;
      },
      maybeSingle: async () => runSelect(tableName, filters, "maybeSingle"),
      then(onFulfilled, onRejected) {
        return Promise.resolve(runSelect(tableName, filters, "array")).then(
          onFulfilled,
          onRejected
        );
      },
    };
    return api;
  }

  return {
    _state: state,
    from(tableName) {
      return {
        select() {
          return selectChain(tableName);
        },
        insert(row) {
          const payload = Array.isArray(row) ? row[0] : row;
          const copy = { ...payload };
          if (tableName === "tickets") {
            copy.id = "ticket-db-1";
            state.tickets.push(copy);
            return {
              select() {
                return {
                  maybeSingle: async () => ({ data: { id: copy.id }, error: null }),
                };
              },
            };
          }
          if (tableName === "work_items") {
            state.work_items.push(copy);
            return Promise.resolve({ data: copy, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        upsert(row) {
          const copy = { ...row };
          state.conversation_ctx.push(copy);
          return Promise.resolve({ data: copy, error: null });
        },
      };
    },
  };
}

test("finalize COMMON_AREA blanks unit/tenant and keeps context line", async (t) => {
  const mem = createFinalizeMemorySupabase();
  setSupabaseClientForTests(mem);
  t.after(() => clearSupabaseClientForTests());

  const r = await finalizeMaintenanceDraft({
    traceId: "ca-finalize-1",
    propertyCode: "PENN",
    unitLabel: "101",
    issueText: "hallway light is out",
    actorKey: "+19085550000",
    mode: "TENANT",
    locationType: "COMMON_AREA",
    reportSourceUnit: "101",
    reportSourcePhone: "+19085550000",
  });
  assert.equal(r.ok, true);
  assert.equal(mem._state.tickets.length, 1);
  const row = mem._state.tickets[0];
  assert.equal(row.location_type, "COMMON_AREA");
  assert.equal(row.unit_label, "");
  assert.equal(row.tenant_phone_e164, "");
  assert.match(String(row.message_raw || ""), /^Report from apt 101 Phone: \+19085550000/);
  assert.match(String(row.message_raw || ""), /hallway light is out/);
});

test("finalize UNIT keeps unit/tenant fields unchanged", async (t) => {
  const mem = createFinalizeMemorySupabase();
  setSupabaseClientForTests(mem);
  t.after(() => clearSupabaseClientForTests());

  const r = await finalizeMaintenanceDraft({
    traceId: "ca-finalize-2",
    propertyCode: "PENN",
    unitLabel: "303",
    issueText: "sink leaking in unit 303",
    actorKey: "+19085550001",
    mode: "TENANT",
    locationType: "UNIT",
  });
  assert.equal(r.ok, true);
  const row = mem._state.tickets[0];
  assert.equal(row.location_type, "UNIT");
  assert.equal(row.unit_label, "303");
  assert.equal(row.tenant_phone_e164, "+19085550001");
});
