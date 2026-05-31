/**
 * Financial capture brain — portal_chat_mode = "financial".
 *
 * Handles: expense → property_expenses, payment/charge/waiver → tenant_ledger_entries.
 * Same confirm-token + undo pattern as staffExpenseCapture.
 *
 * Flow:
 *   text + page_context → extractFinancialSignal (LLM)
 *   → resolveFinancialSignal (V2 brain: property, unit, date)
 *   → needs_clarification? → ask PM
 *   → medium confidence? → draft + confirm token
 *   → high confidence → post → undo window
 */

const crypto = require("crypto");
const { getSupabase } = require("../../db/supabase");
const { extractFinancialSignal } = require("./financialSignalExtract");
const { appendEventLog } = require("../../dal/appendEventLog");
const { resolvePropertyForGather } = require("../../adapters/tenantAgent/resolvePropertyForGather");
const { buildExpenseConfirmToken, verifyExpenseConfirmToken } = require("../staff/expenseConfirmToken");
const { financialCaptureEnabled } = require("../../config/env");

const CONFIRM_RE = /^(?:yes|y|confirm|ok|1)\.?$/i;
const UNDO_RE = /^undo\.?$/i;
const FINANCIAL_MODE = "financial";

// ── Label formatters ────────────────────────────────────────────────────────

const CATEGORY_LABEL = {
  property_tax: "Property Tax", insurance_building: "Building Insurance",
  insurance_liability: "Liability Insurance", hoa_condo_fees: "HOA/Condo Fees",
  permits_licenses: "Permits & Licenses", water_sewer: "Water/Sewer",
  electric: "Electric", gas: "Gas", trash_recycling: "Trash/Recycling",
  landscaping: "Landscaping", snow_removal: "Snow Removal",
  pest_control: "Pest Control", elevator_contract: "Elevator Contract",
  security_monitoring: "Security/Monitoring", pool_maintenance: "Pool Maintenance",
  management_fee: "Management Fee", staff_payroll_allocation: "Staff Allocation",
  legal_accounting: "Legal/Accounting", other: "Other",
};

function fmtUsd(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function fmtDate(isoOrRelative) {
  if (!isoOrRelative) return null;
  if (/^today$/i.test(isoOrRelative)) return new Date().toISOString().slice(0, 10);
  if (/^yesterday$/i.test(isoOrRelative)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrRelative)) return isoOrRelative;
  return new Date().toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ── Context readers ─────────────────────────────────────────────────────────

function readFinancialPageContext(routerParameter) {
  const p = routerParameter || {};
  let raw = p._portalFinancialContextJson;
  if (!raw) {
    try {
      const nest = JSON.parse(String(p._portalPayloadJson || "{}"));
      raw = nest.portal_financial_context ?? nest.portalFinancialContext;
      if (raw && typeof raw === "object") return raw;
    } catch (_) {}
    // Fall back to generic page context
    try {
      const page = JSON.parse(String(p._portalPageContextJson || "{}"));
      if (page && typeof page === "object") return page;
    } catch (_) {}
    return null;
  }
  try {
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    return j && typeof j === "object" ? j : null;
  } catch (_) { return null; }
}

function readFinancialConfirmTokenFromPortal(routerParameter) {
  const ctx = readFinancialPageContext(routerParameter);
  if (!ctx) return "";
  return String(ctx.financial_confirm_token ?? ctx.financialConfirmToken ?? "").trim();
}

function readActorLabel(routerParameter) {
  try {
    const j = JSON.parse(String(routerParameter._portalMutationActorJson || "{}"));
    return String(j.changed_by_actor_label || "").trim() || "Staff";
  } catch (_) { return "Staff"; }
}

// ── Property / unit resolution ──────────────────────────────────────────────

async function loadActiveProperties(sb) {
  const { data, error } = await sb
    .from("properties")
    .select("code, display_name, short_name, display_name_short, active")
    .neq("code", "GLOBAL");
  if (error || !data) return [];
  return data.filter((p) => p.active !== false);
}

async function resolvePropertyCode(sb, hint, pageContext) {
  // 1. From page context — PM is on a property page, already resolved
  const fromPage = String(
    (pageContext && (pageContext.property_code || pageContext.propertyCode)) || ""
  ).trim().toUpperCase();
  if (fromPage && fromPage !== "GLOBAL") return fromPage;

  // 2. No hint to resolve
  if (!hint) return null;

  // 3. Load all active properties from DB, resolve against the hint
  const properties = await loadActiveProperties(sb);
  if (!properties.length) return null;

  const result = resolvePropertyForGather(hint, properties);
  if (result.status === "RESOLVED" && result.property_code) {
    return result.property_code;
  }

  // 4. Exact code match as final fallback
  const upper = hint.trim().toUpperCase();
  const exact = properties.find((p) => String(p.code || "").trim().toUpperCase() === upper);
  return exact ? String(exact.code).trim().toUpperCase() : null;
}

async function resolveUnitCatalogId(sb, propertyCode, unitHint) {
  if (!propertyCode || !unitHint) return null;
  const norm = String(unitHint).trim().toLowerCase().replace(/^0+(?=\d)/, "");
  const { data } = await sb
    .from("units")
    .select("id, unit_label")
    .eq("property_code", propertyCode)
    .limit(200);
  if (!data) return null;
  const match = data.find((u) => {
    const ul = String(u.unit_label || "").trim().toLowerCase().replace(/^0+(?=\d)/, "");
    return ul === norm;
  });
  return match ? match.id : null;
}

// ── Pending confirm state (reuses conversation_ctx like ticket cost) ─────────

const FINANCIAL_CONFIRM_INTENT = "FINANCIAL_CAPTURE_CONFIRM";

async function stashFinancialConfirmPending(sb, actorKey, token) {
  const key = String(actorKey || "").trim();
  if (!key || !token) return;
  const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await sb.from("conversation_ctx").upsert(
    {
      phone_e164: key,
      last_intent: FINANCIAL_CONFIRM_INTENT,
      pending_work_item_id: token.slice(0, 500),
      pending_expires_at: exp,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "phone_e164" }
  );
}

async function readFinancialConfirmPendingToken(sb, actorKey) {
  const key = String(actorKey || "").trim();
  if (!key) return "";
  const { data } = await sb
    .from("conversation_ctx")
    .select("last_intent, pending_work_item_id, pending_expires_at")
    .eq("phone_e164", key)
    .maybeSingle();
  if (!data || data.last_intent !== FINANCIAL_CONFIRM_INTENT) return "";
  const exp = data.pending_expires_at ? new Date(String(data.pending_expires_at)).getTime() : 0;
  if (exp && Date.now() > exp) return "";
  return String(data.pending_work_item_id || "").trim();
}

async function clearFinancialConfirmPending(sb, actorKey) {
  const key = String(actorKey || "").trim();
  if (!key) return;
  const { data } = await sb
    .from("conversation_ctx")
    .select("last_intent")
    .eq("phone_e164", key)
    .maybeSingle();
  if (!data || data.last_intent !== FINANCIAL_CONFIRM_INTENT) return;
  await sb.from("conversation_ctx").update({
    last_intent: "", pending_work_item_id: "", pending_expires_at: null,
    updated_at: new Date().toISOString(),
  }).eq("phone_e164", key);
}

// ── Posting ─────────────────────────────────────────────────────────────────

async function postExpense(sb, proposal, actorLabel) {
  const row = {
    property_code: proposal.propertyCode,
    expense_date: proposal.expenseDate || todayIso(),
    category: proposal.category || "other",
    amount_cents: proposal.amountCents,
    vendor: proposal.vendor || "",
    description: proposal.description || "",
    recurrence: "one_time",
    status: "posted",
  };
  const { data, error } = await sb.from("property_expenses").insert(row).select("id").maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data && data.id };
}

async function postLedgerLine(sb, proposal, kind, actorLabel) {
  const methodParts = [kind === "payment" ? "Payment received" : kind === "charge" ? "Charge" : "Waiver"];
  if (proposal.method) methodParts.push(proposal.method);
  if (proposal.reference) methodParts.push(`#${proposal.reference}`);
  const description = proposal.description || methodParts.join(" · ");

  const row = {
    property_code: proposal.propertyCode,
    unit_catalog_id: proposal.unitId || null,
    source_type: "manual",
    source_id: null,
    entry_kind: kind,
    amount_cents: proposal.amountCents,
    currency: "USD",
    description,
    notes: proposal.notes || "",
    status: "posted",
    ...(proposal.expenseDate ? { effective_date: proposal.expenseDate } : {}),
  };
  const { data, error } = await sb.from("tenant_ledger_entries").insert(row).select("id").maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data && data.id };
}

async function executeConfirmedCapture(sb, proposal, actorLabel, traceId, channel) {
  const kind = proposal.kind;
  let postResult;

  if (kind === "expense") {
    postResult = await postExpense(sb, proposal, actorLabel);
  } else if (kind === "payment" || kind === "charge" || kind === "waiver") {
    postResult = await postLedgerLine(sb, proposal, kind, actorLabel);
  } else {
    return { ok: false, brain: "financial_capture", replyText: "Unknown financial kind — send again." };
  }

  if (!postResult.ok) {
    return { ok: false, brain: "financial_capture", replyText: `Could not save: ${postResult.error}` };
  }

  await appendEventLog({
    traceId,
    log_kind: "portal",
    event: "FINANCIAL_CAPTURE_POSTED",
    payload: { kind, property_code: proposal.propertyCode, amount_cents: proposal.amountCents, channel },
  });

  const kindLabel = kind === "expense" ? "expense" : kind === "payment" ? "payment" : kind === "charge" ? "charge" : "waiver";
  const loc = proposal.unitId
    ? `Unit ${proposal.unitLabel || "?"} · ${proposal.propertyCode}`
    : proposal.propertyCode;
  const reply = `${fmtUsd(proposal.amountCents)} ${kindLabel} posted to ${loc}. Reply undo within 60s if wrong.`;

  return {
    ok: true,
    brain: "financial_capture",
    replyText: reply,
    resolution: { kind, propertyCode: proposal.propertyCode, entryId: postResult.id, confidence: "high" },
  };
}

// ── Undo ────────────────────────────────────────────────────────────────────

async function voidLastFinancialEntry(sb, actorLabel) {
  const since = new Date(Date.now() - 60000).toISOString();
  // Try property_expenses first
  const { data: expRow } = await sb
    .from("property_expenses")
    .select("id, amount_cents")
    .eq("status", "posted")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (expRow) {
    await sb.from("property_expenses").update({ status: "voided" }).eq("id", expRow.id);
    return { ok: true, replyText: `Voided ${fmtUsd(expRow.amount_cents)} expense.` };
  }
  // Try ledger
  const { data: ledRow } = await sb
    .from("tenant_ledger_entries")
    .select("id, amount_cents, entry_kind")
    .eq("source_type", "manual")
    .neq("status", "voided")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ledRow) {
    await sb.from("tenant_ledger_entries").update({ status: "voided" }).eq("id", ledRow.id);
    return { ok: true, replyText: `Voided ${fmtUsd(ledRow.amount_cents)} ${ledRow.entry_kind}.` };
  }
  return { ok: true, replyText: "Nothing to undo in the last 60 seconds." };
}

// ── Draft summary ────────────────────────────────────────────────────────────

function buildDraftSummary(proposal) {
  const amt = fmtUsd(proposal.amountCents);
  const loc = proposal.unitLabel
    ? `Unit ${proposal.unitLabel} · ${proposal.propertyCode}`
    : proposal.propertyCode || "?";

  if (proposal.kind === "expense") {
    const cat = proposal.category ? (CATEGORY_LABEL[proposal.category] || proposal.category) : "expense";
    const vend = proposal.vendor ? ` — ${proposal.vendor}` : "";
    return `Post ${amt} ${cat}${vend} to ${loc}?`;
  }
  if (proposal.kind === "payment") {
    const meth = proposal.method ? ` (${proposal.method})` : "";
    return `Record ${amt} payment${meth} for ${loc}?`;
  }
  if (proposal.kind === "charge") return `Add ${amt} charge to ${loc}?`;
  if (proposal.kind === "waiver") return `Post ${amt} waiver to ${loc}?`;
  return `Post ${amt} to ${loc}?`;
}

// ── Main orchestrator ────────────────────────────────────────────────────────

function isPortalFinancialMode(routerParameter) {
  return String(routerParameter._portalChatMode || "").trim().toLowerCase() === FINANCIAL_MODE;
}

/**
 * @param {object} o
 * @param {string} o.traceId
 * @param {Record<string, string | undefined>} o.routerParameter
 * @param {string} [o.transportChannel]
 * @param {string} [o.staffActorKey]
 */
async function handleFinancialCapture(o) {
  if (!financialCaptureEnabled()) {
    return {
      ok: true,
      brain: "financial_capture",
      replyText: "Financial capture is not enabled. Set PROPERA_FINANCIAL_CAPTURE_ENABLED=1 on propera-v2.",
    };
  }

  const traceId = String(o.traceId || "").trim();
  const routerParameter = o.routerParameter || {};
  const channel = String(o.transportChannel || "portal").trim();
  const actorKey = String(o.staffActorKey || routerParameter.From || "").trim();
  const bodyRaw = String(routerParameter.Body || "").trim();

  const sb = getSupabase();
  if (!sb) {
    return { ok: false, brain: "financial_capture", replyText: "Database not configured." };
  }

  // ── Undo ──
  if (UNDO_RE.test(bodyRaw)) {
    const u = await voidLastFinancialEntry(sb, readActorLabel(routerParameter));
    return { ok: true, brain: "financial_capture", replyText: u.replyText };
  }

  // ── Confirm via portal token (inline UI confirm button) ──
  const portalConfirmToken = readFinancialConfirmTokenFromPortal(routerParameter);
  if (portalConfirmToken) {
    const proposal = verifyExpenseConfirmToken(portalConfirmToken);
    if (!proposal) {
      return { ok: true, brain: "financial_capture", replyText: "Confirmation expired — send again." };
    }
    await clearFinancialConfirmPending(sb, actorKey);
    return executeConfirmedCapture(sb, proposal, readActorLabel(routerParameter), traceId, channel);
  }

  // ── Confirm via YES reply (SMS/Telegram) ──
  if (CONFIRM_RE.test(bodyRaw)) {
    const pendingTok = await readFinancialConfirmPendingToken(sb, actorKey);
    const proposal = pendingTok ? verifyExpenseConfirmToken(pendingTok) : null;
    if (!proposal) {
      return { ok: true, brain: "financial_capture", replyText: "Nothing pending. Send the financial detail again." };
    }
    await clearFinancialConfirmPending(sb, actorKey);
    return executeConfirmedCapture(sb, proposal, readActorLabel(routerParameter), traceId, channel);
  }

  if (!bodyRaw) {
    return { ok: true, brain: "financial_capture", replyText: "Send a financial detail — e.g. \"paid water bill $418 [property]\" or \"apt 3A [property] paid rent $1800 cash\"." };
  }

  // ── Extract signal ──
  await appendEventLog({ traceId, log_kind: "portal", event: "FINANCIAL_CAPTURE_ATTEMPT", payload: { channel } });

  const signal = await extractFinancialSignal(bodyRaw);

  if (signal.kind === "unknown" || signal.amount_cents == null) {
    return {
      ok: true,
      brain: "financial_capture",
      replyText: "Could not extract a clear financial intent. Try: \"paid water bill $418 [property]\" or \"unit 3A paid rent $1800\".",
    };
  }

  // ── Resolve property ──
  const pageContext = readFinancialPageContext(routerParameter);
  const propertyCode = await resolvePropertyCode(sb, signal.property_hint, pageContext);
  if (!propertyCode) {
    return {
      ok: true,
      brain: "financial_capture",
      replyText: `Which property? I couldn't match "${signal.property_hint || "?"}" to one of your properties.`,
    };
  }

  // ── Resolve unit (required for payments/charges/waivers) ──
  let unitId = null;
  let unitLabel = null;
  if (signal.unit_hint) {
    unitId = await resolveUnitCatalogId(sb, propertyCode, signal.unit_hint);
    unitLabel = signal.unit_hint;
    if (!unitId && (signal.kind === "payment" || signal.kind === "charge" || signal.kind === "waiver")) {
      return {
        ok: true,
        brain: "financial_capture",
        replyText: `Unit "${signal.unit_hint}" not found in ${propertyCode}. Check the unit label and try again.`,
      };
    }
  } else if (signal.kind === "payment" || signal.kind === "charge" || signal.kind === "waiver") {
    return {
      ok: true,
      brain: "financial_capture",
      replyText: `Which unit? Include the apartment number — e.g. "unit 3A".`,
    };
  }

  const expenseDate = fmtDate(signal.date_hint) || todayIso();

  // ── Build proposal ──
  const proposal = {
    kind: signal.kind,
    propertyCode,
    unitId,
    unitLabel,
    amountCents: signal.amount_cents,
    category: signal.category_hint || (signal.kind === "expense" ? "other" : null),
    vendor: signal.vendor_hint || "",
    method: signal.method_hint || "",
    reference: signal.reference_hint || "",
    description: buildDescription(signal),
    expenseDate,
    notes: "",
    op: "financial_capture",
    proposal_id: crypto.randomUUID(),
    exp: Date.now() + 10 * 60 * 1000,
  };

  const summary = buildDraftSummary(proposal);

  // ── High confidence: auto-confirm from portal UI (countdown) ──
  // For non-portal channels (SMS/TG), always require explicit YES
  const confirmToken = buildExpenseConfirmToken(proposal);

  if (channel !== "portal") {
    await stashFinancialConfirmPending(sb, actorKey, confirmToken);
    return {
      ok: true,
      brain: "financial_capture",
      replyText: `${summary} Reply YES to confirm or send corrections.`,
      resolution: {
        needsConfirm: true,
        confirmToken,
        confirmSummary: summary,
        confidence: signal.confidence,
      },
    };
  }

  // Portal: return draft for inline confirm card (countdown auto-post)
  return {
    ok: true,
    brain: "financial_capture",
    replyText: summary,
    resolution: {
      needsConfirm: true,
      confirmToken,
      confirmSummary: summary,
      confidence: signal.confidence,
      financialKind: signal.kind,
    },
  };
}

function buildDescription(signal) {
  const parts = [];
  if (signal.kind === "expense") {
    if (signal.vendor_hint) parts.push(signal.vendor_hint);
    if (signal.category_hint) parts.push(CATEGORY_LABEL[signal.category_hint] || signal.category_hint);
  } else if (signal.kind === "payment") {
    parts.push("Rent payment");
    if (signal.method_hint) parts.push(signal.method_hint);
    if (signal.reference_hint) parts.push(`#${signal.reference_hint}`);
  } else if (signal.kind === "charge") {
    parts.push("Charge");
  } else if (signal.kind === "waiver") {
    parts.push("Waiver");
  }
  return parts.join(" · ") || "Financial entry";
}

module.exports = { handleFinancialCapture, isPortalFinancialMode };
