/**
 * Tenant open-ticket lookup for find_related_ticket (Phase 6).
 */
const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");
const { normalizePhoneE164 } = require("../utils/phone");
const { isTicketOpenForTenantAppend } = require("./tenantTicketAppend");

const STRONG_SCORE_MIN = 4;
const WEAK_SCORE_MIN = 2;
const STRONG_GAP_MIN = 3;

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenizeForMatch(text) {
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return new Set(words);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function unitLabelsMatch(a, b) {
  const x = String(a || "").trim().toLowerCase();
  const y = String(b || "").trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.replace(/^apt\s*/, "") === y.replace(/^apt\s*/, "");
}

/**
 * @param {object} ticket
 * @param {object} hints
 * @returns {number}
 */
function scoreTicketAgainstHints(ticket, hints) {
  let score = 0;
  const issueText = String(hints.issueText || "").trim();
  const hintTokens = tokenizeForMatch(issueText);
  const corpus = [
    ticket.message_raw,
    ticket.service_notes,
    ticket.category,
    ticket.unit_label,
  ]
    .map((s) => String(s || ""))
    .join(" ");
  const corpusTokens = tokenizeForMatch(corpus);

  for (const t of hintTokens) {
    if (corpusTokens.has(t)) score += 2;
  }

  if (
    hints.unitHint &&
    unitLabelsMatch(hints.unitHint, ticket.unit_label)
  ) {
    score += 4;
  }

  const propHint = String(hints.property_code || "").trim().toUpperCase();
  const propRow = String(ticket.property_code || "").trim().toUpperCase();
  if (propHint && propRow && propHint === propRow) score += 2;

  const catHint = String(hints.categoryHint || "").trim().toLowerCase();
  const catRow = String(ticket.category || "").trim().toLowerCase();
  if (catHint && catRow && (catHint.includes(catRow) || catRow.includes(catHint))) {
    score += 3;
  }

  return score;
}

/**
 * @param {object} row
 * @returns {object}
 */
function ticketRowToFact(row) {
  const messageRaw = String(row.message_raw || "").trim();
  const issueSnippet =
    messageRaw.length > 80 ? `${messageRaw.slice(0, 77)}...` : messageRaw;
  return {
    ticket_key: String(row.ticket_key || "").trim(),
    ticket_id: String(row.ticket_id || "").trim(),
    status: String(row.status || "").trim(),
    property_code: String(row.property_code || "").trim(),
    unit_label: String(row.unit_label || "").trim(),
    category: String(row.category || "").trim(),
    assigned_name: String(row.assigned_name || "").trim(),
    preferred_window: String(row.preferred_window || "").trim(),
    issueSnippet,
    score: Number(row._match_score || 0),
  };
}

/**
 * @param {object[]} scored
 * @returns {{ matchStatus: string, ticket?: object, tickets?: object[], allowedOperations: string[] }}
 */
function classifyScoredMatches(scored) {
  const ranked = scored
    .filter((t) => t.score >= WEAK_SCORE_MIN)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return { matchStatus: "no_match", tickets: [], allowedOperations: [] };
  }

  const top = ranked[0];
  const second = ranked[1];
  const strong =
    top.score >= STRONG_SCORE_MIN &&
    (!second || top.score - second.score >= STRONG_GAP_MIN);

  if (strong && ranked.length === 1) {
    return {
      matchStatus: "single_strong_match",
      ticket: top,
      tickets: [top],
      allowedOperations: ["append_to_ticket"],
    };
  }

  if (strong) {
    return {
      matchStatus: "single_strong_match",
      ticket: top,
      tickets: [top],
      allowedOperations: ["append_to_ticket"],
    };
  }

  if (ranked.length >= 2) {
    return {
      matchStatus: "multiple_matches",
      tickets: ranked.slice(0, 5),
      allowedOperations: ["append_to_ticket"],
    };
  }

  return {
    matchStatus: "weak_match",
    ticket: top,
    tickets: ranked,
    allowedOperations: ["append_to_ticket"],
  };
}

/**
 * @param {object} o
 * @param {string} o.tenantPhoneE164
 * @param {object} [o.hints]
 * @param {string} o.traceId
 * @returns {Promise<{ ok: boolean, brain?: string, matchStatus?: string, ticket?: object, tickets?: object[], allowedOperations?: string[], error?: string }>}
 */
async function findRelatedTenantTickets(o) {
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "no_db", brain: "tenant_find_related_failed" };
  }

  const tenantPhone = normalizePhoneE164(String(o.tenantPhoneE164 || "").trim());
  if (!tenantPhone) {
    return {
      ok: false,
      error: "missing_phone",
      brain: "tenant_find_related_invalid",
    };
  }

  const hints = o.hints && typeof o.hints === "object" ? o.hints : {};

  const { data: rows, error } = await sb
    .from("tickets")
    .select(
      "ticket_key, ticket_id, property_code, unit_label, category, status, message_raw, service_notes, tenant_phone_e164, assigned_name, preferred_window, updated_at"
    )
    .eq("tenant_phone_e164", tenantPhone)
    .order("updated_at", { ascending: false })
    .limit(25);

  if (error) {
    return {
      ok: false,
      error: error.message,
      brain: "tenant_find_related_failed",
    };
  }

  const openRows = (rows || []).filter((r) =>
    isTicketOpenForTenantAppend(r.status)
  );

  const scored = openRows.map((row) => {
    const score = scoreTicketAgainstHints(row, hints);
    return ticketRowToFact({ ...row, _match_score: score });
  });

  const classified = classifyScoredMatches(scored);

  await appendEventLog({
    traceId: String(o.traceId || "").trim(),
    log_kind: "brain",
    event: "TENANT_FIND_RELATED_TICKET",
    payload: {
      tenant_phone_e164: tenantPhone,
      match_status: classified.matchStatus,
      open_count: openRows.length,
      ranked_count: classified.tickets ? classified.tickets.length : 0,
    },
  });

  return {
    ok: true,
    brain: "tenant_find_related_ticket",
    ...classified,
  };
}

module.exports = {
  findRelatedTenantTickets,
  scoreTicketAgainstHints,
  classifyScoredMatches,
  tokenizeForMatch,
  STRONG_SCORE_MIN,
  WEAK_SCORE_MIN,
};
