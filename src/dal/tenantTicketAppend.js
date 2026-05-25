/**
 * Tenant append to an existing ticket — ownership + open-status validation.
 */
const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");
const { normalizePhoneE164 } = require("../utils/phone");

function isTicketOpenForTenantAppend(status) {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return true;
  if (s === "deleted" || s === "void" || s === "canceled" || s === "cancelled") {
    return false;
  }
  if (s === "completed" || s === "closed" || s === "done") return false;
  return true;
}

/**
 * @param {object} o
 * @param {string} o.ticketKey
 * @param {string} o.tenantPhoneE164
 * @param {string} [o.message]
 * @param {string[]} [o.attachmentUrls]
 * @param {string} o.traceId
 * @returns {Promise<{ ok: boolean, brain?: string, replyText?: string, ticketId?: string, error?: string }>}
 */
async function appendToTenantTicket(o) {
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "no_db", brain: "tenant_append_failed" };
  }

  const ticketKey = String(o.ticketKey || "").trim();
  const tenantPhone = normalizePhoneE164(String(o.tenantPhoneE164 || "").trim());
  const message = String(o.message || "").trim();
  const urls = Array.isArray(o.attachmentUrls)
    ? o.attachmentUrls.map((u) => String(u || "").trim()).filter(Boolean)
    : [];

  if (!ticketKey || !tenantPhone) {
    return {
      ok: false,
      error: "missing_fields",
      brain: "tenant_append_invalid",
      replyText: "We could not add that to your request. Please try again or start a new issue.",
    };
  }

  if (!message && !urls.length) {
    return {
      ok: false,
      error: "empty_append",
      brain: "tenant_append_invalid",
      replyText: "Please send a short note or a photo so we can add it to your request.",
    };
  }

  const { data: ticket, error } = await sb
    .from("tickets")
    .select(
      "id, ticket_id, ticket_key, tenant_phone_e164, status, attachments, service_notes, message_raw"
    )
    .eq("ticket_key", ticketKey)
    .maybeSingle();

  if (error || !ticket) {
    return {
      ok: false,
      error: "not_found",
      brain: "tenant_append_not_found",
      replyText: "We could not find that request. You can describe a new issue and we'll open a ticket.",
    };
  }

  const rowPhone = normalizePhoneE164(String(ticket.tenant_phone_e164 || "").trim());
  if (!rowPhone || rowPhone !== tenantPhone) {
    return {
      ok: false,
      error: "forbidden",
      brain: "tenant_append_forbidden",
      replyText: "We could not add that to this request. Please contact the office if you need help.",
    };
  }

  if (!isTicketOpenForTenantAppend(ticket.status)) {
    return {
      ok: false,
      error: "closed",
      brain: "tenant_append_closed",
      replyText:
        "That request is already closed. Reply with a new issue if you need more help.",
    };
  }

  const now = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const patch = {
    updated_at: now,
    last_activity_at: now,
  };

  if (message) {
    const prevNotes = String(ticket.service_notes || "").trim();
    const line = `[Tenant ${now.slice(0, 16).replace("T", " ")}] ${message}`;
    patch.service_notes = prevNotes ? `${prevNotes}\n${line}` : line;
  }

  if (urls.length) {
    const existing = String(ticket.attachments || "").trim();
    const seen = new Set(
      existing
        ? existing
            .split("\n")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        : []
    );
    const lines = existing ? existing.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    for (const u of urls) {
      const k = u.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(u);
    }
    const joined = lines.join("\n");
    patch.attachments = joined.length > 3800 ? joined.slice(0, 3800) : joined;
  }

  const { error: upErr } = await sb
    .from("tickets")
    .update(patch)
    .eq("ticket_key", ticketKey);

  if (upErr) {
    return {
      ok: false,
      error: upErr.message,
      brain: "tenant_append_failed",
      replyText: "We could not save that update right now. Please try again in a moment.",
    };
  }

  await appendEventLog({
    traceId: String(o.traceId || "").trim(),
    log_kind: "brain",
    event: "TENANT_APPEND_TO_TICKET",
    payload: {
      ticket_key: ticketKey,
      ticket_id: String(ticket.ticket_id || "").trim(),
      attachment_count: urls.length,
      has_message: !!message,
    },
  });

  const humanId = String(ticket.ticket_id || "").trim();
  const ref = humanId ? `Ref #${humanId}` : "your request";
  return {
    ok: true,
    brain: "tenant_append_to_ticket",
    ticketId: humanId,
    replyText: `Got it — we added that to ${ref}.`,
  };
}

module.exports = {
  appendToTenantTicket,
  isTicketOpenForTenantAppend,
};
