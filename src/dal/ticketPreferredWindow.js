/**
 * Post-create schedule capture — GAS `parsePreferredWindowShared_` + Sheet `PREF_WINDOW` / `SCHEDULED_END_AT`.
 *
 * PARITY: uses ported `parsePreferredWindowShared` (GAS `08_INTAKE_RUNTIME.gs`). Labels + instants;
 * `validateSchedPolicy_` is NOT run — see docs/PARITY_LEDGER.md §3.
 */
const { getSupabase } = require("../db/supabase");
const {
  parsePreferredWindowShared,
} = require("../brain/gas/parsePreferredWindowShared");
const { properaTimezone, scheduleLatestHour } = require("../config/env");

const MIN_SCHEDULE_LEN = 2;

/**
 * @param {object} o
 * @param {string} o.ticketKey — uuid string (matches tickets.ticket_key)
 * @param {string} o.preferredWindow — raw tenant text
 * @returns {Promise<{ ok: boolean, error?: string, parsed?: object|null }>}
 */
async function applyPreferredWindowByTicketKey(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const key = String(o.ticketKey || "").trim();
  const raw = String(o.preferredWindow || "").trim();
  if (!key || raw.length < MIN_SCHEDULE_LEN) {
    return { ok: false, error: "bad_input" };
  }

  const tz = properaTimezone();
  let parsed = null;
  try {
    parsed = parsePreferredWindowShared(raw, null, {
      now: new Date(),
      timeZone: tz,
      scheduleLatestHour: scheduleLatestHour(),
    });
  } catch (_) {
    parsed = null;
  }

  const preferred_window =
    parsed && parsed.label ? parsed.label : raw;

  let scheduled_end_at = null;
  if (
    parsed &&
    parsed.end instanceof Date &&
    isFinite(parsed.end.getTime())
  ) {
    scheduled_end_at = parsed.end.toISOString();
  }

  const now = new Date().toISOString();
  const { error: tErr } = await sb
    .from("tickets")
    .update({
      preferred_window: preferred_window,
      scheduled_end_at: scheduled_end_at,
      updated_at: now,
    })
    .eq("ticket_key", key);

  if (tErr) return { ok: false, error: tErr.message };

  const { error: wErr } = await sb
    .from("work_items")
    .update({ substate: "", updated_at: now })
    .eq("ticket_key", key);

  if (wErr) return { ok: false, error: wErr.message };

  return { ok: true, parsed: parsed || null };
}

module.exports = {
  applyPreferredWindowByTicketKey,
  MIN_SCHEDULE_LEN,
};
