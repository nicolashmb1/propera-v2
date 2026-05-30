/**
 * Vendor lane inbound — YES/NO replies update ticket vendor fields (no tenant SMS).
 * @see docs/VENDOR_LANE.md Phase V2
 */

const { getSupabase, isDbConfigured } = require("../db/supabase");
const { appendEventLog } = require("../dal/appendEventLog");
const { resolveTicketForAssignment } = require("../dal/portalTicketAssignment");
const { loadTicketForVendorOps, upsertVendorConversationCtx } = require("../dal/vendorAssignment");
const { VENDOR_STATUS } = require("./vendorStatus");
const { parseVendorReply } = require("./parseVendorReply");
const { extractVendorAvailabilityText } = require("./parseVendorAvailability");
const { listActiveHumanTicketIdsForVendor } = require("./listActiveVendorTickets");
const {
  buildVendorConfirmInstructionsText,
  buildVendorNeedTicketIdText,
  buildVendorTicketNotFoundText,
  buildVendorDeclineRecordedText,
  buildVendorAcceptNeedWindowText,
  buildVendorAcceptScheduledText,
  buildVendorWrongTicketText,
  buildVendorMultiPendingNeedTidText,
} = require("../outgate/vendorMessageSpecs");

const TICKET_VENDOR_INBOUND_SELECT =
  "id, ticket_id, ticket_key, property_code, status, is_imported_history, assign_to, assigned_name, assigned_type, assigned_id, vendor_status, vendor_appt, vendor_notes, vendor_dispatch_at, vendor_dispatched_to";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} ticket
 */
async function reloadTicketVendorFields(sb, ticket) {
  const humanId = String(ticket.ticket_id || "").trim();
  if (!humanId) return ticket;
  const { data, error } = await sb
    .from("tickets")
    .select(TICKET_VENDOR_INBOUND_SELECT)
    .eq("ticket_id", humanId)
    .maybeSingle();
  if (error || !data) return ticket;
  return { ...ticket, ...data };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} vendorId
 */
async function loadLastHumanTicketId(sb, vendorId) {
  const vid = String(vendorId || "").trim();
  if (!vid) return "";
  const { data, error } = await sb
    .from("vendor_conversation_ctx")
    .select("last_human_ticket_id")
    .eq("vendor_id", vid)
    .maybeSingle();
  if (error && error.code !== "42P01") return "";
  return String(data?.last_human_ticket_id || "").trim();
}

/**
 * @param {object} ticket
 * @param {string} vendorId
 */
function vendorMayActOnTicket(ticket, vendorId) {
  const vid = String(vendorId || "").trim();
  if (!vid) return false;
  const assigned = String(ticket.assigned_id || "").trim();
  const dispatched = String(ticket.vendor_dispatched_to || "").trim();
  if (!assigned && !dispatched) return true;
  return assigned === vid || dispatched === vid;
}

/**
 * @param {string} prev
 * @param {string} line
 */
function appendVendorNote(prev, line) {
  const p = String(prev || "").trim();
  const l = String(line || "").trim();
  if (!l) return p;
  return p ? `${p} | ${l}` : l;
}

/**
 * @param {object} o
 * @param {object} o.inbound
 * @param {{ vendorId: string, displayName: string, dispatchPhoneE164?: string }} o.vendor
 * @param {string} o.traceId
 * @returns {Promise<{ ok: boolean, brain: string, replyText: string, ticketUpdated?: boolean }>}
 */
async function handleVendorInbound(o) {
  const traceId = String(o.traceId || "");
  const vendor = o.vendor || {};
  const vendorId = String(vendor.vendorId || "").trim();
  const displayName = String(vendor.displayName || "").trim() || vendorId;
  const bodyText = String(o.inbound?.bodyText || o.inbound?.body || "").trim();

  if (!isDbConfigured()) {
    return {
      ok: false,
      brain: "vendor_lane_no_db",
      replyText: "Vendor line unavailable.",
    };
  }
  const sb = getSupabase();
  if (!sb) {
    return {
      ok: false,
      brain: "vendor_lane_no_db",
      replyText: "Vendor line unavailable.",
    };
  }

  const parsed = parseVendorReply(bodyText);

  if (parsed.kind !== "accept" && parsed.kind !== "decline") {
    const avail = extractVendorAvailabilityText(bodyText);
    if (avail && vendorId) {
      const activeIds = await listActiveHumanTicketIdsForVendor(sb, vendorId);
      if (activeIds.length === 0) {
        await appendEventLog({
          traceId,
          log_kind: "vendor",
          event: "VENDOR_AVAIL_NO_ACTIVE",
          payload: { vendor_id: vendorId, availability: avail },
        });
        return {
          ok: true,
          brain: "vendor_avail_no_active",
          replyText: buildVendorConfirmInstructionsText(),
        };
      }
      if (activeIds.length > 1) {
        await appendEventLog({
          traceId,
          log_kind: "vendor",
          event: "VENDOR_AVAIL_MULTI_PENDING",
          payload: {
            vendor_id: vendorId,
            availability: avail,
            ticket_ids: activeIds.slice(0, 5),
          },
        });
        return {
          ok: true,
          brain: "vendor_avail_multi_pending",
          replyText: buildVendorMultiPendingNeedTidText(avail, activeIds),
        };
      }
      const tid = activeIds[0];
      await appendEventLog({
        traceId,
        log_kind: "vendor",
        event: "VENDOR_AVAIL_IMPLICIT_YES",
        payload: { vendor_id: vendorId, human_ticket_id: tid, availability: avail },
      });
      return handleVendorInbound({
        ...o,
        inbound: {
          ...(o.inbound || {}),
          bodyText: `YES ${tid} ${avail}`,
          body: `YES ${tid} ${avail}`,
        },
      });
    }
  }

  if (parsed.kind === "empty" || parsed.kind === "help") {
    return {
      ok: true,
      brain: "vendor_lane_help",
      replyText: buildVendorConfirmInstructionsText(),
    };
  }

  if (!vendorId && (parsed.kind === "accept" || parsed.kind === "decline")) {
    return {
      ok: true,
      brain: "vendor_identity_unresolved",
      replyText:
        "We could not match your number to a vendor account. Contact the property team to confirm dispatch.",
    };
  }

  let humanTicketId = String(parsed.explicitTicketId || "").trim();
  if (!humanTicketId) {
    humanTicketId = await loadLastHumanTicketId(sb, vendorId);
  }
  if (!humanTicketId) {
    return {
      ok: true,
      brain: "vendor_need_ticket_id",
      replyText: buildVendorNeedTicketIdText(),
    };
  }

  let ticket = await resolveTicketForAssignment(sb, humanTicketId, {});
  if (!ticket) {
    return {
      ok: true,
      brain: "vendor_ticket_not_found",
      replyText: buildVendorTicketNotFoundText(humanTicketId),
    };
  }

  ticket = await reloadTicketVendorFields(sb, ticket);
  ticket = await loadTicketForVendorOps(sb, ticket);

  if (ticket.is_imported_history === true) {
    return {
      ok: true,
      brain: "vendor_imported_read_only",
      replyText: "That ticket is read-only history.",
    };
  }

  if (!vendorMayActOnTicket(ticket, vendorId)) {
    return {
      ok: true,
      brain: "vendor_wrong_assignment",
      replyText: buildVendorWrongTicketText(humanTicketId),
    };
  }

  const now = new Date().toISOString();
  const humanId = String(ticket.ticket_id || humanTicketId).trim();

  if (parsed.kind === "decline") {
    const reason = String(parsed.tail || "").trim().slice(0, 500);
    const noteLine = `Declined by ${displayName}${reason ? `: ${reason}` : ""} @ ${now}`;
    const patch = {
      vendor_status: VENDOR_STATUS.DECLINED,
      vendor_notes: appendVendorNote(ticket.vendor_notes, noteLine).slice(0, 4000),
      updated_at: now,
      last_activity_at: now,
    };

    const { error } = await sb.from("tickets").update(patch).eq("ticket_id", humanId);
    if (error) {
      await appendEventLog({
        traceId,
        log_kind: "vendor",
        event: "VENDOR_INBOUND_FAILED",
        payload: { error: error.message, human_ticket_id: humanId, kind: "decline" },
      });
      return {
        ok: false,
        brain: "vendor_update_failed",
        replyText: "Could not save your reply. Try again or contact the office.",
      };
    }

    await upsertVendorConversationCtx(sb, vendorId, ticket);
    await appendEventLog({
      traceId,
      log_kind: "vendor",
      event: "VENDOR_DECLINED",
      payload: {
        vendor_id: vendorId,
        human_ticket_id: humanId,
        ticket_key: ticket.ticket_key,
        reason: reason || null,
      },
    });

    return {
      ok: true,
      brain: "vendor_declined",
      replyText: buildVendorDeclineRecordedText(humanId, reason),
      ticketUpdated: true,
    };
  }

  const apptRaw = String(parsed.tail || "").trim().slice(0, 500);
  if (!apptRaw) {
    const patch = {
      vendor_status: VENDOR_STATUS.ACCEPTED,
      updated_at: now,
      last_activity_at: now,
    };
    const { error } = await sb.from("tickets").update(patch).eq("ticket_id", humanId);
    if (error) {
      return {
        ok: false,
        brain: "vendor_update_failed",
        replyText: "Could not save your reply.",
      };
    }
    await upsertVendorConversationCtx(sb, vendorId, ticket);
    await appendEventLog({
      traceId,
      log_kind: "vendor",
      event: "VENDOR_ACCEPTED_NEEDS_WINDOW",
      payload: { vendor_id: vendorId, human_ticket_id: humanId },
    });
    return {
      ok: true,
      brain: "vendor_accept_needs_window",
      replyText: buildVendorAcceptNeedWindowText(humanId),
      ticketUpdated: true,
    };
  }

  const noteLine = `Accepted by ${displayName} @ ${now}`;
  const patch = {
    vendor_status: VENDOR_STATUS.ACCEPTED,
    vendor_appt: apptRaw,
    status: "Scheduled",
    vendor_notes: appendVendorNote(ticket.vendor_notes, noteLine).slice(0, 4000),
    updated_at: now,
    last_activity_at: now,
  };

  const { error } = await sb.from("tickets").update(patch).eq("ticket_id", humanId);
  if (error) {
    await appendEventLog({
      traceId,
      log_kind: "vendor",
      event: "VENDOR_INBOUND_FAILED",
      payload: { error: error.message, human_ticket_id: humanId, kind: "accept" },
    });
    return {
      ok: false,
      brain: "vendor_update_failed",
      replyText: "Could not save your availability. Try again.",
    };
  }

  await upsertVendorConversationCtx(sb, vendorId, ticket);
  await appendEventLog({
    traceId,
    log_kind: "vendor",
    event: "VENDOR_ACCEPTED",
    payload: {
      vendor_id: vendorId,
      human_ticket_id: humanId,
      ticket_key: ticket.ticket_key,
      vendor_appt: apptRaw,
    },
  });

  return {
    ok: true,
    brain: "vendor_accept_scheduled",
    replyText: buildVendorAcceptScheduledText(humanId, apptRaw),
    ticketUpdated: true,
  };
}

module.exports = {
  handleVendorInbound,
  parseVendorReply,
  vendorMayActOnTicket,
};
