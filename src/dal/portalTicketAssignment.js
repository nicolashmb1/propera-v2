/**
 * PM portal ticket assignment — deterministic writes + work_items.owner_id sync.
 * This route is the **authoritative PM writer** for assignment columns; it does **not**
 * use `ticketAssignmentGuard.mergeTicketUpdateRespectingPmOverride` (that guard is for
 * policy/automation `tickets.update` paths only). @see docs/PM_ASSIGNMENT_OVERRIDE.md Phase 3.
 * @see supabase/migrations/043_ticket_assignment_responsibility_v1.sql
 */

const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");
const { updateWorkItemsByTicketKey } = require("./portalTicketMutations");
const { getStaffDisplayNameByStaffId } = require("./staffPhoneByStaffId");
const { resolvePortalStaffActorFromJwt } = require("../portal/resolvePortalStaffActor");
const { mergeChangedByIntoTicketPatch } = require("./ticketAuditPatch");

const HUMAN_ID = "([A-Za-z0-9]{2,12}-\\d{6}-\\d{4})";
const HUMAN_TICKET_ID_RE = new RegExp(`^${HUMAN_ID}$`, "i");
const SHORT_HUMAN_TICKET_ID_RE = /^[A-Za-z0-9]{2,12}-\d{1,6}$/i;
/** Accepts any standard UUID (any version/variant) */
const TICKET_ROW_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TICKET_ASSIGNMENT_SELECT =
  "id, ticket_id, ticket_key, property_code, status, is_imported_history, assign_to, assigned_name, assigned_type, assigned_id, assigned_at, assigned_by, assignment_source, assignment_note, assignment_updated_at, assignment_updated_by";

const UNASSIGNED_TOKEN = "__UNASSIGNED__";

function isAssignmentMigrationMissingError(error) {
  const msg = String((error && error.message) || "");
  return (
    error &&
    error.code === "42703" &&
    /\bassignment_(source|note|updated_at|updated_by)\b/.test(msg)
  );
}

function throwIfAssignmentMigrationMissing(error) {
  if (!isAssignmentMigrationMissingError(error)) return;
  const msg = String(error.message || "assignment columns missing");
  const e = new Error("assignment_migration_required:" + msg);
  e.code = "ASSIGNMENT_MIGRATION_REQUIRED";
  throw e;
}

function pmAssignDebugEnabled() {
  const v = String(process.env.PROPERA_PM_ASSIGN_DEBUG || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** @param {string} raw */
function decodeLookupHintSafe(raw) {
  const h = String(raw || "").trim();
  if (!h) return "";
  try {
    return decodeURIComponent(h);
  } catch {
    return h;
  }
}

/** @param {string} decoded */
function classifyAssignmentHint(decoded) {
  const d = String(decoded || "").trim();
  if (!d) return "empty";
  if (TICKET_ROW_UUID_RE.test(d)) return "uuid";
  if (HUMAN_TICKET_ID_RE.test(d)) return "human_full";
  if (SHORT_HUMAN_TICKET_ID_RE.test(d)) return "human_short";
  return "opaque";
}

/** Unicode dashes → ASCII so `tickets.ticket_id` matches Sheet / OS typography. */
function normalizeHumanTicketIdForLookup(s) {
  return String(s || "")
    .trim()
    .replace(/\u2010|\u2011|\u2012|\u2013|\u2014|\u2212/g, "-");
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} lookupHint — human `ticket_id` or row UUID
 */
async function fetchTicketRowForAssignment(sb, lookupHint) {
  const hint = normalizeHumanTicketIdForLookup(String(lookupHint || "").trim());
  if (!sb || !hint) return null;
  if (TICKET_ROW_UUID_RE.test(hint)) {
    const hl = hint.toLowerCase();
    const { data, error } = await sb
      .from("tickets")
      .select(TICKET_ASSIGNMENT_SELECT)
      .eq("id", hl)
      .maybeSingle();
    throwIfAssignmentMigrationMissing(error);
    if (!error && data) return data;
    // Path may carry work-item `ticket_key` (UUID text) instead of row PK `id`.
    const { data: dk, error: ek } = await sb
      .from("tickets")
      .select(TICKET_ASSIGNMENT_SELECT)
      .eq("ticket_key", hl)
      .maybeSingle();
    throwIfAssignmentMigrationMissing(ek);
    if (!ek && dk) return dk;
    const { data: dk2, error: ek2 } = await sb
      .from("tickets")
      .select(TICKET_ASSIGNMENT_SELECT)
      .eq("ticket_key", hint)
      .maybeSingle();
    throwIfAssignmentMigrationMissing(ek2);
    if (!ek2 && dk2) return dk2;
    return null;
  }
  if (HUMAN_TICKET_ID_RE.test(hint) || SHORT_HUMAN_TICKET_ID_RE.test(hint)) {
    const upper = hint.toUpperCase();
    const { data, error } = await sb
      .from("tickets")
      .select(TICKET_ASSIGNMENT_SELECT)
      .eq("ticket_id", upper)
      .maybeSingle();
    throwIfAssignmentMigrationMissing(error);
    if (!error && data) return data;
    const { data: dI, error: eI } = await sb
      .from("tickets")
      .select(TICKET_ASSIGNMENT_SELECT)
      .ilike("ticket_id", hint)
      .maybeSingle();
    throwIfAssignmentMigrationMissing(eI);
    if (!eI && dI) return dI;
    return null;
  }
  // Last-resort: try ticket_key as-is (e.g. GAS key with colons)
  const hintUpper = hint.toUpperCase();
  const { data: dk, error: ek } = await sb
    .from("tickets")
    .select(TICKET_ASSIGNMENT_SELECT)
    .eq("ticket_key", hintUpper)
    .maybeSingle();
  throwIfAssignmentMigrationMissing(ek);
  if (!ek && dk) return dk;
  return null;
}

/**
 * URL hint first, then optional body hints (propera-app sends these when URL human id
 * does not match `tickets.ticket_id` in this DB but `ticket_key` / row id still does).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} decodedUrlHint
 * @param {object} [hints]
 * @param {string} [hints.ticketKeyHint]
 * @param {string} [hints.ticketRowIdHint]
 */
async function resolveTicketForAssignment(sb, decodedUrlHint, hints) {
  const h = hints || {};
  let ticket = await fetchTicketRowForAssignment(sb, decodedUrlHint);
  if (ticket) return ticket;

  const key = String(h.ticketKeyHint ?? h.ticket_key ?? "").trim();
  if (key && TICKET_ROW_UUID_RE.test(key)) {
    ticket = await fetchTicketRowForAssignment(sb, key.toLowerCase());
    if (ticket) return ticket;
  }

  const row = String(h.ticketRowIdHint ?? h.ticket_row_id ?? "").trim();
  if (row && TICKET_ROW_UUID_RE.test(row)) {
    ticket = await fetchTicketRowForAssignment(sb, row.toLowerCase());
    if (ticket) return ticket;
  }

  return null;
}

/**
 * All active staff for PM reassignment (portal token).
 * `propertyCode` is kept for route compatibility; list is org-wide so operators are not
 * blocked by missing `staff_assignments` rows for a property.
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode — unused for query; must be non-empty for API validation
 */
async function listStaffAssignableToProperty(sb, propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!sb || !code) {
    return { ok: false, error: "invalid_property_code", staff: [] };
  }

  const { data: staffRows, error: sErr } = await sb
    .from("staff")
    .select("staff_id, display_name, active")
    .eq("active", true)
    .order("display_name", { ascending: true });

  if (sErr) {
    return { ok: false, error: sErr.message, staff: [] };
  }

  const staff = (staffRows || [])
    .map((r) => ({
      staffId: String(r.staff_id || "").trim(),
      displayName: String(r.display_name || "").trim() || String(r.staff_id || "").trim(),
    }))
    .filter((r) => r.staffId);

  return { ok: true, staff };
}

/**
 * Staff row must exist and be active (PM may assign any active staff to a ticket).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} staffIdText — `staff.staff_id`
 */
async function assertStaffAssignable(sb, staffIdText) {
  const sid = String(staffIdText || "").trim();
  if (!sid) return { ok: false, error: "missing_assigned_staff_id" };

  const { data: st, error: e1 } = await sb
    .from("staff")
    .select("id, active")
    .eq("staff_id", sid)
    .maybeSingle();

  if (e1 || !st || st.active === false) {
    return { ok: false, error: "staff_not_found" };
  }

  return { ok: true };
}

function sanitizeAssignmentNote(raw) {
  return String(raw || "")
    .trim()
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

/**
 * @param {object} o
 * @param {string} o.ticketLookupHint — URL param: human id or tickets.id UUID
 * @param {string} [o.assignedStaffId] — `staff.staff_id`; empty or UNASSIGNED_TOKEN clears
 * @param {string} [o.assignmentNote]
 * @param {string} [o.actorLabel] — PM display name for audit
 * @param {string} [o.traceId]
 * @param {string} [o.ticketKeyHint] — body `ticket_key` / `ticketKey` (UUID) when URL human id misses
 * @param {string} [o.ticketRowIdHint] — body `ticket_row_id` / `ticketRowId` (tickets.id UUID)
 */
async function applyPortalTicketAssignment(o) {
  const traceId = String(o.traceId || "");
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "no_db", status: 503 };
  }

  const hint = String(o.ticketLookupHint || "").trim();
  const decodedRaw = decodeLookupHintSafe(hint);
  const decoded = normalizeHumanTicketIdForLookup(decodedRaw);
  const shape = classifyAssignmentHint(decoded);

  if (pmAssignDebugEnabled()) {
    console.warn(
      "[PROPERA pm-assign:v2] request",
      JSON.stringify({
        traceId: traceId || undefined,
        lookup_param: hint,
        decoded,
        shape,
        assigned_staff_id: String(o.assignedStaffId || "").trim() || undefined,
        ticket_key_hint: String(o.ticketKeyHint ?? o.ticket_key ?? "").trim() || undefined,
        ticket_row_hint: String(o.ticketRowIdHint ?? o.ticket_row_id ?? "").trim() || undefined,
      })
    );
  }

  let ticket;
  try {
    ticket = await resolveTicketForAssignment(sb, decoded, {
      ticketKeyHint: o.ticketKeyHint ?? o.ticket_key,
      ticketRowIdHint: o.ticketRowIdHint ?? o.ticket_row_id,
    });
  } catch (err) {
    if (err && err.code === "ASSIGNMENT_MIGRATION_REQUIRED") {
      console.warn(
        "[PROPERA pm-assign:v2] assignment_migration_required",
        JSON.stringify({
          traceId: traceId || undefined,
          lookup_param: hint,
          decoded,
          message: err.message,
        })
      );
      await appendEventLog({
        traceId,
        log_kind: "portal",
        event: "PORTAL_PM_TICKET_ASSIGNMENT_MIGRATION_REQUIRED",
        payload: { lookup_hint: hint, decoded_lookup: decoded, error: err.message },
      });
      return { ok: false, error: "assignment_migration_required", status: 500 };
    }
    throw err;
  }
  if (!ticket) {
    const fbKey = String(o.ticketKeyHint ?? o.ticket_key ?? "").trim();
    const fbRow = String(o.ticketRowIdHint ?? o.ticket_row_id ?? "").trim();
    console.warn(
      "[PROPERA pm-assign:v2] ticket_not_found",
      JSON.stringify({
        traceId: traceId || undefined,
        lookup_param: hint,
        decoded,
        shape,
        tried_body_ticket_key: !!(fbKey && TICKET_ROW_UUID_RE.test(fbKey)),
        tried_body_ticket_row_id: !!(fbRow && TICKET_ROW_UUID_RE.test(fbRow)),
      })
    );
    await appendEventLog({
      traceId,
      log_kind: "portal",
      event: "PORTAL_PM_TICKET_ASSIGNMENT_NOT_FOUND",
      payload: {
        lookup_hint: hint,
        decoded_lookup: decoded,
        hint_shape: shape,
        tried_body_ticket_key: !!(fbKey && TICKET_ROW_UUID_RE.test(fbKey)),
        tried_body_ticket_row_id: !!(fbRow && TICKET_ROW_UUID_RE.test(fbRow)),
      },
    });
    return { ok: false, error: "ticket_not_found", status: 404 };
  }

  if (ticket.is_imported_history === true) {
    return { ok: false, error: "imported_history_read_only", status: 403 };
  }

  const propertyCode = String(ticket.property_code || "").trim().toUpperCase();
  if (!propertyCode) {
    return { ok: false, error: "ticket_missing_property_code", status: 400 };
  }

  const rawStaff = o.assignedStaffId != null ? String(o.assignedStaffId).trim() : "";
  const unassign =
    !rawStaff ||
    rawStaff === UNASSIGNED_TOKEN ||
    rawStaff.toLowerCase() === "unassigned";

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
  const resolvedActorLabel = String(actorRes.changedBy.changed_by_actor_label || "").trim();
  const note = sanitizeAssignmentNote(o.assignmentNote);
  const now = new Date().toISOString();
  const resolvedHumanId = String(ticket.ticket_id || "").trim();
  const ticketKey = String(ticket.ticket_key || "").trim();

  if (!unassign) {
    const chk = await assertStaffAssignable(sb, rawStaff);
    if (!chk.ok) {
      return { ok: false, error: chk.error || "invalid_staff", status: 400 };
    }
  }

  const displayName = unassign
    ? ""
    : (await getStaffDisplayNameByStaffId(sb, rawStaff)) || rawStaff;

  /** @type {Record<string, unknown>} */
  const ticketPatch = mergeChangedByIntoTicketPatch(
    {
      updated_at: now,
      last_activity_at: now,
      assignment_source: "PM_OVERRIDE",
      assignment_note: note,
      assignment_updated_at: now,
      assignment_updated_by: resolvedActorLabel,
      assigned_by: "PM_PORTAL",
    },
    actorRes.changedBy
  );

  if (unassign) {
    Object.assign(ticketPatch, {
      assigned_type: "",
      assigned_id: "",
      assigned_name: "",
      assign_to: "",
      assigned_at: null,
    });
  } else {
    Object.assign(ticketPatch, {
      assigned_type: "STAFF",
      assigned_id: rawStaff,
      assigned_name: displayName,
      assign_to: displayName,
      assigned_at: now,
    });
  }

  const { error: uErr } = await sb
    .from("tickets")
    .update(ticketPatch)
    .eq("ticket_id", resolvedHumanId);

  if (uErr) {
    if (isAssignmentMigrationMissingError(uErr)) {
      return { ok: false, error: "assignment_migration_required", status: 500 };
    }
    return { ok: false, error: uErr.message, status: 500 };
  }

  const wiRes = await updateWorkItemsByTicketKey(sb, ticketKey, {
    owner_id: unassign ? "" : rawStaff,
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
    log_kind: "portal",
    event: "PORTAL_PM_TICKET_ASSIGNMENT",
    payload: {
      human_ticket_id: resolvedHumanId,
      ticket_key: ticketKey,
      assigned_staff_id: unassign ? null : rawStaff,
      assigned_display: unassign ? null : displayName,
      unassigned: unassign,
      assignment_note: note || undefined,
      actor,
    },
  });

  if (pmAssignDebugEnabled()) {
    console.warn(
      "[PROPERA pm-assign:v2] ok",
      JSON.stringify({
        traceId: traceId || undefined,
        human_ticket_id: resolvedHumanId,
        ticket_row_id: String(ticket.id || "").trim(),
        assigned_staff_id: unassign ? null : rawStaff,
      })
    );
  }

  return {
    ok: true,
    status: 200,
    ticketId: resolvedHumanId,
    ticketRowId: String(ticket.id || "").trim(),
    assignedStaffId: unassign ? "" : rawStaff,
    assignedDisplayName: unassign ? "" : displayName,
    assignmentSource: "PM_OVERRIDE",
  };
}

module.exports = {
  fetchTicketRowForAssignment,
  listStaffAssignableToProperty,
  applyPortalTicketAssignment,
  UNASSIGNED_TOKEN,
};
