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
      name: String(r.tenant_name || r.tenant_display_name || "").trim(),
      phone: String(r.tenant_phone_e164 || "").trim(),
      email: "",
    },
    attachments: attachmentsList.length ? attachmentsList : undefined,
    /** Portal merge layer — not part of legacy GAS shape; consumers may strip. */
    source: "v2",
    ticket_key: String(r.ticket_key || "").trim(),
  };
}

module.exports = { mapTicketRowToRemoteShape };
