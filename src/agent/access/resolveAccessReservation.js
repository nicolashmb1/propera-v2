/**
 * Find access reservations for staff Jarvis (unit + date/time + optional amenity).
 */
const { normalizeUnit_ } = require("../../brain/shared/extractUnitGas");
const {
  listAccessLocationsForPortal,
  listReservationsForLocation,
  getReservationDetail,
} = require("../../dal/accessEngine");
const { resolveAccessLocation } = require("../proposals/resolveAccessLocation");
const {
  parseBookingDate,
  parseClockTime,
} = require("./parseAmenityBookingTimes");
const { zonedWallClock, propertyDayBoundsUtc } = require("../../access/accessLocalTime");

/**
 * @param {Date|string} iso
 * @returns {number}
 */
function startMinutesInPropertyTz(iso) {
  const z = zonedWallClock(iso);
  return z.hour * 60 + z.minute;
}

/**
 * @param {object} reservation
 * @param {number} targetMin — minutes since midnight property TZ
 * @param {number} [toleranceMin]
 */
function reservationMatchesStartTime(reservation, targetMin, toleranceMin = 45) {
  if (targetMin == null || !Number.isFinite(targetMin)) return true;
  const startMin = startMinutesInPropertyTz(reservation.startAt);
  return Math.abs(startMin - targetMin) <= toleranceMin;
}

/**
 * @param {object} opts
 * @param {string} opts.propertyCode
 * @param {string} opts.unitLabel
 * @param {string} [opts.amenityName]
 * @param {string} [opts.bookingDate] — today, tomorrow, YYYY-MM-DD
 * @param {string} [opts.startTime] — 3pm, 15:00
 * @param {string} [opts.reservationId]
 * @param {boolean} [opts.includeCancelled]
 */
async function resolveAccessReservation(opts) {
  const reservationId = String(opts?.reservationId || opts?.reservation_id || "").trim();
  if (reservationId) {
    const detail = await getReservationDetail(reservationId);
    if (!detail) {
      return { ok: false, error: "not_found", message: "Reservation not found." };
    }
    return { ok: true, reservation: detail, via: "id" };
  }

  const propertyCode = String(opts?.propertyCode || opts?.property_code || "")
    .trim()
    .toUpperCase();
  const unitLabel = String(opts?.unitLabel || opts?.unit_label || "").trim();
  const amenityName = String(opts?.amenityName || opts?.amenity_name || "").trim();
  const bookingDateRaw = String(
    opts?.bookingDate || opts?.booking_date || opts?.date || "today"
  ).trim();
  const startTimeRaw = String(opts?.startTime || opts?.start_time || opts?.time || "").trim();
  const includeCancelled = !!opts?.includeCancelled;

  if (!propertyCode) {
    return { ok: false, error: "missing_property", message: "Which property?" };
  }
  if (!unitLabel) {
    return { ok: false, error: "missing_unit", message: "Which unit?" };
  }

  const wantUnit = normalizeUnit_(unitLabel);
  const bookingDate = parseBookingDate(bookingDateRaw);
  if (!bookingDate) {
    return {
      ok: false,
      error: "bad_date",
      message: "Need booking date — today, tomorrow, or YYYY-MM-DD.",
    };
  }

  const dayMid = new Date(
    Date.UTC(bookingDate.year, bookingDate.month - 1, bookingDate.day, 12, 0, 0)
  );
  const { startUtc, endUtc } = propertyDayBoundsUtc(dayMid);

  let locations = await listAccessLocationsForPortal({ propertyCode, activeOnly: true });

  if (amenityName) {
    const locHit = await resolveAccessLocation({ propertyCode, locationHint: amenityName });
    if (!locHit.ok) return locHit;
    locations = [locHit.location];
  }

  if (!locations.length) {
    return {
      ok: false,
      error: "no_locations",
      message: `No amenities at ${propertyCode}.`,
    };
  }

  const targetMin = startTimeRaw ? parseClockTime(startTimeRaw) : null;
  const targetMinutes =
    targetMin != null ? targetMin.hour * 60 + targetMin.minute : null;

  const matches = [];
  for (const loc of locations) {
    const rows = await listReservationsForLocation(loc.id, startUtc.toISOString(), endUtc.toISOString());
    for (const row of rows) {
      if (!includeCancelled && row.status === "CANCELLED") continue;
      const unit = normalizeUnit_(String(row.unitLabel || ""));
      if (unit !== wantUnit) continue;
      if (!reservationMatchesStartTime(row, targetMinutes)) continue;
      matches.push({
        ...row,
        locationName: loc.name,
        propertyCode: loc.propertyCode,
      });
    }
  }

  if (matches.length === 1) {
    const detail = await getReservationDetail(matches[0].id);
    return {
      ok: true,
      reservation: { ...detail, locationName: matches[0].locationName },
      via: "unit_time",
    };
  }

  if (matches.length > 1) {
    const bits = matches.slice(0, 4).map((r) => {
      const t = zonedWallClock(r.startAt);
      const hm = `${t.hour}:${String(t.minute).padStart(2, "0")}`;
      return `${r.locationName || "amenity"} ${hm}`;
    });
    return {
      ok: false,
      error: "ambiguous",
      message: `Multiple bookings for unit ${unitLabel} — ${bits.join(", ")}?`,
      candidates: matches,
    };
  }

  const timeBit = startTimeRaw ? ` at ${startTimeRaw}` : "";
  return {
    ok: false,
    error: "not_found",
    message: `No booking found for unit ${unitLabel}${timeBit} on ${bookingDateRaw}.`,
  };
}

module.exports = {
  resolveAccessReservation,
  reservationMatchesStartTime,
  startMinutesInPropertyTz,
};
