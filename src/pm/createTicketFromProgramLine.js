/**
 * Create a maintenance ticket from a preventive program line (portal bridge).
 * Uses finalizeMaintenanceDraft — not handleInboundCore / createProgramRun.
 * @see docs/PM_PROGRAM_ENGINE_V1.md
 */

const { getSupabase } = require("../db/supabase");
const { finalizeMaintenanceDraft } = require("../dal/finalizeMaintenance");
const { appendEventLog } = require("../dal/appendEventLog");
const { mergeTicketUpdateRespectingPmOverride } = require("../dal/ticketAssignmentGuard");
const { mergeChangedByIntoTicketPatch } = require("../dal/ticketAuditPatch");
const { findActiveCommonAreaByLabel } = require("../dal/propertyLocations");
const { appendProgramTimelineEvent } = require("../dal/programTimeline");

/**
 * @param {string} scopeLabel
 * @returns {string}
 */
function unitLabelFromScope(scopeLabel) {
  const s = String(scopeLabel || "").trim();
  if (/^unit\s+/i.test(s)) return s.replace(/^unit\s+/i, "").trim();
  return s;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} propertyCodeUpper
 * @param {object} line
 * @returns {Promise<object>}
 */
async function resolveFinalizeLocationFromProgramLine(sb, propertyCodeUpper, line) {
  const scopeType = String(line.scope_type || "").trim().toUpperCase();
  const scopeLabel = String(line.scope_label || "").trim();

  if (scopeType === "UNIT") {
    const unitLabel = unitLabelFromScope(scopeLabel);
    let row = null;
    if (sb && unitLabel) {
      const { data: rows } = await sb
        .from("units")
        .select("id, unit_label, property_code")
        .eq("property_code", propertyCodeUpper)
        .eq("unit_label", unitLabel);
      if (rows && rows.length === 1) row = rows[0];
    }
    return {
      locationType: "UNIT",
      unitLabel: row ? String(row.unit_label || "").trim() : unitLabel,
      unitCatalogId: row ? String(row.id) : "",
      locationId: "",
      locationLabelSnapshot: scopeLabel,
      locationKind: "unit",
    };
  }

  if (scopeType === "COMMON_AREA" || scopeType === "FLOOR") {
    const hit = await findActiveCommonAreaByLabel(sb, propertyCodeUpper, scopeLabel);
    return {
      locationType: "COMMON_AREA",
      unitLabel: "",
      unitCatalogId: "",
      locationId: hit ? String(hit.id) : "",
      locationLabelSnapshot: scopeLabel,
      locationKind: "common_area",
    };
  }

  return {
    locationType: "COMMON_AREA",
    unitLabel: "",
    unitCatalogId: "",
    locationId: "",
    locationLabelSnapshot: scopeLabel || "Site",
    locationKind: "property",
  };
}

/**
 * @param {object} o
 * @param {string} o.lineId
 * @param {string} o.issueText
 * @param {string} [o.category]
 * @param {string} [o.urgency]
 * @param {string} [o.actorPhoneE164]
 * @param {string} [o.traceId]
 * @param {Record<string, string>} [o.portalTicketAudit]
 */
async function createTicketFromProgramLine(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const lineId = String(o.lineId || "").trim();
  if (!lineId) return { ok: false, error: "missing_line_id" };

  const { data: line, error: lineErr } = await sb
    .from("program_lines")
    .select("id, program_run_id, scope_type, scope_label, linked_ticket_id")
    .eq("id", lineId)
    .maybeSingle();

  if (lineErr || !line) return { ok: false, error: "not_found" };
  if (String(line.linked_ticket_id || "").trim()) {
    return { ok: false, error: "line_already_linked" };
  }

  const { data: run, error: runErr } = await sb
    .from("program_runs")
    .select("id, property_code, title")
    .eq("id", line.program_run_id)
    .maybeSingle();

  if (runErr || !run) return { ok: false, error: "run_not_found" };

  const propertyCode = String(run.property_code || "").trim().toUpperCase();
  const userIssue = String(o.issueText || "").trim();
  if (!userIssue) return { ok: false, error: "missing_issue_text" };

  const runTitle = String(run.title || "").trim();
  const scopeLabel = String(line.scope_label || "").trim();
  const issueText = [
    `Found during preventive: ${runTitle} — ${scopeLabel}`,
    "",
    userIssue,
  ]
    .filter((x, i, arr) => !(i === 1 && !x))
    .join("\n");

  const category = String(o.category || "").trim() || "General";
  const urgency = String(o.urgency || "").trim() || "Normal";
  const actorKey = String(o.actorPhoneE164 || "").trim() || "portal_preventive";

  const loc = await resolveFinalizeLocationFromProgramLine(sb, propertyCode, line);

  const routerParameter = {
    _portalAction: "create_ticket",
    _portalPayloadJson: JSON.stringify({
      category,
      urgency,
      status: "OPEN",
      serviceNote: "",
      program_run_id: run.id,
      program_line_id: line.id,
      location_kind: loc.locationKind,
      location_label_snapshot: loc.locationLabelSnapshot,
      ...(loc.locationId ? { location_id: loc.locationId } : {}),
      ...(loc.unitCatalogId ? { unit_catalog_id: loc.unitCatalogId } : {}),
    }),
    _mediaJson: "",
  };
  if (o.portalTicketAudit && typeof o.portalTicketAudit === "object") {
    routerParameter._portalMutationActorJson = JSON.stringify(o.portalTicketAudit);
  }

  const fin = await finalizeMaintenanceDraft({
    traceId: String(o.traceId || "program_line_ticket"),
    propertyCode,
    unitLabel: loc.unitLabel,
    issueText,
    actorKey,
    mode: "MANAGER",
    locationType: loc.locationType,
    locationId: loc.locationId || undefined,
    locationLabelSnapshot: loc.locationLabelSnapshot,
    unitCatalogId: loc.unitCatalogId || undefined,
    reportSourceUnit: "",
    reportSourcePhone: "",
    staffActorKey: actorKey,
    routerParameter,
    tenantPhoneE164: "",
    programRunId: run.id,
    programLineId: line.id,
  });

  if (!fin.ok) return { ok: false, error: fin.error || "finalize_failed", hint: fin.hint };

  const lineUp = {
    linked_ticket_id: String(fin.ticketId),
    linked_work_item_id: String(fin.workItemId),
  };
  const { error: lineUpErr } = await sb.from("program_lines").update(lineUp).eq("id", lineId);
  if (lineUpErr) {
    if (lineUpErr.code === "42703") {
      return { ok: false, error: "program_line_ticket_bridge_migration_required", status: 503 };
    }
    return { ok: false, error: lineUpErr.message || "line_link_failed" };
  }

  const { data: newTicketRow } = await sb
    .from("tickets")
    .select("assignment_source")
    .eq("ticket_key", fin.ticketKey)
    .maybeSingle();

  const ticketPatch = mergeChangedByIntoTicketPatch(
    mergeTicketUpdateRespectingPmOverride(newTicketRow || {}, {
      program_run_id: run.id,
      program_line_id: line.id,
    }),
    o.portalTicketAudit && typeof o.portalTicketAudit === "object" ? o.portalTicketAudit : {}
  );

  const { error: tUpErr } = await sb
    .from("tickets")
    .update(ticketPatch)
    .eq("ticket_key", fin.ticketKey);

  if (tUpErr && tUpErr.code !== "42703") {
    return { ok: false, error: tUpErr.message || "ticket_patch_failed" };
  }

  await sb
    .from("work_items")
    .update({ program_run_id: run.id })
    .eq("ticket_key", fin.ticketKey);

  await appendProgramTimelineEvent({
    sb,
    programRunId: run.id,
    programLineId: lineId,
    eventKind: "ticket_linked",
    headline: "Maintenance ticket created",
    detail: String(fin.ticketId),
    actorLabel: actorKey,
  });

  await appendEventLog({
    traceId: String(o.traceId || ""),
    log_kind: "portal",
    event: "PROGRAM_LINE_TICKET_CREATED",
    payload: {
      program_run_id: run.id,
      program_line_id: lineId,
      ticket_id: fin.ticketId,
      work_item_id: fin.workItemId,
      ticket_key: fin.ticketKey,
    },
  });

  const { getProgramRunById } = require("../dal/programRuns");
  const runDetail = await getProgramRunById(run.id);

  return {
    ok: true,
    ticket_id: fin.ticketId,
    work_item_id: fin.workItemId,
    ticket_key: fin.ticketKey,
    run: runDetail,
  };
}

module.exports = {
  createTicketFromProgramLine,
  resolveFinalizeLocationFromProgramLine,
  unitLabelFromScope,
};
