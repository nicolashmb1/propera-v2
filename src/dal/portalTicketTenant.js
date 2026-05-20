/**
 * PM portal ticket tenant change — roster-validated `tenant_phone_e164` + work_items sync.
 * Authoritative REST writer (same pattern as `portalTicketAssignment.js`).
 */

const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");
const { updateWorkItemsByTicketKey } = require("./portalTicketMutations");
const { mergeChangedByIntoTicketPatch } = require("./ticketAuditPatch");
const { resolvePortalStaffActorFromJwt } = require("../portal/resolvePortalStaffActor");
const { resolveTicketForAssignment } = require("./portalTicketAssignment");
const { findTenantCandidates, isPhoneOnRosterForUnit } = require("./tenantRoster");
const { normalizePhoneE164 } = require("../utils/phone");
const { normalizeUnit_ } = require("../brain/shared/extractUnitGas");

function decodeLookupHintSafe(raw) {
  const h = String(raw || "").trim();
  if (!h) return "";
  try {
    return decodeURIComponent(h);
  } catch {
    return h;
  }
}

function normalizeHumanTicketIdForLookup(s) {
  return String(s || "")
    .trim()
    .replace(/\u2010|\u2011|\u2012|\u2013|\u2014|\u2212/g, "-");
}

/**
 * Active roster occupants for a property + unit (PM tenant picker).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {string} unitLabel
 */
async function listTenantsForUnitTicket(sb, propertyCode, unitLabel) {
  const code = String(propertyCode || "").trim().toUpperCase();
  const unit = normalizeUnit_(String(unitLabel || ""));
  if (!sb || !code || !unit) {
    return { ok: false, error: "invalid_property_or_unit", tenants: [] };
  }
  const candidates = await findTenantCandidates(sb, code, unit, "");
  const tenants = candidates
    .map((c) => ({
      phoneE164: String(c.phone || "").trim(),
      name: String(c.name || "").trim(),
    }))
    .filter((t) => t.phoneE164);
  return { ok: true, tenants };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} ticketRowId — `tickets.id`
 * @param {string} headline
 * @param {string} detail
 * @param {Record<string, string>} changedBy
 */
async function insertTenantChangedTimeline(sb, ticketRowId, headline, detail, changedBy) {
  const rowId = String(ticketRowId || "").trim();
  if (!rowId) return;
  const label = String(changedBy.changed_by_actor_label || "").trim().slice(0, 200) || "Portal";
  const { error } = await sb.from("ticket_timeline_events").insert({
    ticket_id: rowId,
    occurred_at: new Date().toISOString(),
    event_kind: "tenant_changed",
    headline: String(headline || "Tenant updated").trim().slice(0, 500),
    detail: String(detail || "").trim().slice(0, 2000),
    actor_label: label,
    actor_type: String(changedBy.changed_by_actor_type || "STAFF").trim().slice(0, 32) || "STAFF",
    actor_id: String(changedBy.changed_by_actor_id || "").trim().slice(0, 120),
    actor_source: String(changedBy.changed_by_actor_source || "portal").trim().slice(0, 80),
  });
  if (error) throw new Error(error.message);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {string} unitLabel
 * @param {string} phoneE164
 */
async function rosterDisplayName(sb, propertyCode, unitLabel, phoneE164) {
  const want = normalizePhoneE164(String(phoneE164 || ""));
  if (!want) return "";
  const candidates = await findTenantCandidates(sb, propertyCode, unitLabel, "");
  const hit = candidates.find((c) => normalizePhoneE164(c.phone) === want);
  return hit && hit.name ? String(hit.name).trim() : want;
}

/**
 * @param {object} o
 * @param {string} o.ticketLookupHint
 * @param {string} o.tenantPhoneE164 — roster phone for ticket property + unit
 * @param {string} [o.ticketKeyHint]
 * @param {string} [o.ticketRowIdHint]
 * @param {string} [o.traceId]
 * @param {string} [o.portalUserAccessToken]
 */
async function applyPortalTicketTenantChange(o) {
  const traceId = String(o.traceId || "");
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "no_db", status: 503 };
  }

  const hint = String(o.ticketLookupHint || "").trim();
  const decoded = normalizeHumanTicketIdForLookup(decodeLookupHintSafe(hint));
  const ticket = await resolveTicketForAssignment(sb, decoded, {
    ticketKeyHint: o.ticketKeyHint ?? o.ticket_key,
    ticketRowIdHint: o.ticketRowIdHint ?? o.ticket_row_id,
  });
  if (!ticket) {
    await appendEventLog({
      traceId,
      log_kind: "portal",
      event: "PORTAL_PM_TICKET_TENANT_NOT_FOUND",
      payload: { lookup_hint: hint },
    });
    return { ok: false, error: "ticket_not_found", status: 404 };
  }

  if (ticket.is_imported_history === true) {
    return { ok: false, error: "imported_history_read_only", status: 403 };
  }

  const { data: row, error: loadErr } = await sb
    .from("tickets")
    .select("id, ticket_id, ticket_key, property_code, unit_label, tenant_phone_e164, is_imported_history")
    .eq("id", ticket.id)
    .maybeSingle();
  if (loadErr || !row) {
    return { ok: false, error: loadErr?.message || "ticket_load_failed", status: 500 };
  }

  const propertyCode = String(row.property_code || "").trim().toUpperCase();
  const unitLabel = normalizeUnit_(String(row.unit_label || ""));
  if (!propertyCode || !unitLabel) {
    return { ok: false, error: "ticket_missing_property_or_unit", status: 400 };
  }

  const nextPhone = normalizePhoneE164(
    o.tenantPhoneE164 != null ? o.tenantPhoneE164 : o.tenant_phone_e164
  );
  if (!nextPhone) {
    return { ok: false, error: "tenant_phone_e164_required", status: 400 };
  }

  const onRoster = await isPhoneOnRosterForUnit(sb, propertyCode, unitLabel, nextPhone);
  if (!onRoster) {
    return { ok: false, error: "tenant_not_on_roster_for_unit", status: 400 };
  }

  const prevPhone = normalizePhoneE164(String(row.tenant_phone_e164 || ""));
  if (prevPhone === nextPhone) {
    return {
      ok: true,
      status: 200,
      ticketId: String(row.ticket_id || "").trim(),
      ticketRowId: String(row.id || "").trim(),
      tenantPhoneE164: nextPhone,
      noop: true,
    };
  }

  const jwt = String(o.portalUserAccessToken || "").trim();
  if (!jwt) {
    return { ok: false, error: "missing_portal_access_token", status: 401 };
  }
  const actorRes = await resolvePortalStaffActorFromJwt(sb, jwt);
  if (!actorRes.ok || !actorRes.changedBy) {
    return {
      ok: false,
      error: actorRes.error || "portal_actor_unresolved",
      status: 403,
    };
  }

  const now = new Date().toISOString();
  const resolvedHumanId = String(row.ticket_id || "").trim();
  const ticketKey = String(row.ticket_key || "").trim();
  const prevName = prevPhone ? await rosterDisplayName(sb, propertyCode, unitLabel, prevPhone) : "";
  const nextName = await rosterDisplayName(sb, propertyCode, unitLabel, nextPhone);
  const detail =
    prevPhone && prevName
      ? `${prevName} → ${nextName || nextPhone}`
      : nextName || nextPhone;

  const ticketPatch = mergeChangedByIntoTicketPatch(
    {
      tenant_phone_e164: nextPhone,
      updated_at: now,
      last_activity_at: now,
    },
    actorRes.changedBy
  );

  const { error: uErr } = await sb.from("tickets").update(ticketPatch).eq("ticket_id", resolvedHumanId);
  if (uErr) {
    return { ok: false, error: uErr.message, status: 500 };
  }

  const wiRes = await updateWorkItemsByTicketKey(sb, ticketKey, {
    phone_e164: nextPhone,
    updated_at: now,
  });
  if (!wiRes.ok) {
    return {
      ok: false,
      error: "work_item_update_failed:" + (wiRes.error || ""),
      status: 500,
    };
  }

  try {
    await insertTenantChangedTimeline(
      sb,
      String(row.id || ""),
      "Tenant updated",
      detail,
      actorRes.changedBy
    );
  } catch (tlErr) {
    return {
      ok: false,
      error: "timeline_insert_failed:" + (tlErr instanceof Error ? tlErr.message : String(tlErr)),
      status: 500,
    };
  }

  await appendEventLog({
    traceId,
    log_kind: "portal",
    event: "PORTAL_PM_TICKET_TENANT_CHANGED",
    payload: {
      human_ticket_id: resolvedHumanId,
      ticket_key: ticketKey,
      property_code: propertyCode,
      unit_label: unitLabel,
      previous_phone_e164: prevPhone || null,
      tenant_phone_e164: nextPhone,
      tenant_display_name: nextName || null,
      changed_by: actorRes.changedBy,
    },
  });

  return {
    ok: true,
    status: 200,
    ticketId: resolvedHumanId,
    ticketRowId: String(row.id || "").trim(),
    tenantPhoneE164: nextPhone,
    tenantDisplayName: nextName || "",
  };
}

module.exports = {
  listTenantsForUnitTicket,
  applyPortalTicketTenantChange,
};
