/**
 * Read `event_log` for the ops dashboard — group by trace (request) and enrich with ctx.
 * Tenant aggregation uses **Telegram user id** (`payload.ctx.tg_user_id`, or `TG:<id>` from `actor_key`).
 */
const { getSupabase } = require("../db/supabase");

/**
 * Canonical numeric Telegram user id from inbound ctx (same user across chats when present).
 * @param {object|null|undefined} ctx
 * @returns {string}
 */
function telegramUserIdFromCtx(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const u = ctx.tg_user_id != null ? String(ctx.tg_user_id).trim() : "";
  if (u) return u;
  const ak = String(ctx.actor_key || "").trim();
  const m = ak.match(/^TG:(\d+)$/i);
  return m ? m[1] : "";
}

function telegramUserIdFromRow(r) {
  const ctx = r.payload && r.payload.ctx;
  return telegramUserIdFromCtx(ctx);
}

/** Accepts `7108534136`, `TG:7108534136`, or legacy exact actor_key match via opts.actorKey */
function normalizeTelegramUserIdFilter(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  const m = t.match(/^TG:(\d+)$/i);
  if (m) return m[1];
  if (/^\d+$/.test(t)) return t;
  return "";
}

/**
 * @param {object} opts
 * @param {number} [opts.hours=48]
 * @param {number} [opts.limit=500]
 * @param {string} [opts.telegramUserId] — numeric id or TG:…
 * @param {string} [opts.actorKey] — exact `payload.ctx.actor_key` (legacy)
 * @param {string} [opts.traceId]
 * @param {string} [opts.chatId]
 */
async function fetchEventLogForDashboard(opts) {
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "no_db", threads: [], rows: [] };
  }

  const hours = Math.min(Math.max(Number(opts.hours) || 48, 1), 168);
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 2000);
  const telegramUserIdFilter = normalizeTelegramUserIdFilter(
    String(opts.telegramUserId || "").trim()
  );
  const actorKey = String(opts.actorKey || "").trim();
  const traceIdFilter = String(opts.traceId || "").trim();
  const chatIdFilter = String(opts.chatId || "").trim();

  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const { data, error } = await sb
    .from("event_log")
    .select("id, trace_id, log_kind, level, event, payload, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return { ok: false, error: error.message, threads: [], rows: [] };
  }

  let rows = data || [];

  if (traceIdFilter) {
    rows = rows.filter((r) => String(r.trace_id || "") === traceIdFilter);
  }
  if (telegramUserIdFilter) {
    rows = rows.filter(
      (r) => telegramUserIdFromRow(r) === telegramUserIdFilter
    );
  } else if (actorKey) {
    const fromTg = normalizeTelegramUserIdFilter(actorKey);
    if (fromTg) {
      rows = rows.filter((r) => telegramUserIdFromRow(r) === fromTg);
    } else {
      rows = rows.filter((r) => {
        const a = r.payload && r.payload.ctx && r.payload.ctx.actor_key;
        return String(a || "") === actorKey;
      });
    }
  }
  if (chatIdFilter) {
    rows = rows.filter((r) => {
      const c = r.payload && r.payload.ctx && r.payload.ctx.chat_id;
      return String(c || "") === chatIdFilter;
    });
  }

  const threads = groupRowsIntoThreads(rows);

  const tenantIndex = buildTenantIndex(rows);

  return {
    ok: true,
    rows: rows.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ),
    threads,
    tenantIndex,
    meta: {
      hours,
      limit,
      since,
      row_count: rows.length,
    },
  };
}

function groupRowsIntoThreads(rows) {
  const map = new Map();
  for (const r of rows) {
    const tid = String(r.trace_id || "unknown");
    if (!map.has(tid)) map.set(tid, []);
    map.get(tid).push(r);
  }
  const threads = [];
  for (const [trace_id, events] of map.entries()) {
    events.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const withCtx = events.find((e) => e.payload && e.payload.ctx);
    const ctx = withCtx && withCtx.payload && withCtx.payload.ctx;
    const tgId = ctx ? telegramUserIdFromCtx(ctx) : "";
    threads.push({
      trace_id,
      telegram_user_id: tgId || null,
      actor_key: ctx && ctx.actor_key ? String(ctx.actor_key) : null,
      chat_id: ctx && ctx.chat_id ? String(ctx.chat_id) : null,
      inbound_preview:
        ctx && ctx.inbound_text_preview
          ? String(ctx.inbound_text_preview)
          : null,
      event_count: events.length,
      started_at: events[0] && events[0].created_at,
      ended_at: events[events.length - 1] && events[events.length - 1].created_at,
      events,
    });
  }
  threads.sort((a, b) => {
    const tb = new Date(b.ended_at || b.started_at).getTime();
    const ta = new Date(a.ended_at || a.started_at).getTime();
    return tb - ta;
  });
  return threads;
}

/** Distinct tenants by Telegram user id (one row per real user). */
function buildTenantIndex(rows) {
  const byTg = new Map();
  for (const r of rows) {
    const ctx = r.payload && r.payload.ctx;
    const tg = telegramUserIdFromCtx(ctx);
    if (!tg) continue;
    let prev = byTg.get(tg);
    if (!prev) {
      prev = {
        telegram_user_id: tg,
        actor_key: ctx.actor_key ? String(ctx.actor_key) : "TG:" + tg,
        chat_id: ctx.chat_id ? String(ctx.chat_id) : "",
        last_at: r.created_at,
        event_count: 0,
        trace_ids: new Set(),
      };
      byTg.set(tg, prev);
    }
    prev.event_count += 1;
    if (r.trace_id) prev.trace_ids.add(String(r.trace_id));
    const t = new Date(r.created_at).getTime();
    if (new Date(prev.last_at).getTime() < t) prev.last_at = r.created_at;
    if (ctx.chat_id) prev.chat_id = String(ctx.chat_id);
    if (ctx.actor_key) prev.actor_key = String(ctx.actor_key);
  }
  return [...byTg.values()]
    .map((x) => ({
      telegram_user_id: x.telegram_user_id,
      actor_key: x.actor_key,
      chat_id: x.chat_id,
      last_at: x.last_at,
      event_count: x.event_count,
      trace_count: x.trace_ids.size,
    }))
    .sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
}

module.exports = {
  fetchEventLogForDashboard,
  groupRowsIntoThreads,
  telegramUserIdFromCtx,
};
