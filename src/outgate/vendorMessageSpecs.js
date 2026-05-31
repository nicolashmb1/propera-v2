/**
 * Vendor dispatch / reply message bodies (deterministic v1 — no DB template required).
 * @see docs/VENDOR_LANE.md — keys align with future message_templates rows.
 */

function cleanGsm7(s) {
  return String(s || "")
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\t/g, " ")
    .trim();
}

/**
 * @param {{ propertyName?: string, unit?: string, category?: string, issue?: string, ticketId?: string }} ctx
 */
function buildVendorDispatchRequestText(ctx) {
  const propertyName = cleanGsm7(ctx.propertyName || "Property");
  const unit = cleanGsm7(ctx.unit || "—");
  const category = cleanGsm7(ctx.category || "Maintenance");
  const issue = cleanGsm7(ctx.issue || "See ticket");
  const ticketId = cleanGsm7(ctx.ticketId || "");
  const tidLine = ticketId ? `\nTicket: ${ticketId}` : "";
  return (
    `Propera — service request\n` +
    `${propertyName} · Unit ${unit}\n` +
    `${category}: ${issue}${tidLine}\n` +
    `Reply YES with your availability or NO to decline.`
  );
}

function buildVendorConfirmInstructionsText() {
  return (
    "Propera vendor line: reply YES or NO, optional ticket id, then availability. " +
    "Example: YES PROP-012626-0001 tomorrow 9-11am"
  );
}

function buildVendorNeedTicketIdText() {
  return "Reply YES or NO with the ticket id (e.g. YES PROP-012626-0001 Mon 9-11am).";
}

/**
 * @param {string} ticketId
 */
function buildVendorTicketNotFoundText(ticketId) {
  const tid = cleanGsm7(ticketId || "");
  return tid ? `Ticket ${tid} not found.` : "Ticket not found.";
}

/**
 * @param {string} ticketId
 * @param {string} [reason]
 */
function buildVendorDeclineRecordedText(ticketId, reason) {
  const tid = cleanGsm7(ticketId || "");
  const r = cleanGsm7(reason || "");
  return r
    ? `Recorded decline for ${tid}. Reason: ${r}`
    : `Recorded decline for ${tid}.`;
}

/**
 * @param {string} ticketId
 */
function buildVendorAcceptNeedWindowText(ticketId) {
  const tid = cleanGsm7(ticketId || "");
  return `Accepted ${tid}. Reply with your availability window (e.g. tomorrow 9-11am).`;
}

/**
 * @param {string} ticketId
 * @param {string} appt
 */
function buildVendorAcceptScheduledText(ticketId, appt) {
  const tid = cleanGsm7(ticketId || "");
  const a = cleanGsm7(appt || "");
  return `Scheduled ${tid}${a ? `: ${a}` : ""}.`;
}

/**
 * @param {string} ticketId
 */
function buildVendorWrongTicketText(ticketId) {
  const tid = cleanGsm7(ticketId || "");
  return `You are not assigned to ${tid}. Contact the property team if this is wrong.`;
}

/**
 * @param {string} availability
 * @param {string[]} ticketIds
 */
function buildVendorMultiPendingNeedTidText(availability, ticketIds) {
  const a = cleanGsm7(availability || "");
  const list = (ticketIds || [])
    .map((id) => cleanGsm7(id))
    .filter(Boolean)
    .slice(0, 5)
    .map((id) => `- ${id}`)
    .join("\n");
  return (
    `You have multiple open jobs. Reply YES with ticket id and your window.\n` +
    `Availability noted: ${a}\n` +
    (list ? `Open tickets:\n${list}` : "")
  );
}

module.exports = {
  buildVendorDispatchRequestText,
  buildVendorConfirmInstructionsText,
  buildVendorNeedTicketIdText,
  buildVendorTicketNotFoundText,
  buildVendorDeclineRecordedText,
  buildVendorAcceptNeedWindowText,
  buildVendorAcceptScheduledText,
  buildVendorWrongTicketText,
  buildVendorMultiPendingNeedTidText,
};
