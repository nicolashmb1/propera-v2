/**
 * book_amenity_reservation — Jarvis Plan → Access Engine staff_override booking.
 * @see docs/JARVIS_SPINE.md
 */

const crypto = require("crypto");
const { createReservationForPortal } = require("../../dal/accessEngine");
const { appendEventLog } = require("../../dal/appendEventLog");
const { accessFriendlyReason } = require("../access/parseAmenityBookingTimes");
const { PROPOSAL_OPS } = require("./types");
const { buildProposalConfirmToken } = require("./proposalToken");

/**
 * @param {object} draft
 * @param {string} summary
 */
function proposalFromBookAmenityDraft(draft, summary) {
  const d = draft || {};
  return {
    version: "1",
    proposal_id: String(d.proposal_id || crypto.randomUUID()).trim(),
    op: PROPOSAL_OPS.BOOK_AMENITY_RESERVATION,
    state: "awaiting_confirm",
    summary_human: String(summary || "").trim(),
    target: {
      location_id: String(d.locationId || d.location_id || "").trim(),
      location_name: String(d.locationName || d.location_name || "").trim(),
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
      unit_label: String(d.unitLabel || d.unit_label || "").trim(),
      tenant_id: String(d.tenantId || d.tenant_id || "").trim(),
    },
    payload: {
      location_id: String(d.locationId || d.location_id || "").trim(),
      location_name: String(d.locationName || d.location_name || "").trim(),
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
      unit_label: String(d.unitLabel || d.unit_label || "").trim(),
      tenant_id: String(d.tenantId || d.tenant_id || "").trim(),
      tenant_name: String(d.tenantName || d.tenant_name || "").trim(),
      start_at: String(d.startAt || d.start_at || "").trim(),
      end_at: String(d.endAt || d.end_at || "").trim(),
      booking_label: String(d.bookingLabel || d.booking_label || "").trim(),
      notes: String(d.notes || "").trim(),
    },
    approval_tier_suggested: 2,
    confirm_token: "",
  };
}

/**
 * @param {object} draft
 * @param {string} summary
 */
function buildBookAmenityProposal(draft, summary) {
  const proposalId = crypto.randomUUID();
  const body = { ...draft, proposal_id: proposalId };
  const token = buildProposalConfirmToken(body, PROPOSAL_OPS.BOOK_AMENITY_RESERVATION);
  const proposal = proposalFromBookAmenityDraft(body, summary);
  proposal.confirm_token = token;
  return { proposal, confirmToken: token };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} _sb
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {{ traceId?: string, actorLabel?: string, staffId?: string }} ctx
 */
async function commitBookAmenityReservation(_sb, verified, ctx) {
  const p = verified.payload || {};
  const locationId = String(p.location_id || p.locationId || "").trim();
  const tenantId = String(p.tenant_id || p.tenantId || "").trim();
  const startAt = String(p.start_at || p.startAt || "").trim();
  const endAt = String(p.end_at || p.endAt || "").trim();
  const notes = String(p.notes || "").trim();
  const locationName = String(p.location_name || p.locationName || "").trim();
  const unitLabel = String(p.unit_label || p.unitLabel || "").trim();
  const bookingLabel = String(p.booking_label || p.bookingLabel || "").trim();

  if (!locationId || !tenantId || !startAt || !endAt) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Missing amenity booking details — try proposing again.",
    };
  }

  const actorLabel = String(ctx.actorLabel || "Staff").trim() || "Staff";

  try {
    const detail = await createReservationForPortal(
      {
        locationId,
        tenantId,
        startAt,
        endAt,
        channel: "staff_override",
        notes,
      },
      { actor: actorLabel, traceId: ctx.traceId }
    );

    await appendEventLog({
      traceId: String(ctx.traceId || "").trim(),
      log_kind: "brain",
      event: "JARVIS_BOOK_AMENITY",
      payload: {
        proposal_id: verified.proposal_id,
        reservation_id: detail?.id,
        location_id: locationId,
        tenant_id: tenantId,
      },
    });

    const when = bookingLabel || `${startAt} – ${endAt}`;
    const place = locationName || "amenity";
    const unitBit = unitLabel ? ` unit ${unitLabel}` : "";

    return {
      ok: true,
      brain: "jarvis_plan",
      replyText: `Booked ${place}${unitBit}: ${when}.`,
      resolution: {
        committed_op: PROPOSAL_OPS.BOOK_AMENITY_RESERVATION,
        proposal_id: verified.proposal_id,
        reservation_id: detail?.id,
        location_name: locationName,
        unit_label: unitLabel,
        booking_label: when,
        status: detail?.status,
      },
    };
  } catch (err) {
    const code = String(err?.code || err?.message || "booking_failed").trim();
    const msg = accessFriendlyReason(code);
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: `Booking not created: ${msg}`,
    };
  }
}

module.exports = {
  proposalFromBookAmenityDraft,
  buildBookAmenityProposal,
  commitBookAmenityReservation,
};
