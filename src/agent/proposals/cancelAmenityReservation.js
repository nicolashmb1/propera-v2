/**
 * cancel_amenity_reservation — Jarvis Plan → Access Engine cancelReservation.
 */

const crypto = require("crypto");
const { cancelReservation } = require("../../dal/accessEngine");
const { appendEventLog } = require("../../dal/appendEventLog");
const { formatUtcInPropertyZone } = require("../../access/accessLocalTime");
const { PROPOSAL_OPS } = require("./types");
const { buildProposalConfirmToken } = require("./proposalToken");

/**
 * @param {object} draft
 * @param {string} summary
 */
function proposalFromCancelAmenityDraft(draft, summary) {
  const d = draft || {};
  return {
    version: "1",
    proposal_id: String(d.proposal_id || crypto.randomUUID()).trim(),
    op: PROPOSAL_OPS.CANCEL_AMENITY_RESERVATION,
    state: "awaiting_confirm",
    summary_human: String(summary || "").trim(),
    target: {
      reservation_id: String(d.reservationId || d.reservation_id || "").trim(),
      location_name: String(d.locationName || d.location_name || "").trim(),
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
      unit_label: String(d.unitLabel || d.unit_label || "").trim(),
    },
    payload: {
      reservation_id: String(d.reservationId || d.reservation_id || "").trim(),
      location_name: String(d.locationName || d.location_name || "").trim(),
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
      unit_label: String(d.unitLabel || d.unit_label || "").trim(),
      tenant_name: String(d.tenantName || d.tenant_name || "").trim(),
      booking_label: String(d.bookingLabel || d.booking_label || "").trim(),
      status: String(d.status || "").trim(),
    },
    approval_tier_suggested: 2,
    confirm_token: "",
  };
}

/**
 * @param {object} draft
 * @param {string} summary
 */
function buildCancelAmenityProposal(draft, summary) {
  const proposalId = crypto.randomUUID();
  const body = {
    ...draft,
    proposal_id: proposalId,
    reservation_id: String(draft.reservationId || draft.reservation_id || "").trim(),
    location_name: String(draft.locationName || draft.location_name || "").trim(),
    property_code: String(draft.propertyCode || draft.property_code || "")
      .trim()
      .toUpperCase(),
    unit_label: String(draft.unitLabel || draft.unit_label || "").trim(),
    tenant_name: String(draft.tenantName || draft.tenant_name || "").trim(),
    booking_label: String(draft.bookingLabel || draft.booking_label || "").trim(),
    status: String(draft.status || "").trim(),
  };
  const token = buildProposalConfirmToken(body, PROPOSAL_OPS.CANCEL_AMENITY_RESERVATION);
  const proposal = proposalFromCancelAmenityDraft(body, summary);
  proposal.confirm_token = token;
  return { proposal, confirmToken: token };
}

function formatBookingLabel(reservation) {
  const start = formatUtcInPropertyZone(reservation.startAt);
  const end = formatUtcInPropertyZone(reservation.endAt);
  return `${start} – ${end}`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} _sb
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {{ traceId?: string, actorLabel?: string }} ctx
 */
async function commitCancelAmenityReservation(_sb, verified, ctx) {
  const p = verified.payload || {};
  const reservationId = String(p.reservation_id || p.reservationId || "").trim();
  const locationName = String(p.location_name || p.locationName || "").trim();
  const unitLabel = String(p.unit_label || p.unitLabel || "").trim();

  if (!reservationId) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Missing reservation — try proposing cancel again.",
    };
  }

  const actorLabel = String(ctx.actorLabel || "Staff").trim() || "Staff";

  try {
    const detail = await cancelReservation(reservationId, {
      actor: actorLabel,
      traceId: ctx.traceId,
    });

    await appendEventLog({
      traceId: String(ctx.traceId || "").trim(),
      log_kind: "brain",
      event: "JARVIS_CANCEL_AMENITY",
      payload: {
        proposal_id: verified.proposal_id,
        reservation_id: reservationId,
      },
    });

    const place = locationName || "amenity";
    const unitBit = unitLabel ? ` unit ${unitLabel}` : "";

    return {
      ok: true,
      brain: "jarvis_plan",
      replyText: `Cancelled ${place}${unitBit} booking.`,
      resolution: {
        committed_op: PROPOSAL_OPS.CANCEL_AMENITY_RESERVATION,
        proposal_id: verified.proposal_id,
        reservation_id: reservationId,
        status: detail?.status,
      },
    };
  } catch (err) {
    const code = String(err?.message || err || "cancel_failed").trim();
    const msg =
      code === "not_found"
        ? "Reservation not found."
        : code === "invalid_status"
          ? "That booking cannot be cancelled."
          : code.replace(/_/g, " ");
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: `Cancel failed: ${msg}`,
    };
  }
}

module.exports = {
  proposalFromCancelAmenityDraft,
  buildCancelAmenityProposal,
  commitCancelAmenityReservation,
  formatBookingLabel,
};
