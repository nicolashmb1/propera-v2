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
  if (!code) return "grand";
  const { data } = await sb
    .from("properties")
    .select("org_id")
    .eq("code", code)
    .maybeSingle();
  const orgId = String(data?.org_id || "").trim();
  return orgId || "grand";
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
async function setAccessProgramEnrollment(opts) {
  const sb = getSupabase();
  if (!sb) throw new Error("no_db");
  const code = String(opts.propertyCode || "").trim().toUpperCase();
  const propertyLocationId = String(opts.propertyLocationId || "").trim();
  const enabled = !!opts.enabled;
  const actor = String(opts.actor || "portal_staff").trim();
  if (!code || !propertyLocationId) throw new Error("missing_fields");

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

  if (!enabled) {
    if (!existing) return { enrolled: false, accessLocation: null };
    const { data: updated, error } = await sb
      .from("access_locations")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message || "deactivate_failed");
    return { enrolled: false, accessLocation: mapLocationRow(updated) };
  }

  if (existing) {
    const { data: updated, error } = await sb
      .from("access_locations")
      .update({
        active: true,
        name: String(pl.label || existing.name).trim(),
        updated_at: new Date().toISOString(),
      })
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
    return { enrolled: true, accessLocation: loc };
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
    },
    actor
  );
  return { enrolled: true, accessLocation: loc };
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
  let q = sb.from("access_blackouts").select("*").eq("location_id", locationId);
  if (from) q = q.gte("end_at", from);
  if (to) q = q.lte("start_at", to);
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
  let q = sb
    .from("access_reservations")
    .select("*, tenant_roster:tenant_id (resident_name, unit_label, phone_e164)")
    .eq("location_id", locationId);
  if (from) q = q.gte("end_at", from);
  if (to) q = q.lte("start_at", to);
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
  const orgId = String(body.orgId || body.org_id || "grand").trim();
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

async function createReservationForPortal(body, actor = "") {
  const sb = getSupabase();
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
  return detail;
}

async function approveReservation(reservationId, actor = "") {
  const sb = getSupabase();
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
  return detail;
}

async function cancelReservation(reservationId, actor = "") {
  const sb = getSupabase();
  const { data: res } = await sb
    .from("access_reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();
  if (!res) throw new Error("not_found");

  if (res.access_pass_id) {
    const { data: pass } = await sb
      .from("access_passes")
      .select("*, access_locks:lock_id (*)")
      .eq("id", res.access_pass_id)
      .maybeSingle();
    if (pass?.access_locks) {
      const adapter = getLockAdapter(pass.access_locks.provider);
      await adapter.revokeCredential(pass.access_locks.id, pass.id);
      await sb
        .from("access_passes")
        .update({
          status: "REVOKED",
          revoked_at: new Date().toISOString(),
          revoked_by: actor,
        })
        .eq("id", pass.id);
    }
  }

  await sb
    .from("access_reservations")
    .update({
      status: "CANCELLED",
      cancelled_by: actor,
      updated_at: new Date().toISOString(),
    })
    .eq("id", reservationId);

  return getReservationDetail(reservationId);
}

async function regeneratePin(reservationId, actor = "") {
  const sb = getSupabase();
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
  return detail;
}

async function patchReservationTimes(reservationId, body, actor = "") {
  const sb = getSupabase();
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

  if (res.access_pass_id && res.status === "CONFIRMED") {
    return regeneratePin(reservationId, actor);
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
};
