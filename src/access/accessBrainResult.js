/**
 * Structured access brain output — agent narrates facts; brain does not improvise calendar truth.
 */

/**
 * @param {object} o
 * @returns {object}
 */
function buildListSlotsFacts(o) {
  const locationName = String(o.locationName || "amenity").trim();
  const dayLabel = String(o.dayLabel || "that day").trim();
  const bookedRanges = Array.isArray(o.bookedRanges) ? o.bookedRanges : [];
  const closedDay = o.closedDay === true;
  const operatingHoursLabel = String(o.operatingHoursLabel || "").trim();
  return {
    kind: "list_slots",
    locationName,
    dayLabel,
    dateForDay: String(o.dateForDay || "").trim(),
    bookedRanges,
    open: !closedDay && bookedRanges.length === 0,
    closedDay,
    operatingHoursLabel,
  };
}

/**
 * @param {object} o
 * @returns {object}
 */
function buildReserveRejectedFacts(o) {
  return {
    kind: "reserve_rejected",
    locationName: String(o.locationName || "amenity").trim(),
    dayLabel: String(o.dayLabel || "").trim(),
    reason: String(o.reason || "").trim(),
    bookedRanges: Array.isArray(o.bookedRanges) ? o.bookedRanges : [],
    requestedStartAt: String(o.requestedStartAt || "").trim(),
    requestedEndAt: String(o.requestedEndAt || "").trim(),
  };
}

/**
 * @param {object} o
 * @returns {object}
 */
function buildReservedFacts(o) {
  return {
    kind: "reserved",
    locationName: String(o.locationName || "amenity").trim(),
    startLabel: String(o.startLabel || "").trim(),
    endLabel: String(o.endLabel || "").trim(),
    pin: String(o.pin || "").trim(),
    reservationId: String(o.reservationId || "").trim(),
  };
}

/**
 * @param {object} o
 * @returns {object}
 */
function buildNeedsWindowFacts(o) {
  return {
    kind: "needs_window",
    locationName: String(o.locationName || "amenity").trim(),
    forListDay: !!o.forListDay,
  };
}

/**
 * Handoff validator rejected the package — kick back to agent with a
 * specific reason so the LLM knows what to gather next.
 * @param {{ kickbackIntent: string, locationName?: string, errorSummary?: string }} o
 */
function buildNeedsMoreFacts(o) {
  return {
    kind: "needs_more",
    kickbackIntent: String(o.kickbackIntent || "").trim(),
    locationName: String(o.locationName || "").trim(),
    errorSummary: String(o.errorSummary || "").trim(),
  };
}

/**
 * Deterministic tenant copy from brain facts (same turn outbound).
 * @param {object | null | undefined} facts
 * @returns {string}
 */
function narrateAccessBrainResult(facts) {
  const f = facts && typeof facts === "object" ? facts : null;
  if (!f || !f.kind) return "";

  switch (String(f.kind)) {
    case "list_slots": {
      if (f.closedDay) {
        return `${f.locationName} is closed on ${f.dayLabel}. Pick another day if you want to book.`;
      }
      const hoursPart = f.operatingHoursLabel
        ? ` It is open ${f.operatingHoursLabel} that day.`
        : "";
      if (f.open) {
        return `On ${f.dayLabel}, ${f.locationName} has nothing booked yet.${hoursPart} Tell me the time you want (for example 2-4 pm) and I can try to reserve it.`;
      }
      const ranges = (f.bookedRanges || [])
        .map((r) => `${r.start}-${r.end}`)
        .join(", ");
      return `On ${f.dayLabel}, ${f.locationName} is already booked: ${ranges}.${hoursPart} Tell me a time that does not overlap and I can try to reserve it.`;
    }
    case "reserve_rejected": {
      const reason = String(f.reason || "").trim();
      if (reason === "slot_full" && f.bookedRanges && f.bookedRanges.length) {
        const ranges = f.bookedRanges.map((r) => `${r.start}-${r.end}`).join(", ");
        return `That time overlaps an existing booking. On ${f.dayLabel}, ${f.locationName} already has: ${ranges}. Pick a different time.`;
      }
      if (reason === "slot_full") {
        return `That time is not available for ${f.locationName} on ${f.dayLabel || "that day"}. Try a different time or ask what is open that day.`;
      }
      return explainReasonCode(reason, f.locationName);
    }
    case "reserved": {
      const base = `Booked ${f.locationName} on ${f.startLabel} to ${f.endLabel}.`;
      return f.pin ? `${base} PIN: ${f.pin}.` : base;
    }
    case "needs_window": {
      if (f.forListDay) {
        return `Which day should I check for ${f.locationName}? For example: tomorrow.`;
      }
      return `What date and time do you want for ${f.locationName}? For example: tomorrow 2-4 pm.`;
    }
    case "needs_more": {
      switch (String(f.kickbackIntent || "")) {
        case "need_intent":
          return "Are you trying to book, check what is open, see your reservation, or cancel?";
        case "need_location":
          return "Which amenity do you want? (game room, gym, etc.)";
        case "need_date":
          return "Which day? You can say today, tomorrow, or a weekday like Saturday.";
        case "need_window":
          return "What time? For example: 10 am to noon.";
        default:
          return "I need a little more detail before I can place that. Tell me the amenity, day, and time.";
      }
    }
    default:
      return "";
  }
}

function explainReasonCode(code, locationName) {
  const name = String(locationName || "that amenity").trim();
  switch (String(code || "").trim()) {
    case "too_soon":
      return "That reservation starts too soon for this amenity policy.";
    case "too_far":
    case "too_far_ahead":
      return "That reservation is too far in advance for this amenity policy.";
    case "same_day_not_allowed":
      return "This amenity does not allow same-day bookings.";
    case "start_in_past":
      return "That time is already in the past.";
    case "duration_too_short":
      return "That reservation is shorter than the minimum duration.";
    case "duration_too_long":
      return "That reservation is longer than the maximum allowed duration.";
    case "slot_full":
      return "That time is already full.";
    case "outside_hours":
      return "That time is outside the amenity hours.";
    case "closed_day":
      return `That amenity is closed on that day.`;
    case "must_end_same_day":
      return "The reservation must start and end on the same calendar day.";
    case "blackout":
      return "That time is blocked for this amenity.";
    case "tenant_daily_limit":
      return `You have reached the daily booking limit for ${name}.`;
    case "tenant_weekly_limit":
      return `You have reached the weekly booking limit for ${name}.`;
    case "tenant_monthly_limit":
      return `You have reached the monthly booking limit for ${name}.`;
    case "no_policy":
      return "This amenity is not open for bookings right now.";
    default:
      return "I could not place that reservation for that time.";
  }
}

/**
 * @param {Array<{ startAt: string, endAt: string }>} rows
 * @param {(iso: string) => string} formatStart
 * @param {(iso: string) => string} formatEnd
 */
function bookedRangesFromRows(rows, formatStart, formatEnd) {
  return (rows || [])
    .filter((row) => row.status !== "CANCELLED")
    .slice(0, 8)
    .map((row) => ({
      start: formatStart(row.startAt),
      end: formatEnd(row.endAt),
    }));
}

module.exports = {
  buildListSlotsFacts,
  buildReserveRejectedFacts,
  buildReservedFacts,
  buildNeedsWindowFacts,
  buildNeedsMoreFacts,
  narrateAccessBrainResult,
  bookedRangesFromRows,
  explainReasonCode,
};
