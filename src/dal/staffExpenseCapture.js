/**
 * Staff expense capture via `$$` marker — channel-agnostic (portal / SMS / Telegram).
 * @see docs/FINANCIAL_INTAKE_V1.md
 */

const crypto = require("crypto");
const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");
const { createTicketCostEntryForPortal, voidTicketCostEntryById } = require("./ticketCostEntries");
const {
  financeCostCaptureChatEnabled,
  financeCostCapturePropertyAllowlist,
} = require("../config/env");
const { normalizeUnit_ } = require("../brain/shared/extractUnitGas");
const {
  isExpenseCaptureMessage,
  stripExpenseMarker,
  parseExpenseCaptureText,
  extractHumanTicketIdAnywhere,
} = require("../brain/staff/expenseCaptureParse");
const {
  buildExpenseConfirmToken,
  verifyExpenseConfirmToken,
} = require("../brain/staff/expenseConfirmToken");

const EXPENSE_CONFIRM_INTENT = "EXPENSE_CONFIRM";
const CONFIRM_BODY_RE = /^(?:yes|y|confirm|ok|1)\.?$/i;

const HUMAN_ID = "([A-Za-z0-9]{2,12}-\\d{6}-\\d{4})";
const HUMAN_TICKET_ID_RE = new RegExp(`^${HUMAN_ID}$`, "i");
const TICKET_ROW_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RECENT_CLOSED_DAYS = 90;
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

function normStr(v) {
  return String(v || "").trim();
}

function isUndoMessage(body) {
  const t = String(body || "").trim().toLowerCase();
  return t === "undo" || t === "undo.";
}

/**
 * @param {Record<string, string | undefined>} routerParameter
 */
function readPortalCostContext(routerParameter) {
  const p = routerParameter || {};
  let raw = p._portalCostContextJson;
  if (!raw) {
    try {
      const nest = JSON.parse(String(p._portalPayloadJson || "{}"));
      raw = nest.portal_cost_context ?? nest.portalCostContext;
      if (raw && typeof raw === "object") return raw;
    } catch (_) {}
    return null;
  }
  try {
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    return j && typeof j === "object" ? j : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {Record<string, string | undefined>} routerParameter
 */
function readExpenseConfirmTokenFromPortal(routerParameter) {
  const costCtx = readPortalCostContext(routerParameter);
  if (!costCtx) return "";
  return normStr(costCtx.expense_confirm_token ?? costCtx.expenseConfirmToken);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} proposal
 * @param {object} o
 */
async function executeConfirmedExpenseCapture(sb, proposal, o) {
  const ticket =
    (await fetchTicketByRowId(sb, proposal.ticketRowId)) ||
    (proposal.ticketHumanId
      ? await fetchTicketByHumanId(sb, proposal.ticketHumanId)
      : null);
  if (!ticket) {
    return {
      ok: true,
      brain: "staff_expense_capture",
      replyText: "That ticket is no longer available — send the cost again.",
    };
  }
  const parsed = {
    entryType: proposal.entryType || "parts",
    vendorName: proposal.vendorName || "",
    description: proposal.description || "Maintenance cost",
    tenantChargeReason: proposal.tenantChargeReason || "",
    receiptStatus: proposal.receiptStatus || "MISSING",
  };
  const vendorAmt = Math.max(0, Number(proposal.vendorAmt) || 0);
  const tenantAmt = Math.max(0, Number(proposal.tenantAmt) || 0);
  const hasTenantCharge = proposal.hasTenantCharge === true && tenantAmt > 0;
  const idempotencyKey =
    normStr(proposal.idempotencyKey) ||
    buildIdempotencyKey(
      o.channel,
      normStr(o.messageId) + ":confirmed",
      normStr(proposal.normalizedBody)
    );

  return postExpenseCaptureRow({
    sb,
    traceId: o.traceId,
    ticket,
    parsed,
    vendorAmt,
    tenantAmt,
    hasTenantCharge,
    idempotencyKey,
    actorLabel: o.actorLabel,
    channel: o.channel,
    confidence: "high",
  });
}

/**
 * @param {string} channel
 * @param {string} messageId
 * @param {string} normalizedBody
 */
function buildIdempotencyKey(channel, messageId, normalizedBody) {
  const base = [normStr(channel), normStr(messageId), normStr(normalizedBody).toLowerCase()].join("|");
  return crypto.createHash("sha256").update(base).digest("hex").slice(0, 64);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} key
 */
async function findCostByIdempotencyKey(sb, key) {
  const k = normStr(key);
  if (!k) return null;
  const since = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS).toISOString();
  const { data, error } = await sb
    .from("ticket_cost_entries")
    .select("id, ticket_id, amount_cents, currency, voided_at, created_at")
    .eq("capture_idempotency_key", k)
    .is("voided_at", null)
    .gte("created_at", since)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} humanId
 */
async function fetchTicketByHumanId(sb, humanId) {
  const hid = normStr(humanId).toUpperCase();
  if (!HUMAN_TICKET_ID_RE.test(hid)) return null;
  const { data, error } = await sb
    .from("tickets")
    .select(
      "id, ticket_id, ticket_key, property_code, unit_label, status, is_imported_history, closed_at, created_at"
    )
    .eq("ticket_id", hid)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} rowId
 */
async function fetchTicketByRowId(sb, rowId) {
  const id = normStr(rowId).toLowerCase();
  if (!TICKET_ROW_UUID_RE.test(id)) return null;
  const { data, error } = await sb
    .from("tickets")
    .select(
      "id, ticket_id, ticket_key, property_code, unit_label, status, is_imported_history, closed_at, created_at"
    )
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

function isTerminalStatus(status) {
  const s = normStr(status).toLowerCase();
  return ["completed", "canceled", "cancelled", "resolved", "closed", "done", "deleted"].includes(
    s
  );
}

function isOpenTicket(t) {
  return t && !isTerminalStatus(t.status);
}

function ticketInRecentWindow(t) {
  if (!t) return false;
  if (isOpenTicket(t)) return true;
  const closed = t.closed_at ? new Date(String(t.closed_at)) : null;
  if (!closed || !Number.isFinite(closed.getTime())) {
    const created = t.created_at ? new Date(String(t.created_at)) : null;
    if (!created || !Number.isFinite(created.getTime())) return false;
    return Date.now() - created.getTime() <= RECENT_CLOSED_DAYS * 86400000;
  }
  return Date.now() - closed.getTime() <= RECENT_CLOSED_DAYS * 86400000;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {string} unitLabel
 */
async function listTicketsForCostAttach(sb, propertyCode, unitLabel) {
  const code = normStr(propertyCode).toUpperCase();
  const unit = normalizeUnit_(unitLabel);
  if (!code || !unit) return [];
  const { data, error } = await sb
    .from("tickets")
    .select(
      "id, ticket_id, ticket_key, property_code, unit_label, status, message_raw, is_imported_history, closed_at, created_at"
    )
    .eq("property_code", code)
    .eq("is_imported_history", false)
    .order("created_at", { ascending: false })
    .limit(80);
  if (error || !data) return [];
  return data.filter((row) => {
    if (isTerminalStatus(row.status) && normStr(row.status).toLowerCase() === "deleted") {
      return false;
    }
    return normalizeUnit_(row.unit_label) === unit && ticketInRecentWindow(row);
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} ticketRowId
 */
async function sumTicketCostCents(sb, ticketRowId) {
  const { data } = await sb
    .from("ticket_cost_entries")
    .select("amount_cents")
    .eq("ticket_id", ticketRowId)
    .is("voided_at", null);
  let sum = 0;
  for (const r of data || []) {
    sum += Number(r.amount_cents) || 0;
  }
  return sum;
}

function fmtUsd(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

/**
 * @param {object} o
 * @returns {"high"|"medium"|"low"}
 */
function computeConfidence(o) {
  const {
    amountCents,
    ticket,
    pinnedTicket,
    humanTicketId,
    vendorName,
    ocrAmountMismatch,
    amountSplitAmbiguous,
  } = o;
  if (!amountCents || amountCents <= 0) return "low";
  if (!ticket) return "low";
  if (amountSplitAmbiguous) return "medium";
  if (ocrAmountMismatch) return "medium";
  if (!(pinnedTicket || humanTicketId)) return "medium";
  if (!vendorName && !o.hasTenantCharge) return "medium";
  if (pinnedTicket || humanTicketId) return "high";
  return "medium";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} actorKey
 * @param {string} token
 */
async function stashExpenseConfirmPending(sb, actorKey, token) {
  const key = normStr(actorKey);
  if (!key || !token) return;
  const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await sb.from("conversation_ctx").upsert(
    {
      phone_e164: key,
      last_intent: EXPENSE_CONFIRM_INTENT,
      pending_work_item_id: token.slice(0, 500),
      pending_expires_at: exp,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "phone_e164" }
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} actorKey
 */
async function clearExpenseConfirmPending(sb, actorKey) {
  const key = normStr(actorKey);
  if (!key) return;
  const { data } = await sb
    .from("conversation_ctx")
    .select("last_intent")
    .eq("phone_e164", key)
    .maybeSingle();
  if (!data || data.last_intent !== EXPENSE_CONFIRM_INTENT) return;
  await sb
    .from("conversation_ctx")
    .update({
      last_intent: "",
      pending_work_item_id: "",
      pending_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("phone_e164", key);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} actorKey
 * @returns {Promise<string>}
 */
async function readExpenseConfirmPendingToken(sb, actorKey) {
  const key = normStr(actorKey);
  if (!key) return "";
  const { data } = await sb
    .from("conversation_ctx")
    .select("last_intent, pending_work_item_id, pending_expires_at")
    .eq("phone_e164", key)
    .maybeSingle();
  if (!data || data.last_intent !== EXPENSE_CONFIRM_INTENT) return "";
  const exp = data.pending_expires_at ? new Date(String(data.pending_expires_at)).getTime() : 0;
  if (exp && Date.now() > exp) return "";
  return normStr(data.pending_work_item_id);
}

/**
 * @param {object} o
 */
function buildConfirmSummary(o) {
  const parts = [];
  if (o.vendorAmt > 0) {
    parts.push(`${fmtUsd(o.vendorAmt)} ${String(o.entryType || "cost").replace(/_/g, " ")}`);
  }
  if (o.hasTenantCharge && o.tenantAmt > 0) {
    parts.push(`tenant charge ${fmtUsd(o.tenantAmt)}`);
  }
  const vendorBit = o.vendorName ? ` — ${o.vendorName}` : "";
  return `Post to ${o.ticketId}: ${parts.join(" + ")}${vendorBit}?`;
}

/**
 * @param {object} o
 */
async function postExpenseCaptureRow(o) {
  const {
    sb,
    traceId,
    ticket,
    parsed,
    vendorAmt,
    tenantAmt,
    hasTenantCharge,
    idempotencyKey,
    actorLabel,
    channel,
  } = o;

  const createBody = {
    amountCents: vendorAmt,
    entryType: parsed.entryType,
    vendorName: parsed.vendorName,
    description: parsed.description,
    paidStatus: "unknown",
    tenantChargeStatus: hasTenantCharge ? "approved" : "not_chargeable",
    tenantChargeAmountCents: hasTenantCharge ? tenantAmt : 0,
    tenantChargeReason: hasTenantCharge ? parsed.tenantChargeReason || parsed.description : "",
    targetKind: "UNIT",
    unitLabelSnapshot: ticket.unit_label || "",
    unitCatalogId: null,
    attachmentUrls: [],
    receiptStatus: parsed.receiptStatus,
    captureIdempotencyKey: idempotencyKey,
    createdBy: actorLabel,
  };

  const created = await createTicketCostEntryForPortal(ticket.id, createBody);
  if (!created.ok) {
    return {
      ok: false,
      brain: "staff_expense_capture",
      replyText: "Could not save cost: " + (created.error || "unknown"),
    };
  }

  const total = await sumTicketCostCents(sb, ticket.id);
  const vendorBit = parsed.vendorName ? ` — ${parsed.vendorName}` : "";
  const summaryParts = [];
  if (vendorAmt > 0) {
    summaryParts.push(
      `${fmtUsd(vendorAmt)} ${parsed.entryType.replace(/_/g, " ")}${vendorBit}`
    );
  }
  if (hasTenantCharge) {
    summaryParts.push(`tenant charge ${fmtUsd(tenantAmt)} (approved)`);
  }
  const replyText = `Attached ${summaryParts.join(" + ")} to ${ticket.ticket_id}. Ticket cost total ${fmtUsd(total)}. Reply undo within 60s if wrong.`;

  await appendEventLog({
    traceId,
    log_kind: "portal",
    event: "EXPENSE_CAPTURE_POSTED",
    payload: {
      ticket_id: ticket.ticket_id,
      cost_entry_id: created.entry && created.entry.id,
      amount_cents: vendorAmt,
      tenant_charge_amount_cents: hasTenantCharge ? tenantAmt : 0,
      entry_type: parsed.entryType,
      confidence: o.confidence || "high",
      channel,
    },
  });

  return {
    ok: true,
    brain: "staff_expense_capture",
    replyText,
    resolution: {
      ticketId: ticket.ticket_id,
      costEntryId: created.entry && created.entry.id,
      confidence: o.confidence || "high",
    },
  };
}

/**
 * Undo last chat-posted cost by this actor label within 60s (no conversation_ctx schema change).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} actorLabel
 */
async function voidLastCostInThread(sb, actorLabel) {
  const label = normStr(actorLabel);
  if (!label) {
    return { ok: false, replyText: "Could not undo — unknown actor." };
  }
  const since = new Date(Date.now() - 60000).toISOString();
  const { data: row } = await sb
    .from("ticket_cost_entries")
    .select("id")
    .eq("created_by", label)
    .not("capture_idempotency_key", "is", null)
    .is("voided_at", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!row || !row.id) {
    return { ok: true, replyText: "Nothing to undo in the last 60 seconds." };
  }
  const out = await voidTicketCostEntryById(row.id, label);
  if (!out.ok) {
    return { ok: true, replyText: out.error || "Could not undo that cost." };
  }
  return { ok: true, replyText: "Undid the last cost entry." };
}

/**
 * @param {object} o
 * @param {string} o.traceId
 * @param {Record<string, string | undefined>} o.routerParameter
 * @param {string} [o.transportChannel]
 * @param {string} [o.staffActorKey]
 * @param {string} [o.messageId]
 * @returns {Promise<object | null>}
 */
async function tryStaffExpenseCapture(o) {
  if (!financeCostCaptureChatEnabled()) return null;

  const traceId = normStr(o.traceId);
  const routerParameter = o.routerParameter || {};
  const bodyRaw = String(routerParameter.Body || "").trim();
  const channel = normStr(o.transportChannel || "portal") || "portal";
  const staffActorKey = normStr(o.staffActorKey);
  let portalMode = String(routerParameter._portalChatMode || "").toLowerCase();
  if (!portalMode) {
    try {
      const nest = JSON.parse(String(routerParameter._portalPayloadJson || "{}"));
      portalMode = String(nest.portal_chat_mode || nest.portalChatMode || "").trim().toLowerCase();
    } catch (_) {}
  }
  const hasMarker = isExpenseCaptureMessage(bodyRaw) || portalMode === "cost";
  if (!hasMarker && !isUndoMessage(bodyRaw) && !CONFIRM_BODY_RE.test(bodyRaw)) return null;

  const sb = getSupabase();
  if (!sb) {
    return {
      ok: false,
      brain: "staff_expense_capture",
      replyText: "Database is not configured.",
    };
  }

  const actorKey =
    normStr(o.staffActorKey) || normStr(routerParameter.From) || normStr(routerParameter._phoneE164);

  const portalConfirmToken = readExpenseConfirmTokenFromPortal(routerParameter);
  if (portalConfirmToken) {
    const proposal = verifyExpenseConfirmToken(portalConfirmToken);
    if (!proposal) {
      return {
        ok: true,
        brain: "staff_expense_capture",
        replyText: "That confirmation expired — send the cost again.",
      };
    }
    await clearExpenseConfirmPending(sb, actorKey);
    const actorLabel =
      (() => {
        try {
          const j = JSON.parse(String(routerParameter._portalMutationActorJson || "{}"));
          return normStr(j.changed_by_actor_label) || "Staff";
        } catch (_) {
          return "Staff";
        }
      })() || "Staff";
    return executeConfirmedExpenseCapture(sb, proposal, {
      traceId,
      channel,
      messageId: normStr(o.messageId),
      actorLabel,
    });
  }

  if (CONFIRM_BODY_RE.test(bodyRaw) && !isExpenseCaptureMessage(bodyRaw)) {
    const pendingTok = await readExpenseConfirmPendingToken(sb, actorKey);
    const proposal = pendingTok ? verifyExpenseConfirmToken(pendingTok) : null;
    if (!proposal) {
      return {
        ok: true,
        brain: "staff_expense_capture",
        replyText: "Nothing pending to confirm. Send a $$ cost message first.",
      };
    }
    await clearExpenseConfirmPending(sb, actorKey);
    const actorLabel =
      (() => {
        try {
          const j = JSON.parse(String(routerParameter._portalMutationActorJson || "{}"));
          return normStr(j.changed_by_actor_label) || "Staff";
        } catch (_) {
          return "Staff";
        }
      })() || "Staff";
    return executeConfirmedExpenseCapture(sb, proposal, {
      traceId,
      channel,
      messageId: normStr(o.messageId),
      actorLabel,
    });
  }

  if (isUndoMessage(bodyRaw)) {
    let undoActor = "Staff";
    try {
      const j = JSON.parse(String(routerParameter._portalMutationActorJson || "{}"));
      undoActor = normStr(j.changed_by_actor_label) || undoActor;
    } catch (_) {}
    const u = await voidLastCostInThread(sb, undoActor);
    await appendEventLog({
      traceId,
      log_kind: "portal",
      event: "EXPENSE_CAPTURE_UNDO",
      payload: { staff_actor_key: staffActorKey },
    });
    return { ok: true, brain: "staff_expense_capture", replyText: u.replyText };
  }

  if (!hasMarker) return null;

  await appendEventLog({
    traceId,
    log_kind: "portal",
    event: "EXPENSE_CAPTURE_ATTEMPT",
    payload: { channel, portal_mode: portalMode || undefined },
  });

  const hasPhoto = !!String(routerParameter._mediaJson || "").trim();
  const parsed = parseExpenseCaptureText(bodyRaw, { hasPhoto });

  const vendorAmt = Math.max(0, Number(parsed.vendorAmountCents ?? parsed.amountCents) || 0);
  const tenantAmt = Math.max(0, Number(parsed.tenantChargeAmountCents) || 0);
  const hasTenantCharge = parsed.hasTenantCharge === true && tenantAmt > 0;

  if (vendorAmt <= 0 && tenantAmt <= 0) {
    return {
      ok: true,
      brain: "staff_expense_capture",
      replyText:
        "Include an amount — vendor cost (e.g. parts 33 homedepot), tenant charge (e.g. tenant charge 100), or both in one message.",
    };
  }

  const costCtx = readPortalCostContext(routerParameter);
  let ticket = null;

  const humanFromText = parsed.humanTicketId || extractHumanTicketIdAnywhere(parsed.body);
  if (humanFromText) {
    ticket = await fetchTicketByHumanId(sb, humanFromText);
  }
  if (!ticket && costCtx) {
    const rowId = normStr(costCtx.ticketRowId ?? costCtx.ticket_row_id);
    const human = normStr(costCtx.humanTicketId ?? costCtx.human_ticket_id);
    if (rowId) ticket = await fetchTicketByRowId(sb, rowId);
    if (!ticket && human) ticket = await fetchTicketByHumanId(sb, human);
  }

  const propertyCode = normStr(
    (costCtx && (costCtx.propertyCode ?? costCtx.property_code)) ||
      (ticket && ticket.property_code)
  ).toUpperCase();
  const unitLabel =
    normStr((costCtx && (costCtx.unit ?? costCtx.unitLabel ?? costCtx.unit_label)) || "") ||
    (ticket && ticket.unit_label);

  if (!ticket && propertyCode && unitLabel) {
    const candidates = await listTicketsForCostAttach(sb, propertyCode, unitLabel);
    if (candidates.length === 1) {
      ticket = candidates[0];
    } else if (candidates.length > 1) {
      const open = candidates.filter(isOpenTicket);
      if (open.length === 1) ticket = open[0];
    }
  }

  if (!ticket) {
    return {
      ok: true,
      brain: "staff_expense_capture",
      replyText:
        "Which ticket is this for? Include the ticket id (PENN-MMDDYY-####) or pin unit + property in Propera chat and pick a ticket.",
    };
  }

  const allow = financeCostCapturePropertyAllowlist();
  if (allow && !allow.has(normStr(ticket.property_code).toUpperCase())) {
    return {
      ok: true,
      brain: "staff_expense_capture",
      replyText: "Cost capture is not enabled for this property yet.",
    };
  }

  if (ticket.is_imported_history === true) {
    return {
      ok: true,
      brain: "staff_expense_capture",
      replyText: "Historical tickets cannot receive new costs.",
    };
  }

  if (isTerminalStatus(ticket.status) && normStr(ticket.status).toLowerCase() === "deleted") {
    return {
      ok: true,
      brain: "staff_expense_capture",
      replyText: "That ticket is deleted — costs cannot be attached.",
    };
  }

  const pinnedTicket = !!(
    costCtx &&
    (normStr(costCtx.ticketRowId ?? costCtx.ticket_row_id) === String(ticket.id) ||
      normStr(costCtx.humanTicketId ?? costCtx.human_ticket_id).toUpperCase() ===
        String(ticket.ticket_id || "").toUpperCase())
  );

  const confidence = computeConfidence({
    amountCents: vendorAmt > 0 ? vendorAmt : tenantAmt,
    ticket,
    pinnedTicket,
    humanTicketId: humanFromText,
    vendorName: parsed.vendorName,
    ocrAmountMismatch: false,
    amountSplitAmbiguous: parsed.amountSplitAmbiguous === true,
    hasTenantCharge,
  });

  if (confidence === "low") {
    return {
      ok: true,
      brain: "staff_expense_capture",
      replyText:
        "I need a clearer match — include the ticket id or select the ticket in Cost mode, then send amount + vendor again.",
    };
  }

  const messageId = normStr(o.messageId) || normStr(routerParameter.MessageSid) || traceId;
  const normalizedBody = stripExpenseMarker(bodyRaw);
  const idempotencyKey = buildIdempotencyKey(channel, messageId, normalizedBody);

  const actorLabel =
    (() => {
      try {
        const j = JSON.parse(String(routerParameter._portalMutationActorJson || "{}"));
        return normStr(j.changed_by_actor_label) || "Staff";
      } catch (_) {
        return "Staff";
      }
    })() || "Staff";

  if (confidence === "medium") {
    const confirmToken = buildExpenseConfirmToken({
      ticketRowId: String(ticket.id),
      ticketHumanId: String(ticket.ticket_id || ""),
      vendorAmt,
      tenantAmt,
      hasTenantCharge,
      entryType: parsed.entryType,
      vendorName: parsed.vendorName,
      description: parsed.description,
      tenantChargeReason: parsed.tenantChargeReason || parsed.description,
      receiptStatus: parsed.receiptStatus,
      idempotencyKey,
      normalizedBody,
    });
    await stashExpenseConfirmPending(sb, actorKey, confirmToken);
    await appendEventLog({
      traceId,
      log_kind: "portal",
      event: "EXPENSE_CAPTURE_CONFIRM_REQUIRED",
      payload: {
        ticket_id: ticket.ticket_id,
        confidence,
        amount_split_ambiguous: parsed.amountSplitAmbiguous === true,
        channel,
      },
    });
    const summary = buildConfirmSummary({
      ticketId: ticket.ticket_id,
      vendorAmt,
      tenantAmt,
      hasTenantCharge,
      entryType: parsed.entryType,
      vendorName: parsed.vendorName,
    });
    const smsHint =
      channel === "portal"
        ? ""
        : " Reply YES to confirm, or send the same $$ message again.";
    return {
      ok: true,
      brain: "staff_expense_capture",
      replyText: `${summary}${smsHint}`,
      resolution: {
        needsConfirm: true,
        confirmToken,
        confirmSummary: summary,
        confidence: "medium",
        amountSplitAmbiguous: parsed.amountSplitAmbiguous === true,
      },
    };
  }

  const existing = await findCostByIdempotencyKey(sb, idempotencyKey);
  if (existing) {
    await appendEventLog({
      traceId,
      log_kind: "portal",
      event: "EXPENSE_CAPTURE_IDEMPOTENT_HIT",
      payload: { cost_entry_id: existing.id, ticket_id: ticket.ticket_id },
    });
    const total = await sumTicketCostCents(sb, ticket.id);
    return {
      ok: true,
      brain: "staff_expense_capture",
      replyText: `Already recorded ${fmtUsd(existing.amount_cents)} on ${ticket.ticket_id}. Ticket total ${fmtUsd(total)}.`,
      resolution: { idempotent: true, costEntryId: existing.id },
    };
  }

  return postExpenseCaptureRow({
    sb,
    traceId,
    ticket,
    parsed,
    vendorAmt,
    tenantAmt,
    hasTenantCharge,
    idempotencyKey,
    actorLabel,
    channel,
    confidence: "high",
  });
}

module.exports = {
  tryStaffExpenseCapture,
  listTicketsForCostAttach,
  isExpenseCaptureMessage,
};
