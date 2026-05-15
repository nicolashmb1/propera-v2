/**
 * Post-create schedule capture — GAS `parsePreferredWindowShared_` + `validateSchedPolicy_` + Sheet columns.
 *
 * Flow matches `schedPolicyRecheckWindowFromText_` (`17_PROPERTY_SCHEDULE_ENGINE.gs` ~563–632): infer stage day,
 * parse (with fallback), build `sched`, run `validateSchedPolicy_` against `property_policy` (ppGet parity).
 */
const { getSupabase } = require("../db/supabase");
const {
  parsePreferredWindowShared,
} = require("../brain/gas/parsePreferredWindowShared");
const { inferStageDayFromText_ } = require("../brain/gas/inferStageDayFromText");
const { validateSchedPolicy_ } = require("../brain/gas/validateSchedPolicy");
const { getSchedPolicySnapshot } = require("./propertyPolicy");
const { properaTimezone, scheduleLatestHour } = require("../config/env");
const { emitTimed } = require("../logging/structuredLog");
const { appendEventLog } = require("./appendEventLog");

const MIN_SCHEDULE_LEN = 2;

async function flightLog(traceId, event, payload) {
  await appendEventLog({
    traceId,
    log_kind: "brain",
    event,
    payload: payload || {},
  });
}

function buildSchedFromParsed(raw, d) {
  const sched = { label: raw };
  if (!d) return sched;
  if (d.start instanceof Date && isFinite(d.start.getTime())) {
    sched.date = d.start;
    sched.startHour = d.start.getHours();
  }
  if (d.end instanceof Date && isFinite(d.end.getTime())) {
    sched.date = sched.date || d.end;
    sched.endHour = d.end.getHours();
  }
  return sched;
}

function parseWithStageFallback(raw, stageDay, opts) {
  let d = null;
  try {
    d = parsePreferredWindowShared(raw, stageDay, opts);
  } catch (_) {
    d = null;
  }
  if (
    !d ||
    (!d.start && !d.end && !(d.label && String(d.label).trim()))
  ) {
    try {
      d = parsePreferredWindowShared(raw, null, opts);
    } catch (_) {
      d = null;
    }
  }
  return d;
}

/**
 * @param {object} o
 * @param {string} o.ticketKey — uuid string (matches tickets.ticket_key)
 * @param {string} o.preferredWindow — raw tenant text
 * @param {string} [o.traceId] — request trace for structured logs (`SCHEDULE_*` events)
 * @param {number} [o.traceStartMs] — HTTP entry time for `elapsed_ms` on log lines
 * @param {Record<string, string>} [o.ticketChangedBy] — `changed_by_actor_*` for auditable schedule writes
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   parsed?: object|null,
 *   policyKey?: string,
 *   policyVars?: object,
 * }>}
 */
async function applyPreferredWindowByTicketKey(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const traceId = String(o.traceId || "").trim();
  const traceStartMs =
    o.traceStartMs != null && isFinite(Number(o.traceStartMs))
      ? Number(o.traceStartMs)
      : null;
  const key = String(o.ticketKey || "").trim();
  const raw = String(o.preferredWindow || "").trim();
  if (!key || raw.length < MIN_SCHEDULE_LEN) {
    return { ok: false, error: "bad_input" };
  }

  const { data: ticket, error: loadErr } = await sb
    .from("tickets")
    .select("property_code")
    .eq("ticket_key", key)
    .maybeSingle();

  if (loadErr) return { ok: false, error: loadErr.message };
  if (!ticket) return { ok: false, error: "ticket_not_found" };

  const propCode = String(ticket.property_code || "").trim().toUpperCase() || "GLOBAL";
  const tz = properaTimezone();
  const opts = {
    now: new Date(),
    timeZone: tz,
    scheduleLatestHour: scheduleLatestHour(),
  };

  let stageDay = "Today";
  try {
    const inf = inferStageDayFromText_(raw);
    if (inf) stageDay = inf;
  } catch (_) {}

  const d = parseWithStageFallback(raw, stageDay, opts);
  const sched = buildSchedFromParsed(raw, d);

  const parsedPayload = {
    ticket_key: key,
    property_code: propCode,
    stage_day: stageDay,
    parse_kind: d ? d.kind : null,
    has_start_end: !!(d && d.start && d.end),
    tz,
    raw_len: raw.length,
    crumb: "schedule_parsed",
  };
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId || null,
    log_kind: "brain",
    event: "SCHEDULE_PARSED",
    data: parsedPayload,
  });
  await flightLog(traceId, "SCHEDULE_PARSED", parsedPayload);

  const policySnapshot = await getSchedPolicySnapshot(sb, propCode);
  const when = new Date();

  const checkPayload = {
    ticket_key: key,
    property_code: propCode,
    sched_date:
      sched.date instanceof Date && isFinite(sched.date.getTime())
        ? sched.date.toISOString()
        : null,
    start_hour:
      sched.startHour != null && isFinite(Number(sched.startHour))
        ? Number(sched.startHour)
        : null,
    end_hour:
      sched.endHour != null && isFinite(Number(sched.endHour))
        ? Number(sched.endHour)
        : null,
    policy_snapshot: {
      earliestHour: policySnapshot.earliestHour,
      latestHour: policySnapshot.latestHour,
      allowWeekends: policySnapshot.allowWeekends,
      schedSatAllowed: policySnapshot.schedSatAllowed,
      schedSunAllowed: policySnapshot.schedSunAllowed,
      minLeadHours: policySnapshot.minLeadHours,
      maxDaysOut: policySnapshot.maxDaysOut,
      schedSatLatestHour: policySnapshot.schedSatLatestHour,
    },
    crumb: "schedule_policy_check",
  };
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId || null,
    log_kind: "brain",
    event: "SCHEDULE_POLICY_CHECK",
    data: checkPayload,
  });
  await flightLog(traceId, "SCHEDULE_POLICY_CHECK", checkPayload);

  let verdict = { ok: true };
  try {
    verdict = validateSchedPolicy_(propCode, sched, when, policySnapshot);
  } catch (e) {
    const errPayload = {
      ticket_key: key,
      property_code: propCode,
      message: e && e.message ? String(e.message) : "validateSchedPolicy_ threw",
      crumb: "schedule_policy_error",
    };
    emitTimed(traceStartMs, {
      level: "warn",
      trace_id: traceId || null,
      log_kind: "brain",
      event: "SCHEDULE_POLICY_ERROR",
      data: errPayload,
    });
    await flightLog(traceId, "SCHEDULE_POLICY_ERROR", errPayload);
    verdict = { ok: true };
  }

  const verdictPayload = {
    ticket_key: key,
    property_code: propCode,
    policy_key: verdict.ok ? null : verdict.key,
    policy_vars: verdict.ok ? null : verdict.vars || null,
    ok: !!verdict.ok,
    crumb: verdict.ok ? "schedule_policy_ok" : "schedule_policy_reject",
    summary: verdict.ok
      ? "Schedule policy: allowed (" + propCode + ")"
      : "Schedule policy: rejected · " + String(verdict.key || ""),
  };
  emitTimed(traceStartMs, {
    level: verdict.ok ? "info" : "warn",
    trace_id: traceId || null,
    log_kind: "brain",
    event: verdict.ok ? "SCHEDULE_POLICY_OK" : "SCHEDULE_POLICY_REJECT",
    data: {
      ticket_key: key,
      property_code: propCode,
      policy_key: verdict.ok ? null : verdict.key,
      crumb: verdict.ok ? "schedule_policy_ok" : "schedule_policy_reject",
    },
  });
  await flightLog(
    traceId,
    verdict.ok ? "SCHEDULE_POLICY_OK" : "SCHEDULE_POLICY_REJECT",
    verdictPayload
  );

  if (!verdict.ok) {
    return {
      ok: false,
      error: "policy",
      policyKey: verdict.key,
      policyVars: verdict.vars,
      parsed: d || null,
    };
  }

  const preferred_window =
    d && d.label ? d.label : raw;

  let scheduled_end_at = null;
  if (
    d &&
    d.end instanceof Date &&
    isFinite(d.end.getTime())
  ) {
    scheduled_end_at = d.end.toISOString();
  }

  const now = new Date().toISOString();
  const { mergeChangedByIntoTicketPatch } = require("./ticketAuditPatch");
  const audit =
    o.ticketChangedBy && typeof o.ticketChangedBy === "object" ? o.ticketChangedBy : null;
  const baseTicketPatch = {
    preferred_window: preferred_window,
    scheduled_end_at: scheduled_end_at,
    updated_at: now,
  };
  const ticketPatch = audit ? mergeChangedByIntoTicketPatch(baseTicketPatch, audit) : baseTicketPatch;

  const { error: tErr } = await sb.from("tickets").update(ticketPatch).eq("ticket_key", key);

  if (tErr) return { ok: false, error: tErr.message };

  const { error: wErr } = await sb
    .from("work_items")
    .update({ substate: "", updated_at: now })
    .eq("ticket_key", key);

  if (wErr) return { ok: false, error: wErr.message };

  return { ok: true, parsed: d || null };
}

/**
 * Tenant-facing copy when `validateSchedPolicy_` rejects (GAS `SCHED_REJECT_*`).
 * @param {string} [key]
 * @param {object} [vars]
 */
function schedulePolicyRejectMessage(key, vars) {
  void vars;
  const k = String(key || "").trim();
  if (k === "SCHED_REJECT_WEEKEND") {
    return (
      "That day isn't available for visits at this property. " +
      "Please choose a different day that matches this building's schedule."
    );
  }
  if (k === "SCHED_REJECT_TOO_SOON") {
    return (
      "That time is too soon — we need more advance notice. " +
      "Please pick a later date or time."
    );
  }
  if (k === "SCHED_REJECT_TOO_FAR") {
    return "That date is too far out. Please choose something within the allowed booking window.";
  }
  if (k === "SCHED_REJECT_HOURS") {
    return (
      "That time is outside allowed hours for this property. " +
      "Please pick a time within the building's service window."
    );
  }
  return (
    "That preferred time isn't available for this property's schedule. " +
    "Please try another day or time."
  );
}

module.exports = {
  applyPreferredWindowByTicketKey,
  MIN_SCHEDULE_LEN,
  schedulePolicyRejectMessage,
};
