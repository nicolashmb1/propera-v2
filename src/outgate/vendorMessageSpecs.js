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
    "Example: YES PENN-012626-0001 tomorrow 9-11am"
  );
}

module.exports = {
  buildVendorDispatchRequestText,
  buildVendorConfirmInstructionsText,
};
