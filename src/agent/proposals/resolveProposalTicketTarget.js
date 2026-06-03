/**
 * Shared ticket target resolution for Jarvis proposals (voice, plan, chat).
 * Surfaces candidates — brain commits after confirm.
 * @see docs/JARVIS_SPINE.md § Operation contract
 */

const { getSupabase } = require("../../db/supabase");
const { resolveTicketTargetFromQuestion } = require("../jarvisAsk/resolveQuestionTargets");
const { loadOpenTicketTargetForUnit } = require("../jarvisAsk/loadTicketByUnit");
const { tokenizeForMatch, scoreTicketAgainstHints } = require("../../dal/findRelatedTenantTickets");

/**
 * @param {object} row
 */
function openTicketRowToTarget(row) {
  return {
    ticketRowId: String(row.ticketRowId || row.ticket_row_id || "").trim(),
    humanTicketId: String(row.humanTicketId || row.ticket_id || "").trim(),
    unitLabel: String(row.unitLabel || row.unit_label || "").trim(),
    propertyCode: String(row.propertyCode || row.property_code || "")
      .trim()
      .toUpperCase(),
    category: String(row.category || row.category_final || "").trim(),
    summary: String(row.summary || row.message_raw || "").trim().slice(0, 120),
  };
}

/**
 * @param {object[]} rows
 * @param {string} [issueHint]
 */
function rankOpenTicketsByIssueHint(rows, issueHint) {
  const hint = String(issueHint || "").trim();
  if (!hint || !rows.length) return rows;
  const hints = { issueText: hint };
  return [...rows]
    .map((row) => {
      const score = scoreTicketAgainstHints(
        {
          message_raw: row.summary || row.message_raw || "",
          service_notes: "",
          category: row.category || "",
          unit_label: row.unitLabel || row.unit_label || "",
          property_code: row.propertyCode || row.property_code || "",
        },
        hints
      );
      return { row, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.row);
}

/**
 * Resolve an open ticket target for a staff proposal.
 *
 * @param {object} opts
 * @param {import("../operationalScope/types").OperationalScope | null} [opts.scope]
 * @param {object | null} [opts.pageContext]
 * @param {string} [opts.humanTicketId]
 * @param {string} [opts.unitLabel]
 * @param {string} [opts.propertyCode]
 * @param {string} [opts.issueHint] — e.g. "dishwasher", "microwave"
 * @returns {Promise<
 *   | { ok: true, target: object, reason: string }
 *   | { ok: false, error: string, message: string, candidates?: object[] }
 * >}
 */
async function resolveProposalTicketTarget(opts) {
  const o = opts || {};
  const humanId = String(o.humanTicketId || "")
    .trim()
    .toUpperCase();
  const unitHint = String(o.unitLabel || o.unit || "").trim();
  const propertyCode = String(
    o.propertyCode ||
      o.pageContext?.propertyCode ||
      o.pageContext?.property_code ||
      o.scope?.anchor?.propertyCode ||
      ""
  )
    .trim()
    .toUpperCase();
  const issueHint = String(o.issueHint || "").trim();
  const scope = o.scope || null;

  if (humanId) {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb
        .from("portal_tickets_v1")
        .select(
          "ticket_row_id, ticket_id, unit_label, property_code, status, category_final, category, message_raw"
        )
        .eq("ticket_id", humanId)
        .maybeSingle();
      if (data) {
        return {
          ok: true,
          target: openTicketRowToTarget({
            ticket_row_id: data.ticket_row_id,
            ticket_id: data.ticket_id,
            unit_label: data.unit_label,
            property_code: data.property_code,
            category: data.category_final || data.category,
            message_raw: data.message_raw,
          }),
          reason: "HUMAN_TICKET_ID",
        };
      }
    }
    return {
      ok: true,
      target: {
        ticketRowId: "",
        humanTicketId: humanId,
        unitLabel: unitHint,
        propertyCode,
        category: "",
        summary: "",
      },
      reason: "HUMAN_TICKET_ID_UNVERIFIED",
    };
  }

  const questionBits = [
    unitHint ? `unit ${unitHint}` : "",
    issueHint,
    propertyCode,
  ]
    .filter(Boolean)
    .join(" ");
  const scopeForResolve = scope || {
    anchor: { propertyCode, unit: unitHint },
    propertyOpenTickets: [],
  };

  if (questionBits) {
    const fromQuestion = resolveTicketTargetFromQuestion(scopeForResolve, questionBits);
    if (fromQuestion?.reason === "QUESTION_UNIT_AMBIGUOUS") {
      return {
        ok: false,
        error: "ambiguous_unit",
        message: `Multiple open tickets for unit ${unitHint}. Say the ticket id or be more specific.`,
        candidates: (fromQuestion.candidates || []).map(openTicketRowToTarget),
      };
    }
    if (fromQuestion?.humanTicketId || fromQuestion?.ticketRowId) {
      return {
        ok: true,
        target: openTicketRowToTarget(fromQuestion),
        reason: fromQuestion.reason || "QUESTION_RESOLVED",
      };
    }
    if (fromQuestion?.reason === "QUESTION_UNIT_NO_OPEN_TICKET" && propertyCode && unitHint) {
      const dbTarget = await loadOpenTicketTargetForUnit(propertyCode, unitHint);
      if (dbTarget) {
        return {
          ok: true,
          target: openTicketRowToTarget(dbTarget),
          reason: dbTarget.reason,
        };
      }
    }
  }

  let opens = (scope?.propertyOpenTickets || []).map(openTicketRowToTarget);
  if (unitHint) {
    const want = unitHint.toLowerCase().replace(/\s/g, "");
    opens = opens.filter(
      (t) => String(t.unitLabel || "").toLowerCase().replace(/\s/g, "") === want
    );
  }
  if (issueHint && opens.length > 1) {
    opens = rankOpenTicketsByIssueHint(opens, issueHint);
  }

  if (opens.length === 1) {
    return { ok: true, target: opens[0], reason: "SCOPE_SINGLE_OPEN" };
  }
  if (opens.length > 1) {
    return {
      ok: false,
      error: "ambiguous_open",
      message: "Multiple open tickets match — say the ticket id or narrow the issue (e.g. dishwasher).",
      candidates: opens.slice(0, 6),
    };
  }

  if (propertyCode && unitHint) {
    const dbTarget = await loadOpenTicketTargetForUnit(propertyCode, unitHint);
    if (dbTarget) {
      return {
        ok: true,
        target: openTicketRowToTarget(dbTarget),
        reason: dbTarget.reason,
      };
    }
  }

  return {
    ok: false,
    error: "no_open_ticket",
    message: "No open ticket found — give property, unit, or ticket id.",
    candidates: [],
  };
}

module.exports = {
  resolveProposalTicketTarget,
  openTicketRowToTarget,
  rankOpenTicketsByIssueHint,
};
