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
const { assignVendorToTicket } = require("./vendorAssignment");

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

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} vendorIdText — `vendors.vendor_id`
 */
async function assertVendorAssignable(sb, vendorIdText) {
  const vid = String(vendorIdText || "").trim();
  if (!vid) return { ok: false, error: "missing_assigned_vendor_id" };

  const { data: row, error: e1 } = await sb
    .from("vendors")
    .select("vendor_id, active")
    .eq("vendor_id", vid)
    .maybeSingle();

  if (e1) {
    if (e1.code === "42P01" || /relation.*vendors.*does not exist/i.test(String(e1.message || ""))) {
      return { ok: false, error: "vendors_migration_required" };
    }
    return { ok: false, error: e1.message };
  }
  if (!row || row.active === false) {
    return { ok: false, error: "vendor_not_found" };
  }

  return { ok: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} vendorIdText
 * @returns {Promise<string>}
 */
async function getVendorDisplayNameByVendorId(sb, vendorIdText) {
  const vid = String(vendorIdText || "").trim();
  if (!vid) return "";
  const { data: row } = await sb
    .from("vendors")
    .select("display_name, vendor_id")
    .eq("vendor_id", vid)
    .maybeSingle();
  if (!row) return vid;
  const label = String(row.display_name || "").trim();
  return label || vid;
}

/**
 * Active vendors for PM assignment (portal token).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ orgId?: string }} [opts]
 */
async function listVendorsForAssignment(sb, opts = {}) {
  if (!sb) {
    return { ok: false, error: "no_db", vendors: [] };
  }

  const orgId = String(opts.orgId || "").trim().toLowerCase();

  let query = sb
    .from("vendors")
    .select("vendor_id, display_name, active")
    .eq("active", true);
  if (orgId) query = query.eq("org_id", orgId);
  const { data: rows, error: vErr } = await query.order("display_name", { ascending: true });

  if (vErr) {
    if (vErr.code === "42P01" || /relation.*vendors.*does not exist/i.test(String(vErr.message || ""))) {
      return { ok: false, error: "vendors_migration_required", vendors: [] };
    }
    return { ok: false, error: vErr.message, vendors: [] };
  }

  const vendors = (rows || [])
    .map((r) => ({
      vendorId: String(r.vendor_id || "").trim(),
      displayName: String(r.display_name || "").trim() || String(r.vendor_id || "").trim(),
    }))
    .filter((r) => r.vendorId);

  return { ok: true, vendors };
}

const VENDOR_ID_EXPLICIT_RE = /^[A-Za-z0-9_]{2,64}$/;

/**
 * Build a stable `vendors.vendor_id` slug from display name (VND_ACME_PLUMBING).
 * @param {string} displayName
 */
function vendorIdSlugFromDisplayName(displayName) {
  const raw = String(displayName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!raw) return "";
  const core = raw.length > 48 ? raw.slice(0, 48) : raw;
  return `VND_${core}`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} baseId
 */
async function resolveUniqueVendorId(sb, baseId) {
  const root = String(baseId || "").trim();
  if (!root) return { ok: false, error: "invalid_vendor_id" };
  let candidate = root;
  for (let n = 0; n < 50; n += 1) {
    const { data: row, error } = await sb
      .from("vendors")
      .select("vendor_id")
      .eq("vendor_id", candidate)
      .maybeSingle();
    if (error) {
      if (error.code === "42P01" || /relation.*vendors.*does not exist/i.test(String(error.message || ""))) {
        return { ok: false, error: "vendors_migration_required" };
      }
      return { ok: false, error: error.message };
    }
    if (!row) return { ok: true, vendorId: candidate };
    candidate = `${root}_${n + 2}`;
  }
  return { ok: false, error: "vendor_id_collision" };
}

/**
 * PM portal: create an active vendor for assignment dropdowns.
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} input
 * @param {string} input.displayName
 * @param {string} [input.vendorId] — optional explicit slug; otherwise derived from display name
 * @param {string} [input.notes]
 * @param {string} [input.orgId]
 */
async function createVendorForPortal(sb, input) {
  if (!sb) {
    return { ok: false, error: "no_db" };
  }
  const orgId =
    String((input && input.orgId) || (input && input.org_id) || "").trim().toLowerCase();
  const displayName = String((input && input.displayName) || (input && input.display_name) || "")
    .trim()
    .slice(0, 200);
  if (!displayName) {
    return { ok: false, error: "missing_display_name", status: 400 };
  }

  const explicitId = String((input && input.vendorId) || (input && input.vendor_id) || "").trim();
  let baseId = "";
  if (explicitId) {
    if (!VENDOR_ID_EXPLICIT_RE.test(explicitId)) {
      return { ok: false, error: "invalid_vendor_id", status: 400 };
    }
    baseId = explicitId;
  } else {
    baseId = vendorIdSlugFromDisplayName(displayName);
    if (!baseId) {
      return { ok: false, error: "invalid_display_name", status: 400 };
    }
  }

  const unique = await resolveUniqueVendorId(sb, baseId);
  if (!unique.ok) {
    const status = unique.error === "vendors_migration_required" ? 503 : 500;
    return { ok: false, error: unique.error, status };
  }

  const notes = String((input && input.notes) || "")
    .trim()
    .slice(0, 2000);
  const now = new Date().toISOString();
  const { error: insErr } = await sb.from("vendors").insert({
    vendor_id: unique.vendorId,
    display_name: displayName,
    active: true,
    notes,
    org_id: orgId,
    created_at: now,
    updated_at: now,
  });

  if (insErr) {
    if (insErr.code === "42P01" || /relation.*vendors.*does not exist/i.test(String(insErr.message || ""))) {
      return { ok: false, error: "vendors_migration_required", status: 503 };
    }
    if (insErr.code === "23505") {
      return { ok: false, error: "vendor_id_exists", status: 409 };
    }
    return { ok: false, error: insErr.message, status: 500 };
  }

  return {
    ok: true,
    vendor: {
      vendorId: unique.vendorId,
      displayName,
    },
  };
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
 * @param {string} [o.assignedStaffId] — `staff.staff_id`; empty or UNASSIGNED_TOKEN clears (staff path)
 * @param {string} [o.assignedVendorId] — `vendors.vendor_id`; non-empty selects vendor assignment
 * @param {string} [o.assignmentNote]
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
        assigned_vendor_id: String(o.assignedVendorId || "").trim() || undefined,
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

  const staffFieldPresent =
    Object.prototype.hasOwnProperty.call(o, "assignedStaffId") ||
    Object.prototype.hasOwnProperty.call(o, "assigned_staff_id");
  const vendorFieldPresent =
    Object.prototype.hasOwnProperty.call(o, "assignedVendorId") ||
    Object.prototype.hasOwnProperty.call(o, "assigned_vendor_id");

  const dispatchOnlyEarly =
    o.dispatchOnly === true || o.dispatch_only === true;
  if (!staffFieldPresent && !vendorFieldPresent && !dispatchOnlyEarly) {
    return { ok: false, error: "assigned_staff_id_or_assigned_vendor_id_required", status: 400 };
  }

  const rawStaff = o.assignedStaffId != null ? String(o.assignedStaffId).trim() : "";
  let rawVendor = o.assignedVendorId != null ? String(o.assignedVendorId).trim() : "";
  const dispatchOnly = o.dispatchOnly === true || o.dispatch_only === true;

  const staffEmpty =
    !rawStaff || rawStaff === UNASSIGNED_TOKEN || rawStaff.toLowerCase() === "unassigned";
  const vendorEmpty =
    !rawVendor || rawVendor === UNASSIGNED_TOKEN || rawVendor.toLowerCase() === "unassigned";

  if (dispatchOnly) {
    const onTicketVendor =
      String(ticket.assigned_type || "").toUpperCase() === "VENDOR"
        ? String(ticket.assigned_id || "").trim()
        : "";
    if (vendorEmpty && onTicketVendor) {
      rawVendor = onTicketVendor;
    }
    if (!rawVendor) {
      return { ok: false, error: "dispatch_only_requires_vendor_assignment", status: 400 };
    }
  }

  const vendorEmptyNow =
    !rawVendor || rawVendor === UNASSIGNED_TOKEN || rawVendor.toLowerCase() === "unassigned";

  if (!vendorEmptyNow && !staffEmpty) {
    return { ok: false, error: "cannot_set_staff_and_vendor_together", status: 400 };
  }

  /** @type {"STAFF"|"VENDOR"} */
  let assignMode = "STAFF";
  let unassign = false;
  if (dispatchOnly) {
    assignMode = "VENDOR";
  } else if (!vendorEmptyNow) {
    assignMode = "VENDOR";
  } else if (!staffEmpty) {
    assignMode = "STAFF";
  } else {
    unassign = true;
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
  const resolvedActorLabel = String(actorRes.changedBy.changed_by_actor_label || "").trim();
  const note = sanitizeAssignmentNote(o.assignmentNote);
  const now = new Date().toISOString();
  const resolvedHumanId = String(ticket.ticket_id || "").trim();
  const ticketKey = String(ticket.ticket_key || "").trim();

  if (!unassign && assignMode === "STAFF") {
    const chk = await assertStaffAssignable(sb, rawStaff);
    if (!chk.ok) {
      return { ok: false, error: chk.error || "invalid_staff", status: 400 };
    }
  }
  if (!unassign && assignMode === "VENDOR") {
    const chk = await assertVendorAssignable(sb, rawVendor);
    if (!chk.ok) {
      const st = chk.error === "vendors_migration_required" ? 500 : 400;
      return { ok: false, error: chk.error || "invalid_vendor", status: st };
    }

    const dispatchOnAssign =
      o.dispatchOnAssign === true || o.dispatch_on_assign === true;
    const vOut = await assignVendorToTicket({
      ticketLookupHint: decoded,
      ticketKeyHint: o.ticketKeyHint ?? o.ticket_key,
      ticketRowIdHint: o.ticketRowIdHint ?? o.ticket_row_id,
      vendorId: rawVendor,
      source: "PM_OVERRIDE",
      assignedBy: resolvedActorLabel,
      assignmentNote: note,
      dispatch: dispatchOnAssign,
      dispatchOnly,
      forceResend: o.forceResend === true || o.force_resend === true,
      traceId,
      changedBy: actorRes.changedBy,
    });
    if (!vOut.ok) {
      return {
        ok: false,
        error: vOut.error || "vendor_assign_failed",
        status: vOut.status || 400,
      };
    }

    await appendEventLog({
      traceId,
      log_kind: "portal",
      event: "PORTAL_PM_TICKET_ASSIGNMENT",
      payload: {
        human_ticket_id: vOut.ticketId,
        ticket_key: ticketKey,
        assigned_vendor_id: rawVendor,
        assigned_display: vOut.assignedDisplayName || rawVendor,
        assigned_type: "VENDOR",
        unassigned: false,
        assignment_note: note || undefined,
        changed_by: actorRes.changedBy,
        dispatched: vOut.dispatched,
        dispatch_skipped_reason: vOut.dispatchSkippedReason,
        dispatch_error: vOut.dispatchError,
        dispatch_only: dispatchOnly,
      },
    });

    return {
      ok: true,
      status: 200,
      ticketId: vOut.ticketId,
      ticketRowId: vOut.ticketRowId,
      assignedStaffId: "",
      assignedVendorId: rawVendor,
      assignedType: "VENDOR",
      assignedDisplayName: vOut.assignedDisplayName || rawVendor,
      assignmentSource: "PM_OVERRIDE",
      assigned: vOut.assigned !== false,
      assignmentSkipped: vOut.assignmentSkipped === true,
      dispatched: !!vOut.dispatched,
      dispatchSkippedReason: vOut.dispatchSkippedReason,
      dispatchError: vOut.dispatchError,
    };
  }

  const displayName = unassign
    ? ""
    : assignMode === "VENDOR"
      ? (await getVendorDisplayNameByVendorId(sb, rawVendor)) || rawVendor
      : (await getStaffDisplayNameByStaffId(sb, rawStaff)) || rawStaff;

  const assignedId = unassign ? "" : assignMode === "VENDOR" ? rawVendor : rawStaff;
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
      assigned_type: assignMode,
      assigned_id: assignedId,
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

  const wiPatch =
    assignMode === "VENDOR" && !unassign
      ? { owner_id: rawVendor, owner_type: "VENDOR", updated_at: now }
      : !unassign
        ? { owner_id: rawStaff, owner_type: "STAFF", updated_at: now }
        : { owner_id: "", owner_type: "", updated_at: now };
  const wiRes = await updateWorkItemsByTicketKey(sb, ticketKey, wiPatch);
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
      assigned_staff_id: unassign || assignMode !== "STAFF" ? null : rawStaff,
      assigned_vendor_id: unassign || assignMode !== "VENDOR" ? null : rawVendor,
      assigned_display: unassign ? null : displayName,
      assigned_type: unassign ? null : assignMode,
      unassigned: unassign,
      assignment_note: note || undefined,
      changed_by: actorRes.changedBy,
    },
  });

  if (pmAssignDebugEnabled()) {
    console.warn(
      "[PROPERA pm-assign:v2] ok",
      JSON.stringify({
        traceId: traceId || undefined,
        human_ticket_id: resolvedHumanId,
        ticket_row_id: String(ticket.id || "").trim(),
        assigned_staff_id: unassign || assignMode !== "STAFF" ? null : rawStaff,
        assigned_vendor_id: unassign || assignMode !== "VENDOR" ? null : rawVendor,
      })
    );
  }

  return {
    ok: true,
    status: 200,
    ticketId: resolvedHumanId,
    ticketRowId: String(ticket.id || "").trim(),
    assignedStaffId: unassign || assignMode !== "STAFF" ? "" : rawStaff,
    assignedVendorId: unassign || assignMode !== "VENDOR" ? "" : rawVendor,
    assignedType: unassign ? "" : assignMode,
    assignedDisplayName: unassign ? "" : displayName,
    assignmentSource: "PM_OVERRIDE",
  };
}

module.exports = {
  fetchTicketRowForAssignment,
  resolveTicketForAssignment,
  listStaffAssignableToProperty,
  listVendorsForAssignment,
  createVendorForPortal,
  applyPortalTicketAssignment,
  assertVendorAssignable,
  assertStaffAssignable,
  UNASSIGNED_TOKEN,
};
