/**
 * Decode proposal commit payload → portal / co-pilot display fields.
 * Shared by pending-proposal API and live voice bridge.
 */

/**
 * @param {string} op
 * @param {object} [payload] — verified confirm token body or proposal.payload
 * @returns {{
 *   amountCents?: number,
 *   entryType?: string,
 *   vendorName?: string,
 *   noteText?: string,
 *   dispatch?: boolean,
 *   humanTicketId?: string,
 *   unitLabel?: string,
 *   propertyCode?: string,
 * }}
 */
function extractProposalPortalFields(op, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const normalizedOp = String(op || p.op || "").trim();
  const out = {};

  const humanTicketId = String(
    p.humanTicketId ||
      p.human_ticket_id ||
      p.ticketHumanId ||
      p.ticket_human_id ||
      ""
  ).trim();
  if (humanTicketId) out.humanTicketId = humanTicketId;

  const unitLabel = String(p.unitLabel || p.unit_label || "").trim();
  if (unitLabel) out.unitLabel = unitLabel;

  const propertyCode = String(p.propertyCode || p.property_code || "")
    .trim()
    .toUpperCase();
  if (propertyCode) out.propertyCode = propertyCode;

  if (normalizedOp === "attach_ticket_cost") {
    const cents = Math.max(0, Number(p.vendorAmt || p.vendor_amt_cents) || 0);
    if (cents > 0) out.amountCents = cents;
    const entryType = String(p.entryType || p.entry_type || "").trim();
    if (entryType) out.entryType = entryType;
    const vendorName = String(p.vendorName || p.vendor_name || "").trim();
    if (vendorName) out.vendorName = vendorName;
  } else if (normalizedOp === "append_service_note") {
    const noteText = String(p.noteText || p.note_text || "").trim();
    if (noteText) out.noteText = noteText;
  } else if (normalizedOp === "propose_vendor_request") {
    const vendorName = String(
      p.vendorDisplayName || p.vendor_display_name || p.vendorName || p.vendor_name || ""
    ).trim();
    if (vendorName) out.vendorName = vendorName;
    out.dispatch = p.dispatch !== false;
  } else if (normalizedOp === "create_service_request") {
    const issueText = String(p.issue_text || p.issueText || p.message || "").trim();
    if (issueText) out.issue = issueText;
    const category = String(p.category || "").trim();
    if (category) out.category = category;
    const urgency = String(p.urgency || "").trim();
    if (urgency) out.urgency = urgency;
    const preferredWindow = String(p.preferred_window || p.preferredWindow || "").trim();
    if (preferredWindow) out.preferredWindow = preferredWindow;
  } else if (normalizedOp === "schedule_ticket") {
    const preferredWindow = String(p.preferred_window || p.preferredWindow || "").trim();
    if (preferredWindow) out.preferredWindow = preferredWindow;
    out.statusTo = "Scheduled";
  } else if (normalizedOp === "book_amenity_reservation") {
    const amenityName = String(p.location_name || p.locationName || "").trim();
    if (amenityName) out.amenityName = amenityName;
    const bookingLabel = String(p.booking_label || p.bookingLabel || "").trim();
    if (bookingLabel) out.bookingLabel = bookingLabel;
    const tenantName = String(p.tenant_name || p.tenantName || "").trim();
    if (tenantName) out.tenantName = tenantName;
  } else if (normalizedOp === "set_amenity_schedule") {
    const amenityName = String(p.location_name || p.locationName || "").trim();
    if (amenityName) out.amenityName = amenityName;
    const scheduleSummary = String(p.schedule_summary || p.scheduleSummary || "").trim();
    if (scheduleSummary) out.scheduleSummary = scheduleSummary;
  } else if (normalizedOp === "cancel_amenity_reservation") {
    const amenityName = String(p.location_name || p.locationName || "").trim();
    if (amenityName) out.amenityName = amenityName;
    const bookingLabel = String(p.booking_label || p.bookingLabel || "").trim();
    if (bookingLabel) out.bookingLabel = bookingLabel;
  } else if (normalizedOp === "set_ticket_status") {
    const statusTo = String(p.status_to || p.statusTo || "").trim();
    if (statusTo) out.statusTo = statusTo;
  } else if (normalizedOp === "set_ticket_category") {
    const category = String(p.category || "").trim();
    if (category) out.category = category;
  } else if (normalizedOp === "update_ticket_issue") {
    const issueText = String(p.issue_text || p.issueText || "").trim();
    if (issueText) out.issue = issueText;
  } else if (normalizedOp === "close_ticket") {
    out.statusTo = "Completed";
  } else if (normalizedOp === "cancel_ticket") {
    out.statusTo = "Deleted";
  } else if (normalizedOp === "send_communication_campaign") {
    const audienceLabel = String(p.audience_label || p.audienceLabel || "").trim();
    if (audienceLabel) out.audienceLabel = audienceLabel;
    const willSend = Number(p.will_send ?? p.willSend);
    if (Number.isFinite(willSend) && willSend >= 0) out.willSend = willSend;
    const skippedNoPhone = Number(p.skipped_no_phone ?? p.skippedNoPhone);
    if (Number.isFinite(skippedNoPhone) && skippedNoPhone > 0) out.skippedNoPhone = skippedNoPhone;
    const skippedOptOut = Number(p.skipped_opt_out ?? p.skippedOptOut);
    if (Number.isFinite(skippedOptOut) && skippedOptOut > 0) out.skippedOptOut = skippedOptOut;
    const messageBody = String(p.message_body || p.messageBody || "").trim();
    if (messageBody) out.messageBody = messageBody;
    const finalPreview = String(p.final_message_preview || p.finalMessagePreview || "").trim();
    if (finalPreview) out.finalMessagePreview = finalPreview;
    const smsSegments = Number(p.sms_segments ?? p.smsSegments);
    if (Number.isFinite(smsSegments) && smsSegments > 0) out.smsSegments = smsSegments;
    const campaignId = String(p.campaign_id || p.campaignId || "").trim();
    if (campaignId) out.campaignId = campaignId;
    const commType = String(p.comm_type || p.commType || "").trim();
    if (commType) out.commType = commType;
  } else if (normalizedOp === "update_amenity_policy") {
    const amenityName = String(p.location_name || p.locationName || "").trim();
    if (amenityName) out.amenityName = amenityName;
    const policySummary = String(p.policy_summary || p.policySummary || "").trim();
    if (policySummary) out.policySummary = policySummary;
    const patch = p.policy_patch || p.policyPatch || {};
    const maxMin = Number(
      patch.maxDurationMin ?? patch.max_duration_min ?? p.max_duration_min ?? p.maxDurationMin
    );
    if (Number.isFinite(maxMin) && maxMin > 0) out.maxDurationMin = maxMin;
  }

  return out;
}

module.exports = { extractProposalPortalFields };
