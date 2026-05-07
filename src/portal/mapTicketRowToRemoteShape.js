/**
 * Map `public.tickets` row → GAS portal `path=tickets` row shape
 * (@see propera-app `RemoteTicketRow` / `mapRemoteTicketRowToTicket`).
 *
 * @param {object} row — Supabase tickets row
 * @returns {Record<string, unknown>}
 */
function mapTicketRowToRemoteShape(row) {
  const r = row || {};
  const created = r.created_at ? new Date(r.created_at).toISOString() : "";
  const closed = r.closed_at ? new Date(r.closed_at).toISOString() : "";

  const prop =
    String(r.property_display_name || "").trim() ||
    String(r.property_code || "").trim();

  const assignee =
    String(r.assigned_name || "").trim() ||
    String(r.assign_to || "").trim() ||
    "";

  const attachmentsRaw = String(r.attachments || "").trim();
  const attachmentsList = attachmentsRaw
    ? attachmentsRaw.split(/[\n|]+/).map((s) => s.trim()).filter(Boolean)
    : [];

  const phoneE164 = String(r.tenant_phone_e164 || "").trim();
  const tenantNameRaw = String(r.tenant_name || r.tenant_display_name || "").trim();
  /** Never show a resident name without a ticket phone — avoids bogus joins when phone is blank. */
  const tenantName = phoneE164 ? tenantNameRaw : "";

  return {
    ticketId: String(r.ticket_id || "").trim(),
    property: prop,
    unit: String(r.unit_label || "").trim(),
    status: String(r.status || "").trim(),
    category: String(r.category || "").trim(),
    categoryFinal: String(r.category_final || "").trim(),
    priority: String(r.priority || "normal").trim(),
    summary: String(r.message_raw || "").trim().slice(0, 200),
    message: String(r.message_raw || "").trim(),
    issue: String(r.message_raw || "").trim(),
    serviceNotes: String(r.service_notes || "").trim(),
    preferredWindow: String(r.preferred_window || "").trim(),
    assignee,
    createdAt: created,
    closedAt: closed,
    tenant: {
      name: tenantName,
      phone: phoneE164,
      email: "",
    },
    attachments: attachmentsList.length ? attachmentsList : undefined,
    /** Portal merge layer — historical imports use `gas` so app keeps legacy id display (no `v2:` prefix). */
    source: r.is_imported_history ? "gas" : "v2",
    ticket_key: String(r.ticket_key || "").trim(),
    /** Historical Sheet1 import — PM mutations must be blocked in app/V2. */
    isImportedHistory: !!r.is_imported_history,
  };
}

module.exports = { mapTicketRowToRemoteShape };
