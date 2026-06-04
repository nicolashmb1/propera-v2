/**
 * Shared ticket target resolution for Jarvis proposals (voice, plan, chat).
 * Surfaces candidates — brain commits after confirm.
 * @see docs/JARVIS_SPINE.md § Operation contract
 */

const { getSupabase } = require("../../db/supabase");
const { resolveTicketTargetFromQuestion } = require("../jarvisAsk/resolveQuestionTargets");
const { loadOpenTicketTargetForUnit, loadOpenTicketTargetsForUnit } = require("../jarvisAsk/loadTicketByUnit");
const { scoreTicketAgainstHints } = require("../../dal/findRelatedTenantTickets");

const STRONG_ISSUE_SCORE = 4;
const STRONG_ISSUE_GAP = 3;

/**
 * When multiple open tickets share a unit, auto-pick if issue hint clearly matches one.
 * @param {object[]} rows
 * @param {string} issueHint
 */
function tryAutoPickByIssueHint(rows, issueHint) {
  const hint = String(issueHint || "").trim();
  if (!hint || !Array.isArray(rows) || rows.length <= 1) return null;

  const scored = rows
    .map((row) => ({
      row,
      score: scoreTicketAgainstHints(
        {
          message_raw: row.summary || row.message_raw || row.issue || "",
          service_notes: "",
          category: row.category || "",
          unit_label: row.unitLabel || row.unit_label || "",
          property_code: row.propertyCode || row.property_code || "",
        },
        { issueText: hint }
      ),
    }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];
  if (!top || top.score < STRONG_ISSUE_SCORE) return null;
  if (second && top.score - second.score < STRONG_ISSUE_GAP) return null;
  return top.row;
}

/**
 * @param {object} row
 */
function openTicketRowToTarget(row) {
  const summary = String(row.summary || row.message_raw || "").trim();
  return {
    ticketRowId: String(row.ticketRowId || row.ticket_row_id || "").trim(),
    humanTicketId: String(row.humanTicketId || row.ticket_id || "").trim(),
    unitLabel: String(row.unitLabel || row.unit_label || "").trim(),
    propertyCode: String(row.propertyCode || row.property_code || "")
      .trim()
      .toUpperCase(),
    category: String(row.category || row.category_final || "").trim(),
    summary: summary.slice(0, 120),
    issue: summary.slice(0, 120),
    message_raw: summary,
    created_at: row.created_at || row.createdAt || null,
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
        message: `Multiple open tickets for unit ${unitHint} — which issue is it?`,
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
    const auto = tryAutoPickByIssueHint(opens, issueHint);
    if (auto) {
      return { ok: true, target: auto, reason: "SCOPE_ISSUE_MATCH" };
    }
    return {
      ok: false,
      error: "ambiguous_open",
      message: "Multiple open tickets — which issue is it?",
      candidates: opens.slice(0, 6),
    };
  }

  if (propertyCode && unitHint) {
    const dbOpens = (await loadOpenTicketTargetsForUnit(propertyCode, unitHint)).map(
      openTicketRowToTarget
    );
    if (dbOpens.length === 1) {
      return { ok: true, target: dbOpens[0], reason: "DB_UNIT_SINGLE" };
    }
    if (dbOpens.length > 1) {
      let list = dbOpens;
      if (issueHint) {
        list = rankOpenTicketsByIssueHint(dbOpens, issueHint);
        const auto = tryAutoPickByIssueHint(list, issueHint);
        if (auto) {
          return { ok: true, target: auto, reason: "DB_ISSUE_MATCH" };
        }
      }
      return {
        ok: false,
        error: "ambiguous_open",
        message: `Multiple open tickets for unit ${unitHint} — which issue is it?`,
        candidates: list.slice(0, 6),
      };
    }
  }

  return {
    ok: false,
    error: "no_open_ticket",
    message: "No open ticket found — give property, unit, or describe the issue.",
    candidates: [],
  };
}

module.exports = {
  resolveProposalTicketTarget,
  openTicketRowToTarget,
  rankOpenTicketsByIssueHint,
};
