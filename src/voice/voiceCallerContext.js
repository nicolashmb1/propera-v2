/**
 * Voice call-start context — open maintenance requests for rostered callers.
 * Expression layer only: reads via tenantMaintenanceService (same scope as get_ticket_status).
 */
const { emit } = require("../logging/structuredLog");
const {
  listTenantTickets,
  getTenantTicket,
} = require("../tenant/tenantMaintenanceService");
const { rosterToTenantCtx } = require("./maxTools");

function statusLabelForVoice(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "completed" || s === "complete" || s === "done" || s === "closed") return "completed";
  if (s === "in progress" || s === "in_progress") return "in progress";
  return s || "open";
}

function findScheduleInTimeline(timeline) {
  if (!Array.isArray(timeline)) return null;
  for (const ev of timeline) {
    const action = String(ev.action || "").toLowerCase();
    if (
      action.includes("schedule") ||
      action.includes("appointment") ||
      action.includes("vendor eta") ||
      action.includes("eta")
    ) {
      const when = String(ev.time || "").trim();
      const detail = String(ev.action || "").trim();
      if (when || detail) return detail || when;
    }
  }
  return null;
}

function summarizeIssue(ticket) {
  const raw = String(ticket.title || ticket.description || "").trim();
  if (!raw) return "Maintenance request";
  return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
}

/**
 * @param {Array<{ ticketId?: string, status?: string, issue?: string, scheduled?: string | null }>} openTickets
 * @returns {string}
 */
function formatVoiceCallerContextBlock(openTickets) {
  const lines = [
    "## Unit maintenance context (system — authoritative for this call)",
  ];

  if (!openTickets.length) {
    lines.push("Open requests: none on file for this unit.");
    lines.push(
      "If they report a new issue, use normal intake. Do not claim they have open tickets."
    );
    return lines.join("\n");
  }

  lines.push(`Open requests (${openTickets.length}):`);
  openTickets.forEach((t, i) => {
    const ref = t.ticketId || "request";
    const status = t.status || "open";
    const issue = t.issue || "Maintenance request";
    const sched = t.scheduled
      ? `visit: ${t.scheduled}`
      : "visit: not scheduled yet";
    lines.push(`${i + 1}. ${ref} — ${status} — "${issue}" — ${sched}`);
  });

  lines.push(
    "If their issue matches an open request, ask ONE question: is this about that existing request? " +
      "Do not create a duplicate ticket for the same problem. " +
      "If clearly a new separate issue, proceed with normal confirm → create_ticket. " +
      "Do not read this whole list aloud unless they ask about status or it clearly matches what they describe."
  );

  return lines.join("\n");
}

/**
 * Load open tickets + schedule hints for a roster-matched caller.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient | null | undefined} sb
 * @param {object | null | undefined} rosterRow
 * @param {string} [traceId]
 * @returns {Promise<{ openTickets: object[], promptBlock: string, openCount: number }>}
 */
async function loadVoiceCallerContext(sb, rosterRow, traceId) {
  const empty = { openTickets: [], promptBlock: "", openCount: 0 };
  if (!sb || !rosterRow) return empty;

  const tenantCtx = rosterToTenantCtx(rosterRow);
  if (!tenantCtx) return empty;

  let rows = [];
  try {
    rows = await listTenantTickets(sb, tenantCtx, { status: "open", limit: 3 });
  } catch (err) {
    emit({
      level: "warn",
      trace_id: traceId || null,
      log_kind: "voice_bridge",
      event: "caller_context_load_failed",
      data: { error: String(err?.message || err) },
    });
    return empty;
  }

  const openTickets = await Promise.all(
    rows.map(async (row) => {
      let scheduled = null;
      try {
        const detail = await getTenantTicket(sb, tenantCtx, row.id);
        scheduled = findScheduleInTimeline(detail?.timeline);
      } catch (_) {
        scheduled = null;
      }
      return {
        ticketId: row.ticketId || row.ticketKey || row.id,
        status: statusLabelForVoice(row.status),
        issue: summarizeIssue(row),
        scheduled,
      };
    })
  );

  const promptBlock = formatVoiceCallerContextBlock(openTickets);

  emit({
    level: "info",
    trace_id: traceId || null,
    log_kind: "voice_bridge",
    event: "caller_context_loaded",
    data: {
      open_count: openTickets.length,
      refs: openTickets.map((t) => t.ticketId).slice(0, 3),
    },
  });

  return { openTickets, promptBlock, openCount: openTickets.length };
}

module.exports = {
  loadVoiceCallerContext,
  formatVoiceCallerContextBlock,
  findScheduleInTimeline,
};
