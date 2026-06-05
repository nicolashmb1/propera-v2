/**
 * Access Engine DAL — locations, policies, reservations, calendar.
 * @see docs/ACCESS_ENGINE_BUILD_PLAN.md
 */
const { getSupabase } = require("../db/supabase");
const { canReserve } = require("../access/canReserve");
const { getActivePolicy } = require("../access/getActivePolicy");
const { issuePassForReservation } = require("../access/issuePassForReservation");
const { decryptCredentialValue } = require("../access/credentialCrypto");
const { getLockAdapter } = require("../access/lockAdapter/getLockAdapter");
const {
  ACCESS_LIFECYCLE_JOB_TYPES,
  upsertAccessLifecycleJob,
  cancelAccessLifecycleJobs,
} = require("../access/accessLifecycleJobs");
const { dispatchAccessNotification } = require("../access/accessNotifications");
const { appendEventLog } = require("./appendEventLog");
const { staffPhoneForPropertyRole } = require("../adapters/tenantAgent/resolvePropertyStaffContact");

/**
 * @param {object} row
 */
function mapLocationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    propertyCode: row.property_code,
    propertyLocationId: row.property_location_id || null,
    slug: row.slug,
    name: row.name,
    description: row.description,
    active: !!row.active,
    staffOnly: !!row.staff_only,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function slugFromLabel(label) {
  const s = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "room";
}

async function resolveOrgIdForProperty(sb, propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!code) return "";
  const { data } = await sb
    .from("properties")
    .select("org_id")
    .eq("code", code)
    .maybeSingle();
  return String(data?.org_id || "").trim();
}

/**
 * Building Structure common areas + whether each is enrolled in the Access program.
 * @param {string} propertyCode
 */
async function listAccessProgramForProperty(propertyCode) {
  const sb = getSupabase();
  if (!sb) throw new Error("no_db");
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!code || code === "GLOBAL") throw new Error("invalid_property_code");

  const orgId = await resolveOrgIdForProperty(sb, code);

  const { data: areas, error: areaErr } = await sb
    .from("property_locations")
    .select("id, property_code, kind, label, active, sort_order")
    .eq("property_code", code)
    .eq("kind", "common_area")
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true });

  if (areaErr) throw new Error(areaErr.message || "property_locations_failed");

  const { data: accessRows, error: accErr } = await sb
    .from("access_locations")
    .select("*")
    .eq("property_code", code)
    .eq("org_id", orgId);

  if (accErr) throw new Error(accErr.message || "access_locations_failed");

  const byPropertyLocationId = new Map();
  const legacy = [];
  for (const row of accessRows || []) {
    const plid = row.property_location_id;
    if (plid) {
      const prev = byPropertyLocationId.get(plid);
      if (!prev || (!prev.active && row.active)) byPropertyLocationId.set(plid, row);
    } else if (row.active) {
      legacy.push(row);
    }
  }

  const scopes = (areas || []).map((pl) => {
    const hit = byPropertyLocationId.get(pl.id);
    return {
      propertyLocationId: pl.id,
      kind: pl.kind,
      label: pl.label,
      sortOrder: pl.sort_order,
      enrolled: !!(hit && hit.active),
      staffOnly: !!(hit && hit.active && hit.staff_only),
      accessLocationId: hit ? hit.id : null,
      slug: hit ? hit.slug : null,
      accessName: hit ? hit.name : null,
    };
  });

  return {
    propertyCode: code,
    orgId,
    scopes,
    legacyAccessLocations: legacy.map(mapLocationRow).filter(Boolean),
  };
}

/**
 * Enable or disable a common area in the Access program for a property.
 * @param {object} opts
 * @param {string} opts.propertyCode
 * @param {string} opts.propertyLocationId
 * @param {boolean} opts.enabled
 * @param {string} [opts.actor]
 */
function parseStaffOnlyFlag(opts) {
  if (opts == null || typeof opts !== "object") return undefined;
  if (opts.staffOnly !== undefined) return !!opts.staffOnly;
  if (opts.internalOnly !== undefined) return !!opts.internalOnly;
  if (opts.staff_only !== undefined) {
    return opts.staff_only === true || String(opts.staff_only).toLowerCase() === "true";
  }
  if (opts.internal_only !== undefined) {
    return opts.internal_only === true || String(opts.internal_only).toLowerCase() === "true";
  }
  return undefined;
}

function parseEnrollmentEnabled(opts) {
  if (opts == null || typeof opts !== "object") return undefined;
  if (opts.enabled !== undefined) {
    return opts.enabled === true || String(opts.enabled).toLowerCase() === "true";
  }
  if (opts.enrolled !== undefined) {
    return opts.enrolled === true || String(opts.enrolled).toLowerCase() === "true";
  }
  return undefined;
}

async function setAccessProgramEnrollment(opts) {
  const sb = getSupabase();
  if (!sb) throw new Error("no_db");
  const code = String(opts.propertyCode || "").trim().toUpperCase();
  const propertyLocationId = String(opts.propertyLocationId || "").trim();
  const enabled = parseEnrollmentEnabled(opts);
  const staffOnly = parseStaffOnlyFlag(opts);
  const actor = String(opts.actor || "portal_staff").trim();
  if (!code || !propertyLocationId) throw new Error("missing_fields");
  if (enabled === undefined && staffOnly === undefined) throw new Error("missing_fields");

  const { data: pl, error: plErr } = await sb
    .from("property_locations")
    .select("id, property_code, kind, label, active")
    .eq("id", propertyLocationId)
    .eq("property_code", code)
    .maybeSingle();

  if (plErr || !pl || !pl.active) throw new Error("property_location_not_found");
  if (String(pl.kind || "") !== "common_area") throw new Error("not_common_area");

  const orgId = await resolveOrgIdForProperty(sb, code);

  const { data: existing } = await sb
    .from("access_locations")
    .select("*")
    .eq("property_location_id", propertyLocationId)
    .order("active", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (enabled === false) {
    if (!existing) return { enrolled: false, accessLocation: null, staffOnly: false };
    const { data: updated, error } = await sb
      .from("access_locations")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message || "deactivate_failed");
    return { enrolled: false, accessLocation: mapLocationRow(updated), staffOnly: false };
  }

  if (existing) {
    const patch = {
      name: String(pl.label || existing.name).trim(),
      updated_at: new Date().toISOString(),
    };
    if (enabled === true) patch.active = true;
    if (staffOnly !== undefined) patch.staff_only = staffOnly;
    const { data: updated, error } = await sb
      .from("access_locations")
      .update(patch)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message || "reactivate_failed");
    const loc = mapLocationRow(updated);
    const hasPolicy = await getAccessPolicyForLocation(loc.id);
    if (!hasPolicy) {
      await sb.from("access_location_policies").insert({
        location_id: loc.id,
        org_id: orgId,
        created_by: actor,
      });
    }
    const { data: lockRow } = await sb
      .from("access_locks")
      .select("id")
      .eq("location_id", loc.id)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (!lockRow) {
      await sb.from("access_locks").insert({
        org_id: orgId,
        location_id: loc.id,
        provider: "noop",
        external_lock_id: `noop-${loc.id.slice(0, 8)}`,
        active: true,
      });
    }
    return {
      enrolled: !!loc.active,
      accessLocation: loc,
      staffOnly: !!loc.staffOnly,
    };
  }

  if (enabled !== true) {
    throw new Error("missing_fields");
  }

  const label = String(pl.label || "").trim();
  let slug = slugFromLabel(label);
  const { data: slugHits } = await sb
    .from("access_locations")
    .select("slug")
    .eq("org_id", orgId)
    .eq("property_code", code)
    .ilike("slug", `${slug}%`);
  const taken = new Set((slugHits || []).map((r) => r.slug));
  if (taken.has(slug)) {
    let n = 2;
    while (taken.has(`${slug}-${n}`)) n += 1;
    slug = `${slug}-${n}`;
  }

  const loc = await createAccessLocationForPortal(
    {
      orgId,
      propertyCode: code,
      name: label,
      slug,
      propertyLocationId,
      active: true,
      staffOnly: staffOnly === true,
    },
    actor
  );
  return { enrolled: true, accessLocation: loc, staffOnly: !!loc.staffOnly };
}

/**
 * @param {object} row
 * @param {object} [tenant]
 * @param {object} [pass]
 */
function mapReservationRow(row, tenant, pass) {
  if (!row) return null;
  const out = {
    id: row.id,
    orgId: row.org_id,
    locationId: row.location_id,
    tenantId: row.tenant_id,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    channel: row.channel,
    depositAmount: Number(row.deposit_amount) || 0,
    depositStatus: row.deposit_status,
    notes: row.notes,
    overrideBy: row.override_by,
    approvedBy: row.approved_by,
    cancelledBy: row.cancelled_by,
    accessPassId: row.access_pass_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (tenant) {
    out.tenantName = tenant.resident_name || "";
    out.unitLabel = tenant.unit_label || "";
    out.tenantPhone = tenant.phone_e164 || "";
  }
  if (pass) {
    out.passStatus = pass.status;
    out.credentialType = pass.credential_type;
    out.pinMasked = pass.credential_value_enc
      ? `••••${decryptCredentialValue(pass.credential_value_enc).slice(-2)}`
      : null;
  }
  return out;
}

/**
 * @param {object} policy
 */
function mapPolicyRow(policy) {
  if (!policy) return null;
  return {
    id: policy.id,
    locationId: policy.location_id,
    orgId: policy.org_id,
    effectiveFrom: policy.effective_from,
    effectiveUntil: policy.effective_until,
    minDurationMin: policy.min_duration_min,
    maxDurationMin: policy.max_duration_min,
    advanceBookingMin: policy.advance_booking_min,
    advanceBookingMaxDays: policy.advance_booking_max_days,
    sameDayAllowed: policy.same_day_allowed,
    maxConcurrent: policy.max_concurrent,
    maxPerTenantDay: policy.max_per_tenant_day,
    maxPerTenantWeek: policy.max_per_tenant_week,
    maxPerTenantMonth: policy.max_per_tenant_month,
    requiresApproval: policy.requires_approval,
    approvalTimeoutMin: policy.approval_timeout_min,
    approvalTimeoutAction: policy.approval_timeout_action,
    depositAmount: Number(policy.deposit_amount) || 0,
    depositRefundable: policy.deposit_refundable,
    depositRefundCutoffHours: policy.deposit_refund_cutoff_hours,
    hourlyRate: Number(policy.hourly_rate) || 0,
    eligibleTenants: policy.eligible_tenants,
    guestAllowed: policy.guest_allowed,
    maxGuests: policy.max_guests,
    reminderBeforeMin: policy.reminder_before_min,
    staffNotifyOnReserve: policy.staff_notify_on_reserve,
    staffNotifyOnCancel: policy.staff_notify_on_cancel,
    staffNotifyReminderCopy: policy.staff_notify_reminder_copy,
  };
}

async function listAccessLocationsForPortal({ orgId, propertyCode } = {}) {
  const sb = getSupabase();
  if (!sb) return [];
  let q = sb
    .from("access_locations")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (orgId) q = q.eq("org_id", String(orgId).trim());
  if (propertyCode) q = q.eq("property_code", String(propertyCode).trim().toUpperCase());
  const { data, error } = await q;
  if (error || !data) return [];
  return data.map(mapLocationRow);
}

async function getAccessLocationById(locationId) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb
    .from("access_locations")
    .select("*")
    .eq("id", locationId)
    .maybeSingle();
  return mapLocationRow(data);
}

async function getActiveLockForLocation(locationId) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb
    .from("access_locks")
    .select("*")
    .eq("location_id", locationId)
    .eq("active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

async function getAccessPolicyForLocation(locationId) {
  const sb = getSupabase();
  if (!sb) return null;
  const policy = await getActivePolicy(sb, locationId);
  return mapPolicyRow(policy);
}

async function listSchedulesForLocation(locationId) {
  const sb = getSupabase();
  if (!sb) return [];
  const { data } = await sb
    .from("access_schedules")
    .select("*")
    .eq("location_id", locationId)
    .order("day_of_week");
  return (data || []).map((r) => ({
    id: r.id,
    dayOfWeek: r.day_of_week,
    openTime: r.open_time,
    closeTime: r.close_time,
  }));
}

async function listBlackoutsForLocation(locationId, from, to) {
  const sb = getSupabase();
  if (!sb) return [];
  const fromIso = from instanceof Date ? from.toISOString() : from;
  const toIso = to instanceof Date ? to.toISOString() : to;
  let q = sb.from("access_blackouts").select("*").eq("location_id", locationId);
  if (fromIso) q = q.gte("end_at", fromIso);
  if (toIso) q = q.lte("start_at", toIso);
  const { data } = await q.order("start_at");
  return (data || []).map((r) => ({
    id: r.id,
    startAt: r.start_at,
    endAt: r.end_at,
    reason: r.reason,
    createdBy: r.created_by,
  }));
}

async function listReservationsForLocation(locationId, from, to) {
  const sb = getSupabase();
  if (!sb) return [];
  const fromIso = from instanceof Date ? from.toISOString() : from;
  const toIso = to instanceof Date ? to.toISOString() : to;
  let q = sb
    .from("access_reservations")
    .select("*, tenant_roster:tenant_id (resident_name, unit_label, phone_e164)")
    .eq("location_id", locationId);
  if (fromIso) q = q.gte("end_at", fromIso);
  if (toIso) q = q.lte("start_at", toIso);
  const { data } = await q.order("start_at");
  const passIds = (data || []).map((r) => r.access_pass_id).filter(Boolean);
  let passesById = {};
  if (passIds.length) {
    const { data: passes } = await sb
      .from("access_passes")
      .select("*")
      .in("id", passIds);
    for (const p of passes || []) passesById[p.id] = p;
  }
  return (data || []).map((r) => {
    const t = r.tenant_roster;
    const pass = r.access_pass_id ? passesById[r.access_pass_id] : null;
    return mapReservationRow(r, t, pass);
  });
}

async function getLocationStats(locationId, dateIso) {
  const sb = getSupabase();
  const day = dateIso ? new Date(dateIso) : new Date();
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const weekStart = new Date(dayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const now = new Date();

  const rows = await listReservationsForLocation(
    locationId,
    weekStart.toISOString(),
    weekEnd.toISOString()
  );

  const today = rows.filter((r) => {
    const s = new Date(r.startAt);
    return s >= dayStart && s < dayEnd && r.status !== "CANCELLED";
  });
  const activeNow = rows.filter((r) => {
    if (r.status !== "ACTIVE" && r.status !== "CONFIRMED") return false;
    const s = new Date(r.startAt);
    const e = new Date(r.endAt);
    return s <= now && e > now;
  });
  const pending = rows.filter(
    (r) => r.status === "PENDING_APPROVAL" || r.status === "PENDING_DEPOSIT"
  );

  const confirmedWeek = rows.filter(
    (r) =>
      !["CANCELLED", "NO_SHOW"].includes(r.status) &&
      new Date(r.startAt) >= weekStart &&
      new Date(r.startAt) < weekEnd
  );
  const completedWeek = rows.filter((r) => r.status === "COMPLETED");

  return {
    todayCount: today.length,
    activeNow: activeNow.length,
    pendingApproval: pending.length,
    weekUtilizationPct:
      confirmedWeek.length > 0
        ? Math.round((completedWeek.length / confirmedWeek.length) * 100)
        : 0,
  };
}

/**
 * @param {object} body
 * @param {string} [actor]
 */
async function createAccessLocationForPortal(body, actor = "") {
  const sb = getSupabase();
  if (!sb) throw new Error("no_db");
  const orgId = String(body.orgId || body.org_id || "").trim();
  if (!orgId) throw new Error("org_id_required");
  const propertyCode = String(body.propertyCode || body.property_code || "")
    .trim()
    .toUpperCase();
  const name = String(body.name || "").trim();
  const slug = String(body.slug || name).trim().toLowerCase().replace(/\s+/g, "-");
  if (!propertyCode || !name) throw new Error("missing_fields");

  const propertyLocationId = String(
    body.propertyLocationId || body.property_location_id || ""
  ).trim();

  const insertRow = {
    org_id: orgId,
    property_code: propertyCode,
    slug,
    name,
    description: String(body.description || ""),
    active: body.active !== false,
    staff_only:
      body.staffOnly === true ||
      body.staff_only === true ||
      body.internalOnly === true ||
      body.internal_only === true,
  };
  if (propertyLocationId) insertRow.property_location_id = propertyLocationId;

  const { data: loc, error } = await sb
    .from("access_locations")
    .insert(insertRow)
    .select("*")
    .single();
  if (error || !loc) throw new Error(error?.message || "insert_failed");

  await sb.from("access_location_policies").insert({
    location_id: loc.id,
    org_id: orgId,
    created_by: actor,
    ...(body.policyDefaults || {}),
  });

  const days = body.scheduleDays;
  if (Array.isArray(days)) {
    for (const d of days) {
      await sb.from("access_schedules").insert({
        location_id: loc.id,
        day_of_week: d.dayOfWeek ?? d.day_of_week,
        open_time: d.openTime || d.open_time || "08:00",
        close_time: d.closeTime || d.close_time || "23:00",
      });
    }
  } else {
    for (let dow = 0; dow <= 6; dow++) {
      await sb.from("access_schedules").insert({
        location_id: loc.id,
        day_of_week: dow,
        open_time: "08:00",
        close_time: "23:00",
      });
    }
  }

  await sb.from("access_locks").insert({
    org_id: orgId,
    location_id: loc.id,
    provider: "noop",
    external_lock_id: `noop-${loc.id.slice(0, 8)}`,
    active: true,
  });

  return mapLocationRow(loc);
}

async function upsertAccessPolicyForLocation(locationId, body, actor = "") {
  const sb = getSupabase();
  const loc = await getAccessLocationById(locationId);
  if (!loc) throw new Error("location_not_found");

  const patch = {
    location_id: locationId,
    org_id: loc.orgId,
    effective_from: new Date().toISOString(),
    created_by: actor,
    min_duration_min: body.minDurationMin ?? body.min_duration_min ?? 30,
    max_duration_min: body.maxDurationMin ?? body.max_duration_min ?? 120,
    advance_booking_min: body.advanceBookingMin ?? body.advance_booking_min ?? 60,
    advance_booking_max_days:
      body.advanceBookingMaxDays ?? body.advance_booking_max_days ?? 14,
    same_day_allowed: body.sameDayAllowed ?? body.same_day_allowed ?? true,
    max_concurrent: body.maxConcurrent ?? body.max_concurrent ?? 1,
    max_per_tenant_day: body.maxPerTenantDay ?? body.max_per_tenant_day ?? null,
    max_per_tenant_week: body.maxPerTenantWeek ?? body.max_per_tenant_week ?? null,
    max_per_tenant_month:
      body.maxPerTenantMonth ?? body.max_per_tenant_month ?? null,
    requires_approval: body.requiresApproval ?? body.requires_approval ?? false,
    approval_timeout_min:
      body.approvalTimeoutMin ?? body.approval_timeout_min ?? 60,
    approval_timeout_action:
      body.approvalTimeoutAction ?? body.approval_timeout_action ?? "auto_cancel",
    deposit_amount: body.depositAmount ?? body.deposit_amount ?? 0,
    deposit_refundable: body.depositRefundable ?? body.deposit_refundable ?? true,
    deposit_refund_cutoff_hours:
      body.depositRefundCutoffHours ?? body.deposit_refund_cutoff_hours ?? 24,
    hourly_rate: body.hourlyRate ?? body.hourly_rate ?? 0,
    eligible_tenants: body.eligibleTenants ?? body.eligible_tenants ?? "all",
    guest_allowed: body.guestAllowed ?? body.guest_allowed ?? false,
    max_guests: body.maxGuests ?? body.max_guests ?? 0,
    reminder_before_min: body.reminderBeforeMin ?? body.reminder_before_min ?? 30,
    staff_notify_on_reserve:
      body.staffNotifyOnReserve ?? body.staff_notify_on_reserve ?? true,
    staff_notify_on_cancel:
      body.staffNotifyOnCancel ?? body.staff_notify_on_cancel ?? true,
    staff_notify_reminder_copy:
      body.staffNotifyReminderCopy ?? body.staff_notify_reminder_copy ?? false,
  };

  const { data: prev } = await sb
    .from("access_location_policies")
    .select("id")
    .eq("location_id", locationId)
    .is("effective_until", null)
    .maybeSingle();
  if (prev?.id) {
    await sb
      .from("access_location_policies")
      .update({ effective_until: new Date().toISOString() })
      .eq("id", prev.id);
  }

  const { data: created, error } = await sb
    .from("access_location_policies")
    .insert(patch)
    .select("*")
    .single();
  if (error || !created) throw new Error(error?.message || "policy_insert_failed");

  await sb.from("access_policy_audit").insert({
    location_id: locationId,
    policy_id: created.id,
    changed_by: actor,
    change_summary: body,
  });

  return mapPolicyRow(created);
}

async function replaceSchedulesForLocation(locationId, schedules) {
  const sb = getSupabase();
  await sb.from("access_schedules").delete().eq("location_id", locationId);
  for (const s of schedules || []) {
    await sb.from("access_schedules").insert({
      location_id: locationId,
      day_of_week: s.dayOfWeek ?? s.day_of_week,
      open_time: s.openTime || s.open_time,
      close_time: s.closeTime || s.close_time,
    });
  }
  return listSchedulesForLocation(locationId);
}

async function createBlackoutForLocation(locationId, body, actor = "") {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("access_blackouts")
    .insert({
      location_id: locationId,
      start_at: body.startAt || body.start_at,
      end_at: body.endAt || body.end_at,
      reason: String(body.reason || ""),
      created_by: actor,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return {
    id: data.id,
    startAt: data.start_at,
    endAt: data.end_at,
    reason: data.reason,
  };
}

async function deleteBlackout(blackoutId) {
  const sb = getSupabase();
  await sb.from("access_blackouts").delete().eq("id", blackoutId);
  return { ok: true };
}

async function getReservationDetail(reservationId) {
  const sb = getSupabase();
  const { data: row } = await sb
    .from("access_reservations")
    .select("*, tenant_roster:tenant_id (resident_name, unit_label, phone_e164)")
    .eq("id", reservationId)
    .maybeSingle();
  if (!row) return null;
  let pass = null;
  if (row.access_pass_id) {
    const { data: p } = await sb
      .from("access_passes")
      .select("*")
      .eq("id", row.access_pass_id)
      .maybeSingle();
    pass = p;
  }
  const mapped = mapReservationRow(row, row.tenant_roster, pass);
  if (pass) {
    mapped.pin = decryptCredentialValue(pass.credential_value_enc);
  }
  return mapped;
}

function parseActorAndOptions(actorOrOptions, maybeOptions) {
  if (actorOrOptions && typeof actorOrOptions === "object" && !Array.isArray(actorOrOptions)) {
    return {
      actor: String(actorOrOptions.actor || "").trim(),
      opts: actorOrOptions,
    };
  }
  return {
    actor: String(actorOrOptions || "").trim(),
    opts:
      maybeOptions && typeof maybeOptions === "object" && !Array.isArray(maybeOptions)
        ? maybeOptions
        : {},
  };
}

function prefersStructuredOnlyChannel(channel) {
  const ch = String(channel || "").trim().toLowerCase();
  return ch === "portal" || ch === "tenant_portal" || ch === "qr_portal" || ch === "staff_override";
}

async function resolveStaffNotificationPhone(sb, propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!sb || !code) return "";
  for (const prefix of ["SUPER|", "PM|"]) {
    const phone = await staffPhoneForPropertyRole(sb, code, prefix);
    if (phone) return phone;
  }
  return "";
}

async function loadReservationBundle(sb, reservationId) {
  const id = String(reservationId || "").trim();
  if (!sb || !id) return null;
  const { data: row } = await sb
    .from("access_reservations")
    .select("*, tenant_roster:tenant_id (resident_name, unit_label, phone_e164)")
    .eq("id", id)
    .maybeSingle();
  if (!row) return null;

  let pass = null;
  if (row.access_pass_id) {
    const { data: passRow } = await sb
      .from("access_passes")
      .select("*, access_locks:lock_id (*)")
      .eq("id", row.access_pass_id)
      .maybeSingle();
    pass = passRow || null;
  }

  const location = await getAccessLocationById(row.location_id);
  const policy = await getActivePolicy(sb, row.location_id);
  return { row, pass, location, policy, tenant: row.tenant_roster || null };
}

async function updatePassStatusForReservation(sb, reservationRow, nextStatus, actor = "") {
  if (!sb || !reservationRow || !reservationRow.access_pass_id) return null;
  const status = String(nextStatus || "").trim().toUpperCase();
  if (!status) return null;
  const patch = {
    status,
  };
  if (status === "ACTIVE") {
    patch.revoked_at = null;
    patch.revoked_by = "";
  } else if (status === "REVOKED" || status === "EXPIRED") {
    patch.revoked_at = new Date().toISOString();
    patch.revoked_by = String(actor || "").trim();
  }
  const { data } = await sb
    .from("access_passes")
    .update(patch)
    .eq("id", reservationRow.access_pass_id)
    .select("*")
    .maybeSingle();
  return data || null;
}

async function revokePassForReservation(sb, reservationRow, actor = "", nextStatus = "REVOKED") {
  if (!sb || !reservationRow || !reservationRow.access_pass_id) return null;
  const { data: pass } = await sb
    .from("access_passes")
    .select("*, access_locks:lock_id (*)")
    .eq("id", reservationRow.access_pass_id)
    .maybeSingle();
  if (!pass) return null;
  if (pass.access_locks) {
    const adapter = getLockAdapter(pass.access_locks.provider);
    await adapter.revokeCredential(pass.access_locks.id, pass.id);
  }
  const status = String(nextStatus || "REVOKED").trim().toUpperCase() || "REVOKED";
  await sb
    .from("access_passes")
    .update({
      status,
      revoked_at: new Date().toISOString(),
      revoked_by: String(actor || "").trim(),
    })
    .eq("id", pass.id);
  return pass;
}

async function syncReservationLifecycleJobsForRow(sb, reservationRow, policy) {
  if (!sb || !reservationRow) return;
  await cancelAccessLifecycleJobs(sb, reservationRow.id);

  const status = String(reservationRow.status || "").trim().toUpperCase();
  if (
    status === "CANCELLED" ||
    status === "COMPLETED" ||
    status === "NO_SHOW" ||
    status === "PENDING_DEPOSIT"
  ) {
    return;
  }

  const startAt = new Date(reservationRow.start_at);
  const endAt = new Date(reservationRow.end_at);
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) return;

  if (status === "PENDING_APPROVAL") {
    const timeoutMin = Math.max(1, Number(policy?.approval_timeout_min) || 60);
    const approvalAt = new Date(
      new Date(reservationRow.created_at || reservationRow.updated_at || new Date()).getTime() +
        timeoutMin * 60000
    );
    await upsertAccessLifecycleJob(sb, {
      reservationId: reservationRow.id,
      jobType: ACCESS_LIFECYCLE_JOB_TYPES.APPROVAL_TIMEOUT,
      runAt: approvalAt,
      payload: {
        action: String(policy?.approval_timeout_action || "auto_cancel").trim().toLowerCase(),
      },
    });
    return;
  }

  if (status === "CONFIRMED" || status === "ACTIVE") {
    const reminderBeforeMin = Math.max(0, Number(policy?.reminder_before_min) || 0);
    if (reminderBeforeMin > 0) {
      const reminderAt = new Date(startAt.getTime() - reminderBeforeMin * 60000);
      if (reminderAt.getTime() > Date.now()) {
        await upsertAccessLifecycleJob(sb, {
          reservationId: reservationRow.id,
          jobType: ACCESS_LIFECYCLE_JOB_TYPES.REMINDER,
          runAt: reminderAt,
        });
      }
    }

    if (status === "CONFIRMED") {
      await upsertAccessLifecycleJob(sb, {
        reservationId: reservationRow.id,
        jobType: ACCESS_LIFECYCLE_JOB_TYPES.START_WINDOW,
        runAt: startAt,
      });
    }

    await upsertAccessLifecycleJob(sb, {
      reservationId: reservationRow.id,
      jobType: ACCESS_LIFECYCLE_JOB_TYPES.END_WINDOW,
      runAt: endAt,
    });
  }
}

async function syncReservationLifecycleJobs(reservationId) {
  const sb = getSupabase();
  if (!sb) return;
  const bundle = await loadReservationBundle(sb, reservationId);
  if (!bundle) return;
  await syncReservationLifecycleJobsForRow(sb, bundle.row, bundle.policy);
}

async function notifyReservationEvent(bundle, templateKey, opts = {}) {
  if (!bundle || !bundle.row || !bundle.location) return;
  const sb = getSupabase();
  if (!sb) return;
  const traceId = String(opts.traceId || "").trim();
  const detail = await getReservationDetail(bundle.row.id);
  if (!detail) return;

  const context = {
    propertyCode: bundle.location.propertyCode,
    locationName: bundle.location.name,
    startAt: detail.startAt,
    endAt: detail.endAt,
    tenantName: detail.tenantName,
    unitLabel: detail.unitLabel,
    pin: detail.pin || "",
    pinMasked: detail.pinMasked || "",
  };
  const preferredChannel = prefersStructuredOnlyChannel(detail.channel) ? "sms" : detail.channel;

  const tenantTemplate = String(templateKey || "").trim();
  const shouldSendTenant =
    !!detail.tenantPhone &&
    (!!opts.forceTenantNotification ||
      !prefersStructuredOnlyChannel(detail.channel) ||
      tenantTemplate === "ACCESS_TENANT_REMINDER" ||
      tenantTemplate === "ACCESS_TENANT_ACTIVE" ||
      tenantTemplate === "ACCESS_TENANT_COMPLETED" ||
      tenantTemplate === "ACCESS_TENANT_DENIED");

  if (shouldSendTenant && tenantTemplate) {
    await dispatchAccessNotification({
      sb,
      traceId,
      reservationId: detail.id,
      templateKey: tenantTemplate,
      recipientPhoneE164: detail.tenantPhone,
      preferredChannel,
      audience: "tenant",
      tenantActorKey: detail.tenantPhone,
      context,
    });
  }

  const notifyReserve = bundle.policy?.staff_notify_on_reserve !== false;
  const notifyCancel = bundle.policy?.staff_notify_on_cancel !== false;
  const notifyReminder = !!bundle.policy?.staff_notify_reminder_copy;
  let staffTemplateKey = "";
  if (
    tenantTemplate === "ACCESS_TENANT_RESERVATION_CONFIRMED" ||
    tenantTemplate === "ACCESS_TENANT_APPROVED"
  ) {
    staffTemplateKey = notifyReserve ? "ACCESS_STAFF_NEW_RESERVATION" : "";
  } else if (tenantTemplate === "ACCESS_TENANT_APPROVAL_REQUIRED") {
    staffTemplateKey = "ACCESS_STAFF_APPROVAL_REQUIRED";
  } else if (
    tenantTemplate === "ACCESS_TENANT_CANCELLED" ||
    tenantTemplate === "ACCESS_TENANT_DENIED"
  ) {
    staffTemplateKey = notifyCancel ? "ACCESS_STAFF_CANCELLED" : "";
  } else if (tenantTemplate === "ACCESS_TENANT_REMINDER") {
    staffTemplateKey = notifyReminder ? "ACCESS_STAFF_REMINDER" : "";
  }

  if (!staffTemplateKey) return;

  if (
    staffTemplateKey === "ACCESS_STAFF_NEW_RESERVATION" ||
    staffTemplateKey === "ACCESS_STAFF_APPROVAL_REQUIRED"
  ) {
    try {
      const { notifyPortalPushAmenityReservation } = require("../portal/pushNotifications");
      void notifyPortalPushAmenityReservation({
        reservationId: detail.id,
        locationName: context.locationName,
        tenantName: context.tenantName,
        unitLabel: context.unitLabel,
        propertyCode: context.propertyCode,
        needsApproval: staffTemplateKey === "ACCESS_STAFF_APPROVAL_REQUIRED",
      }).catch(() => {});
    } catch (_) {
      /* push is best-effort */
    }
  }

  const staffPhone = await resolveStaffNotificationPhone(sb, bundle.location.propertyCode);
  if (!staffPhone) return;

  await dispatchAccessNotification({
    sb,
    traceId,
    reservationId: detail.id,
    templateKey: staffTemplateKey,
    recipientPhoneE164: staffPhone,
    preferredChannel: "sms",
    audience: "staff",
    context,
  });
}

async function createReservationForPortal(body, actor = "") {
  const sb = getSupabase();
  const parsed = parseActorAndOptions(actor);
  actor = parsed.actor;
  const opts = parsed.opts;
  const locationId = String(body.locationId || body.location_id || "").trim();
  const tenantId = String(body.tenantId || body.tenant_id || "").trim();
  const startAt = body.startAt || body.start_at;
  const endAt = body.endAt || body.end_at;
  const channel = String(body.channel || "staff_override").trim();

  const staffOverride =
    channel === "staff_override" || !!body.staffOverride || !!body.staff_override;
  const check = await canReserve({
    sb,
    locationId,
    tenantId,
    startAt,
    endAt,
    staffOverride,
  });
  if (!check.allowed) {
    const err = new Error(check.reason || "not_allowed");
    err.code = check.reason;
    throw err;
  }

  const loc = await getAccessLocationById(locationId);
  if (!loc) throw new Error("location_not_found");
  if (tenantId && !staffOverride && loc.staffOnly) {
    const err = new Error("staff_only_location");
    err.code = "staff_only_location";
    throw err;
  }

  const policy = await getActivePolicy(sb, locationId);
  let status = "CONFIRMED";
  if (check.requiresApproval) status = "PENDING_APPROVAL";
  else if ((check.depositAmount || 0) > 0) status = "PENDING_DEPOSIT";

  const { data: res, error } = await sb
    .from("access_reservations")
    .insert({
      org_id: loc.orgId,
      location_id: locationId,
      tenant_id: tenantId,
      start_at: startAt,
      end_at: endAt,
      status,
      channel,
      deposit_amount: check.depositAmount || 0,
      deposit_status: status === "PENDING_DEPOSIT" ? "pending" : "none",
      notes: String(body.notes || ""),
      override_by: channel === "staff_override" ? actor : "",
    })
    .select("*")
    .single();
  if (error || !res) throw new Error(error?.message || "reservation_failed");

  let pin = null;
  if (status === "CONFIRMED") {
    const lock = await getActiveLockForLocation(locationId);
    if (lock) {
      const issued = await issuePassForReservation(sb, res, lock, actor);
      pin = issued.pin;
    }
  }

  const detail = await getReservationDetail(res.id);
  if (pin) detail.pin = pin;
  await syncReservationLifecycleJobsForRow(sb, res, policy);
  const bundle = await loadReservationBundle(sb, res.id);
  if (bundle) {
    try {
      await notifyReservationEvent(
        bundle,
        status === "PENDING_APPROVAL"
          ? "ACCESS_TENANT_APPROVAL_REQUIRED"
          : "ACCESS_TENANT_RESERVATION_CONFIRMED",
        { traceId: opts.traceId }
      );
    } catch (notifyErr) {
      const message = String(notifyErr?.message || notifyErr || "access_notify_failed").trim();
      await appendEventLog({
        traceId: String(opts.traceId || "").trim(),
        log_kind: "access_engine",
        event: "ACCESS_RESERVE_NOTIFY_FAILED",
        payload: {
          reservation_id: res.id,
          error: message.slice(0, 500),
        },
      });
    }
  }
  return detail;
}

async function approveReservation(reservationId, actor = "") {
  const sb = getSupabase();
  const parsed = parseActorAndOptions(actor);
  actor = parsed.actor;
  const opts = parsed.opts;
  const { data: res } = await sb
    .from("access_reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();
  if (!res) throw new Error("not_found");
  if (res.status !== "PENDING_APPROVAL") throw new Error("invalid_status");

  await sb
    .from("access_reservations")
    .update({
      status: "CONFIRMED",
      approved_by: actor,
      updated_at: new Date().toISOString(),
    })
    .eq("id", reservationId);

  const lock = await getActiveLockForLocation(res.location_id);
  let pin = null;
  if (lock) {
    const updated = { ...res, status: "CONFIRMED" };
    const issued = await issuePassForReservation(sb, updated, lock, actor);
    pin = issued.pin;
  }
  const detail = await getReservationDetail(reservationId);
  if (pin) detail.pin = pin;
  await syncReservationLifecycleJobs(reservationId);
  const bundle = await loadReservationBundle(sb, reservationId);
  if (bundle) {
    await notifyReservationEvent(
      bundle,
      String(opts.templateKey || "").trim() || "ACCESS_TENANT_APPROVED",
      { traceId: opts.traceId }
    );
  }
  return detail;
}

async function cancelReservation(reservationId, actor = "") {
  const sb = getSupabase();
  const parsed = parseActorAndOptions(actor);
  actor = parsed.actor;
  const opts = parsed.opts;
  const { data: res } = await sb
    .from("access_reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();
  if (!res) throw new Error("not_found");

  await revokePassForReservation(sb, res, actor, "EXPIRED");

  await sb
    .from("access_reservations")
    .update({
      status: "CANCELLED",
      cancelled_by: actor,
      updated_at: new Date().toISOString(),
    })
    .eq("id", reservationId);

  await syncReservationLifecycleJobs(reservationId);
  const bundle = await loadReservationBundle(sb, reservationId);
  if (bundle) {
    await notifyReservationEvent(bundle, "ACCESS_TENANT_CANCELLED", {
      traceId: opts.traceId,
      forceTenantNotification: !!opts.forceTenantNotification,
    });
  }
  return getReservationDetail(reservationId);
}

async function regeneratePin(reservationId, actor = "") {
  const sb = getSupabase();
  const parsed = parseActorAndOptions(actor);
  actor = parsed.actor;
  const { data: res } = await sb
    .from("access_reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();
  if (!res) throw new Error("not_found");
  if (["CANCELLED", "COMPLETED", "NO_SHOW"].includes(res.status)) {
    throw new Error("invalid_status");
  }
  const lock = await getActiveLockForLocation(res.location_id);
  if (!lock) throw new Error("no_lock");
  if (res.access_pass_id) {
    await sb
      .from("access_passes")
      .update({
        status: "REVOKED",
        revoked_at: new Date().toISOString(),
        revoked_by: actor,
      })
      .eq("id", res.access_pass_id);
  }
  const issued = await issuePassForReservation(sb, res, lock, actor);
  const detail = await getReservationDetail(reservationId);
  detail.pin = issued.pin;
  await syncReservationLifecycleJobs(reservationId);
  return detail;
}

async function patchReservationTimes(reservationId, body, actor = "") {
  const sb = getSupabase();
  const parsed = parseActorAndOptions(actor);
  actor = parsed.actor;
  const { data: res } = await sb
    .from("access_reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();
  if (!res) throw new Error("not_found");

  const startAt = body.startAt || body.start_at || res.start_at;
  const endAt = body.endAt || body.end_at || res.end_at;
  const check = await canReserve({
    sb,
    locationId: res.location_id,
    tenantId: res.tenant_id,
    startAt,
    endAt,
    excludeReservationId: reservationId,
    staffOverride: true,
  });
  if (!check.allowed) {
    const err = new Error(check.reason);
    err.code = check.reason;
    throw err;
  }

  await sb
    .from("access_reservations")
    .update({
      start_at: startAt,
      end_at: endAt,
      notes: body.notes != null ? String(body.notes) : res.notes,
      override_by: actor || res.override_by,
      updated_at: new Date().toISOString(),
    })
    .eq("id", reservationId);

  if (res.access_pass_id && (res.status === "CONFIRMED" || res.status === "ACTIVE")) {
    return regeneratePin(reservationId, actor);
  }
  await syncReservationLifecycleJobs(reservationId);
  return getReservationDetail(reservationId);
}

async function denyReservationByTimeout(reservationId, actor = "", opts = {}) {
  const sb = getSupabase();
  const { data: res } = await sb
    .from("access_reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();
  if (!res) throw new Error("not_found");
  if (res.status !== "PENDING_APPROVAL") return getReservationDetail(reservationId);

  await sb
    .from("access_reservations")
    .update({
      status: "CANCELLED",
      cancelled_by: String(actor || "").trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", reservationId);

  await syncReservationLifecycleJobs(reservationId);
  const bundle = await loadReservationBundle(sb, reservationId);
  if (bundle) {
    await notifyReservationEvent(bundle, "ACCESS_TENANT_DENIED", {
      traceId: opts.traceId,
      forceTenantNotification: true,
    });
  }
  return getReservationDetail(reservationId);
}

async function markReservationActive(reservationId, opts = {}) {
  const sb = getSupabase();
  const actor = String(opts.actor || "").trim();
  const { data: res } = await sb
    .from("access_reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();
  if (!res) throw new Error("not_found");

  if (opts.dryRunReminder) {
    if (res.status !== "CONFIRMED") return getReservationDetail(reservationId);
    const bundle = await loadReservationBundle(sb, reservationId);
    if (bundle) {
      await notifyReservationEvent(bundle, "ACCESS_TENANT_REMINDER", {
        traceId: opts.traceId,
        forceTenantNotification: true,
      });
    }
    return getReservationDetail(reservationId);
  }

  if (res.status === "ACTIVE") return getReservationDetail(reservationId);
  if (res.status !== "CONFIRMED") return getReservationDetail(reservationId);

  await sb
    .from("access_reservations")
    .update({
      status: "ACTIVE",
      updated_at: new Date().toISOString(),
    })
    .eq("id", reservationId);
  await updatePassStatusForReservation(sb, res, "ACTIVE", actor);
  await syncReservationLifecycleJobs(reservationId);
  const bundle = await loadReservationBundle(sb, reservationId);
  if (bundle) {
    await notifyReservationEvent(bundle, "ACCESS_TENANT_ACTIVE", {
      traceId: opts.traceId,
      forceTenantNotification: true,
    });
  }
  return getReservationDetail(reservationId);
}

async function completeReservationLifecycle(reservationId, opts = {}) {
  const sb = getSupabase();
  const actor = String(opts.actor || "").trim();
  const { data: res } = await sb
    .from("access_reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();
  if (!res) throw new Error("not_found");
  if (["CANCELLED", "COMPLETED", "NO_SHOW"].includes(String(res.status || "").trim())) {
    return getReservationDetail(reservationId);
  }

  await revokePassForReservation(sb, res, actor);
  await sb
    .from("access_reservations")
    .update({
      status: "COMPLETED",
      updated_at: new Date().toISOString(),
    })
    .eq("id", reservationId);
  await syncReservationLifecycleJobs(reservationId);
  const bundle = await loadReservationBundle(sb, reservationId);
  if (bundle) {
    await notifyReservationEvent(bundle, "ACCESS_TENANT_COMPLETED", {
      traceId: opts.traceId,
      forceTenantNotification: true,
    });
  }
  return getReservationDetail(reservationId);
}

module.exports = {
  listAccessProgramForProperty,
  setAccessProgramEnrollment,
  listAccessLocationsForPortal,
  getAccessLocationById,
  getAccessPolicyForLocation,
  listSchedulesForLocation,
  listBlackoutsForLocation,
  listReservationsForLocation,
  getLocationStats,
  createAccessLocationForPortal,
  upsertAccessPolicyForLocation,
  replaceSchedulesForLocation,
  createBlackoutForLocation,
  deleteBlackout,
  getReservationDetail,
  createReservationForPortal,
  approveReservation,
  cancelReservation,
  regeneratePin,
  patchReservationTimes,
  syncReservationLifecycleJobs,
  denyReservationByTimeout,
  markReservationActive,
  completeReservationLifecycle,
};
