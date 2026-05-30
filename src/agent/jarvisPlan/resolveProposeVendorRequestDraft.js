/**
 * Resolve ticket + vendor for propose_vendor_request (DB — brain validation).
 */

const crypto = require("crypto");
const { getSupabase } = require("../../db/supabase");
const {
  fetchTicketRowForAssignment,
  listVendorsForAssignment,
} = require("../../dal/portalTicketAssignment");
const { tradeHintForVendorMatch } = require("./parseProposeVendorRequest");

const CLOSED = new Set(["completed", "canceled", "cancelled", "resolved", "closed", "done", "deleted"]);

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ humanTicketId?: string, ticketRowId?: string, propertyCode?: string, unit?: string }} hints
 */
async function resolveTicketForVendorProposal(sb, hints) {
  const human = String(hints.humanTicketId || "").trim();
  const rowId = String(hints.ticketRowId || "").trim();
  if (human) {
    const ticket = await fetchTicketRowForAssignment(sb, human);
    if (!ticket) return { ok: false, error: "ticket_not_found", message: `Ticket ${human} not found.` };
    if (ticket.is_imported_history) {
      return { ok: false, error: "imported_read_only", message: "That ticket is read-only history." };
    }
    return { ok: true, ticket };
  }
  if (rowId) {
    const ticket = await fetchTicketRowForAssignment(sb, rowId);
    if (!ticket) return { ok: false, error: "ticket_not_found", message: "Pinned ticket not found." };
    if (ticket.is_imported_history) {
      return { ok: false, error: "imported_read_only", message: "That ticket is read-only history." };
    }
    return { ok: true, ticket };
  }

  const prop = String(hints.propertyCode || "")
    .trim()
    .toUpperCase();
  const unit = String(hints.unit || "").trim();
  if (!prop || !unit) {
    return {
      ok: false,
      error: "need_ticket_or_unit",
      message:
        "Include ticket id (e.g. PENN-012626-0001) or unit + property (e.g. schedule plumber for unit 303 PENN). Pin a ticket in the page context when viewing a unit.",
    };
  }

  const { data, error } = await sb
    .from("tickets")
    .select(
      "id, ticket_id, ticket_key, property_code, unit_label, status, is_imported_history, assigned_name"
    )
    .eq("property_code", prop)
    .order("updated_at", { ascending: false })
    .limit(30);

  if (error) {
    return { ok: false, error: "ticket_lookup_failed", message: error.message };
  }

  const unitNorm = unit.toLowerCase().replace(/\s/g, "");
  const open = (data || []).filter((row) => {
    if (row.is_imported_history) return false;
    const st = String(row.status || "").trim().toLowerCase();
    if (CLOSED.has(st)) return false;
    const u = String(row.unit_label || "")
      .trim()
      .toLowerCase()
      .replace(/\s/g, "");
    return u === unitNorm || u === unitNorm.replace(/^0+/, "") || `unit${u}` === unitNorm;
  });

  if (open.length === 0) {
    return {
      ok: false,
      error: "no_open_ticket",
      message: `No open ticket for unit ${unit} at ${prop}.`,
    };
  }
  if (open.length > 1) {
    const list = open
      .slice(0, 5)
      .map((r) => String(r.ticket_id || "").trim())
      .filter(Boolean)
      .join(", ");
    return {
      ok: false,
      error: "multiple_tickets",
      message: `Several open tickets for unit ${unit} at ${prop}: ${list}. Reply with a ticket id.`,
    };
  }

  const ticket = await fetchTicketRowForAssignment(sb, open[0].ticket_id);
  return ticket
    ? { ok: true, ticket }
    : { ok: false, error: "ticket_not_found", message: "Could not load ticket." };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} tradeKey
 */
async function resolveVendorForTrade(sb, tradeKey) {
  const list = await listVendorsForAssignment(sb);
  if (!list.ok) {
    return {
      ok: false,
      error: list.error || "vendors_unavailable",
      message: "Vendor catalog unavailable.",
    };
  }
  const vendors = list.vendors || [];
  if (!vendors.length) {
    return { ok: false, error: "no_vendors", message: "No active vendors in catalog." };
  }

  const vendorRe = tradeHintForVendorMatch(tradeKey);
  let matches = vendors;
  if (vendorRe) {
    matches = vendors.filter((v) => vendorRe.test(String(v.displayName || "")));
  }
  if (matches.length === 0) {
    return {
      ok: false,
      error: "no_vendor_match",
      message: vendorRe
        ? `No vendor matched trade "${tradeKey}". Add a vendor or name one explicitly.`
        : "Specify trade (plumber, electric, hvac) or vendor name.",
    };
  }
  if (matches.length > 1 && vendorRe) {
    const names = matches
      .slice(0, 5)
      .map((v) => v.displayName || v.vendorId)
      .join(", ");
    return {
      ok: false,
      error: "multiple_vendors",
      message: `Multiple vendors match: ${names}. Pick one in the ticket panel or refine the request.`,
    };
  }
  const pick = matches[0];
  return {
    ok: true,
    vendorId: pick.vendorId,
    vendorDisplayName: pick.displayName || pick.vendorId,
  };
}

/**
 * @param {object} parsed — from parseProposeVendorRequest
 * @param {string} actorLabel
 */
async function resolveProposeVendorRequestDraft(parsed, actorLabel) {
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, message: "Database is not configured." };
  }

  const ticketRes = await resolveTicketForVendorProposal(sb, {
    humanTicketId: parsed.humanTicketId,
    ticketRowId: parsed.ticketRowId,
    propertyCode: parsed.propertyCode,
    unit: parsed.unit,
  });
  if (!ticketRes.ok) {
    return { ok: false, message: ticketRes.message, error: ticketRes.error };
  }

  const vendorRes = await resolveVendorForTrade(sb, parsed.tradeKey || "vendor");
  if (!vendorRes.ok) {
    return { ok: false, message: vendorRes.message, error: vendorRes.error };
  }

  const ticket = ticketRes.ticket;
  const humanTicketId = String(ticket.ticket_id || "").trim();
  const unitLabel = String(ticket.unit_label || parsed.unit || "").trim();
  const prop = String(ticket.property_code || parsed.propertyCode || "").trim();

  const loc =
    unitLabel || prop
      ? ` (${[unitLabel ? `unit ${unitLabel}` : "", prop || ""].filter(Boolean).join(", ")})`
      : "";
  const summary =
    `Assign ${vendorRes.vendorDisplayName} to ${humanTicketId}${loc}` +
    (parsed.dispatch ? " and send dispatch SMS" : " (assign only, no SMS)") +
    "?";

  return {
    ok: true,
    summary,
    commitPayload: {
      proposal_id: crypto.randomUUID(),
      ticketRowId: String(ticket.id || "").trim(),
      humanTicketId,
      ticketKey: String(ticket.ticket_key || "").trim(),
      vendorId: vendorRes.vendorId,
      vendorDisplayName: vendorRes.vendorDisplayName,
      dispatch: parsed.dispatch !== false,
      assignmentNote: String(parsed.assignmentNote || "").slice(0, 200),
      assignedBy: String(actorLabel || "Jarvis Plan").trim(),
      idempotencyKey: crypto.randomUUID(),
    },
  };
}

module.exports = {
  resolveTicketForVendorProposal,
  resolveVendorForTrade,
  resolveProposeVendorRequestDraft,
};
