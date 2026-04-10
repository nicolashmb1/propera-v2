/**
 * Create ticket + work_item rows — Sheet1-shaped ticket row when migration 006 is applied.
 */
const crypto = require("crypto");
const { getSupabase } = require("../db/supabase");
const { getPropertyByCode } = require("./propertyLookup");
const {
  formatHumanTicketId,
  inferEmergency,
  localCategoryFromText,
  buildThreadIdV2,
} = require("./ticketDefaults");

function shortWiSuffix() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
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

  const tenantPhone =
    o.mode === "MANAGER" ? "" : String(o.actorKey || "").trim();

  const p = o.routerParameter || {};
  const threadId = buildThreadIdV2({
    traceId: o.traceId,
    mode: o.mode,
    telegramUpdateId: o.telegramUpdateId || p._telegramUpdateId,
    telegramChatId: p._telegramChatId,
  });

  const { emergency, emergencyType } = inferEmergency(o.issueText);
  const categoryLabel = localCategoryFromText(o.issueText);
  const now = new Date();
  const nowIso = now.toISOString();

  const meta = {
    source: o.mode === "MANAGER" ? "STAFF_CAPTURE" : "TELEGRAM_TENANT",
    trace_id: o.traceId,
    telegram_update_id: o.telegramUpdateId || p._telegramUpdateId || null,
    staff_actor: o.staffActorKey || null,
    ticket_human_id: humanTicketId,
    ticket_uuid: uuidTicketKey,
  };

  /** Full Sheet1 parity (requires supabase/migrations/006_tickets_sheet1_columns.sql). */
  const ticketRow = {
    ticket_id: humanTicketId,
    tenant_phone_e164: tenantPhone,
    property_code: o.propertyCode,
    unit_label: o.unitLabel,
    message_raw: o.issueText,
    category: categoryLabel,
    status: "OPEN",
    ticket_key: uuidTicketKey,
    updated_at: nowIso,

    timestamp_logged_at: nowIso,
    property_display_name: displayName,
    emergency,
    emergency_type: emergencyType,
    urgency: "Normal",
    urgency_reason: "",
    confidence: 100,
    next_question: "",
    auto_reply: "No",
    escalated_to_you: "No",
    thread_id: threadId,

    assign_to: "",
    due_by: null,
    last_activity_at: nowIso,
    preferred_window: "",
    handoff_sent: "",

    priority: "",
    service_notes: "",
    closed_at: null,
    attachments: "",

    completed_msg_sent: "No",
    completed_msg_sent_at: null,
    created_msg_sent: "No",
    created_msg_sent_at: null,
    created_by_manager: o.mode === "MANAGER" ? "Yes" : "No",
    cancel_msg_sent: "No",
    cancel_msg_sent_at: null,

    legacy_property_id: legacyPropId,
    legacy_unit_id: "",
    location_type: "UNIT",
    work_type: "MAINTENANCE",
    resident_id: "",
    unit_issue_count: "",
    target_property_id: "",

    assigned_type: "",
    assigned_id: "",
    assigned_name: "",
    assigned_at: null,
    assigned_by: "",
    vendor_status: "",
    vendor_appt: "",
    vendor_notes: "",

    visit_id: "",
    owner_action: "",
    owner_action_at: null,
    // Create path: no tenant window yet. `scheduled_end_at` set later by `applyPreferredWindowByTicketKey` (parsed.end).
    scheduled_end_at: null,
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

  const { error: wErr } = await sb.from("work_items").insert({
    work_item_id: workItemId,
    type: "MAINT",
    status: "OPEN",
    state: "OPEN",
    substate: "",
    phone_e164: String(o.actorKey || "").trim(),
    property_id: o.propertyCode,
    unit_id: o.unitLabel,
    ticket_key: uuidTicketKey,
    metadata_json: meta,
  });

  if (wErr) return { ok: false, error: "work_item:" + wErr.message };

  const actorForCtx = String(o.actorKey || "").trim();
  if (actorForCtx) {
    await sb.from("conversation_ctx").upsert(
      {
        phone_e164: actorForCtx,
        active_work_item_id: workItemId,
        last_intent: "MAINT_INTAKE_FINALIZED",
        updated_at: nowIso,
      },
      { onConflict: "phone_e164" }
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

module.exports = { finalizeMaintenanceDraft };
