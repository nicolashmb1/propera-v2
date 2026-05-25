/**
 * Expression prompts for find_related_ticket results (Phase 6).
 */

/**
 * @param {object} ticket
 * @returns {string}
 */
function buildStrongMatchClarifyPrompt(ticket) {
  const ref = String(ticket.ticket_id || "").trim();
  const parts = [];
  if (ref) {
    parts.push(`I found your open request (Ref #${ref})`);
  } else {
    parts.push("I found an open maintenance request for you");
  }
  if (ticket.assigned_name) {
    parts.push(`it's assigned to ${ticket.assigned_name}`);
  }
  if (ticket.preferred_window) {
    parts.push(`scheduled for ${ticket.preferred_window}`);
  }
  let lead = parts.join(" — ");
  if (lead.includes(" — it's")) {
    lead = lead.replace(" — it's", ". It's");
  } else if (parts.length > 1) {
    lead = parts.join(". ");
  }
  return (
    `${lead}. ` +
    "Is this what you're following up on, or a different issue?"
  );
}

/**
 * @param {object[]} tickets
 * @returns {string}
 */
function buildMultipleMatchPrompt(tickets) {
  const lines = (tickets || [])
    .slice(0, 5)
    .map((t, i) => {
      const ref = String(t.ticket_id || "").trim() || "unknown";
      const snippet = String(t.issueSnippet || t.category || "Maintenance").trim();
      return `${i + 1}. Ref #${ref} — ${snippet}`;
    });
  return (
    "I found a few open requests:\n" +
    lines.join("\n") +
    "\n\nReply with the Ref # you're following up on, or say it's a new issue."
  );
}

/**
 * @param {object} ticket
 * @returns {string}
 */
function buildWeakMatchClarifyPrompt(ticket) {
  const ref = String(ticket.ticket_id || "").trim();
  if (ref) {
    return (
      `You may have an open request (Ref #${ref}). ` +
      "Is this what you're following up on, or a different issue?"
    );
  }
  return "Is this about an existing maintenance request, or a different issue?";
}

module.exports = {
  buildStrongMatchClarifyPrompt,
  buildMultipleMatchPrompt,
  buildWeakMatchClarifyPrompt,
};
