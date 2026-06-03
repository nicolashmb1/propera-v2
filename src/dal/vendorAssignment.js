/**
 * Vendor assignment (authoritative) + dispatch (side effect).
 * @see docs/VENDOR_LANE.md
 */

const { getSupabase, isDbConfigured } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");
const { updateWorkItemsByTicketKey } = require("./portalTicketMutations");
const { mergeChangedByIntoTicketPatch } = require("./ticketAuditPatch");
const { getPropertyByCode } = require("./propertyLookup");
const { dispatchOutbound } = require("../outgate/dispatchOutbound");
const { buildVendorDispatchRequestText } = require("../outgate/vendorMessageSpecs");
const { VENDOR_STATUS } = require("../vendor/vendorStatus");

const TICKET_VENDOR_SELECT =
  "id, ticket_id, ticket_key, property_code, unit_label, category, message_raw, status, is_imported_history, assign_to, assigned_name, assigned_type, assigned_id, assigned_at, assigned_by, assignment_source, assignment_note, assignment_updated_at, assignment_updated_by, vendor_status, vendor_dispatch_at, vendor_dispatched_to";

function isVendorLaneMigrationMissing(error) {
  const msg = String((error && error.message) || "");
  return (
    error &&
    error.code === "42703" &&
    /\b(vendor_dispatch_at|vendor_dispatched_to)\b/.test(msg)
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} ticket
 */
async function loadTicketForVendorOps(sb, ticket) {
  const humanId = String(ticket.ticket_id || "").trim();
  if (!humanId) return ticket;
  const { data, error } = await sb
    .from("tickets")
    .select(TICKET_VENDOR_SELECT)
    .eq("ticket_id", humanId)
    .maybeSingle();
  if (error && !isVendorLaneMigrationMissing(error)) return ticket;
  return data || ticket;
}

/**
 * @param {object} ticket
 * @param {string} vendorId
 */
function isDispatchDeduped(ticket, vendorId) {
  const vid = String(vendorId || "").trim();
  const sentTo = String(ticket.vendor_dispatched_to || "").trim();
  if (!vid || sentTo !== vid) return false;
  return !!ticket.vendor_dispatch_at;
}

/**
 * @param {object} o
 * @param {import("@supabase/supabase-js").SupabaseClient} o.sb
 * @param {object} o.ticket
 * @param {{ vendorId: string, displayName: string, dispatchPhoneE164: string }} o.vendor
 * @param {string} o.traceId
 * @param {boolean} [o.forceResend]
 */
async function dispatchVendorRequest(o) {
  const { sb, ticket, vendor, traceId, forceResend } = o;
  const vendorId = String(vendor.vendorId || "").trim();
  const phone = String(vendor.dispatchPhoneE164 || "").trim();

  if (!vendorDispatchEnabled()) {
    await appendEventLog({
      traceId,
      log_kind: "vendor",
      event: "VENDOR_DISPATCH_SKIPPED",
      payload: { reason: "dispatch_disabled", vendor_id: vendorId, ticket_key: ticket.ticket_key },
    });
    return { dispatched: false, dispatchSkippedReason: "dispatch_disabled" };
  }

  if (!phone) {
    await appendEventLog({
      traceId,
      log_kind: "vendor",
      event: "VENDOR_DISPATCH_SKIPPED",
      payload: { reason: "missing_phone", vendor_id: vendorId, ticket_key: ticket.ticket_key },
    });
    return { dispatched: false, dispatchSkippedReason: "missing_phone" };
  }

  if (!forceResend && isDispatchDeduped(ticket, vendorId)) {
    await appendEventLog({
      traceId,
      log_kind: "vendor",
      event: "VENDOR_DISPATCH_SKIPPED",
      payload: { reason: "already_dispatched", vendor_id: vendorId, ticket_key: ticket.ticket_key },
    });
    return { dispatched: false, dispatchSkippedReason: "already_dispatched" };
  }

  const propertyCode = String(ticket.property_code || "").trim().toUpperCase();
  let propertyName = propertyCode;
  if (propertyCode) {
    const prop = await getPropertyByCode(propertyCode);
    if (prop && String(prop.display_name || "").trim()) {
      propertyName = String(prop.display_name).trim();
    }
  }

  const body = buildVendorDispatchRequestText({
    propertyName,
    unit: ticket.unit_label,
    category: ticket.category,
    issue: ticket.message_raw,
    ticketId: ticket.ticket_id,
  });

  const sendRes = await dispatchOutbound({
    traceId,
    transportChannel: "sms",
    body,
    twilioTo: phone,
    dispatchMeta: {
      intentType: "VENDOR_DISPATCH_REQUEST",
      vendor_id: vendorId,
      ticket_key: String(ticket.ticket_key || ""),
      human_ticket_id: String(ticket.ticket_id || ""),
    },
  });

  const now = new Date().toISOString();
  if (sendRes.ok && !sendRes.skipped) {
    const { error: upErr } = await sb
      .from("tickets")
      .update({
        vendor_dispatch_at: now,
        vendor_dispatched_to: vendorId,
        updated_at: now,
      })
      .eq("ticket_id", String(ticket.ticket_id || "").trim());

    if (upErr && !isVendorLaneMigrationMissing(upErr)) {
      await appendEventLog({
        traceId,
        log_kind: "vendor",
        event: "VENDOR_DISPATCH_FAILED",
        payload: { reason: "mark_dispatch_failed", error: upErr.message, vendor_id: vendorId },
      });
      return { dispatched: false, dispatchError: upErr.message };
    }

    await upsertVendorConversationCtx(sb, vendorId, ticket);
    await appendEventLog({
      traceId,
      log_kind: "vendor",
      event: "VENDOR_DISPATCH_SENT",
      payload: {
        vendor_id: vendorId,
        ticket_key: ticket.ticket_key,
        human_ticket_id: ticket.ticket_id,
        phone_e164: phone,
      },
    });
    return { dispatched: true };
  }

  await appendEventLog({
    traceId,
    log_kind: "vendor",
    event: "VENDOR_DISPATCH_FAILED",
    payload: {
      vendor_id: vendorId,
      ticket_key: ticket.ticket_key,
      error: sendRes.error || "send_failed",
      skipped: !!sendRes.skipped,
    },
  });
  return {
    dispatched: false,
    dispatchError: sendRes.error || "send_failed",
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} vendorId
 * @param {object} ticket
 */
async function upsertVendorConversationCtx(sb, vendorId, ticket) {
  const vid = String(vendorId || "").trim();
  if (!vid) return;
  const row = {
    vendor_id: vid,
    last_ticket_key: String(ticket.ticket_key || "").trim(),
    last_human_ticket_id: String(ticket.ticket_id || "").trim(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("vendor_conversation_ctx").upsert(row, { onConflict: "vendor_id" });
  if (error && error.code !== "42P01") {
    /* migration optional for V1 */
  }
}

function vendorDispatchEnabled() {
  const v = String(process.env.VENDOR_DISPATCH_ENABLED || "1")
    .trim()
    .toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

/**
 * @param {object} o
 * @param {string} o.ticketLookupHint
 * @param {string} [o.ticketKeyHint]
 * @param {string} [o.ticketRowIdHint]
 * @param {string} o.vendorId
 * @param {"PM_OVERRIDE"|"POLICY"|"STAFF_COMMAND"|"AGENT"} o.source
 * @param {string} o.assignedBy
 * @param {string} [o.assignmentNote]
 * @param {boolean} [o.dispatch] — default true
 * @param {boolean} [o.dispatchOnly] — skip assignment patch; dispatch only
 * @param {boolean} [o.forceResend]
 * @param {string} o.traceId
 * @param {object} [o.changedBy] — portal audit patch
 * @param {string} [o.portalUserAccessToken]
 */
async function assignVendorToTicket(o) {
  const { resolveTicketForAssignment, assertVendorAssignable } = require("./portalTicketAssignment");
  const traceId = String(o.traceId || "");
  if (!isDbConfigured()) {
    return { ok: false, error: "no_db", status: 503 };
  }
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "no_db", status: 503 };
  }

  const vendorId = String(o.vendorId || "").trim();
  if (!vendorId) {
    return { ok: false, error: "missing_vendor_id", status: 400 };
  }

  const chk = await assertVendorAssignable(sb, vendorId);
  if (!chk.ok) {
    const st = chk.error === "vendors_migration_required" ? 503 : 400;
    return { ok: false, error: chk.error || "invalid_vendor", status: st };
  }

  const hint = String(o.ticketLookupHint || "").trim();
  let ticket = await resolveTicketForAssignment(sb, hint, {
    ticketKeyHint: o.ticketKeyHint,
    ticketRowIdHint: o.ticketRowIdHint,
  });
  if (!ticket) {
    return { ok: false, error: "ticket_not_found", status: 404 };
  }
  if (ticket.is_imported_history === true) {
    return { ok: false, error: "imported_history_read_only", status: 403 };
  }

  ticket = await loadTicketForVendorOps(sb, ticket);

  const { data: vRow } = await sb
    .from("vendors")
    .select("vendor_id, display_name")
    .eq("vendor_id", vendorId)
    .maybeSingle();
  const displayName =
    String((vRow && vRow.display_name) || "").trim() || vendorId;

  const vendor = {
    vendorId,
    displayName,
    dispatchPhoneE164: await resolveDispatchPhoneForVendor(sb, vendorId),
  };

  const dispatchOnly = o.dispatchOnly === true;
  const wantDispatch = o.dispatch !== false;

  if (dispatchOnly) {
    if (String(ticket.assigned_id || "").trim() !== vendorId) {
      return { ok: false, error: "ticket_not_assigned_to_vendor", status: 400 };
    }
    const disp = await dispatchVendorRequest({
      sb,
      ticket,
      vendor,
      traceId,
      forceResend: o.forceResend === true,
    });
    return {
      ok: true,
      status: 200,
      assigned: true,
      assignmentSkipped: true,
      ticketId: ticket.ticket_id,
      ticketRowId: ticket.id,
      assignedVendorId: vendorId,
      ...disp,
    };
  }

  const source = String(o.source || "POLICY").trim();
  const existingSource = String(ticket.assignment_source || "").trim();
  if (existingSource === "PM_OVERRIDE" && source !== "PM_OVERRIDE") {
    await appendEventLog({
      traceId,
      log_kind: "vendor",
      event: "VENDOR_ASSIGNMENT_SKIPPED_PM_OVERRIDE",
      payload: {
        vendor_id: vendorId,
        ticket_key: ticket.ticket_key,
        attempted_source: source,
      },
    });
    return {
      ok: true,
      status: 200,
      assigned: false,
      assignmentSkipped: true,
      assignmentSkippedReason: "pm_override",
      ticketId: ticket.ticket_id,
      ticketRowId: ticket.id,
      dispatched: false,
      dispatchSkippedReason: "assignment_skipped",
    };
  }

  const now = new Date().toISOString();
  const note = String(o.assignmentNote || "")
    .trim()
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);

  const assignmentSource =
    source === "PM_OVERRIDE" ? "PM_OVERRIDE" : source === "POLICY" ? "POLICY" : source;

  /** @type {Record<string, unknown>} */
  const ticketPatch = mergeChangedByIntoTicketPatch(
    {
      updated_at: now,
      last_activity_at: now,
      assigned_type: "VENDOR",
      assigned_id: vendorId,
      assigned_name: displayName,
      assign_to: displayName,
      assigned_at: now,
      assigned_by: source === "PM_OVERRIDE" ? "PM_PORTAL" : source,
      assignment_source: assignmentSource,
      assignment_note: note,
      assignment_updated_at: now,
      assignment_updated_by: String(o.assignedBy || source).trim(),
    },
    o.changedBy || null
  );

  const curStatus = String(ticket.vendor_status || "").trim();
  if (!curStatus) {
    ticketPatch.vendor_status = VENDOR_STATUS.CONTACTED;
  }

  const { error: uErr } = await sb
    .from("tickets")
    .update(ticketPatch)
    .eq("ticket_id", String(ticket.ticket_id || "").trim());

  if (uErr) {
    return { ok: false, error: uErr.message, status: 500 };
  }

  const ticketKey = String(ticket.ticket_key || "").trim();
  const wiRes = await updateWorkItemsByTicketKey(sb, ticketKey, {
    owner_id: vendorId,
    owner_type: "VENDOR",
    updated_at: now,
  });
  if (!wiRes.ok) {
    return {
      ok: false,
      error: "work_item_update_failed:" + (wiRes.error || ""),
      status: 500,
    };
  }

  await appendEventLog({
    traceId,
    log_kind: "vendor",
    event: "VENDOR_ASSIGNED",
    payload: {
      vendor_id: vendorId,
      ticket_key: ticketKey,
      human_ticket_id: ticket.ticket_id,
      assignment_source: assignmentSource,
    },
  });

  ticket = { ...ticket, ...ticketPatch, ticket_key: ticketKey };

  let disp = {
    dispatched: false,
    dispatchSkippedReason: wantDispatch ? undefined : "dispatch_not_requested",
  };
  if (wantDispatch) {
    disp = await dispatchVendorRequest({
      sb,
      ticket,
      vendor,
      traceId,
      forceResend: o.forceResend === true,
    });
  }

  return {
    ok: true,
    status: 200,
    assigned: true,
    assignmentSkipped: false,
    ticketId: ticket.ticket_id,
    ticketRowId: ticket.id,
    assignedVendorId: vendorId,
    assignedDisplayName: displayName,
    assignmentSource,
    ...disp,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} vendorId
 */
async function resolveDispatchPhoneForVendor(sb, vendorId) {
  const vid = String(vendorId || "").trim();
  if (!vid) return "";
  const { data: rows } = await sb
    .from("vendor_contacts")
    .select("phone_e164, role, active")
    .eq("vendor_id", vid)
    .eq("active", true);
  const list = rows || [];
  const dispatch =
    list.find((r) => String(r.role || "").toLowerCase() === "dispatch") || list[0];
  if (!dispatch) return "";
  const phone = String(dispatch.phone_e164 || "").trim();
  if (!phone) return "";
  if (phone.startsWith("+")) return phone;
  const d10 = phone.replace(/\D/g, "").slice(-10);
  return d10 ? `+1${d10}` : phone;
}

module.exports = {
  assignVendorToTicket,
  dispatchVendorRequest,
  vendorDispatchEnabled,
  isDispatchDeduped,
  upsertVendorConversationCtx,
  loadTicketForVendorOps,
};
