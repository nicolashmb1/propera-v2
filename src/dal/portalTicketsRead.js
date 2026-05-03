/**
 * Read-only portal ticket list from Supabase.
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

/**
 * Best-effort tenant display names by phone (tenant_roster first, contacts fallback).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string[]} phones
 * @returns {Promise<Record<string, string>>}
 */
async function tenantNamesByPhone(sb, phones) {
  const out = {};
  const uniq = Array.from(
    new Set((phones || []).map((p) => String(p || "").trim()).filter(Boolean))
  );
  if (!sb || !uniq.length) return out;

  const { data: roster } = await sb
    .from("tenant_roster")
    .select("phone_e164, resident_name, active")
    .in("phone_e164", uniq)
    .eq("active", true);
  for (const r of roster || []) {
    const ph = String(r.phone_e164 || "").trim();
    const nm = String(r.resident_name || "").trim();
    if (ph && nm && !out[ph]) out[ph] = nm;
  }

  const missing = uniq.filter((p) => !out[p]);
  if (!missing.length) return out;
  const { data: contacts } = await sb
    .from("contacts")
    .select("phone_e164, display_name")
    .in("phone_e164", missing);
  for (const c of contacts || []) {
    const ph = String(c.phone_e164 || "").trim();
    const nm = String(c.display_name || "").trim();
    if (ph && nm && !out[ph]) out[ph] = nm;
  }
  return out;
}

/**
 * @returns {Promise<object[]>} Remote-shaped rows (see mapTicketRowToRemoteShape)
 */
async function listTicketsForPortal() {
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("tickets")
    .select(
      [
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
        "attachments",
      ].join(",")
    )
    .order("created_at", { ascending: false })
    .limit(2500);

  if (error || !data) return [];

  const phoneMap = await tenantNamesByPhone(
    sb,
    data.map((r) => String(r.tenant_phone_e164 || "").trim())
  );

  return data
    .filter((r) => String(r.status || "").trim().toLowerCase() !== "deleted")
    .map((row) =>
      mapTicketRowToRemoteShape({
        ...row,
        tenant_name: phoneMap[String(row.tenant_phone_e164 || "").trim()] || "",
      })
    );
}

/**
 * Property deck row — GAS-like enough for propera-app `Property` type (minimal KPIs from tickets).
 */
async function listPropertiesForPortal() {
  const sb = getSupabase();
  if (!sb) return [];

  const { data: props, error: pErr } = await sb
    .from("properties")
    .select("code, display_name, short_name, ticket_prefix, address, program_expansion_profile")
    .eq("active", true);

  if (pErr || !props || !props.length) return [];

  // Internal config row — lifecycle defaults, not a real building (propera-app hides it).
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
    };
  });
}

module.exports = {
  listTicketsForPortal,
  listPropertiesForPortal,
};
