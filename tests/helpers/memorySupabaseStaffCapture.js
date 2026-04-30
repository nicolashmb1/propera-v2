/**
 * In-memory Supabase subset for staff-capture cross-channel integration tests.
 */

function matches(row, filters) {
  return filters.every((f) => {
    const v = row[f.col];
    if (f.op === "eq") return String(v) === String(f.val);
    if (f.op === "neq") return String(v) !== String(f.val);
    return true;
  });
}

function filterRows(rows, filters) {
  return rows.filter((row) => matches(row, filters));
}

function createMemorySupabase(seed) {
  const state = {
    draftSeqCounter: seed.draftSeqCounter || 0,
    properties: (seed.properties || []).map((r) => ({ ...r })),
    staff_capture_drafts: (seed.staff_capture_drafts || []).map((r) => ({ ...r })),
    contacts: (seed.contacts || []).map((r) => ({ ...r })),
    staff: (seed.staff || []).map((r) => ({ ...r })),
    telegram_chat_link: (seed.telegram_chat_link || []).map((r) => ({ ...r })),
    event_log: [],
    conversation_ctx: (seed.conversation_ctx || []).map((r) => ({ ...r })),
    property_aliases: (seed.property_aliases || []).map((r) => ({ ...r })),
  };

  function rowsFor(tableName) {
    const k =
      {
        properties: "properties",
        staff_capture_drafts: "staff_capture_drafts",
        contacts: "contacts",
        staff: "staff",
        telegram_chat_link: "telegram_chat_link",
        event_log: "event_log",
        conversation_ctx: "conversation_ctx",
        property_aliases: "property_aliases",
      }[tableName] || null;
    return k ? state[k] : null;
  }

  function selectChain(tableName, filters, selectCols) {
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
    async function exec() {
      const rows = rowsFor(tableName);
      if (!rows) return { data: null, error: { message: "unknown table" } };
      const hit = filterRows(rows, filters);
      const now = new Date().toISOString();
      hit.forEach((row) => Object.assign(row, patch));
      if (tableName === "staff_capture_drafts") {
        hit.forEach((row) => {
          row.updated_at_iso = patch.updated_at_iso || now;
        });
      }
      return { data: hit, error: null };
    }
    const chain = {
      eq(col, val) {
        filters.push({ op: "eq", col, val });
        return chain;
      },
      then(onFulfilled, onRejected) {
        return exec().then(onFulfilled, onRejected);
      },
    };
    return chain;
  }

  function deleteThenable(tableName) {
    const filters = [];
    async function exec() {
      const rows = rowsFor(tableName);
      if (!rows) return { data: null, error: { message: "unknown table" } };
      const hit = filterRows(rows, filters);
      hit.forEach((h) => {
        const i = rows.indexOf(h);
        if (i >= 0) rows.splice(i, 1);
      });
      return { data: null, error: null };
    }
    const chain = {
      eq(col, val) {
        filters.push({ op: "eq", col, val });
        return chain;
      },
      then(onFulfilled, onRejected) {
        return exec().then(onFulfilled, onRejected);
      },
    };
    return chain;
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
          const rows = rowsFor(tableName);
          if (!rows) return Promise.resolve({ data: null, error: { message: "unknown table" } });
          const o = Array.isArray(row) ? row[0] : row;
          const copy = { ...o };
          rows.push(copy);
          return Promise.resolve({ data: copy, error: null });
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

module.exports = { createMemorySupabase };
