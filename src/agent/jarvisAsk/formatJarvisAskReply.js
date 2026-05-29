/**
 * Deterministic Jarvis Ask replies — operator brief first, then detail.
 */

const { classifyJarvisIntent } = require("./classifyJarvisIntent");
const { formatAgeBrief } = require("./timeBrief");

/**
 * @param {string} cents
 */
function dollarsFromCents(cents) {
  const n = Number(cents);
  if (!isFinite(n)) return "0.00";
  return (n / 100).toFixed(2);
}

/**
 * @param {import("../operationalScope/types").OperationalScopeOpenTicket[]} opens
 */
function sortOpenTicketsForDisplay(opens) {
  return [...(opens || [])].sort((a, b) => {
    const au = /urgent|high/i.test(String(a.status || "") + String(a.summary || ""));
    const bu = /urgent|high/i.test(String(b.status || "") + String(b.summary || ""));
    if (au !== bu) return au ? -1 : 1;
    return String(a.humanTicketId || "").localeCompare(
      String(b.humanTicketId || "")
    );
  });
}

/**
 * @param {object} t — focusTicket
 */
function buildTicketVerdict(t) {
  if (!t) return "";
  const parts = [];
  if (t.unit) parts.push(`Unit ${t.unit}`);
  const status = t.status || "unknown status";
  const cat = t.category ? ` — ${t.category}` : "";
  parts.push(`${status}${cat}`);
  if (t.assignee) parts.push(`assigned ${t.assignee}`);
  if (t.updatedAt) parts.push(`updated ${formatAgeBrief(t.updatedAt)}`);
  return parts.join(" · ");
}

/**
 * @param {object} sit — propertySituation
 */
function buildPropertyVerdict(sit, openCount) {
  if (!sit) return "";
  const code = sit.propertyCode || "?";
  const name = sit.name ? ` (${sit.name})` : "";
  const open = sit.openTicketCount ?? openCount ?? 0;
  const urg = sit.urgentTicketCount || 0;
  let line = `${code}${name}: ${open} open`;
  if (urg > 0) line += ` (${urg} urgent)`;
  if (sit.unitCount) {
    line += ` · ${sit.unitCount} units`;
    if (sit.occupiedCount != null) line += `, ${sit.occupiedCount} occupied`;
  }
  return line;
}

/**
 * @param {object} facts — from gatherJarvisFacts
 * @param {string} question
 */
function formatJarvisAskReply(facts, question) {
  const q = String(question || "").trim();
  const ql = q.toLowerCase();
  if (!q) {
    return (
      "Ask about this property or a unit. Examples:\n" +
      "• What's the situation at this property?\n" +
      "• What is going on with unit 423?\n" +
      "• How much maintenance spend this month?\n" +
      "• What tickets are open?"
    );
  }

  const intents =
    facts.intents && facts.intents.length
      ? new Set(facts.intents)
      : classifyJarvisIntent(q);

  const lines = [];
  const resolution = facts.questionResolution || null;

  if (resolution && resolution.reason === "QUESTION_UNIT_AMBIGUOUS") {
    lines.push(
      `Unit ${resolution.unitLabel} has ${(resolution.candidates || []).length} open tickets — pick one:`
    );
    for (const row of resolution.candidates || []) {
      const id = row.humanTicketId || row.ticketRowId || "?";
      const sum = row.summary ? ` — ${row.summary}` : "";
      lines.push(`• ${id}${sum}`.slice(0, 160));
    }
    return lines.join("\n").trim();
  }

  if (resolution && resolution.reason === "QUESTION_UNIT_NO_OPEN_TICKET") {
    const sit = facts.propertySituation;
    const brief = sit ? buildPropertyVerdict(sit, (facts.openTicketsAtProperty || []).length) : "";
    lines.push(
      `No open ticket for unit ${resolution.unitLabel} at this property.`
    );
    if (brief) lines.push(brief);
    return lines.join("\n").trim();
  }

  const t = facts.focusTicket;
  const sit = facts.propertySituation || facts.propertyMaintenanceSpend;
  const opens = facts.openTicketsAtProperty || [];
  const resolvedFromQuestion = facts.resolvedFromQuestion === true;

  const wantsTicket =
    intents.has("TICKET_DETAIL") || resolvedFromQuestion || !!t;
  const wantsSituation = intents.has("PROPERTY_SITUATION");
  const wantsSpend = intents.has("PROPERTY_SPEND");
  const wantsOpenList = intents.has("OPEN_LIST");
  const wantsTicketCost = intents.has("TICKET_COST");

  if (t && wantsTicket) {
    const verdict = buildTicketVerdict(t);
    if (verdict) lines.push(verdict);
    lines.push("");
    lines.push(t.humanTicketId || t.ticketRowId || "Ticket");
    if (t.tenantName) lines.push(`Tenant: ${t.tenantName}`);
    if (t.messagePreview) lines.push(`Reported: ${t.messagePreview}`);
    if (t.serviceNotes && /note|vendor|update|status/.test(ql)) {
      lines.push(`Service notes: ${t.serviceNotes}`);
    }
    if (t.preferredWindow && /schedule|window|when/.test(ql)) {
      lines.push(`Preferred window: ${t.preferredWindow}`);
    }
    const timeline = t.timeline || [];
    if (timeline.length) {
      lines.push("");
      lines.push("Recent activity:");
      for (const ev of timeline) {
        const who = ev.by && ev.by !== "System" ? ` (${ev.by})` : "";
        const age = ev.age ? `${ev.age} — ` : "";
        lines.push(`• ${age}${ev.action}${who}`.slice(0, 200));
      }
    } else if (t.updatedAt) {
      lines.push(`Last update: ${formatAgeBrief(t.updatedAt)}`);
    }
  } else if (wantsSituation && sit) {
    lines.push(buildPropertyVerdict(sit, opens.length));
  } else if (!t && sit && propertyCodeFromFacts(facts)) {
    lines.push(buildPropertyVerdict(sit, opens.length));
  }

  if (wantsSpend && sit) {
    lines.push("");
    lines.push(`Maintenance spend — ${sit.propertyCode} (${sit.monthLabel}):`);
    lines.push(
      `• This month: $${dollarsFromCents(sit.companyCentsMonth)} company (${sit.entryCountMonth} line(s))`
    );
    if (sit.tenantCentsMonth > 0) {
      lines.push(
        `• Tenant charges: $${dollarsFromCents(sit.tenantCentsMonth)}`
      );
    }
    lines.push(
      `• YTD: $${dollarsFromCents(sit.companyCentsYtd)} company` +
        (sit.entryCountYtd ? ` — ${sit.entryCountYtd} line(s)` : "")
    );
  }

  const costs = facts.costSummary;
  if (wantsTicketCost && t) {
    lines.push("");
    if (costs && costs.entryCount > 0) {
      lines.push(
        `Ticket costs: ${costs.entryCount} line(s) — $${dollarsFromCents(costs.companyCents)} company` +
          (costs.tenantCents > 0
            ? `, $${dollarsFromCents(costs.tenantCents)} tenant`
            : "")
      );
    } else {
      lines.push("No cost lines on this ticket yet.");
    }
  }

  const showOpenList =
    wantsOpenList ||
    (wantsSituation && !resolvedFromQuestion && !t) ||
    (wantsSituation && opens.length && !t);

  if (showOpenList && opens.length && !(t && resolvedFromQuestion)) {
    const sorted = sortOpenTicketsForDisplay(opens);
    lines.push("");
    lines.push(`Open tickets (${sorted.length}):`);
    for (const row of sorted.slice(0, 12)) {
      const id = row.humanTicketId || row.ticketRowId || "?";
      const unit = row.unitLabel ? ` unit ${row.unitLabel}` : "";
      const st = row.status ? ` — ${row.status}` : "";
      const sum = row.summary ? ` — ${row.summary}` : "";
      lines.push(`• ${id}${unit}${st}${sum}`.slice(0, 180));
    }
    if (sorted.length > 12) {
      lines.push(`…and ${sorted.length - 12} more.`);
    }
  } else if (wantsOpenList && !opens.length && sit) {
    lines.push("");
    lines.push("No open tickets at this property right now.");
  }

  const work = facts.activeWork || [];
  if (work.length && (/my |work item|assigned to me/.test(ql) || wantsOpenList)) {
    lines.push("");
    lines.push(`Your open work items (${work.length}):`);
    for (const w of work.slice(0, 8)) {
      const tid = w.ticketHumanId ? ` (${w.ticketHumanId})` : "";
      lines.push(
        `• ${w.workItemId} — ${w.propertyId || "?"}/${w.unitId || "?"}${tid}`
      );
    }
  }

  if (lines.length === 0) {
    const story = String(facts.scopeStory || "").trim();
    if (story) return story + "\n\nTry: “what's the situation?” or “unit 423”.";
    return "Open a property page, then ask about the situation, a unit, or maintenance spend.";
  }

  return lines.join("\n").trim();
}

function propertyCodeFromFacts(facts) {
  return String(
    facts.anchor?.propertyCode ||
      facts.propertySituation?.propertyCode ||
      ""
  ).trim();
}

module.exports = { formatJarvisAskReply, dollarsFromCents };
