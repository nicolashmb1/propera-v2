/**
 * Staff ticket field amendments from natural language (Telegram / SMS / WhatsApp / portal Body).
 * Deterministic: verb / unit-swap / human-id hints + same WI resolution as staff lifecycle when id omitted.
 * Does not use LLM — keeps North Compass / guardrails (no parallel interpreter).
 */

const { appendEventLog } = require("./appendEventLog");
const { getConversationCtx } = require("./conversationCtx");
const {
  listOpenWorkItemsForOwner,
  getWorkItemByWorkItemId,
} = require("./workItems");
const { resolveTargetWorkItemForStaff } = require("../brain/staff/resolveTargetWorkItemForStaff");
const {
  parseFieldsFromUpdateRest,
  hasUpdatableTicketFields,
} = require("./portalTicketMutations");

/** Same shape as `portalTicketMutations` HUMAN_ID — ticket id anywhere in the message. */
const HUMAN_ID_ANY = "([A-Za-z0-9]{2,12}-\\d{6}-\\d{4})";

/**
 * @param {string} body
 * @returns {string} uppercase human ticket id or ""
 */
function extractHumanTicketIdAnywhere(body) {
  const re = new RegExp(HUMAN_ID_ANY, "gi");
  const m = re.exec(String(body || ""));
  return m ? String(m[1] || "").trim().toUpperCase() : "";
}

/**
 * @param {string} body
 * @returns {boolean}
 */
function looksLikeStaffNaturalTicketAmend(body) {
  const b = String(body || "").trim();
  if (!b || b.charAt(0) === "#") return false;
  if (/^\s*Update\s+/i.test(b)) return false;

  const fields = parseFieldsFromUpdateRest(b);
  if (!hasUpdatableTicketFields(fields)) return false;

  if (extractHumanTicketIdAnywhere(b)) return true;

  if (
    /\b(update|change|modify|correct|fix|amend|revise|wrong|mistake|typo|should\s+be|meant|adjusted|edited)\b/i.test(
      b
    )
  ) {
    return true;
  }

  if (
    Object.prototype.hasOwnProperty.call(fields, "unit") &&
    String(fields.unit || "").trim() &&
    /\b(?:apt|unit|apartment)\s+\d/i.test(b) &&
    /\b(?:to|into|as|→)\b/i.test(b)
  ) {
    return true;
  }

  /** Schedule / window text (e.g. "Westgrand 304 … schedule for Friday afternoon") → `preferredWindow` field. */
  const pw =
    fields.preferredWindow != null ? String(fields.preferredWindow || "").trim() : "";
  if (
    pw &&
    /\b(schedule|scheduling|book|reschedule|window|availability|visit|appointment|when|afternoon|morning|evening)\b/i.test(
      b
    )
  ) {
    return true;
  }

  return false;
}

async function loadPropertyCodesUpper(sb) {
  const { data, error } = await sb.from("properties").select("code");
  if (error || !data) return new Set();
  const set = new Set();
  data.forEach((r) => {
    if (r && r.code) set.add(String(r.code).toUpperCase());
  });
  return set;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ staffId: string, staffActorKey: string, body: string, traceId: string }} o
 * @returns {Promise<{ ok: true, humanTicketId: string } | { ok: false, replyText: string }>}
 */
async function resolveHumanTicketIdForStaffAmend(sb, o) {
  const staffId = String(o.staffId || "").trim();
  const staffActorKey = String(o.staffActorKey || "").trim();
  const body = String(o.body || "").trim();
  const traceId = String(o.traceId || "").trim();

  const direct = extractHumanTicketIdAnywhere(body);
  if (direct) {
    return { ok: true, humanTicketId: direct };
  }

  if (!staffId) {
    return {
      ok: false,
      replyText:
        "Include the ticket id (example: PENN-050426-6362) or start with what you want to change plus enough words to match one open ticket.",
    };
  }

  const known = await loadPropertyCodesUpper(sb);
  const ctx = await getConversationCtx(staffActorKey);
  const rawRows = await listOpenWorkItemsForOwner(staffId);
  const openWis = rawRows.map((r) => ({
    workItemId: r.work_item_id,
    unitId: r.unit_id,
    propertyId: r.property_id,
    metadata_json: r.metadata_json,
    ticketKey: r.ticket_key ? String(r.ticket_key).trim() : "",
  }));

  let ctxPendingWi = null;
  const pendingCtxId =
    ctx &&
    (String(ctx.pending_work_item_id || "").trim() ||
      String(ctx.active_work_item_id || "").trim());
  if (pendingCtxId && !openWis.some((w) => w.workItemId === pendingCtxId)) {
    ctxPendingWi = await getWorkItemByWorkItemId(pendingCtxId);
  }

  const resolved = resolveTargetWorkItemForStaff({
    openWis,
    bodyTrim: body,
    ctx,
    knownPropertyCodesUpper: known,
    staffId,
    ctxPendingWi,
  });

  if (!resolved.wiId) {
    await appendEventLog({
      traceId,
      log_kind: "router",
      event: "STAFF_TICKET_AMEND_UNRESOLVED",
      payload: {
        reason: resolved.reason || "CLARIFICATION",
        staff_id: staffId,
        open_wi_count: openWis.length,
      },
    });
    return {
      ok: false,
      replyText:
        "Which ticket should I change? Reply with the ticket id (PENN-MMDDYY-####), or add property + unit and a few words from the issue so I can match one open ticket.",
    };
  }

  const wi = await getWorkItemByWorkItemId(resolved.wiId);
  const ticketKey = wi && String(wi.ticket_key || "").trim();
  if (!ticketKey) {
    return {
      ok: false,
      replyText:
        "That work item is not linked to a ticket row yet — paste the human ticket id (PENN-MMDDYY-####).",
    };
  }

  const { data: trow, error: tErr } = await sb
    .from("tickets")
    .select("ticket_id")
    .eq("ticket_key", ticketKey)
    .maybeSingle();

  if (tErr || !trow || !trow.ticket_id) {
    return {
      ok: false,
      replyText: "Could not load ticket id for that work item. Include PENN-MMDDYY-#### in your message.",
    };
  }

  await appendEventLog({
    traceId,
    log_kind: "router",
    event: "STAFF_TICKET_AMEND_RESOLVED",
    payload: {
      wi_id: resolved.wiId,
      ticket_key: ticketKey,
      human_ticket_id: String(trow.ticket_id).trim().toUpperCase(),
      reason: resolved.reason || "",
    },
  });

  return { ok: true, humanTicketId: String(trow.ticket_id).trim().toUpperCase() };
}

/**
 * @param {object} o
 * @param {import("@supabase/supabase-js").SupabaseClient} o.sb
 * @param {string} o.traceId
 * @param {Record<string, string | undefined>} o.routerParameter
 * @param {string} o.staffId
 * @param {string} o.staffActorKey
 * @returns {Promise<{ parsed: { kind: 'update', humanTicketId: string, fields: object } } | { amendRun: object } | null>}
 */
async function tryStaffNaturalLanguageTicketAmend(o) {
  const sb = o.sb;
  const traceId = String(o.traceId || "");
  const body = String((o.routerParameter && o.routerParameter.Body) || "").trim();
  const staffId = String(o.staffId || "").trim();
  const staffActorKey = String(o.staffActorKey || "").trim();

  if (!sb || !looksLikeStaffNaturalTicketAmend(body)) return null;

  const fields = parseFieldsFromUpdateRest(body);
  if (!hasUpdatableTicketFields(fields)) return null;

  const idRes = await resolveHumanTicketIdForStaffAmend(sb, {
    staffId,
    staffActorKey,
    body,
    traceId,
  });

  if (!idRes.ok) {
    return {
      amendRun: {
        ok: true,
        brain: "staff_ticket_amend_nl",
        replyText: idRes.replyText,
        resolution: { error: "ticket_target_unresolved" },
      },
    };
  }

  await appendEventLog({
    traceId,
    log_kind: "router",
    event: "STAFF_TICKET_AMEND_PARSED",
    payload: {
      human_ticket_id: idRes.humanTicketId,
      field_keys: Object.keys(fields),
    },
  });

  return {
    parsed: {
      kind: "update",
      humanTicketId: idRes.humanTicketId,
      fields,
    },
  };
}

module.exports = {
  extractHumanTicketIdAnywhere,
  looksLikeStaffNaturalTicketAmend,
  tryStaffNaturalLanguageTicketAmend,
};
