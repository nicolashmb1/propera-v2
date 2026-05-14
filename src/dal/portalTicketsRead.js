/**
 * Read-only portal ticket list from Supabase.
 * Prefers `portal_*_v1` views when present (migrations 024+); falls back to legacy queries.
 */
const { getSupabase } = require("../db/supabase");
const { mapTicketRowToRemoteShape } = require("../portal/mapTicketRowToRemoteShape");
const { programExpansionProfileForApi } = require("./portalPropertyProgramProfile");

const CLOSED = new Set([
  "completed",
  "canceled",
  "cancelled",
  "resolved",
  "closed",
  "done",
  "deleted",
]);

function isOpenStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return true;
  return !CLOSED.has(s);
}

function isUrgentPriority(priority) {
  const p = String(priority || "").trim().toLowerCase();
  return p === "urgent" || p === "high";
}

function normProp(s) {
  return String(s || "")
    .trim()
    .toUpperCase();
}

function normUnit(s) {
  return String(s || "")
    .trim()
    .toUpperCase();
}

/** Scoped key: same phone must not resolve across different property/unit. */
function tenantLookupKey(phone, propertyCode, unitLabel) {
  const ph = String(phone || "").trim();
  return `${ph}|${normProp(propertyCode)}|${normUnit(unitLabel)}`;
}

/**
 * Tenant display names: roster requires phone + property_code + unit_label match.
 * Contacts only when ticket has no property and no unit (global identity fallback).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {Array<{ tenant_phone_e164?: string; property_code?: string; unit_label?: string }>} ticketRows
 * @returns {Promise<Record<string, string>>} map ticket lookup key -> resident_name
 */
async function tenantNamesForTicketRows(sb, ticketRows) {
  const out = {};
  const rows = ticketRows || [];
  const uniqPhones = Array.from(
    new Set(rows.map((r) => String(r.tenant_phone_e164 || "").trim()).filter(Boolean))
  );
  if (!sb || !uniqPhones.length) return out;

  const { data: roster } = await sb
    .from("tenant_roster")
    .select("phone_e164, property_code, unit_label, resident_name, active")
    .in("phone_e164", uniqPhones)
    .eq("active", true);

  for (const r of roster || []) {
    const ph = String(r.phone_e164 || "").trim();
    const nm = String(r.resident_name || "").trim();
    if (!ph || !nm) continue;
    const key = tenantLookupKey(ph, r.property_code, r.unit_label);
    if (!out[key]) out[key] = nm;
  }

  const needContact = rows.filter((t) => {
    const ph = String(t.tenant_phone_e164 || "").trim();
    if (!ph) return false;
    const prop = String(t.property_code || "").trim();
    const unit = String(t.unit_label || "").trim();
    if (prop || unit) return false;
    const k = tenantLookupKey(ph, prop, unit);
    return !out[k];
  });
  const contactPhones = Array.from(
    new Set(needContact.map((t) => String(t.tenant_phone_e164 || "").trim()).filter(Boolean))
  );
  if (!contactPhones.length) return out;

  const { data: contacts } = await sb
    .from("contacts")
    .select("phone_e164, display_name")
    .in("phone_e164", contactPhones);
  for (const c of contacts || []) {
    const ph = String(c.phone_e164 || "").trim();
    const nm = String(c.display_name || "").trim();
    if (!ph || !nm) continue;
    const key = tenantLookupKey(ph, "", "");
    if (!out[key]) out[key] = nm;
  }
  return out;
}

/**
 * @returns {Promise<object[]>} Remote-shaped rows (see mapTicketRowToRemoteShape)
 */
async function listTicketsForPortal() {
  const sb = getSupabase();
  if (!sb) return [];

  const viaView = await sb
    .from("portal_tickets_v1")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(2500);

  if (!viaView.error && Array.isArray(viaView.data)) {
    return viaView.data.map((row) => mapTicketRowToRemoteShape(row));
  }

  const { data, error } = await sb
    .from("tickets")
    .select(
      [
        "id",
        "ticket_id",
        "tenant_phone_e164",
        "property_code",
        "unit_label",
        "message_raw",
        "category",
        "category_final",
        "status",
        "ticket_key",
        "created_at",
        "updated_at",
        "property_display_name",
        "priority",
        "service_notes",
        "closed_at",
        "preferred_window",
        "assign_to",
        "assigned_name",
        "assigned_type",
        "assigned_id",
        "assigned_at",
        "assigned_by",
        "assignment_source",
        "assignment_note",
        "assignment_updated_at",
        "assignment_updated_by",
        "attachments",
        "is_imported_history",
      ].join(",")
    )
    .order("created_at", { ascending: false })
    .limit(2500);

  if (error || !data) return [];

  const phoneMap = await tenantNamesForTicketRows(sb, data);

  return data
    .filter((r) => String(r.status || "").trim().toLowerCase() !== "deleted")
    .map((row) => {
      const ph = String(row.tenant_phone_e164 || "").trim();
      const key = tenantLookupKey(ph, row.property_code, row.unit_label);
      return mapTicketRowToRemoteShape({
        ...row,
        tenant_name: phoneMap[key] || "",
      });
    });
}

function mapPortalPropertyViewRow(p) {
  const code = String(p.property_code || "").trim().toUpperCase();
  return {
    propertyCode: code,
    name: String(p.name || "").trim() || code,
    shortName: String(p.short_name || "").trim(),
    ticketPrefix: String(p.ticket_prefix || "").trim(),
    open: Number(p.open) || 0,
    urgent: Number(p.urgent) || 0,
    units: Number(p.units) || 0,
    occupied: Number(p.occupied) || 0,
    avgResolution: String(p.avg_resolution || "—"),
    lastActivity: String(p.last_activity || "—"),
    address: String(p.address || "").trim(),
    programExpansionProfile: programExpansionProfileForApi(p.program_expansion_profile),
    maintenanceSpendCentsMonth: Number(p.maintenance_spend_cents_month) || 0,
    maintenanceTenantChargeCentsMonth: Number(p.maintenance_tenant_charge_cents_month) || 0,
    maintenanceCostEntryCountMonth: Number(p.maintenance_cost_entry_count_month) || 0,
  };
}

/**
 * Property deck row — GAS-like enough for propera-app `Property` type (minimal KPIs from tickets).
 */
async function listPropertiesForPortal() {
  const sb = getSupabase();
  if (!sb) return [];

  const viaView = await sb.from("portal_properties_v1").select("*");
  if (!viaView.error && Array.isArray(viaView.data) && viaView.data.length) {
    return viaView.data.map(mapPortalPropertyViewRow);
  }

  const { data: props, error: pErr } = await sb
    .from("properties")
    .select("code, display_name, short_name, ticket_prefix, address, program_expansion_profile")
    .eq("active", true);

  if (pErr || !props || !props.length) return [];

  const visibleProps = props.filter(
    (p) => String(p.code || "").trim().toUpperCase() !== "GLOBAL"
  );
  if (!visibleProps.length) return [];

  const { data: tickets, error: tErr } = await sb
    .from("tickets")
    .select("property_code, status, priority");

  if (tErr) {
    return visibleProps.map((p) => {
      const code = String(p.code || "").trim().toUpperCase();
      return {
        propertyCode: code,
        name: String(p.display_name || p.code || "").trim() || p.code,
        shortName: String(p.short_name || "").trim(),
        ticketPrefix: String(p.ticket_prefix || "").trim(),
        open: 0,
        urgent: 0,
        units: 0,
        occupied: 0,
        avgResolution: "—",
        lastActivity: "—",
        address: String(p.address || "").trim(),
        programExpansionProfile: programExpansionProfileForApi(p.program_expansion_profile),
        maintenanceSpendCentsMonth: 0,
        maintenanceTenantChargeCentsMonth: 0,
        maintenanceCostEntryCountMonth: 0,
      };
    });
  }

  const byCode = {};
  for (const t of tickets || []) {
    const code = String(t.property_code || "").trim().toUpperCase();
    if (!code) continue;
    if (!byCode[code]) byCode[code] = { open: 0, urgent: 0 };
    if (isOpenStatus(t.status)) {
      byCode[code].open += 1;
      if (isUrgentPriority(t.priority)) byCode[code].urgent += 1;
    }
  }

  return visibleProps.map((p) => {
    const code = String(p.code || "").trim().toUpperCase();
    const k = byCode[code] || { open: 0, urgent: 0 };
    return {
      propertyCode: code,
      name: String(p.display_name || p.code || "").trim() || code,
      shortName: String(p.short_name || "").trim(),
      ticketPrefix: String(p.ticket_prefix || "").trim(),
      open: k.open,
      urgent: k.urgent,
      units: 0,
      occupied: 0,
      avgResolution: "—",
      lastActivity: "—",
      address: String(p.address || "").trim(),
      programExpansionProfile: programExpansionProfileForApi(p.program_expansion_profile),
      maintenanceSpendCentsMonth: 0,
      maintenanceTenantChargeCentsMonth: 0,
      maintenanceCostEntryCountMonth: 0,
    };
  });
}

module.exports = {
  listTicketsForPortal,
  listPropertiesForPortal,
};
