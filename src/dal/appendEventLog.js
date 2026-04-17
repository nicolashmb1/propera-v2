/**
 * Flight recorder — same rows as migration 002_event_log.sql
 *
 * When the request runs inside `runWithInboundLogCtx` (Telegram webhook), merges
 * `getInboundLogCtx()` into `payload.ctx` so DB rows match structured stdout (actor, chat, etc.).
 */
const { getSupabase } = require("../db/supabase");
const { getInboundLogCtx } = require("../logging/inboundLogContext");

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

  const inbound = getInboundLogCtx();
  let payloadOut = o.payload != null ? o.payload : null;
  if (inbound && typeof inbound === "object") {
    if (
      o.payload != null &&
      typeof o.payload === "object" &&
      !Array.isArray(o.payload)
    ) {
      payloadOut = {
        ...o.payload,
        ctx: {
          ...inbound,
          ...(o.payload.ctx && typeof o.payload.ctx === "object"
            ? o.payload.ctx
            : {}),
        },
      };
    } else if (o.payload != null) {
      payloadOut = { ctx: { ...inbound }, data: o.payload };
    } else {
      payloadOut = { ctx: { ...inbound } };
    }
  }

  const row = {
    trace_id: String(o.traceId || ""),
    log_kind: String(o.log_kind || "brain"),
    level: String(o.level || "info"),
    event: String(o.event),
    payload: payloadOut,
  };

  const { error } = await sb.from("event_log").insert(row);
  if (error) return { ok: false };
  return { ok: true };
}

module.exports = { appendEventLog };
