/**
 * In-memory Supabase client for **scenario tests** (tenant maintenance + schedule paths).
 * Extends staff-capture mock shapes with: tickets, work_items, intake_sessions, property_policy,
 * richer select (.neq, .in), chained updates, and insert().select().maybeSingle().
 *
 * Does **not** replace `memorySupabaseStaffCapture.js` — staff integration keeps using that helper.
 */

const crypto = require("crypto");

function matches(row, filters) {
  return filters.every((f) => {
    const v = row[f.col];
    if (f.op === "eq") return String(v) === String(f.val);
    if (f.op === "neq") return String(v) !== String(f.val);
    if (f.op === "in") {
      const vals = (f.vals || []).map((x) => String(x));
      return vals.includes(String(v));
    }
    return true;
  });
}

function filterRows(rows, filters) {
  return rows.filter((row) => matches(row, filters));
}

function tableKey(tableName) {
  const map = {
    properties: "properties",
    property_policy: "property_policy",
    property_aliases: "property_aliases",
    contacts: "contacts",
    staff: "staff",
    staff_capture_drafts: "staff_capture_drafts",
    telegram_chat_link: "telegram_chat_link",
    conversation_ctx: "conversation_ctx",
    event_log: "event_log",
    intake_sessions: "intake_sessions",
    tickets: "tickets",
    work_items: "work_items",
  };
  return map[tableName] || null;
}

/**
 * @param {object} seed
 */
function createScenarioMemorySupabase(seed) {
  const state = {
    draftSeqCounter: seed.draftSeqCounter || 0,
    properties: (seed.properties || []).map((r) => ({ ...r })),
    property_policy: (seed.property_policy || []).map((r) => ({ ...r })),
    property_aliases: (seed.property_aliases || []).map((r) => ({ ...r })),
    contacts: (seed.contacts || []).map((r) => ({ ...r })),
    staff: (seed.staff || []).map((r) => ({ ...r })),
    staff_capture_drafts: (seed.staff_capture_drafts || []).map((r) => ({ ...r })),
    telegram_chat_link: (seed.telegram_chat_link || []).map((r) => ({ ...r })),
    conversation_ctx: (seed.conversation_ctx || []).map((r) => ({ ...r })),
    event_log: (seed.event_log || []).map((r) => ({ ...r })),
    intake_sessions: (seed.intake_sessions || []).map((r) => ({ ...r })),
    tickets: (seed.tickets || []).map((r) => ({ ...r })),
    work_items: (seed.work_items || []).map((r) => ({ ...r })),
  };

  function rowsFor(tableName) {
    const k = tableKey(tableName);
    return k ? state[k] : null;
  }

  function selectChain(tableName, filters, _selectCols) {
    let orderCol = null;
    let orderAsc = true;
    let limitN = null;

    const chain = {
      eq(col, val) {
        filters.push({ op: "eq", col, val });
        return chain;
      },
      neq(col, val) {
        filters.push({ op: "neq", col, val });
        return chain;
      },
      in(col, vals) {
        filters.push({ op: "in", col, vals: Array.isArray(vals) ? vals : [] });
        return chain;
      },
      order(col, opts) {
        orderCol = col;
        orderAsc = !(opts && opts.ascending === false);
        return chain;
      },
      limit(n) {
        limitN = n;
        return chain;
      },
      maybeSingle: async () => runOnce("maybeSingle"),
      single: async () => runOnce("single"),
    };

    async function runOnce(mode) {
      const rows = rowsFor(tableName);
      if (!rows) return { data: null, error: { message: "unknown table " + tableName } };
      let r = filterRows(rows, filters);
      if (orderCol) {
        r = [...r].sort((a, b) => {
          const av = a[orderCol];
          const bv = b[orderCol];
          if (av < bv) return orderAsc ? -1 : 1;
          if (av > bv) return orderAsc ? 1 : -1;
          return 0;
        });
      }
      if (limitN != null) r = r.slice(0, limitN);
      if (mode === "array") return { data: r, error: null };
      if (r.length === 0) {
        if (mode === "single") return { data: null, error: { message: "not found" } };
        return { data: null, error: null };
      }
      if (r.length > 1) {
        if (mode === "maybeSingle") return { data: null, error: { message: "multiple rows" } };
        if (mode === "single") return { data: null, error: { message: "multiple rows" } };
        return { data: r[0], error: null };
      }
      return { data: r[0], error: null };
    }

    chain.then = (onFulfilled, onRejected) =>
      runOnce("array").then(onFulfilled, onRejected);

    return chain;
  }

  function updateThenable(tableName, patch) {
    const filters = [];
    const chain = {
      eq(col, val) {
        filters.push({ op: "eq", col, val });
        return chain;
      },
      then(onFulfilled, onRejected) {
        const rows = rowsFor(tableName);
        if (!rows) return Promise.resolve({ data: null, error: { message: "unknown table" } });
        const hit = filterRows(rows, filters);
        const now = new Date().toISOString();
        hit.forEach((row) => Object.assign(row, patch, { updated_at: patch.updated_at || now }));
        return Promise.resolve({ data: hit, error: null }).then(onFulfilled, onRejected);
      },
    };
    return chain;
  }

  function deleteThenable(tableName) {
    const filters = [];
    const chain = {
      eq(col, val) {
        filters.push({ op: "eq", col, val });
        return chain;
      },
      then(onFulfilled, onRejected) {
        const rows = rowsFor(tableName);
        if (!rows) return Promise.resolve({ data: null, error: { message: "unknown table" } });
        const hit = filterRows(rows, filters);
        hit.forEach((h) => {
          const i = rows.indexOf(h);
          if (i >= 0) rows.splice(i, 1);
        });
        return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
      },
    };
    return chain;
  }

  function insertThenable(tableName, row) {
    const rows = rowsFor(tableName);
    let consumed = false;
    const o = Array.isArray(row) ? row[0] : row;
    const copy = { ...o };

    function push() {
      if (consumed) return copy;
      consumed = true;
      if (!rows) return copy;
      if (tableName === "tickets" && copy.id == null) {
        copy.id = crypto.randomUUID();
      }
      rows.push(copy);
      return copy;
    }

    return {
      select(_cols) {
        return {
          maybeSingle: async () => {
            const c = push();
            return { data: { id: c.id }, error: null };
          },
          single: async () => {
            const c = push();
            return { data: { id: c.id }, error: null };
          },
        };
      },
      then(onFulfilled, onRejected) {
        push();
        return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
      },
    };
  }

  return {
    rpc(name) {
      if (name === "next_staff_capture_draft_seq") {
        state.draftSeqCounter += 1;
        return Promise.resolve({ data: state.draftSeqCounter, error: null });
      }
      return Promise.resolve({ data: null, error: { message: "unknown rpc " + name } });
    },
    from(tableName) {
      return {
        select(cols) {
          return selectChain(tableName, [], cols || "*");
        },
        insert(row) {
          return insertThenable(tableName, row);
        },
        update(patch) {
          return updateThenable(tableName, patch);
        },
        delete() {
          return deleteThenable(tableName);
        },
        upsert(row, opts) {
          const rows = rowsFor(tableName);
          if (!rows) return Promise.resolve({ data: null, error: { message: "unknown table" } });
          const onConflict = opts && opts.onConflict ? String(opts.onConflict) : "id";
          const key = row[onConflict];
          const idx = rows.findIndex((r) => String(r[onConflict]) === String(key));
          const copy = { ...row };
          if (idx >= 0) {
            Object.assign(rows[idx], copy);
          } else {
            rows.push(copy);
          }
          return Promise.resolve({ data: copy, error: null });
        },
      };
    },
    _state: state,
  };
}

/** Canonical tenant actor for `scenarioMaintenanceSeedPenn()` scenarios */
const SCENARIO_TENANT_E164 = "+15551234001";

/** Staff actor for `#` capture scenarios (distinct from {@link SCENARIO_TENANT_E164}). */
const SCENARIO_STAFF_E164 = "+15551234002";

/**
 * PENN maintenance seed plus one active staff row linked to `staffPhoneE164` (contacts + staff).
 * @param {string} staffPhoneE164
 */
function scenarioMaintenanceSeedPennWithStaffPhone(staffPhoneE164) {
  const phone = String(staffPhoneE164 || "").trim();
  const base = scenarioMaintenanceSeedPenn();
  return {
    ...base,
    contacts: [
      {
        id: "scen-contact-staff",
        phone_e164: phone,
      },
    ],
    staff: [
      {
        id: "scen-staff-row",
        staff_id: "scen-staff-uuid",
        contact_id: "scen-contact-staff",
        display_name: "Staff Scenario",
        role: "manager",
        active: true,
      },
    ],
  };
}

/** Minimal seeds: PENN building + lifecycle off + permissive schedule policy for in-memory schedule replies */
function scenarioMaintenanceSeedPenn() {
  return {
    contacts: [],
    staff: [],
    staff_capture_drafts: [],
    telegram_chat_link: [],
    conversation_ctx: [],
    event_log: [],
    intake_sessions: [],
    tickets: [],
    work_items: [],
    property_aliases: [],
    properties: [
      {
        code: "PENN",
        display_name: "The Grand at Penn",
        ticket_prefix: "PENN",
        short_name: "Penn",
        address: "1 Penn Ave",
        active: true,
        legacy_property_id: "",
      },
    ],
    property_policy: [
      {
        property_code: "GLOBAL",
        policy_key: "LIFECYCLE_ENABLED",
        value: "false",
        value_type: "BOOL",
      },
      {
        property_code: "GLOBAL",
        policy_key: "SCHED_MIN_LEAD_HOURS",
        value: "0",
        value_type: "NUMBER",
      },
      {
        property_code: "GLOBAL",
        policy_key: "SCHED_MAX_DAYS_OUT",
        value: "60",
        value_type: "NUMBER",
      },
      {
        property_code: "PENN",
        policy_key: "SCHED_MIN_LEAD_HOURS",
        value: "0",
        value_type: "NUMBER",
      },
    ],
  };
}

module.exports = {
  createScenarioMemorySupabase,
  scenarioMaintenanceSeedPenn,
  scenarioMaintenanceSeedPennWithStaffPhone,
  SCENARIO_TENANT_E164,
  SCENARIO_STAFF_E164,
};
