/**
 * Flight recorder — same rows as migration 002_event_log.sql
 */
const { getSupabase } = require("../db/supabase");

/**
 * @param {object} o
 * @param {string} o.traceId
 * @param {string} [o.log_kind]
 * @param {string} [o.level]
 * @param {string} o.event
 * @param {object} [o.payload]
 * @returns {Promise<{ ok: boolean }>}
 */
async function appendEventLog(o) {
  const sb = getSupabase();
  if (!sb || !o || !o.event) return { ok: false };

  const row = {
    trace_id: String(o.traceId || ""),
    log_kind: String(o.log_kind || "brain"),
    level: String(o.level || "info"),
    event: String(o.event),
    payload: o.payload != null ? o.payload : null,
  };

  const { error } = await sb.from("event_log").insert(row);
  if (error) return { ok: false };
  return { ok: true };
}

module.exports = { appendEventLog };
