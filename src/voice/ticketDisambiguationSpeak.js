/**
 * Voice-friendly ticket labels — issue and date first, not ticket ids.
 */

/**
 * @param {object} c
 * @returns {string}
 */
function ticketIssueLabel(c) {
  const issue = String(
    c.issue || c.summary || c.message_raw || c.messagePreview || c.issue_text || ""
  ).trim();
  const category = String(c.category || c.category_final || "").trim();
  if (issue) return issue.slice(0, 80);
  if (category && category.toLowerCase() !== "general") return category;
  return "";
}

/**
 * @param {object} c
 * @returns {string}
 */
function ticketAgeSpeak(c) {
  const days =
    c.ageDays != null
      ? Number(c.ageDays)
      : c.age_days != null
        ? Number(c.age_days)
        : NaN;
  if (days === 0) return "opened today";
  if (days === 1) return "from yesterday";
  if (Number.isFinite(days) && days > 1 && days <= 21) return `${Math.round(days)} days ago`;

  const raw = c.created_at || c.createdAt;
  if (raw) {
    const d = new Date(raw);
    if (Number.isFinite(d.getTime())) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
  }
  return "";
}

/**
 * Short phrase for one ticket in a list — e.g. "shower clogged, from yesterday"
 * @param {object} c
 * @param {{ includeAge?: boolean }} [opts]
 */
function formatTicketChoiceLabel(c, opts) {
  const issue = ticketIssueLabel(c);
  const age = opts?.includeAge !== false ? ticketAgeSpeak(c) : "";
  if (issue && age) return `${issue}, ${age}`;
  if (issue) return issue;
  const cat = String(c.category || "").trim();
  if (cat) return cat;
  const unit = String(c.unitLabel || c.unit_label || "").trim();
  if (unit) return `unit ${unit} open ticket`;
  return "open ticket";
}

/**
 * Natural voice phrase — "the one for shower clogged"
 * @param {object} c
 */
function formatTicketChoicePhrase(c) {
  const label = formatTicketChoiceLabel(c);
  if (label === "open ticket") return label;
  return `the one for ${label}`;
}

/**
 * @param {object[]} candidates
 * @param {{ includeAge?: boolean }} [opts]
 */
function formatDisambiguationSpeak(candidates, opts) {
  const list = (candidates || []).slice(0, 4);
  if (!list.length) return "Which ticket did you mean?";
  if (list.length === 1) {
    const phrase = formatTicketChoicePhrase(list[0]);
    return phrase === "open ticket"
      ? "I found one open ticket. Is that the one?"
      : `I found ${phrase}. Is that the one?`;
  }
  const bits = list.map((c) => formatTicketChoicePhrase(c));
  return `Which one — ${bits.join(", or ")}?`;
}

/**
 * @param {object} target
 */
function formatResolvedTicketSpeak(target) {
  const unit = String(target?.unitLabel || target?.unit_label || "").trim();
  const issue = ticketIssueLabel(target);
  const prop = String(target?.propertyCode || target?.property_code || "")
    .trim()
    .toUpperCase();
  if (unit && issue && prop) return `Got it — unit ${unit} at ${prop}, ${issue}.`;
  if (unit && issue) return `Got it — unit ${unit}, ${issue}.`;
  if (issue && prop) return `Got it — ${prop}, ${issue}.`;
  if (issue) return `Got it — ${issue}.`;
  if (unit && prop) return `Got it — unit ${unit} at ${prop}.`;
  if (unit) return `Got it — unit ${unit}.`;
  return "Got it.";
}

function formatProposeConfirmSpeak(action, target, detail) {
  const unit = String(target?.unitLabel || target?.unit_label || "").trim();
  const issue = ticketIssueLabel(target);
  const who =
    unit && issue ? `unit ${unit}, ${issue}` : unit ? `unit ${unit}` : issue || "";
  if (who && detail) return `${action} ${who}: ${detail}. Say yes?`;
  if (who) return `${action} ${who}. Say yes?`;
  if (detail) return `${action}: ${detail}. Say yes?`;
  return `${action}. Say yes?`;
}

/**
 * UI / chat candidate row — issue first, id in parentheses for reference.
 * @param {object} c
 * @param {number} i
 */
function formatCandidateLine(c, i) {
  const issue = ticketIssueLabel(c);
  const age = ticketAgeSpeak(c);
  const unit = c.unitLabel ? ` · unit ${c.unitLabel}` : "";
  const id = c.humanTicketId ? ` (${c.humanTicketId})` : "";
  const main = issue || String(c.category || "").trim() || "open ticket";
  const when = age ? ` · ${age}` : "";
  return `${i + 1}. ${main}${unit}${when}${id}`;
}

module.exports = {
  ticketIssueLabel,
  ticketAgeSpeak,
  formatTicketChoiceLabel,
  formatTicketChoicePhrase,
  formatDisambiguationSpeak,
  formatResolvedTicketSpeak,
  formatCandidateLine,
  formatProposeConfirmSpeak,
};
