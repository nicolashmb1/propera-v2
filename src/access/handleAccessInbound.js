const { getSupabase } = require("../db/supabase");
const { resolveInboundPhoneForRosterLookup } = require("../adapters/tenantAgent/lookupTenantRosterForAgent");
const {
  listTenantAccessLocations,
  listTenantAccessReservations,
  getTenantAccessReservation,
  checkTenantCanReserve,
  createTenantAccessReservation,
  cancelTenantAccessReservation,
} = require("../tenant/tenantAccessService");
const {
  listDayReservationsForTenantLocation,
  listSchedulesForTenantLocation,
} = require("../tenant/tenantAccessService");
const { resolveOperatingHoursForAnchor } = require("./scheduleForDay");
const { ACCESS_INTENT_TYPES } = require("./parseAccessIntent");
const { resolveDay } = require("./dayResolver");
const {
  formatUtcInPropertyZone,
  formatUtcTimeInPropertyZone,
  propertyTimezone: accessTz,
} = require("./accessLocalTime");
const { appendEventLog } = require("../dal/appendEventLog");
const {
  buildListSlotsFacts,
  buildReserveRejectedFacts,
  buildReservedFacts,
  buildNeedsWindowFacts,
  buildNeedsMoreFacts,
  narrateAccessBrainResult,
  bookedRangesFromRows,
  explainReasonCode,
} = require("./accessBrainResult");
const {
  validateAccessHandoff,
  primaryKickbackIntent,
  summarizeHandoffErrors,
} = require("../adapters/agentContract/handoffSchema");

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

async function resolveInboundTenantContext(routerParameter) {
  const sb = getSupabase();
  if (!sb) return { matched: false };
  const phoneE164 = await resolveInboundPhoneForRosterLookup(
    sb,
    routerParameter || {},
    String(
      routerParameter?._canonicalBrainActorKey || routerParameter?._phoneE164 || routerParameter?.From || ""
    ).trim()
  );
  if (!phoneE164) return { matched: false };
  const { data, error } = await sb
    .from("tenant_roster")
    .select("id, property_code, unit_label, resident_name, phone_e164, active, updated_at")
    .eq("phone_e164", phoneE164)
    .eq("active", true)
    .order("updated_at", { ascending: false });
  if (error || !data || !data.length) return { matched: false, phoneE164 };

  const uniqueKeys = new Set(
    data.map((row) =>
      [
        String(row.property_code || "").trim().toUpperCase(),
        String(row.unit_label || "").trim().toUpperCase(),
      ].join("|")
    )
  );
  if (uniqueKeys.size !== 1) return { matched: false, phoneE164, ambiguous: true };

  const row = data[0];
  return {
    matched: true,
    phoneE164,
    tenantCtx: {
      tenantId: String(row.id || "").trim(),
      propertyCode: String(row.property_code || "").trim().toUpperCase(),
      unitLabel: String(row.unit_label || "").trim(),
      residentName: String(row.resident_name || "").trim(),
    },
  };
}

function isValidAccessIso(iso) {
  const d = new Date(String(iso || "").trim());
  return Number.isFinite(d.getTime());
}

/**
 * Window from agent handoff package only — brain does not parse NL for times.
 * @param {{ startAt?: string, endAt?: string }} intentPayload
 * @returns {{ startAt: string, endAt: string } | null}
 */
function windowFromAgentPackage(intentPayload) {
  const startAt = String(intentPayload?.startAt || "").trim();
  const endAt = String(intentPayload?.endAt || "").trim();
  if (startAt && endAt && isValidAccessIso(startAt) && isValidAccessIso(endAt)) {
    return { startAt, endAt };
  }
  return null;
}

function extractIntentPayload(routerParameter) {
  const raw = String(routerParameter?._accessPayloadJson || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      intentType: String(parsed.intentType || "").trim(),
      locationHint: String(parsed.locationHint || "").trim(),
      startAt: String(parsed.startAt || "").trim(),
      endAt: String(parsed.endAt || "").trim(),
      locationId: String(parsed.locationId || "").trim(),
      dateForDay: String(parsed.dateForDay || "").trim(),
      cancelReservationId: String(parsed.cancelReservationId || "").trim(),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Resolve an amenity hint OR free-form body text against the property catalog.
 *
 * Thin wrapper over the canonical resolver (`resolveAmenity` / `resolveAmenityFromText`).
 * Kept as an export for back-compat with `accessGatherRules.js`. New callers
 * should use the resolver directly.
 *
 * Closed-fail: returns null when nothing matches. Never silently substitutes
 * a different amenity when the hint clearly doesn't match.
 */
function resolveLocationFromText(locations, locationHint, bodyText) {
  const { resolveAmenity, resolveAmenityFromText } = require("./amenityResolver");
  const hint = String(locationHint || "").trim();
  if (hint) {
    const r = resolveAmenity(hint, locations);
    if (r.ok) return r.location;
  }
  const text = String(bodyText || "").trim();
  if (text) {
    const r = resolveAmenityFromText(text, locations);
    if (r.ok) return r.location;
  }
  return null;
}

function reservationSummary(reservation) {
  const tz = accessTz();
  const location = String(reservation.locationName || "amenity").trim();
  const startLabel = formatUtcInPropertyZone(reservation.startAt, tz);
  const endLabel = formatUtcTimeInPropertyZone(reservation.endAt, tz);
  return `${location} on ${startLabel} to ${endLabel}`;
}

function formatBookedRangesForDay(rows, dayLabel) {
  const tz = accessTz();
  const bookedRanges = bookedRangesFromRows(
    rows,
    (iso) => formatUtcTimeInPropertyZone(iso, tz),
    (iso) => formatUtcTimeInPropertyZone(iso, tz)
  );
  const rangesLabel = bookedRanges.map((r) => `${r.start}-${r.end}`).join(", ");
  return { dayLabel: dayLabel || "that day", rangesLabel, bookedRanges };
}

function accessBrainReply(accessFacts) {
  return narrateAccessBrainResult(accessFacts);
}

function reservationActionReply(reservation) {
  const base = `Booked ${reservationSummary(reservation)}.`;
  if (reservation.pin) return `${base} PIN: ${reservation.pin}.`;
  if (reservation.pinMasked) return `${base} PIN ready: ${reservation.pinMasked}.`;
  return base;
}

function explainReserveError(errorCode, locationName) {
  const code = String(errorCode || "").trim();
  if (code === "location_not_found") {
    return "I could not find that amenity for your building.";
  }
  if (code === "invalid_input" || code === "invalid_time_range") {
    return "I need a clearer date and time to check that.";
  }
  if (code === "reservation_failed" || code === "pass_insert_failed") {
    return "I could not save that reservation right now. Please try again in a moment or use the resident portal.";
  }
  if (/^sb is not defined$/i.test(code)) {
    return "I could not complete the booking due to a system error. Please try again.";
  }
  return explainReasonCode(code, locationName);
}

async function handleAccessInbound(o) {
  const traceId = String(o.traceId || "").trim();
  const routerParameter = o.routerParameter || {};

  const intentPayload = extractIntentPayload(routerParameter);
  if (!intentPayload) return { handled: false };

  const intentType = String(intentPayload.intentType || "").trim();
  if (!intentType || intentType === ACCESS_INTENT_TYPES.UNKNOWN) return { handled: false };

  // Strict handoff gate (Piece 1 — agent->brain contract).
  // The agent's gather loop is free; the seam is not. If the package isn't
  // resolved to canonical truth, kick back with a specific intent so the
  // LLM asks for what's missing on the next turn (no regex needed).
  const handoffCheck = validateAccessHandoff(intentPayload);
  if (!handoffCheck.ok) {
    const kickbackIntent = primaryKickbackIntent(handoffCheck.errors);
    const errorSummary = summarizeHandoffErrors(handoffCheck.errors);
    await appendEventLog({
      traceId,
      log_kind: "access_inbound",
      event: "ACCESS_HANDOFF_REJECTED",
      payload: {
        intent_type: intentType,
        kickback_intent: kickbackIntent,
        error_summary: errorSummary,
      },
    });
    const accessFacts = buildNeedsMoreFacts({
      kickbackIntent,
      locationName: "",
      errorSummary,
    });
    return {
      handled: true,
      brain: "access_needs_more",
      reason: kickbackIntent,
      accessFacts,
      replyText: narrateAccessBrainResult(accessFacts),
    };
  }

  const ctx = await resolveInboundTenantContext(routerParameter);
  if (!ctx.matched || !ctx.tenantCtx) {
    return {
      handled: true,
      brain: "access_missing_tenant_context",
      replyText:
        "I can help with amenity access once I can match your resident record. Please use the resident portal amenities page for now.",
    };
  }

  const tenantCtx = {
    tenantId: ctx.tenantCtx.tenantId,
    propertyCode: ctx.tenantCtx.propertyCode,
  };
  const locations = await listTenantAccessLocations(tenantCtx);
  const { resolveAmenityById } = require("./amenityResolver");
  const resolvedLocation = intentPayload.locationId
    ? resolveAmenityById(intentPayload.locationId, locations)
    : resolveLocationFromText(locations, intentPayload.locationHint, "");

  let parsedWindow = windowFromAgentPackage(intentPayload);

  // Resolve the day hint once for any intent that needs it. Downstream
  // branches (list_slots fact-build, reserve-rejected fact-build) reuse the
  // same `resolvedDay` so day label / anchor / bounds never disagree.
  const listSlotsDefaultDay =
    intentType === ACCESS_INTENT_TYPES.LIST_SLOTS ? "today" : "tomorrow";
  const resolvedDay = resolveDay(intentPayload.dateForDay || listSlotsDefaultDay, new Date());
  if (intentType === ACCESS_INTENT_TYPES.LIST_SLOTS) {
    parsedWindow = { startAt: resolvedDay.anchorIso, endAt: resolvedDay.anchorIso };
  }

  if (intentType === ACCESS_INTENT_TYPES.STATUS) {
    const reservations = await listTenantAccessReservations(tenantCtx);
    const active = reservations.filter((row) =>
      ["PENDING_APPROVAL", "CONFIRMED", "ACTIVE"].includes(String(row.status || "").trim())
    );
    const filtered = resolvedLocation
      ? active.filter((row) => String(row.locationId || "").trim() === String(resolvedLocation.id || "").trim())
      : active;
    if (!filtered.length) {
      return {
        handled: true,
        brain: "access_status_none",
        replyText: "You do not have an active amenity reservation right now.",
      };
    }
    const reservation = await getTenantAccessReservation(tenantCtx, filtered[0].id);
    return {
      handled: true,
      brain: "access_status_reply",
      replyText: reservation
        ? `Current reservation: ${reservationActionReply(reservation)} Status: ${reservation.status}.`
        : `Current reservation: ${reservationSummary(filtered[0])}. Status: ${filtered[0].status}.`,
    };
  }

  if (intentType === ACCESS_INTENT_TYPES.CANCEL) {
    const reservations = await listTenantAccessReservations(tenantCtx);
    const active = reservations.filter((row) =>
      ["PENDING_APPROVAL", "CONFIRMED", "ACTIVE"].includes(String(row.status || "").trim())
    );
    const filtered = resolvedLocation
      ? active.filter((row) => String(row.locationId || "").trim() === String(resolvedLocation.id || "").trim())
      : active;
    if (filtered.length !== 1) {
      return {
        handled: true,
        brain: "access_cancel_needs_specific",
        replyText:
          "I can cancel one active amenity reservation at a time. Please mention the amenity name or use the resident portal amenities page.",
      };
    }
    const cancelled = await cancelTenantAccessReservation(tenantCtx, filtered[0].id);
    return {
      handled: true,
      brain: "access_cancelled",
      replyText: cancelled
        ? `Cancelled ${reservationSummary(cancelled)}.`
        : "Your amenity reservation was cancelled.",
    };
  }

  if (!resolvedLocation) {
    return {
      handled: true,
      brain: "access_missing_location",
      replyText:
        "Which amenity do you want? You can say something like 'book gameroom tomorrow 3-5 pm'.",
    };
  }

  if (intentType === ACCESS_INTENT_TYPES.LIST_SLOTS) {
    if (!parsedWindow?.startAt) {
      const accessFacts = buildNeedsWindowFacts({
        locationName: resolvedLocation.name,
        forListDay: true,
      });
      return {
        handled: true,
        brain: "access_needs_window",
        reason: "needs_window",
        accessFacts,
        replyText: accessBrainReply(accessFacts),
      };
    }
    const dayRows = await listDayReservationsForTenantLocation(
      tenantCtx,
      resolvedLocation.id,
      parsedWindow.startAt
    );
    const schedules = await listSchedulesForTenantLocation(tenantCtx, resolvedLocation.id);
    const hoursInfo = resolveOperatingHoursForAnchor(
      resolvedDay.anchorIso,
      schedules,
      accessTz()
    );
    const { dayLabel, bookedRanges } = formatBookedRangesForDay(dayRows, resolvedDay.localLabel);
    const accessFacts = buildListSlotsFacts({
      locationName: resolvedLocation.name,
      dayLabel,
      dateForDay: intentPayload.dateForDay || listSlotsDefaultDay,
      bookedRanges,
      closedDay: hoursInfo.closed,
      operatingHoursLabel: hoursInfo.label,
    });
    return {
      handled: true,
      brain: accessFacts.open ? "access_slots_open_day" : "access_slots_listed",
      accessFacts,
      replyText: accessBrainReply(accessFacts),
    };
  }

  if (!parsedWindow?.startAt || !parsedWindow?.endAt) {
    const accessFacts = buildNeedsWindowFacts({ locationName: resolvedLocation.name });
    return {
      handled: true,
      brain: "access_needs_window",
      reason: "needs_window",
      accessFacts,
      replyText: accessBrainReply(accessFacts),
    };
  }

  const cancelId = String(intentPayload.cancelReservationId || "").trim();
  if (cancelId) {
    try {
      await cancelTenantAccessReservation(tenantCtx, cancelId);
    } catch (_) {
      // Proceed — prior booking may already be cancelled.
    }
  }

  const canReserve = await checkTenantCanReserve(
    tenantCtx,
    resolvedLocation.id,
    parsedWindow.startAt,
    parsedWindow.endAt
  );
  if (!canReserve.allowed) {
    await appendEventLog({
      traceId,
      log_kind: "access_inbound",
      event: "ACCESS_RESERVE_REJECTED",
      payload: {
        tenant_id: tenantCtx.tenantId,
        location_id: resolvedLocation.id,
        reason: canReserve.reason,
        start_at: parsedWindow.startAt,
        end_at: parsedWindow.endAt,
      },
    });

    const dayRows = await listDayReservationsForTenantLocation(
      tenantCtx,
      resolvedLocation.id,
      parsedWindow.startAt
    );
    const { dayBoundsForInstant } = require("./dayResolver");
    const requestedDay = dayBoundsForInstant(parsedWindow.startAt).resolved;
    const { dayLabel, bookedRanges } = formatBookedRangesForDay(dayRows, requestedDay.localLabel);
    const accessFacts = buildReserveRejectedFacts({
      locationName: resolvedLocation.name,
      dayLabel,
      reason: canReserve.reason,
      bookedRanges,
      requestedStartAt: parsedWindow.startAt,
      requestedEndAt: parsedWindow.endAt,
    });
    return {
      handled: true,
      brain: "access_reserve_rejected",
      reason: canReserve.reason,
      accessFacts,
      replyText: accessBrainReply(accessFacts),
    };
  }

  try {
    const reservation = await createTenantAccessReservation(tenantCtx, {
      locationId: resolvedLocation.id,
      startAt: parsedWindow.startAt,
      endAt: parsedWindow.endAt,
      channel: String(o.transportChannel || "sms").trim().toLowerCase(),
    });
    await appendEventLog({
      traceId,
      log_kind: "access_inbound",
      event: "ACCESS_INBOUND_RESERVED",
      payload: {
        tenant_id: tenantCtx.tenantId,
        property_code: tenantCtx.propertyCode,
        reservation_id: reservation?.id || null,
        location_id: resolvedLocation.id,
      },
    });
    const tz = accessTz();
    const accessFacts = buildReservedFacts({
      locationName: reservation.locationName || resolvedLocation.name,
      startLabel: formatUtcInPropertyZone(reservation.startAt, tz),
      endLabel: formatUtcTimeInPropertyZone(reservation.endAt, tz),
      pin: reservation.pin || "",
      reservationId: reservation?.id || "",
    });
    return {
      handled: true,
      brain: "access_reserved",
      accessFacts,
      replyText: accessBrainReply(accessFacts),
      reservationId: reservation?.id || "",
      locationId: resolvedLocation.id,
      startAt: parsedWindow.startAt,
      endAt: parsedWindow.endAt,
    };
  } catch (err) {
    const code = String(err.code || err.message || "access_reservation_failed").trim();
    const accessFacts = buildReserveRejectedFacts({
      locationName: resolvedLocation.name,
      reason: code,
      bookedRanges: [],
    });
    return {
      handled: true,
      brain: "access_reserve_failed",
      reason: code,
      accessFacts,
      replyText: accessBrainReply(accessFacts),
    };
  }
}

module.exports = {
  handleAccessInbound,
  resolveInboundTenantContext,
  resolveLocationFromText,
  extractIntentPayload,
  explainReserveError,
};
