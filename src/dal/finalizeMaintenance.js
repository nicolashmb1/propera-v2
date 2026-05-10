/**
 * Create ticket + work_item rows — Sheet1-shaped ticket row when migration 006 is applied.
 */
const crypto = require("crypto");
const { getSupabase } = require("../db/supabase");
const { getPropertyByCode } = require("./propertyLookup");
const { lifecyclePolicyGet } = require("./lifecyclePolicyDal");
const {
  formatHumanTicketId,
  inferEmergency,
  localCategoryFromText,
  buildThreadIdV2,
} = require("./ticketDefaults");

/**
 * Portal `create_ticket` — user-supplied category/urgency/status; never infer emergency or category from issue text.
 * @param {Record<string, unknown>} routerParameter
 * @returns {null | { category: string, urgency: string, status: string, serviceNote: string }}
 */
function readPortalCreateTicketPresentation(routerParameter) {
  const p = routerParameter || {};
  if (
    String(p._portalAction || "").trim().toLowerCase() !== "create_ticket"
  ) {
    return null;
  }
  try {
    const j = JSON.parse(String(p._portalPayloadJson || "{}"));
    const cat = String(j.category != null ? j.category : "").trim();
    const urgRaw = String(j.urgency != null ? j.urgency : "NORMAL")
      .trim()
      .toUpperCase();
    let urgency = "Normal";
    if (urgRaw === "URGENT" || urgRaw === "HIGH") urgency = "Urgent";
    const status = String(j.status != null ? j.status : "OPEN").trim() || "OPEN";
    const serviceNote = String(j.serviceNote != null ? j.serviceNote : "").trim();
    return {
      category: cat || "General",
      urgency,
      status,
      serviceNote,
    };
  } catch (_) {
    return null;
  }
}
const { parseMediaJson } = require("../brain/shared/mediaPayload");
const { getStaffDisplayNameByStaffId } = require("./staffPhoneByStaffId");
const {
  normalizeLocationType,
  isCommonAreaLocation,
} = require("../brain/shared/commonArea");

function shortWiSuffix() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
}

function buildTicketAttachmentsFromRouterParameter(routerParameter) {
  const p = routerParameter || {};
  const media = parseMediaJson(p._mediaJson);
  if (!media.length) return "";

  const lines = [];
  const seen = new Set();
  for (const m of media) {
    const url = String((m && (m.url || m.file_url || m.fileUrl)) || "").trim();
    const provider = String((m && m.provider) || "").trim().toLowerCase();
    const fileId = String((m && m.file_id) || "").trim();
    const fileName = String((m && m.file_name) || "").trim();

    let token = "";
    if (url) token = url;
    else if (provider === "telegram" && fileId) token = "telegram:" + fileId;
    else if (fileName) token = "file:" + fileName;
    if (!token) continue;

    const k = token.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(token);
  }
  if (!lines.length) return "";
  const joined = lines.join("\n");
  return joined.length > 3800 ? joined.slice(0, 3800) : joined;
}

/**
 * @param {object} o
 * @param {string} o.traceId
 * @param {string} o.propertyCode
 * @param {string} o.unitLabel
 * @param {string} o.issueText
 * @param {string} o.actorKey
 * @param {'TENANT'|'MANAGER'} o.mode
 * @param {string} [o.staffActorKey]
 * @param {string} [o.telegramUpdateId]
 * @param {Record<string, string | undefined>} [o.routerParameter]
 * @param {string} [o.tenantPhoneE164] — **MANAGER / staff #capture:** resident phone from `tenant_roster` lookup only; never staff phone
 * @param {object} [o.tenantLookupMeta] — merged into `work_items.metadata_json` (GAS `enrichStaffCapTenantIdentity_` fields)
 * @param {string} [o.locationType] — `UNIT|COMMON_AREA`
 * @param {string} [o.locationId] — optional canonical location UUID (transition)
 * @param {string} [o.locationLabelSnapshot] — human-readable location at create
 * @param {string} [o.unitCatalogId] — optional `public.units.id`
 * @param {string} [o.reportSourceUnit] — report context only (not persisted as `unit_label` for common-area)
 * @param {string} [o.reportSourcePhone] — report context only (not persisted as tenant phone for common-area)
 * @param {string} [o.turnoverId] — optional `public.turnovers.id`
 * @param {string} [o.turnoverItemId] — optional `public.turnover_items.id`
 */
async function finalizeMaintenanceDraft(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const prop = await getPropertyByCode(o.propertyCode);
  const displayName = prop ? prop.display_name : "";
  const ticketPrefix = prop && prop.ticket_prefix ? prop.ticket_prefix : o.propertyCode;
  const legacyPropId = prop ? prop.legacy_property_id : "";

  const humanTicketId = formatHumanTicketId(ticketPrefix);
  const uuidTicketKey = crypto.randomUUID();
  const workItemId = "WI_" + shortWiSuffix();

  const resolvedTenant = String(o.tenantPhoneE164 || "").trim();
  const locationType = normalizeLocationType(o.locationType);
  const commonArea = isCommonAreaLocation(locationType);
  const tenantPhoneRaw =
    o.mode === "MANAGER"
      ? resolvedTenant
      : String(o.actorKey || "").trim();
  const tenantPhone = commonArea ? "" : tenantPhoneRaw;
  const persistedUnit = commonArea ? "" : String(o.unitLabel || "").trim();

  const sourceUnit = String(o.reportSourceUnit || o.unitLabel || "").trim();
  const sourcePhone = String(o.reportSourcePhone || tenantPhoneRaw || "").trim();
  const issueBase = String(o.issueText || "").trim();
  let messageRaw = issueBase;
  if (commonArea) {
    const ctxParts = [];
    if (sourceUnit) ctxParts.push("Report from apt " + sourceUnit);
    if (sourcePhone) ctxParts.push("Phone: " + sourcePhone);
    const ctxLine = ctxParts.join(" ");
    if (ctxLine) {
      messageRaw = ctxLine + (issueBase ? "\n" + issueBase : "");
    }
  }

  const p = o.routerParameter || {};
  const portalPresentation = readPortalCreateTicketPresentation(p);
  let emergency;
  let emergencyType;
  let categoryLabel;
  let urgencyCol;
  let ticketStatus;
  let priorityCol;
  let serviceNotesCol;

  if (portalPresentation) {
    emergency = "No";
    emergencyType = "";
    categoryLabel = portalPresentation.category;
    urgencyCol = portalPresentation.urgency;
    ticketStatus = portalPresentation.status;
    serviceNotesCol = portalPresentation.serviceNote;
    const urgUpper = String(portalPresentation.urgency || "").toUpperCase();
    priorityCol = urgUpper === "URGENT" ? "URGENT" : "";
  } else {
    const inf = inferEmergency(o.issueText);
    emergency = inf.emergency;
    emergencyType = inf.emergencyType;
    categoryLabel = localCategoryFromText(o.issueText);
    urgencyCol = "Normal";
    ticketStatus = "OPEN";
    priorityCol = "";
    serviceNotesCol = "";
  }

  const ticketAttachments = buildTicketAttachmentsFromRouterParameter(p);
  const mediaForMeta = parseMediaJson(p._mediaJson);
  const threadId = buildThreadIdV2({
    traceId: o.traceId,
    mode: o.mode,
    telegramUpdateId: o.telegramUpdateId || p._telegramUpdateId,
    telegramChatId: p._telegramChatId,
  });

  const propCodeUpper = String(o.propertyCode || "").trim().toUpperCase();
  let ownerId = "";
  try {
    ownerId = String(
      (await lifecyclePolicyGet(sb, propCodeUpper, "ASSIGN_DEFAULT_OWNER", "")) ||
        ""
    ).trim();
  } catch (_) {}

  let assignLabel = "";
  if (ownerId) {
    try {
      assignLabel =
        (await getStaffDisplayNameByStaffId(sb, ownerId)) || ownerId;
    } catch (_) {
      assignLabel = ownerId;
    }
  }

  /** GAS lifecycle: unscheduled intake vs emergency (see `onWorkItemCreatedUnscheduled_`). */
  const wiState =
    emergency === "Yes" || String(emergency).toLowerCase() === "yes"
      ? "STAFF_TRIAGE"
      : "UNSCHEDULED";
  const wiSubstate =
    emergency === "Yes" || String(emergency).toLowerCase() === "yes"
      ? "EMERGENCY"
      : "";
  const now = new Date();
  const nowIso = now.toISOString();

  const meta = {
    source: o.mode === "MANAGER" ? "STAFF_CAPTURE" : "TELEGRAM_TENANT",
    trace_id: o.traceId,
    telegram_update_id: o.telegramUpdateId || p._telegramUpdateId || null,
    staff_actor: o.staffActorKey || null,
    ticket_human_id: humanTicketId,
    ticket_uuid: uuidTicketKey,
    media_count: mediaForMeta.length,
    media_ocr_present: mediaForMeta.some((m) => String((m && m.ocr_text) || "").trim().length > 0),
  };
  if (o.tenantLookupMeta && typeof o.tenantLookupMeta === "object") {
    Object.assign(meta, o.tenantLookupMeta);
  }
  if (portalPresentation) {
    meta.portal_structured_create = true;
  }

  /** Full Sheet1 parity (requires supabase/migrations/006_tickets_sheet1_columns.sql). */
  const ticketRow = {
    ticket_id: humanTicketId,
    tenant_phone_e164: tenantPhone,
    property_code: o.propertyCode,
    unit_label: persistedUnit,
    message_raw: messageRaw,
    category: categoryLabel,
    status: ticketStatus,
    ticket_key: uuidTicketKey,
    updated_at: nowIso,

    timestamp_logged_at: nowIso,
    property_display_name: displayName,
    emergency,
    emergency_type: emergencyType,
    urgency: urgencyCol,
    urgency_reason: "",
    confidence: 100,
    next_question: "",
    auto_reply: "No",
    escalated_to_you: "No",
    thread_id: threadId,

    assign_to: assignLabel,
    due_by: null,
    last_activity_at: nowIso,
    preferred_window: "",
    handoff_sent: "",

    priority: priorityCol,
    service_notes: serviceNotesCol,
    closed_at: null,
    attachments: ticketAttachments,

    completed_msg_sent: "No",
    completed_msg_sent_at: null,
    created_msg_sent: "No",
    created_msg_sent_at: null,
    created_by_manager: o.mode === "MANAGER" ? "Yes" : "No",
    cancel_msg_sent: "No",
    cancel_msg_sent_at: null,

    legacy_property_id: legacyPropId,
    legacy_unit_id: "",
    location_id: o.locationId || null,
    location_label_snapshot: String(o.locationLabelSnapshot || "").trim(),
    unit_catalog_id: o.unitCatalogId || null,
    location_type: locationType,
    work_type: "MAINTENANCE",
    resident_id: "",
    unit_issue_count: "",
    target_property_id: "",

    assigned_type: ownerId ? "STAFF" : "",
    assigned_id: ownerId,
    assigned_name: assignLabel,
    assigned_at: ownerId ? nowIso : null,
    assigned_by: ownerId ? "POLICY:ASSIGN_DEFAULT_OWNER" : "",
    vendor_status: "",
    vendor_appt: "",
    vendor_notes: "",

    visit_id: "",
    owner_action: "",
    owner_action_at: null,
    // Create path: no tenant window yet. `scheduled_end_at` set later by `applyPreferredWindowByTicketKey` (parsed.end).
    scheduled_end_at: null,

    is_imported_history: false,
    source_system: "",
    source_ticket_id: "",
    source_row_hash: "",
    imported_at: null,
    import_batch_id: "",

    turnover_id: o.turnoverId || null,
    turnover_item_id: o.turnoverItemId || null,
  };

  const { data: ticket, error: tErr } = await sb
    .from("tickets")
    .insert(ticketRow)
    .select("id")
    .maybeSingle();

  if (tErr) {
    return {
      ok: false,
      error: "ticket:" + tErr.message,
      hint:
        tErr.message && tErr.message.indexOf("column") >= 0
          ? "Run migration 006_tickets_sheet1_columns.sql on this database."
          : undefined,
    };
  }

  const wiPhone =
    o.mode === "MANAGER"
      ? resolvedTenant
      : String(o.actorKey || "").trim();

  const { error: wErr } = await sb.from("work_items").insert({
    work_item_id: workItemId,
    type: "MAINT",
    status: "OPEN",
    state: wiState,
    substate: wiSubstate,
    phone_e164: wiPhone,
    property_id: o.propertyCode,
    unit_id: persistedUnit,
    ticket_key: uuidTicketKey,
    owner_id: ownerId || "",
    metadata_json: meta,
    location_id: o.locationId || null,
    location_label_snapshot: String(o.locationLabelSnapshot || "").trim(),
    unit_catalog_id: o.unitCatalogId || null,
    turnover_id: o.turnoverId || null,
  });

  if (wErr) return { ok: false, error: "work_item:" + wErr.message };

  const ctxPhone =
    o.mode === "MANAGER" ? resolvedTenant : String(o.actorKey || "").trim();
  if (ctxPhone) {
    await sb.from("conversation_ctx").upsert(
      {
        phone_e164: ctxPhone,
        active_work_item_id: workItemId,
        last_intent: "MAINT_INTAKE_FINALIZED",
        updated_at: nowIso,
      },
      { onConflict: "phone_e164" }
    );
  }

  /** Arm `PING_UNSCHEDULED` for open-service WIs — must not require `ASSIGN_DEFAULT_OWNER` (owner may be empty). */
  const emergencyYes =
    emergency === "Yes" || String(emergency).toLowerCase() === "yes";
  if (!emergencyYes && wiState === "UNSCHEDULED") {
    const { handleLifecycleSignal } = require("../brain/lifecycle/handleLifecycleSignal");
    await handleLifecycleSignal(
      sb,
      {
        eventType: "WI_CREATED_UNSCHEDULED",
        wiId: workItemId,
        propertyId: propCodeUpper,
        actorType: "SYSTEM",
        actorId: "TICKET_CREATE",
        reasonCode: "NO_SCHEDULE_ON_CREATE",
      },
      { traceId: o.traceId }
    );
  }

  return {
    ok: true,
    ticketId: humanTicketId,
    workItemId,
    ticketKey: uuidTicketKey,
    ticketDbId: ticket && ticket.id,
    threadId,
  };
}

module.exports = { finalizeMaintenanceDraft, buildTicketAttachmentsFromRouterParameter };
