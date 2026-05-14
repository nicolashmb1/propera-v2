/**
 * Map `public.tickets` row → GAS portal `path=tickets` row shape
 * (@see propera-app `RemoteTicketRow` / `mapRemoteTicketRowToTicket`).
 *
 * @param {object} row — Supabase tickets row
 * @returns {Record<string, unknown>}
 */
function inferAssignmentSourceMachine(r) {
  const raw = String(r.assignment_source || "").trim().toUpperCase();
  if (raw) return raw;
  const by = String(r.assigned_by || "").trim();
  if (by.toUpperCase().startsWith("POLICY:")) return "POLICY";
  if (by.toUpperCase() === "PM_PORTAL") return "PM_OVERRIDE";
  if (String(r.assigned_id || "").trim() || String(r.assigned_name || "").trim()) return "POLICY";
  return "";
}

function inferAssignmentSourceLabel(r) {
  const machine = inferAssignmentSourceMachine(r);
  const pretty = {
    POLICY: "Policy",
    PM_OVERRIDE: "PM override",
    STAFF_REASSIGN: "Staff reassignment",
    SYSTEM_ESCALATION: "System escalation",
    VENDOR: "Vendor",
  };
  if (machine && pretty[machine]) return pretty[machine];
  if (machine) {
    return machine
      .toLowerCase()
      .split("_")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  const by = String(r.assigned_by || "").trim();
  if (by.toUpperCase().startsWith("POLICY:")) return "Policy";
  if (by.toUpperCase() === "PM_PORTAL") return "PM override";
  if (by) return by.length > 48 ? by.slice(0, 48) + "…" : by;
  return "";
}

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

  const assignmentUpdatedRaw = r.assignment_updated_at || r.assigned_at || null;
  const assignmentUpdatedAt = assignmentUpdatedRaw
    ? new Date(assignmentUpdatedRaw).toISOString()
    : "";

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
    ticketRowId: String(r.ticket_row_id || r.id || "").trim(),
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
    propertyCode: String(r.property_code || "").trim(),
    assignedStaffId: String(r.assigned_id || "").trim(),
    assignmentTargetType: String(r.assigned_type || "").trim(),
    assignmentSource: inferAssignmentSourceMachine(r),
    assignmentSourceLabel: inferAssignmentSourceLabel(r),
    assignmentNote: String(r.assignment_note || "").trim(),
    assignmentUpdatedAt,
    assignmentUpdatedBy: String(r.assignment_updated_by || "").trim(),
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
