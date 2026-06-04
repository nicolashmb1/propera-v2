/**
 * set_amenity_schedule — Jarvis Plan → Access Engine weekly hours replace.
 * @see docs/JARVIS_SPINE.md
 */

const crypto = require("crypto");
const { replaceSchedulesForLocation } = require("../../dal/accessEngine");
const { appendEventLog } = require("../../dal/appendEventLog");
const { PROPOSAL_OPS } = require("./types");
const { buildProposalConfirmToken } = require("./proposalToken");

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function normalizeTimeHm(raw) {
  const s = String(raw || "08:00").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "08:00";
  const hour = Math.min(23, Math.max(0, Number(m[1])));
  const minute = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * @param {object[]} rows
 */
function normalizeScheduleRows(rows) {
  const out = [];
  for (const row of rows || []) {
    const day = Number(row.dayOfWeek ?? row.day_of_week);
    if (!Number.isFinite(day) || day < 0 || day > 6) continue;
    out.push({
      dayOfWeek: day,
      openTime: normalizeTimeHm(row.openTime || row.open_time),
      closeTime: normalizeTimeHm(row.closeTime || row.close_time),
    });
  }
  return out.sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

function formatScheduleSummary(rows) {
  const normalized = normalizeScheduleRows(rows);
  if (!normalized.length) return "no hours";
  if (normalized.length === 7) {
    const open = normalized[0].openTime;
    const close = normalized[0].closeTime;
    const allSame = normalized.every((r) => r.openTime === open && r.closeTime === close);
    if (allSame) return `daily ${open}–${close}`;
  }
  return normalized
    .map((r) => `${DAY_NAMES[r.dayOfWeek]} ${r.openTime}–${r.closeTime}`)
    .join(", ");
}

/**
 * @param {object} draft
 * @param {string} summary
 */
function proposalFromSetAmenityScheduleDraft(draft, summary) {
  const d = draft || {};
  const schedules = normalizeScheduleRows(d.schedules);
  return {
    version: "1",
    proposal_id: String(d.proposal_id || crypto.randomUUID()).trim(),
    op: PROPOSAL_OPS.SET_AMENITY_SCHEDULE,
    state: "awaiting_confirm",
    summary_human: String(summary || "").trim(),
    target: {
      location_id: String(d.locationId || d.location_id || "").trim(),
      location_name: String(d.locationName || d.location_name || "").trim(),
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
    },
    payload: {
      location_id: String(d.locationId || d.location_id || "").trim(),
      location_name: String(d.locationName || d.location_name || "").trim(),
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
      schedules,
      schedule_summary: formatScheduleSummary(schedules),
    },
    approval_tier_suggested: 2,
    confirm_token: "",
  };
}

/**
 * @param {object} draft
 * @param {string} summary
 */
function buildSetAmenityScheduleProposal(draft, summary) {
  const proposalId = crypto.randomUUID();
  const schedules = normalizeScheduleRows(draft.schedules);
  const body = {
    ...draft,
    proposal_id: proposalId,
    schedules,
    schedule_summary: formatScheduleSummary(schedules),
  };
  const token = buildProposalConfirmToken(body, PROPOSAL_OPS.SET_AMENITY_SCHEDULE);
  const proposal = proposalFromSetAmenityScheduleDraft(body, summary);
  proposal.confirm_token = token;
  return { proposal, confirmToken: token };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} _sb
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {{ traceId?: string }} ctx
 */
async function commitSetAmenitySchedule(_sb, verified, ctx) {
  const p = verified.payload || {};
  const locationId = String(p.location_id || p.locationId || "").trim();
  const locationName = String(p.location_name || p.locationName || "").trim();
  const schedules = normalizeScheduleRows(p.schedules);

  if (!locationId) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Missing amenity location — try proposing again.",
    };
  }
  if (!schedules.length) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Need at least one day with open and close times.",
    };
  }

  try {
    await replaceSchedulesForLocation(locationId, schedules);

    await appendEventLog({
      traceId: String(ctx.traceId || "").trim(),
      log_kind: "brain",
      event: "JARVIS_SET_AMENITY_SCHEDULE",
      payload: {
        proposal_id: verified.proposal_id,
        location_id: locationId,
        day_count: schedules.length,
      },
    });

    const summary = formatScheduleSummary(schedules);
    const place = locationName || "amenity";

    return {
      ok: true,
      brain: "jarvis_plan",
      replyText: `Hours set for ${place}: ${summary}.`,
      resolution: {
        committed_op: PROPOSAL_OPS.SET_AMENITY_SCHEDULE,
        proposal_id: verified.proposal_id,
        location_name: locationName,
        schedule_summary: summary,
      },
    };
  } catch (err) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: `Hours not saved: ${String(err?.message || err || "failed")}`,
    };
  }
}

module.exports = {
  normalizeScheduleRows,
  formatScheduleSummary,
  proposalFromSetAmenityScheduleDraft,
  buildSetAmenityScheduleProposal,
  commitSetAmenitySchedule,
};
