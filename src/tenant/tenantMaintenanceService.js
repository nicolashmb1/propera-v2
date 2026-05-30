/**
 * Tenant portal — maintenance (ticket) read + write.
 *
 * WRITE rule: ticket creation goes through runInboundPipeline with action
 * create_ticket, same as the PM portal webhook. Never insert tickets or
 * work_items directly. After pipeline confirms ticket_id, we patch
 * intake_channel = 'tenant_portal'.
 *
 * READ rule: always scope by tenantCtx.phone + propertyCode + unitLabel.
 * Never expose tickets belonging to other tenants.
 */

const { buildRouterParameterFromPortal } = require("../contracts/buildRouterParameterFromPortal");
const { runInboundPipeline } = require("../inbound/runInboundPipeline");
const { getSupabase } = require("../db/supabase");
const { supabaseTenantDocsBucket, supabaseUrl } = require("../config/env");
const { normalizePhoneE164 } = require("../utils/phone");

/** Closed tab — Propera canonical "Completed" (normalizePortalTicketStatus). */
function isCompletedStatus(s) {
  const t = String(s || "").trim().toLowerCase();
  return t === "completed" || t === "complete" || t === "done" || t === "closed";
}

/** Portal canonical "Deleted" — hidden on every tab. */
function isDeletedStatus(s) {
  const t = String(s || "").trim().toLowerCase();
  return t === "deleted" || t === "delete";
}

/** Canceled/void — hidden on every tab (not shown as Open or Closed). */
function isVoidStatus(s) {
  const t = String(s || "").trim().toLowerCase();
  return t === "canceled" || t === "cancelled" || t === "void";
}

/** Open tab — all statuses except closed/completed and Deleted (e.g. Open, In Progress). */
function isTenantOpenStatus(s) {
  return !isCompletedStatus(s) && !isDeletedStatus(s);
}

/** Case/space-insensitive unit match (roster "14B" vs ticket "14 B"). */
function normalizeUnitLabel(label) {
  return String(label || "").trim().toUpperCase().replace(/\s+/g, "");
}

/** pm-attachments object path or legacy token → public Supabase object URL. */
function resolveTenantAttachmentPublicUrl(token) {
  const t = String(token || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  const base = String(supabaseUrl || "").trim().replace(/\/$/, "");
  if (!base) return t;
  const path = t.replace(/^pm-attachments\//i, "").replace(/^\/+/, "");
  if (!path.startsWith("tenant-portal/")) return t;
  return encodeURI(`${base}/storage/v1/object/public/pm-attachments/${path}`);
}

function tenantTicketScope(tenantCtx) {
  const phone = normalizePhoneE164(tenantCtx.phone);
  const propertyCode = String(tenantCtx.propertyCode || "").trim().toUpperCase();
  const unitNorm = normalizeUnitLabel(tenantCtx.unitLabel);
  return { phone, propertyCode, unitNorm };
}

function rowMatchesTenantScope(row, scope) {
  const rowPhone = normalizePhoneE164(row.tenant_phone_e164);
  const rowProperty = String(row.property_code || "").trim().toUpperCase();
  const rowUnit = normalizeUnitLabel(row.unit_label);
  return (
    !!scope.phone &&
    !!scope.propertyCode &&
    !!scope.unitNorm &&
    rowPhone === scope.phone &&
    rowProperty === scope.propertyCode &&
    rowUnit === scope.unitNorm
  );
}

/**
 * Map a raw tickets row to a tenant-safe shape (no internal codes in UI copy).
 * @param {object} row
 */
function mapTicketToTenantShape(row) {
  const r = row || {};
  const status = String(r.status || "open").trim().toLowerCase();
  return {
    id:             String(r.id || "").trim(),
    ticketId:       String(r.ticket_id || "").trim(),
    ticketKey:      String(r.ticket_key || "").trim(),
    category:       String(r.category_final || r.category || "General").trim(),
    title:          String(r.message_raw || "").trim().slice(0, 120) || "Maintenance request",
    description:    String(r.message_raw || "").trim(),
    status,
    priority:       String(r.priority || "normal").trim().toLowerCase(),
    intakeChannel:  String(r.intake_channel || "").trim(),
    createdAt:      r.created_at ? new Date(r.created_at).toISOString() : "",
    updatedAt:      r.updated_at ? new Date(r.updated_at).toISOString() : "",
    closedAt:       r.closed_at  ? new Date(r.closed_at).toISOString()  : null,
    serviceNotes:   String(r.service_notes || "").trim(),
    assignee:       String(r.assigned_name || r.assign_to || "").trim(),
    attachments:    String(r.attachments || "").trim()
                      .split(/[\n|]+/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                      .map(resolveTenantAttachmentPublicUrl)
                      .filter(Boolean),
  };
}

const TENANT_TIMELINE_KIND_COLORS = {
  created: "#5E6AD2",
  assigned: "#7c6fba",
  scheduled: "#c07a0a",
  schedule: "#c07a0a",
  vendor_eta: "#a06820",
  eta: "#a06820",
  status_changed: "#1a9e5f",
  status: "#1a9e5f",
  resolved_closed: "#1a9e5f",
  cost_added: "#0d9488",
  cost_updated: "#0f766e",
  tenant_charge_decision: "#7c3aed",
  tenant_changed: "#5b6eae",
};

function sanitizeTimelineActorLabel(raw) {
  const t = String(raw || "").trim();
  if (!t) return "System";
  if (/^POLICY:/i.test(t)) return "Policy";
  if (t.toUpperCase() === "PM_PORTAL") return "Portal";
  return t;
}

function timelineColorForKind(kind) {
  const k = String(kind || "").trim().toLowerCase();
  return TENANT_TIMELINE_KIND_COLORS[k] || "#6b7280";
}

function timelineActionLabel(row) {
  const headline = String(row.headline || "").trim();
  if (headline) return headline;
  const kind = String(row.event_kind || "").trim().toLowerCase();
  if (kind === "resolved_closed") return "Ticket completed";
  if (kind === "status_changed") return "Status updated";
  if (kind === "tenant_changed") return "Tenant updated";
  if (kind === "cost_added") return "Cost added";
  if (kind === "cost_updated") return "Cost updated";
  return "Activity updated";
}

function isTenantVisibleTimelineKind(kindRaw) {
  const kind = String(kindRaw || "").trim().toLowerCase();
  // Tenant portal must not expose internal finance/cost events.
  if (kind === "cost_added" || kind === "cost_updated" || kind === "tenant_charge_decision") {
    return false;
  }
  return true;
}

function buildTenantTimelineFallbackFromTicketRow(row) {
  const out = [];
  const createdAt = row && row.created_at ? new Date(row.created_at).toISOString() : "";
  const closedAt = row && row.closed_at ? new Date(row.closed_at).toISOString() : "";
  const status = String((row && row.status) || "").trim().toLowerCase();
  if (createdAt) {
    out.push({
      action: "Ticket created",
      by: "System",
      time: createdAt,
      color: timelineColorForKind("created"),
    });
  }
  if (closedAt && (status === "completed" || status === "complete" || status === "done" || status === "closed")) {
    out.push({
      action: "Ticket completed",
      by: "System",
      time: closedAt,
      color: timelineColorForKind("resolved_closed"),
    });
  }
  return out
    .filter((e) => !!e.time)
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}

async function listTenantTicketTimeline(sb, ticketRow) {
  const id = String(ticketRow && ticketRow.id ? ticketRow.id : "").trim();
  if (!id) return [];
  const { data, error } = await sb
    .from("ticket_timeline_events")
    .select("occurred_at, event_kind, headline, actor_label")
    .eq("ticket_id", id)
    .order("occurred_at", { ascending: false })
    .limit(100);
  if (error) throw Object.assign(new Error(error.message), { code: "DB_ERROR" });
  const mapped = (data || [])
    .filter((row) => isTenantVisibleTimelineKind(row.event_kind))
    .map((row) => ({
      action: timelineActionLabel(row),
      by: sanitizeTimelineActorLabel(row.actor_label),
      time: row.occurred_at ? new Date(row.occurred_at).toISOString() : "",
      color: timelineColorForKind(row.event_kind),
    }));
  if (mapped.length > 0) return mapped;
  // Older tickets may predate timeline event writes; keep resident Activity non-empty.
  return buildTenantTimelineFallbackFromTicketRow(ticketRow);
}

/**
 * List tickets for the authenticated tenant (scoped by phone + property + unit).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ phone: string, propertyCode: string, unitLabel: string }} tenantCtx
 * @param {{ status?: "open"|"closed"|"all", limit?: number, offset?: number }} opts
 */
async function listTenantTickets(sb, tenantCtx, opts = {}) {
  const scope = tenantTicketScope(tenantCtx);
  if (!scope.phone || !scope.propertyCode || !scope.unitNorm) return [];

  const status   = String(opts.status || "all").toLowerCase();
  const limit    = Math.min(Number(opts.limit  || 20), 100);
  const offset   = Math.max(Number(opts.offset || 0),  0);
  const scanCap  = Math.min(Math.max(limit + offset, limit) * 4, 200);

  let q = sb
    .from("tickets")
    .select(
      "id, ticket_id, ticket_key, message_raw, category, category_final, " +
      "status, priority, service_notes, attachments, intake_channel, " +
      "assign_to, assigned_name, created_at, updated_at, closed_at, " +
      "tenant_phone_e164, property_code, unit_label"
    )
    .eq("tenant_phone_e164", scope.phone)
    .eq("property_code", scope.propertyCode)
    .not("status", "in", "(deleted,Deleted,DELETED,delete,DELETE,canceled,CANCELED,cancelled,CANCELLED,void,VOID)")
    .order("created_at", { ascending: false })
    .limit(scanCap);

  // Push coarse status filtering into SQL so closed tickets are not lost
  // when a tenant has many open tickets within the scan window.
  if (status === "open") {
    q = q.not(
      "status",
      "in",
      "(completed,Completed,COMPLETED,complete,COMPLETE,done,DONE,closed,CLOSED)"
    );
  } else if (status === "closed") {
    q = q.in("status", ["completed", "Completed", "COMPLETED", "complete", "COMPLETE", "done", "DONE", "closed", "CLOSED"]);
  }

  const { data, error } = await q;
  if (error) throw Object.assign(new Error(error.message), { code: "DB_ERROR" });

  let rows = (data || [])
    .filter((row) => rowMatchesTenantScope(row, scope))
    .filter((row) => !isDeletedStatus(row.status) && !isVoidStatus(row.status));

  if (status === "open") rows = rows.filter((row) => isTenantOpenStatus(row.status));
  if (status === "closed") rows = rows.filter((row) => isCompletedStatus(row.status));

  return rows.slice(offset, offset + limit).map(mapTicketToTenantShape);
}

/**
 * Fetch a single ticket, verified to belong to the tenant.
 */
async function getTenantTicket(sb, tenantCtx, ticketId) {
  const scope = tenantTicketScope(tenantCtx);
  if (!scope.phone || !scope.propertyCode || !scope.unitNorm) return null;

  const { data, error } = await sb
    .from("tickets")
    .select(
      "id, ticket_id, ticket_key, message_raw, category, category_final, " +
      "status, priority, service_notes, attachments, intake_channel, " +
      "assign_to, assigned_name, created_at, updated_at, closed_at, " +
      "tenant_phone_e164, property_code, unit_label"
    )
    .eq("id", ticketId)
    .maybeSingle();

  if (error) throw Object.assign(new Error(error.message), { code: "DB_ERROR" });
  if (!data) return null;
  if (!rowMatchesTenantScope(data, scope)) return null;
  if (isDeletedStatus(data.status) || isVoidStatus(data.status)) return null;
  const ticket = mapTicketToTenantShape(data);
  const timeline = await listTenantTicketTimeline(sb, data);
  return { ...ticket, timeline };
}

/**
 * Create a maintenance ticket for the tenant via the inbound pipeline.
 * Uses action=create_ticket (structured, not free-text SMS intake).
 * After pipeline confirms ticket_id, patches intake_channel = 'tenant_portal'.
 *
 * @param {{ phone: string, propertyCode: string, unitLabel: string, tenantId: string }} tenantCtx
 * @param {{ category: string, description: string, photoUrls?: string[] }} body
 * @param {string} traceId
 */
async function createTenantMaintenanceTicket(tenantCtx, body, traceId) {
  const phone = normalizePhoneE164(tenantCtx.phone);
  const propertyCode = String(tenantCtx.propertyCode || "").trim().toUpperCase();
  const unitLabel = String(tenantCtx.unitLabel || "").trim();
  if (!phone || !propertyCode || !unitLabel) {
    throw Object.assign(new Error("tenant_session_incomplete"), { code: "SESSION_ERROR" });
  }
  const category    = String(body.category    || "General").trim();
  const description = String(body.description || "").trim();
  const photoUrls   = Array.isArray(body.photoUrls) ? body.photoUrls : [];

  if (!description || description.length < 5) {
    throw Object.assign(new Error("Description too short"), { code: "VALIDATION_ERROR" });
  }

  const tenantId = String(tenantCtx.tenantId || "").trim();

  const payloadJson = {
    channel:        "tenant_portal",
    actor_type:     "TENANT",
    action:         "create_ticket",
    property:       propertyCode,
    property_code:  propertyCode,
    unit:           unitLabel,
    unit_label:     unitLabel,
    tenant_id:      tenantId,
    category,
    message:        description,
    description,
    location_kind:  "unit",
    ...(photoUrls.length > 0 ? { attachmentUrls: photoUrls, photo_paths: photoUrls } : {}),
  };

  const portalBody = {
    action:          "create_ticket",
    actorPhoneE164:  phone,
    tenantPhoneE164: phone,
    ...payloadJson,
  };

  const routerParameter = buildRouterParameterFromPortal(portalBody);

  const result = await runInboundPipeline({
    traceId,
    traceStartMs: Date.now(),
    routerParameter,
    transportChannel: "portal",
    telegramSignal: null,
    logKind: "tenant_maintenance_create",
    portalUserAccessToken: "",
  });

  const json = result?.json || {};
  const coreRun = result?.coreRun || null;
  if (json.ok === false || coreRun?.ok === false) {
    const msg =
      coreRun?.replyText ||
      json.staff?.reply ||
      json.error ||
      "ticket_create_failed";
    throw Object.assign(new Error(msg), { code: "PIPELINE_ERROR" });
  }

  const fin =
    coreRun?.finalize ||
    (json.core && json.core.finalize) ||
    null;
  const ticketDbId = fin?.ticketDbId ? String(fin.ticketDbId).trim() : "";
  const ticketKey = fin?.ticketKey ? String(fin.ticketKey).trim() : "";
  const humanId = fin?.ticketId ? String(fin.ticketId).trim() : "";

  if (!ticketDbId && !ticketKey) {
    const staffBrain = String(result?.staffRun?.brain || "").trim();
    const msg =
      staffBrain === "staff_clarification"
        ? "Could not create a maintenance request on a staff-linked phone. Use a tenant-only number or contact support."
        : coreRun?.replyText ||
          result?.staffRun?.replyText ||
          "Ticket was not created. Please try again.";
    throw Object.assign(new Error(msg), { code: "PIPELINE_ERROR" });
  }

  const sb = getSupabase();
  if (sb && ticketDbId) {
    await sb
      .from("tickets")
      .update({ intake_channel: "tenant_portal" })
      .eq("id", ticketDbId);
  }

  return {
    id:         ticketDbId || null,
    ticketId:   humanId || null,
    ticketKey:  ticketKey || null,
    humanId:    humanId || null,
  };
}

/**
 * Generate a signed upload URL for a maintenance photo.
 * Path: pm-attachments/tenant-portal/{propertyCode}/{tenantId}/{fileName}
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ propertyCode: string, tenantId: string }} tenantCtx
 * @param {string} fileName  — original filename from client
 */
async function getMaintenanceUploadUrl(sb, tenantCtx, fileName) {
  const { propertyCode, tenantId } = tenantCtx;
  const safeName = String(fileName || "photo.jpg")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 100);
  /** Same bucket as PM portal (`026_pm_attachments_storage_bucket.sql`) — public URLs on ticket rows. */
  const bucket = "pm-attachments";
  const path = `tenant-portal/${propertyCode.toUpperCase()}/${tenantId}/${Date.now()}_${safeName}`;

  /** @deprecated — propera-app uses POST /api/tenant/maintenance/upload (service-role upload). */
  const { data, error } = await sb.storage.from(bucket).createSignedUploadUrl(path);

  if (error) throw Object.assign(new Error(error.message), { code: "STORAGE_ERROR" });

  const { data: pub } = sb.storage.from(bucket).getPublicUrl(data.path);

  return {
    uploadUrl:  data.signedUrl,
    path:       data.path,
    token:      data.token,
    publicPath: data.path,
    publicUrl:  pub.publicUrl,
  };
}

module.exports = {
  listTenantTickets,
  getTenantTicket,
  createTenantMaintenanceTicket,
  getMaintenanceUploadUrl,
  mapTicketToTenantShape,
};
