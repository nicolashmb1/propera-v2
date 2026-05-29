/**
 * Conversation state schema (Piece 3 of the access foundation).
 *
 * `partial_package` is the agent's working memory for an in-flight tenant
 * conversation. Before this file, every caller poked the JSON directly
 * (`partial._access_request = ...`, `delete partial._access_last_error`,
 * etc.) — which meant the shape drifted and the lane was re-decided on
 * every turn. The "Saturday correction routed to maintenance" bug was a
 * direct symptom of that.
 *
 * Here the lane + the four access slots become first-class fields with
 * typed read/write helpers. Every caller goes through these helpers so
 * the shape stays consistent and the lane is always explicit.
 *
 * Doctrine:
 *  - Principle 5 (Persist explicit state, not infer it)
 *  - Guardrail 22 (Make everything explicit)
 *  - Guardrail 15 (Preserve strict separation of layers)
 *
 * Non-goal: this file does NOT take over every partial_package slot.
 *  - Maintenance in-flight gather fields (`property`, `unit`, `issue`,
 *    `location_kind`, `preferredWindow`, `_related_ticket_candidates`,
 *    `_follow_up_pending`, `_awaiting`) stay flat for now. Migrating
 *    them is a much larger surgery (dozens of read/write call sites).
 *  - However, the *outcomes* of the maintenance lane (last-ticket and
 *    last-error snapshots) are typed here so the post-handoff observability
 *    story matches access. See `MAINTENANCE_FIELD` below.
 *  - Pipeline dedupe state (`_dedupe_*`) stays as an ad-hoc bag.
 */

const CONVERSATION_LANE = Object.freeze({
  ACCESS: "access",
  MAINTENANCE: "maintenance",
});

const VALID_LANES = new Set(Object.values(CONVERSATION_LANE));

/**
 * Closed set of access slot keys. Centralized so nothing else has to
 * hard-code the underscore-prefixed JSON keys.
 */
const ACCESS_FIELD = Object.freeze({
  ACTIVE_LANE: "_active_lane",
  ACCESS_REQUEST: "_access_request",
  ACCESS_LAST_BOOKING: "_access_last_booking",
  ACCESS_LAST_ERROR: "_access_last_error",
});

/**
 * Closed set of maintenance slot keys. Only the *outcome* slots are typed
 * here — see the file header for why the in-flight gather fields stay flat.
 */
const MAINTENANCE_FIELD = Object.freeze({
  MAINTENANCE_LAST_TICKET: "_maintenance_last_ticket",
  MAINTENANCE_LAST_ERROR: "_maintenance_last_error",
});

/**
 * @typedef {object} AccessRequestSlot
 * @property {string} [intentType]
 * @property {string} [locationId]
 * @property {string} [locationHint]
 * @property {string} [startAt]
 * @property {string} [endAt]
 * @property {string} [dateForDay]
 * @property {string} [_cancelReservationId]
 */

/**
 * @typedef {object} AccessLastBookingSlot
 * @property {string} reservationId
 * @property {string} locationId
 * @property {string} [locationHint]
 * @property {string} [dateForDay]
 * @property {string} [startAt]
 * @property {string} [endAt]
 * @property {string} [at]                 ISO timestamp recorded at write time.
 */

/**
 * @typedef {object} AccessLastErrorSlot
 * @property {string} brain                Brain code, e.g. "access_needs_more".
 * @property {string} [code]               Reason / kickback intent.
 * @property {string} [replyText]
 * @property {object | null} [accessFacts] Structured facts (see accessBrainResult).
 * @property {string} [at]                 ISO timestamp recorded at write time.
 */

/**
 * @typedef {object} MaintenanceLastTicketSlot
 * @property {string} ticketKey            Stable handle (e.g. "PROP-123") or empty.
 * @property {string} [propertyCode]       Upper-case.
 * @property {string} [unitLabel]
 * @property {string} [locationKind]       "unit" | "common_area" | "property"
 * @property {string} [category]
 * @property {string} [issueSummary]       First ~120 chars of the issue text.
 * @property {string} [preferredWindow]
 * @property {boolean} [emergency]
 * @property {string} [at]                 ISO timestamp recorded at write time.
 */

/**
 * @typedef {object} MaintenanceLastErrorSlot
 * @property {string} stage                Where the error came from: "handoff_contract" | "core_brain" | other free-form tag.
 * @property {string[]} [rejectedFields]   For contract rejections.
 * @property {string[]} [rejectionReasons] For contract rejections (human-readable).
 * @property {string} [code]               Free-form code for non-contract errors.
 * @property {string} [replyText]          What the tenant saw on this turn.
 * @property {string} [at]                 ISO timestamp recorded at write time.
 */

/**
 * @typedef {object} PartialPackage
 * @property {string} [_active_lane]
 * @property {AccessRequestSlot} [_access_request]
 * @property {AccessLastBookingSlot} [_access_last_booking]
 * @property {AccessLastErrorSlot} [_access_last_error]
 * @property {MaintenanceLastTicketSlot} [_maintenance_last_ticket]
 * @property {MaintenanceLastErrorSlot} [_maintenance_last_error]
 * Plus arbitrary other working-memory fields (maintenance gather, dedupe, awaiting, etc.).
 */

/* ------------------------------------------------------------------ */
/* Immutability + normalization helpers                                */
/* ------------------------------------------------------------------ */

/**
 * Shallow-clone `partial` and return a fresh PartialPackage. Always use this
 * before any mutation — callers never own the original object.
 *
 * @param {object | null | undefined} partial
 * @returns {PartialPackage}
 */
function clonePartial(partial) {
  return partial && typeof partial === "object" ? { ...partial } : {};
}

/**
 * Coerce any incoming object to a known-shaped PartialPackage. Drops invalid
 * lane values; preserves unknown keys so working memory from other flows
 * (maintenance, awaiting, find-related) is not destroyed.
 *
 * @param {object | null | undefined} raw
 * @returns {PartialPackage}
 */
function normalizePartialPackage(raw) {
  const next = clonePartial(raw);
  const lane = String(next[ACCESS_FIELD.ACTIVE_LANE] || "").trim();
  if (lane && !VALID_LANES.has(lane)) {
    delete next[ACCESS_FIELD.ACTIVE_LANE];
  }

  // Defensive: drop typed maintenance slots if they're not objects so a
  // corrupted row can't poison the read helpers downstream.
  for (const key of [
    MAINTENANCE_FIELD.MAINTENANCE_LAST_TICKET,
    MAINTENANCE_FIELD.MAINTENANCE_LAST_ERROR,
  ]) {
    const v = next[key];
    if (v != null && (typeof v !== "object" || Array.isArray(v))) {
      delete next[key];
    }
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Active lane                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {PartialPackage | null | undefined} partial
 * @returns {string} One of CONVERSATION_LANE.* or "" if unset.
 */
function readActiveLane(partial) {
  const v = String(partial?.[ACCESS_FIELD.ACTIVE_LANE] || "").trim();
  return VALID_LANES.has(v) ? v : "";
}

/**
 * Set (or clear) the active lane. Pass empty string to clear.
 * @param {PartialPackage} partial
 * @param {string} lane
 * @returns {PartialPackage}
 */
function withActiveLane(partial, lane) {
  const next = clonePartial(partial);
  const v = String(lane || "").trim();
  if (v && VALID_LANES.has(v)) {
    next[ACCESS_FIELD.ACTIVE_LANE] = v;
  } else {
    delete next[ACCESS_FIELD.ACTIVE_LANE];
  }
  return next;
}

/**
 * Convenience — return a partial with the active lane stripped.
 * @param {PartialPackage} partial
 */
function withoutActiveLane(partial) {
  const next = clonePartial(partial);
  delete next[ACCESS_FIELD.ACTIVE_LANE];
  return next;
}

/* ------------------------------------------------------------------ */
/* Access request (in-flight gather)                                   */
/* ------------------------------------------------------------------ */

/**
 * @param {PartialPackage | null | undefined} partial
 * @returns {AccessRequestSlot | null}
 */
function readAccessRequest(partial) {
  const v = partial?.[ACCESS_FIELD.ACCESS_REQUEST];
  return v && typeof v === "object" ? v : null;
}

/**
 * @param {PartialPackage} partial
 * @param {AccessRequestSlot | null | undefined} request
 * @returns {PartialPackage}
 */
function withAccessRequest(partial, request) {
  const next = clonePartial(partial);
  if (request && typeof request === "object") {
    next[ACCESS_FIELD.ACCESS_REQUEST] = { ...request };
  } else {
    delete next[ACCESS_FIELD.ACCESS_REQUEST];
  }
  return next;
}

/**
 * @param {PartialPackage} partial
 */
function withoutAccessRequest(partial) {
  const next = clonePartial(partial);
  delete next[ACCESS_FIELD.ACCESS_REQUEST];
  return next;
}

/* ------------------------------------------------------------------ */
/* Last successful booking                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {PartialPackage | null | undefined} partial
 * @returns {AccessLastBookingSlot | null}
 */
function readAccessLastBooking(partial) {
  const v = partial?.[ACCESS_FIELD.ACCESS_LAST_BOOKING];
  return v && typeof v === "object" ? v : null;
}

/**
 * @param {PartialPackage} partial
 * @param {AccessLastBookingSlot} booking
 * @returns {PartialPackage}
 */
function withAccessLastBooking(partial, booking) {
  const next = clonePartial(partial);
  if (booking && typeof booking === "object") {
    next[ACCESS_FIELD.ACCESS_LAST_BOOKING] = {
      ...booking,
      at: String(booking.at || new Date().toISOString()),
    };
  } else {
    delete next[ACCESS_FIELD.ACCESS_LAST_BOOKING];
  }
  return next;
}

/**
 * @param {PartialPackage} partial
 */
function withoutAccessLastBooking(partial) {
  const next = clonePartial(partial);
  delete next[ACCESS_FIELD.ACCESS_LAST_BOOKING];
  return next;
}

/* ------------------------------------------------------------------ */
/* Last brain error / kickback                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {PartialPackage | null | undefined} partial
 * @returns {AccessLastErrorSlot | null}
 */
function readAccessLastError(partial) {
  const v = partial?.[ACCESS_FIELD.ACCESS_LAST_ERROR];
  return v && typeof v === "object" ? v : null;
}

/**
 * @param {PartialPackage} partial
 * @param {AccessLastErrorSlot} err
 * @returns {PartialPackage}
 */
function withAccessLastError(partial, err) {
  const next = clonePartial(partial);
  if (err && typeof err === "object") {
    next[ACCESS_FIELD.ACCESS_LAST_ERROR] = {
      brain: String(err.brain || "").trim(),
      code: String(err.code || "").trim(),
      replyText: String(err.replyText || "").trim(),
      accessFacts: err.accessFacts || null,
      at: String(err.at || new Date().toISOString()),
    };
  } else {
    delete next[ACCESS_FIELD.ACCESS_LAST_ERROR];
  }
  return next;
}

/**
 * @param {PartialPackage} partial
 */
function withoutAccessLastError(partial) {
  const next = clonePartial(partial);
  delete next[ACCESS_FIELD.ACCESS_LAST_ERROR];
  return next;
}

/* ------------------------------------------------------------------ */
/* Higher-level transitions                                            */
/* ------------------------------------------------------------------ */

/**
 * On successful booking — replace the live request with a booking record and
 * clear any prior error in one atomic transition.
 *
 * @param {PartialPackage} partial
 * @param {AccessLastBookingSlot} booking
 */
function recordAccessBookingSuccess(partial, booking) {
  let next = withAccessLastBooking(partial, booking);
  next = withoutAccessRequest(next);
  next = withoutAccessLastError(next);
  return next;
}

/**
 * @param {object | null | undefined} a
 * @param {object | null | undefined} b
 * @returns {boolean}
 */
function accessWindowsMatch(a, b) {
  if (!a || !b) return false;
  return (
    String(a.startAt || "").trim() === String(b.startAt || "").trim() &&
    String(a.endAt || "").trim() === String(b.endAt || "").trim()
  );
}

/**
 * On brain rejection (needs_more / needs_window / etc.) — keep the live
 * request but stamp the kickback so the LLM sees it next turn. Optionally
 * strip ambiguous window fields when the kickback says we need a fresh one.
 *
 * @param {PartialPackage} partial
 * @param {AccessRequestSlot} request
 * @param {AccessLastErrorSlot} err
 * @param {{ stripWindow?: boolean }} [opts]
 */
function recordAccessBrainRejection(partial, request, err, opts = {}) {
  let next = withAccessLastError(partial, err);
  const trimmed = { ...(request || {}) };
  if (opts.stripWindow) {
    delete trimmed.startAt;
    delete trimmed.endAt;
  }
  next = withAccessRequest(next, trimmed);
  return next;
}

/**
 * Close out the access lane entirely — used when the LLM signals
 * ACCESS_CLOSE or the tenant says "thanks, all set". Strips lane, in-flight
 * request, and last error. Keeps `_access_last_booking` so a follow-up
 * correction is still possible within the 48h TTL.
 *
 * @param {PartialPackage} partial
 */
function clearAccessLane(partial) {
  let next = withoutActiveLane(partial);
  next = withoutAccessRequest(next);
  next = withoutAccessLastError(next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Maintenance — last ticket (outcome of successful handoff)           */
/* ------------------------------------------------------------------ */

const ISSUE_SUMMARY_MAX = 120;

function summarizeIssue(text) {
  const s = String(text || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s.length > ISSUE_SUMMARY_MAX ? s.slice(0, ISSUE_SUMMARY_MAX) : s;
}

/**
 * @param {PartialPackage | null | undefined} partial
 * @returns {MaintenanceLastTicketSlot | null}
 */
function readMaintenanceLastTicket(partial) {
  const v = partial?.[MAINTENANCE_FIELD.MAINTENANCE_LAST_TICKET];
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/**
 * @param {PartialPackage} partial
 * @param {MaintenanceLastTicketSlot} ticket
 * @returns {PartialPackage}
 */
function withMaintenanceLastTicket(partial, ticket) {
  const next = clonePartial(partial);
  if (ticket && typeof ticket === "object") {
    next[MAINTENANCE_FIELD.MAINTENANCE_LAST_TICKET] = {
      ticketKey: String(ticket.ticketKey || "").trim(),
      propertyCode: String(ticket.propertyCode || "").trim().toUpperCase(),
      unitLabel: String(ticket.unitLabel || "").trim(),
      locationKind: String(ticket.locationKind || "").trim().toLowerCase(),
      category: String(ticket.category || "").trim(),
      issueSummary: summarizeIssue(ticket.issueSummary || ""),
      preferredWindow: String(ticket.preferredWindow || "").trim(),
      emergency: ticket.emergency === true,
      at: String(ticket.at || new Date().toISOString()),
    };
  } else {
    delete next[MAINTENANCE_FIELD.MAINTENANCE_LAST_TICKET];
  }
  return next;
}

/**
 * @param {PartialPackage} partial
 */
function withoutMaintenanceLastTicket(partial) {
  const next = clonePartial(partial);
  delete next[MAINTENANCE_FIELD.MAINTENANCE_LAST_TICKET];
  return next;
}

/* ------------------------------------------------------------------ */
/* Maintenance — last error (outcome of brain or contract rejection)   */
/* ------------------------------------------------------------------ */

/**
 * @param {PartialPackage | null | undefined} partial
 * @returns {MaintenanceLastErrorSlot | null}
 */
function readMaintenanceLastError(partial) {
  const v = partial?.[MAINTENANCE_FIELD.MAINTENANCE_LAST_ERROR];
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/**
 * @param {PartialPackage} partial
 * @param {MaintenanceLastErrorSlot} err
 * @returns {PartialPackage}
 */
function withMaintenanceLastError(partial, err) {
  const next = clonePartial(partial);
  if (err && typeof err === "object") {
    next[MAINTENANCE_FIELD.MAINTENANCE_LAST_ERROR] = {
      stage: String(err.stage || "").trim(),
      rejectedFields: Array.isArray(err.rejectedFields)
        ? err.rejectedFields.map((s) => String(s || "").trim()).filter(Boolean)
        : [],
      rejectionReasons: Array.isArray(err.rejectionReasons)
        ? err.rejectionReasons.map((s) => String(s || "").trim()).filter(Boolean)
        : [],
      code: String(err.code || "").trim(),
      replyText: String(err.replyText || "").trim(),
      at: String(err.at || new Date().toISOString()),
    };
  } else {
    delete next[MAINTENANCE_FIELD.MAINTENANCE_LAST_ERROR];
  }
  return next;
}

/**
 * @param {PartialPackage} partial
 */
function withoutMaintenanceLastError(partial) {
  const next = clonePartial(partial);
  delete next[MAINTENANCE_FIELD.MAINTENANCE_LAST_ERROR];
  return next;
}

/* ------------------------------------------------------------------ */
/* Maintenance — atomic transitions                                    */
/* ------------------------------------------------------------------ */

/**
 * On successful ticket creation — stamp the ticket snapshot and clear any
 * prior error. The flat in-flight fields (`property`, `unit`, `issue`,
 * `preferredWindow`, ...) are NOT cleared here because the post-complete
 * flow ("did you forget to mention X?") still consults them. Callers that
 * want a hard reset can use {@link clearMaintenanceLane}.
 *
 * @param {PartialPackage} partial
 * @param {MaintenanceLastTicketSlot} ticket
 */
function recordMaintenanceTicketSuccess(partial, ticket) {
  let next = withMaintenanceLastTicket(partial, ticket);
  next = withoutMaintenanceLastError(next);
  return next;
}

/**
 * On handoff-contract rejection — stamp the error so the LLM can see what
 * the brain refused and re-ask precisely. Does NOT touch the flat gather
 * fields (`tryTenantAgentHandoff` already strips the rejected ones on its
 * own; this just records the audit trail for the next turn's LLM context).
 *
 * @param {PartialPackage} partial
 * @param {MaintenanceLastErrorSlot} err
 */
function recordMaintenanceContractRejection(partial, err) {
  return withMaintenanceLastError(partial, {
    ...err,
    stage: String(err?.stage || "handoff_contract").trim(),
  });
}

/**
 * Close out the maintenance lane entirely — strips lane and last error.
 * Keeps `_maintenance_last_ticket` so a follow-up ("did you fix the leak
 * from yesterday?") can still recognize the prior thread within TTL.
 *
 * @param {PartialPackage} partial
 */
function clearMaintenanceLane(partial) {
  let next = withoutActiveLane(partial);
  next = withoutMaintenanceLastError(next);
  return next;
}

module.exports = {
  CONVERSATION_LANE,
  ACCESS_FIELD,
  MAINTENANCE_FIELD,
  normalizePartialPackage,
  // Active lane
  readActiveLane,
  withActiveLane,
  withoutActiveLane,
  // Access request
  readAccessRequest,
  withAccessRequest,
  withoutAccessRequest,
  // Access last booking
  readAccessLastBooking,
  withAccessLastBooking,
  withoutAccessLastBooking,
  // Access last error
  readAccessLastError,
  withAccessLastError,
  withoutAccessLastError,
  // Access atomic transitions
  recordAccessBookingSuccess,
  recordAccessBrainRejection,
  clearAccessLane,
  accessWindowsMatch,
  // Maintenance last ticket
  readMaintenanceLastTicket,
  withMaintenanceLastTicket,
  withoutMaintenanceLastTicket,
  // Maintenance last error
  readMaintenanceLastError,
  withMaintenanceLastError,
  withoutMaintenanceLastError,
  // Maintenance atomic transitions
  recordMaintenanceTicketSuccess,
  recordMaintenanceContractRejection,
  clearMaintenanceLane,
};
