/**
 * Human-readable Jarvis confirm receipts (voice + portal).
 */

const { PROPOSAL_OPS } = require("./types");

/**
 * @param {{ op: string, payload?: object }} verified
 * @param {{ replyText?: string, resolution?: object }} run
 * @returns {string}
 */
function formatJarvisConfirmReceipt(verified, run) {
  const op = String(verified?.op || "").trim();
  const p = verified?.payload || {};
  const humanId = String(
    run?.resolution?.human_ticket_id ||
      p.human_ticket_id ||
      p.humanTicketId ||
      p.ticketHumanId ||
      ""
  )
    .trim()
    .toUpperCase();
  const reply = String(run?.replyText || "").trim() || "Done.";

  if (op === PROPOSAL_OPS.APPEND_SERVICE_NOTE) {
    return humanId ? `Note added to ${humanId}.` : reply;
  }
  if (op === PROPOSAL_OPS.ATTACH_TICKET_COST) {
    return humanId ? `Cost posted to ${humanId}.` : reply;
  }
  if (op === PROPOSAL_OPS.PROPOSE_VENDOR_REQUEST) {
    return humanId ? `Vendor assigned on ${humanId}.` : reply;
  }
  if (op === PROPOSAL_OPS.CREATE_SERVICE_REQUEST) {
    return reply;
  }
  if (
    op === PROPOSAL_OPS.SCHEDULE_TICKET ||
    op === PROPOSAL_OPS.BOOK_AMENITY_RESERVATION ||
    op === PROPOSAL_OPS.SET_AMENITY_SCHEDULE ||
    op === PROPOSAL_OPS.CANCEL_AMENITY_RESERVATION ||
    op === PROPOSAL_OPS.UPDATE_AMENITY_POLICY ||
    op === PROPOSAL_OPS.SET_TICKET_STATUS ||
    op === PROPOSAL_OPS.SET_TICKET_CATEGORY ||
    op === PROPOSAL_OPS.UPDATE_TICKET_ISSUE ||
    op === PROPOSAL_OPS.CLOSE_TICKET ||
    op === PROPOSAL_OPS.CANCEL_TICKET ||
    op === PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN
  ) {
    return reply;
  }
  return humanId ? `${reply} (${humanId})` : reply;
}

/**
 * @param {{ op: string, payload?: object }} verified
 */
formatJarvisConfirmReceipt.multiTicketHint = function multiTicketHint(verified) {
  if (String(verified?.op || "") !== PROPOSAL_OPS.CREATE_SERVICE_REQUEST) return undefined;
  const p = verified.payload || {};
  return {
    property_code: String(p.property_code || p.propertyCode || "")
      .trim()
      .toUpperCase(),
    unit_label: String(p.unit_label || p.unitLabel || "").trim(),
    preferred_window: String(p.preferred_window || p.preferredWindow || "").trim(),
    hint:
      "If staff asked for more tickets for this unit, call propose_create_service_request for the next issue now — reuse property, unit, and schedule unless they say otherwise.",
  };
};

module.exports = { formatJarvisConfirmReceipt };
