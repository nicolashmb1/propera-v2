/**
 * Preventive program timeline V1 — append-only Activity rows.
 * @see docs/PM_PROGRAM_ENGINE_V1.md
 * @see supabase/migrations/059_program_timeline_v1.sql
 */

const { getSupabase } = require("../db/supabase");

/** Contract kinds — keep aligned with tests/programTimelineKinds.test.js */
const PROGRAM_TIMELINE_KINDS = Object.freeze([
  "run_created",
  "run_deleted",
  "line_added",
  "line_removed",
  "line_reordered",
  "line_completed",
  "line_reopened",
  "line_vendor_set",
  "line_staff_set",
  "ticket_linked",
]);

const MAX_HEADLINE = 240;
const MAX_DETAIL = 2000;
const MAX_ACTOR = 200;

/**
 * @param {string} kind
 * @returns {boolean}
 */
function isProgramTimelineKind(kind) {
  return PROGRAM_TIMELINE_KINDS.includes(String(kind || "").trim());
}

/**
 * @param {object} o
 * @param {import('@supabase/supabase-js').SupabaseClient} [o.sb]
 * @param {string} o.programRunId
 * @param {string} [o.programLineId]
 * @param {string} o.eventKind
 * @param {string} o.headline
 * @param {string} [o.detail]
 * @param {string} [o.actorLabel]
 * @returns {Promise<{ ok: boolean; skipped?: boolean; error?: string }>}
 */
async function appendProgramTimelineEvent(o) {
  const sb = o.sb || getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const programRunId = String(o.programRunId || "").trim();
  const eventKind = String(o.eventKind || "").trim();
  if (!programRunId) return { ok: false, error: "missing_program_run_id" };
  if (!isProgramTimelineKind(eventKind)) {
    return { ok: false, error: "invalid_event_kind" };
  }

  const headline = String(o.headline || "").trim().slice(0, MAX_HEADLINE);
  if (!headline) return { ok: false, error: "missing_headline" };

  const row = {
    program_run_id: programRunId,
    program_line_id: o.programLineId ? String(o.programLineId).trim() : null,
    event_kind: eventKind,
    headline,
    detail: String(o.detail || "").trim().slice(0, MAX_DETAIL),
    actor_label: String(o.actorLabel || "Portal").trim().slice(0, MAX_ACTOR) || "Portal",
    occurred_at: new Date().toISOString(),
  };

  const { error } = await sb.from("program_timeline_events").insert(row);
  if (error) {
    if (error.code === "42P01" || /program_timeline_events/.test(String(error.message || ""))) {
      return { ok: true, skipped: true };
    }
    return { ok: false, error: error.message || "insert_failed" };
  }
  return { ok: true };
}

/**
 * @param {string} programRunId
 * @returns {Promise<object[]>}
 */
async function listProgramTimelineForRun(programRunId) {
  const sb = getSupabase();
  const id = String(programRunId || "").trim();
  if (!sb || !id) return [];

  const { data, error } = await sb
    .from("program_timeline_events")
    .select(
      "id, program_run_id, program_line_id, occurred_at, event_kind, headline, detail, actor_label"
    )
    .eq("program_run_id", id)
    .order("occurred_at", { ascending: true });

  if (error) {
    if (error.code === "42P01") return [];
    return [];
  }
  return data || [];
}

module.exports = {
  PROGRAM_TIMELINE_KINDS,
  isProgramTimelineKind,
  appendProgramTimelineEvent,
  listProgramTimelineForRun,
};
