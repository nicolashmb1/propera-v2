/**
 * Format service history analytics for Ask / voice.
 */

/**
 * @param {object} unitAnalysis
 * @param {number} ticketCount
 */
function formatUnitBreakdownLines(unitAnalysis, ticketCount) {
  const breakdown = unitAnalysis?.unitBreakdown || [];
  if (!breakdown.length) return [];
  const lines = ["", "By unit:"];
  for (const u of breakdown.slice(0, 15)) {
    const label =
      u.unitLabel === "(no unit)"
        ? u.propertyCode
        : `${u.propertyCode} unit ${u.unitLabel}`;
    lines.push(`• ${label}: ${u.count} ticket${u.count === 1 ? "" : "s"}`);
  }
  if (breakdown.length > 15) {
    lines.push(`…and ${breakdown.length - 15} more units.`);
  }
  if (ticketCount > 0 && unitAnalysis.distinctUnitCount > 0) {
    const avg = (ticketCount / unitAnalysis.distinctUnitCount).toFixed(1);
    lines.push(`Average ${avg} ticket(s) per unit.`);
  }
  return lines;
}

/**
 * @param {object} result — from queryServiceHistory
 */
function formatServiceHistoryReply(result) {
  if (!result || !result.ok) {
    return String(result?.message || "Could not run service history query.").trim();
  }

  const count = Number(result.count) || 0;
  const days = Number(result.daysBack) || 30;
  const label = String(result.issueLabel || "matching").trim();
  const prop = String(result.propertyCode || "").trim();
  const scope = prop ? ` at ${prop}` : " across the portfolio";
  const mode = String(result.analysisMode || "summary").trim();
  const ua = result.unitAnalysis || {};

  const lines = [];

  if (mode === "distinct_units") {
    const n = Number(ua.distinctUnitCount) || 0;
    if (count === 0) {
      lines.push(`No ${label} tickets in the last ${days} days${scope}.`);
    } else {
      lines.push(
        `${count} ${label} ticket${count === 1 ? "" : "s"} in the last ${days} days${scope} ` +
          `span ${n} different unit${n === 1 ? "" : "s"}.`
      );
      if (n > 0 && n < count) {
        lines.push(
          `${count - n} ticket${count - n === 1 ? " is" : "s are"} repeat visits at the same unit(s).`
        );
      }
    }
    lines.push(...formatUnitBreakdownLines(ua, count));
    return lines.join("\n").trim();
  }

  if (mode === "repeat_units") {
    const repeats = ua.repeatUnits || [];
    const repeatCount = Number(ua.repeatUnitCount) || 0;
    if (count === 0) {
      lines.push(`No ${label} tickets in the last ${days} days${scope}.`);
    } else if (repeatCount === 0) {
      lines.push(
        `None — ${count} ${label} ticket${count === 1 ? "" : "s"} in the last ${days} days${scope}, ` +
          `each at a different unit (no repeats).`
      );
    } else {
      lines.push(
        `${repeatCount} unit${repeatCount === 1 ? "" : "s"} had repeat ${label} issues ` +
          `(2+ tickets) in the last ${days} days${scope}:`
      );
      lines.push("");
      for (const u of repeats.slice(0, 12)) {
        const unitLabel =
          u.unitLabel === "(no unit)" ? "" : ` unit ${u.unitLabel}`;
        lines.push(`• ${u.propertyCode}${unitLabel}: ${u.count} tickets`);
      }
      if (repeats.length > 12) {
        lines.push(`…and ${repeats.length - 12} more units with repeats.`);
      }
    }
    return lines.join("\n").trim();
  }

  if (mode === "unit_breakdown") {
    lines.push(
      `${count} ${label} ticket${count === 1 ? "" : "s"} in the last ${days} days${scope} ` +
        `across ${Number(ua.distinctUnitCount) || 0} unit(s).`
    );
    lines.push(...formatUnitBreakdownLines(ua, count));
    const repeatCount = Number(ua.repeatUnitCount) || 0;
    if (repeatCount > 0) {
      lines.push("");
      lines.push(`${repeatCount} unit${repeatCount === 1 ? "" : "s"} with 2+ tickets.`);
    }
    return lines.join("\n").trim();
  }

  // summary (default)
  lines.push(
    `${count} ${label} issue${count === 1 ? "" : "s"} in the last ${days} days${scope}.`
  );

  if (count > 0 && ua.distinctUnitCount != null) {
    lines.push(
      `${ua.distinctUnitCount} different unit${ua.distinctUnitCount === 1 ? "" : "s"}` +
        (ua.repeatUnitCount > 0
          ? `; ${ua.repeatUnitCount} with repeat issues.`
          : ".")
    );
  }

  const tickets = result.tickets || [];
  if (tickets.length) {
    lines.push("");
    lines.push(count <= tickets.length ? "Tickets:" : "Recent examples:");
    for (const t of tickets.slice(0, 12)) {
      const id = t.humanTicketId || t.ticketRowId || "?";
      const p = t.propertyCode ? ` ${t.propertyCode}` : "";
      const unit = t.unitLabel ? ` unit ${t.unitLabel}` : "";
      const cat = t.category ? ` — ${t.category}` : "";
      lines.push(`• ${id}${p}${unit}${cat}`.slice(0, 180));
    }
    if (count > tickets.length) {
      lines.push(`…and ${count - tickets.length} more.`);
    }
  } else if (count === 0) {
    lines.push("");
    lines.push("No matching tickets in that window.");
  }

  return lines.join("\n").trim();
}

/**
 * @param {object} result
 */
function formatServiceHistorySpeak(result) {
  if (!result || !result.ok) {
    return "I couldn't look that up right now.";
  }
  const count = Number(result.count) || 0;
  const days = Number(result.daysBack) || 30;
  const label = String(result.issueLabel || "matching").trim();
  const prop = String(result.propertyCode || "").trim();
  const scope = prop ? ` at ${prop}` : "";
  const mode = String(result.analysisMode || "summary").trim();
  const ua = result.unitAnalysis || {};

  if (mode === "distinct_units") {
    if (count === 0) {
      return `No ${label} tickets in the last ${days} days${scope}.`;
    }
    const n = Number(ua.distinctUnitCount) || 0;
    return `${count} ${label} tickets span ${n} different unit${n === 1 ? "" : "s"} in the last ${days} days${scope}.`;
  }

  if (mode === "repeat_units") {
    const repeatCount = Number(ua.repeatUnitCount) || 0;
    if (count === 0) {
      return `No ${label} tickets in the last ${days} days${scope}.`;
    }
    if (repeatCount === 0) {
      return `No repeat units — ${count} tickets, each at a different unit.`;
    }
    const top = (ua.repeatUnits || [])[0];
    const topBit = top
      ? ` Top repeat: ${top.propertyCode}${top.unitLabel !== "(no unit)" ? ` unit ${top.unitLabel}` : ""} with ${top.count}.`
      : "";
    return `${repeatCount} unit${repeatCount === 1 ? "" : "s"} had repeat ${label} issues.${topBit}`;
  }

  if (mode === "unit_breakdown") {
    const n = Number(ua.distinctUnitCount) || 0;
    return `${count} ${label} tickets across ${n} units in the last ${days} days${scope}. See chat for breakdown.`;
  }

  if (count === 0) {
    return `No ${label} issues in the last ${days} days${scope}.`;
  }
  const unitBit =
    ua.distinctUnitCount != null
      ? ` Across ${ua.distinctUnitCount} unit${ua.distinctUnitCount === 1 ? "" : "s"}.`
      : "";
  const examples = (result.tickets || [])
    .slice(0, 3)
    .map((t) => {
      const bits = [t.propertyCode, t.unitLabel ? `unit ${t.unitLabel}` : ""].filter(Boolean);
      return bits.join(" ");
    })
    .filter(Boolean);
  const ex = examples.length ? ` Examples: ${examples.join(", ")}.` : "";
  return `${count} ${label} ticket${count === 1 ? "" : "s"} in the last ${days} days${scope}.${unitBit}${ex}`;
}

module.exports = { formatServiceHistoryReply, formatServiceHistorySpeak };
