/**
 * Voice read — lookup amenity booking + PIN for staff.
 */
const { getAccessPolicyForLocation } = require("../../dal/accessEngine");
const { resolveAccessReservation } = require("./resolveAccessReservation");
const { resolveJarvisPropertyForCreate } = require("../proposals/resolveJarvisProperty");
const { resolveAccessLocation } = require("../proposals/resolveAccessLocation");
const { formatUtcInPropertyZone } = require("../../access/accessLocalTime");

/**
 * @param {object} args
 * @param {object} ctx
 */
async function lookupAmenityBookingVoice(args, ctx) {
  const propResolved = await resolveJarvisPropertyForCreate({
    propertyHint: args.property_code || args.propertyCode,
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    traceId: ctx.traceId,
  });
  const propertyCode = propResolved.ok ? propResolved.propertyCode : "";

  const hit = await resolveAccessReservation({
    propertyCode,
    unitLabel: args.unit_label || args.unitLabel || args.unit,
    amenityName: args.amenity_name || args.amenityName,
    bookingDate: args.booking_date || args.bookingDate || args.date || "today",
    startTime: args.start_time || args.startTime || args.time,
    reservationId: args.reservation_id || args.reservationId,
  });

  if (!hit.ok) {
    return {
      found: false,
      error: hit.error,
      message: hit.message,
      candidates: hit.candidates,
      speak: hit.message,
    };
  }

  const r = hit.reservation;
  const when = `${formatUtcInPropertyZone(r.startAt)} – ${formatUtcInPropertyZone(r.endAt)}`;
  const place = r.locationName || args.amenity_name || "amenity";
  const unit = r.unitLabel || args.unit_label || "";
  const pin = String(r.pin || "").trim();
  const pinMasked = String(r.pinMasked || "").trim();
  const status = String(r.status || "").trim();

  let pinLine = "";
  if (pin) pinLine = `PIN is ${pin}.`;
  else if (pinMasked) pinLine = `PIN on file: ${pinMasked}.`;
  else if (status === "PENDING_APPROVAL") pinLine = "Pending approval — no PIN yet.";
  else if (status === "CANCELLED") pinLine = "Booking is cancelled.";
  else pinLine = "No PIN issued for this booking.";

  const speak =
    `${place}${unit ? ` unit ${unit}` : ""}, ${when}. ${pinLine}`.trim();

  return {
    found: true,
    reservation_id: r.id,
    amenity_name: place,
    property_code: r.propertyCode || propertyCode || undefined,
    unit_label: unit || undefined,
    tenant_name: r.tenantName || undefined,
    status,
    start_at: r.startAt,
    end_at: r.endAt,
    pin: pin || undefined,
    pin_masked: pinMasked || undefined,
    when,
    message: speak,
    speak,
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function getAmenityBookingRulesVoice(args, ctx) {
  const propResolved = await resolveJarvisPropertyForCreate({
    propertyHint: args.property_code || args.propertyCode,
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    traceId: ctx.traceId,
  });
  if (!propResolved.ok) {
    return { error: propResolved.error, message: propResolved.message || "Which property?" };
  }

  const amenityName = String(args.amenity_name || args.amenityName || "").trim();
  if (!amenityName) {
    return { error: "missing_amenity", message: "Which amenity?" };
  }

  const locHit = await resolveAccessLocation({
    propertyCode: propResolved.propertyCode,
    locationHint: amenityName,
  });
  if (!locHit.ok) {
    return { error: locHit.error, message: locHit.message, candidates: locHit.candidates };
  }

  const policy = await getAccessPolicyForLocation(locHit.location.id);
  if (!policy) {
    return {
      message: `No booking rules configured for ${locHit.location.name}.`,
      speak: `No booking rules for ${locHit.location.name}.`,
    };
  }

  const speak =
    `${locHit.location.name} at ${propResolved.propertyCode}: ` +
    `max block ${policy.maxDurationMin} minutes, min ${policy.minDurationMin} minutes, ` +
    `advance notice ${policy.advanceBookingMin} minutes, ` +
    `${policy.maxPerTenantDay ?? "no"} per tenant per day.`;

  return {
    amenity_name: locHit.location.name,
    property_code: propResolved.propertyCode,
    max_duration_min: policy.maxDurationMin,
    min_duration_min: policy.minDurationMin,
    advance_booking_min: policy.advanceBookingMin,
    max_per_tenant_day: policy.maxPerTenantDay,
    requires_approval: policy.requiresApproval,
    message: speak,
    speak,
  };
}

module.exports = { lookupAmenityBookingVoice, getAmenityBookingRulesVoice };
