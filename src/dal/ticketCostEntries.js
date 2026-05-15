/**
 * Ticket cost entries — operational finance V1 (portal; feature-flagged).
 * @see docs/PROPERA_FINANCIAL_LAYER_MAP.md
 */
const { getSupabase } = require("../db/supabase");
const {
  financeLedgerEnabled,
} = require("../config/env");

const TICKET_ROW_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TARGET_KINDS = new Set([
  "UNIT",
  "PROPERTY_LOCATION",
  "PROPERTY_WIDE",
  "TURNOVER",
  "PROGRAM",
  "OTHER",
]);
const ENTRY_TYPES = new Set([
  "parts",
  "labor",
  "vendor_invoice",
  "cleaning",
  "permit",
  "other",
]);
const PAID_STATUSES = new Set(["unpaid", "paid", "reimbursed", "unknown"]);
const CHARGE_STATUSES = new Set([
  "not_chargeable",
  "needs_review",
  "approved",
  "charged",
  "paid",
  "waived",
]);

function normStr(v) {
  return String(v || "").trim();
}

function moneyDetailLine(amountCents, currency) {
  const c = Number(amountCents) || 0;
  const cur = normStr(currency) || "USD";
  const n = (c / 100).toFixed(2);
  return `${cur} ${n}`;
}

async function fetchTicketRow(sb, ticketRowId) {
  const id = normStr(ticketRowId);
  if (!id || !TICKET_ROW_UUID_RE.test(id)) return null;
  const { data, error } = await sb
    .from("tickets")
    .select(
      "id, ticket_id, property_code, unit_label, unit_catalog_id, location_id, location_label_snapshot, tenant_phone_e164, is_imported_history"
    )
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

function normUnitLabel(u) {
  return String(u || "")
    .trim()
    .toUpperCase()
    .replace(/\s/g, "");
}

async function resolveTenantRosterId(sb, ticket) {
  const phone = normStr(ticket.tenant_phone_e164);
  const prop = normStr(ticket.property_code).toUpperCase();
  const unitWant = normUnitLabel(ticket.unit_label);
  if (!phone || !prop) return null;
  const { data: rows } = await sb
    .from("tenant_roster")
    .select("id, unit_label, updated_at")
    .eq("phone_e164", phone)
    .eq("active", true)
    .eq("property_code", prop)
    .order("updated_at", { ascending: false })
    .limit(20);
  const list = rows || [];
  const exact = list.find((r) => normUnitLabel(r.unit_label) === unitWant);
  const pick = exact || list[0];
  return pick && pick.id ? String(pick.id) : null;
}

async function insertTimeline(sb, ticketId, kind, headline, detail, actor) {
  const label = normStr(actor).slice(0, 200) || "Portal";
  const { error } = await sb.from("ticket_timeline_events").insert({
    ticket_id: ticketId,
    occurred_at: new Date().toISOString(),
    event_kind: kind,
    headline: normStr(headline).slice(0, 500) || kind,
    detail: normStr(detail).slice(0, 2000),
    actor_label: label,
    actor_type: "STAFF",
    actor_id: "",
    actor_source: "propera_app",
  });
  if (error) throw new Error(error.message);
}

function validateTargetPayload(row) {
  const tk = normStr(row.target_kind).toUpperCase();
  if (!TARGET_KINDS.has(tk)) return { ok: false, error: "invalid_target_kind" };
  if (tk === "UNIT" && !normStr(row.unit_catalog_id)) {
    return { ok: false, error: "unit_catalog_id_required_for_unit_target" };
  }
  if (tk === "PROPERTY_LOCATION" && !normStr(row.location_id)) {
    return { ok: false, error: "location_id_required_for_property_location_target" };
  }
  return { ok: true, target_kind: tk };
}

function mapRowToApi(r) {
  if (!r) return null;
  return {
    id: String(r.id),
    ticketId: String(r.ticket_id),
    propertyCode: normStr(r.property_code).toUpperCase(),
    workItemId: r.work_item_id ? String(r.work_item_id) : null,
    targetKind: normStr(r.target_kind),
    unitCatalogId: r.unit_catalog_id ? String(r.unit_catalog_id) : null,
    unitLabelSnapshot: normStr(r.unit_label_snapshot),
    locationId: r.location_id ? String(r.location_id) : null,
    locationLabelSnapshot: normStr(r.location_label_snapshot),
    tenantRosterId: r.tenant_roster_id ? String(r.tenant_roster_id) : null,
    entryType: normStr(r.entry_type),
    amountCents: Number(r.amount_cents) || 0,
    currency: normStr(r.currency) || "USD",
    vendorName: normStr(r.vendor_name),
    description: normStr(r.description),
    paidBy: normStr(r.paid_by),
    paidStatus: normStr(r.paid_status),
    attachmentUrls: Array.isArray(r.attachment_urls) ? r.attachment_urls : [],
    tenantChargeAmountCents:
      r.tenant_charge_amount_cents == null ? null : Number(r.tenant_charge_amount_cents),
    tenantChargeStatus: normStr(r.tenant_charge_status),
    tenantChargeReason: normStr(r.tenant_charge_reason),
    chargeDecisionBy: normStr(r.charge_decision_by),
    chargeDecisionAt: r.charge_decision_at ? String(r.charge_decision_at) : null,
    ledgerPostedAt: r.ledger_posted_at ? String(r.ledger_posted_at) : null,
    createdBy: normStr(r.created_by),
    createdAt: r.created_at ? String(r.created_at) : "",
    updatedAt: r.updated_at ? String(r.updated_at) : "",
  };
}

/**
 * @param {string} ticketRowId — tickets.id UUID
 */
async function listTicketCostEntriesForPortal(ticketRowId) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const ticket = await fetchTicketRow(sb, ticketRowId);
  if (!ticket) return { ok: false, error: "ticket_not_found" };
  const { data, error } = await sb
    .from("ticket_cost_entries")
    .select("*")
    .eq("ticket_id", ticket.id)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, entries: (data || []).map(mapRowToApi) };
}

/**
 * @param {object} body
 */
async function createTicketCostEntryForPortal(ticketRowId, body) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const ticket = await fetchTicketRow(sb, ticketRowId);
  if (!ticket) return { ok: false, error: "ticket_not_found" };
  if (ticket.is_imported_history === true) {
    return { ok: false, error: "imported_history_read_only" };
  }

  const propTicket = normStr(ticket.property_code).toUpperCase();
  const propBody = normStr(body.propertyCode || body.property_code).toUpperCase();
  if (propBody && propBody !== propTicket) {
    return { ok: false, error: "property_code_mismatch" };
  }

  const vt = validateTargetPayload(body);
  if (!vt.ok) return { ok: false, error: vt.error };

  const entryType = normStr(body.entryType || body.entry_type).toLowerCase();
  if (!ENTRY_TYPES.has(entryType)) return { ok: false, error: "invalid_entry_type" };

  const amountCents = Math.round(Number(body.amountCents ?? body.amount_cents));
  if (!Number.isFinite(amountCents) || amountCents < 0) {
    return { ok: false, error: "invalid_amount_cents" };
  }

  const paidStatus = normStr(body.paidStatus || body.paid_status || "unknown").toLowerCase();
  if (!PAID_STATUSES.has(paidStatus)) return { ok: false, error: "invalid_paid_status" };

  let chargeStatus = normStr(
    body.tenantChargeStatus || body.tenant_charge_status || "not_chargeable"
  ).toLowerCase();
  if (!CHARGE_STATUSES.has(chargeStatus)) chargeStatus = "not_chargeable";

  let chargeAmt =
    body.tenantChargeAmountCents != null || body.tenant_charge_amount_cents != null
      ? Math.round(Number(body.tenantChargeAmountCents ?? body.tenant_charge_amount_cents))
      : null;
  if (chargeStatus === "not_chargeable" || chargeStatus === "waived") {
    chargeAmt = chargeAmt == null ? 0 : chargeAmt;
  }
  if (chargeAmt != null && (!Number.isFinite(chargeAmt) || chargeAmt < 0)) {
    return { ok: false, error: "invalid_tenant_charge_amount_cents" };
  }

  const attachments = Array.isArray(body.attachmentUrls || body.attachment_urls)
    ? body.attachmentUrls || body.attachment_urls
    : [];

  const tenantRosterId =
    (await resolveTenantRosterId(sb, ticket)) ||
    (body.tenantRosterId || body.tenant_roster_id
      ? normStr(body.tenantRosterId || body.tenant_roster_id)
      : null);

  const nowIso = new Date().toISOString();
  let chargeDecisionAt = null;
  let chargeDecisionBy = normStr(body.chargeDecisionBy || body.charge_decision_by);
  if (chargeStatus === "approved" || chargeStatus === "charged" || chargeStatus === "paid") {
    chargeDecisionAt = nowIso;
    if (!chargeDecisionBy) chargeDecisionBy = normStr(body.createdBy || body.created_by);
  }

  const insertRow = {
    ticket_id: ticket.id,
    work_item_id: normStr(body.workItemId || body.work_item_id) || null,
    property_code: propTicket,
    target_kind: vt.target_kind,
    unit_catalog_id: normStr(body.unitCatalogId || body.unit_catalog_id) || null,
    unit_label_snapshot: normStr(body.unitLabelSnapshot || body.unit_label_snapshot),
    location_id: normStr(body.locationId || body.location_id) || null,
    location_label_snapshot: normStr(body.locationLabelSnapshot || body.location_label_snapshot),
    tenant_roster_id: tenantRosterId,
    entry_type: entryType,
    amount_cents: amountCents,
    currency: normStr(body.currency || "USD").slice(0, 8) || "USD",
    vendor_name: normStr(body.vendorName || body.vendor_name).slice(0, 240),
    description: normStr(body.description).slice(0, 2000),
    paid_by: normStr(body.paidBy || body.paid_by).slice(0, 120),
    paid_status: paidStatus,
    attachment_urls: attachments,
    tenant_charge_amount_cents: chargeAmt,
    tenant_charge_status: chargeStatus,
    tenant_charge_reason: normStr(body.tenantChargeReason || body.tenant_charge_reason).slice(
      0,
      2000
    ),
    charge_decision_by: chargeDecisionBy.slice(0, 200),
    charge_decision_at: chargeDecisionAt,
    created_by: normStr(body.createdBy || body.created_by).slice(0, 200),
  };

  const { data, error } = await sb.from("ticket_cost_entries").insert(insertRow).select("*").single();
  if (error) return { ok: false, error: error.message };

  await insertTimeline(
    sb,
    ticket.id,
    "cost_added",
    `Cost added (${entryType})`,
    moneyDetailLine(amountCents, insertRow.currency) +
      (insertRow.vendor_name ? ` — ${insertRow.vendor_name}` : ""),
    insertRow.created_by
  );

  const ledgerOut = await maybePostTicketChargeToLedger(sb, data, ticket, insertRow.created_by);
  if (!ledgerOut.ok) return ledgerOut;

  return { ok: true, entry: mapRowToApi(data) };
}

async function maybePostTicketChargeToLedger(sb, costRow, ticket, actorLabel) {
  if (!financeLedgerEnabled()) return { ok: true };

  const st = normStr(costRow.tenant_charge_status).toLowerCase();
  const amt = Number(costRow.tenant_charge_amount_cents);
  if (!(st === "approved" || st === "charged" || st === "paid") || !amt || amt <= 0) {
    return { ok: true };
  }
  if (costRow.ledger_posted_at) return { ok: true };

  const rosterId =
    costRow.tenant_roster_id || (await resolveTenantRosterId(sb, ticket)) || null;
  const desc =
    normStr(costRow.description) ||
    `Maintenance charge (ticket ${normStr(ticket.ticket_id)})`;

  const ledgerInsert = {
    property_code: normStr(costRow.property_code).toUpperCase(),
    unit_catalog_id: costRow.unit_catalog_id || null,
    tenant_roster_id: rosterId,
    ticket_id: ticket.id,
    source_type: "ticket_cost_entry",
    source_id: costRow.id,
    entry_kind: "charge",
    amount_cents: amt,
    currency: normStr(costRow.currency) || "USD",
    description: desc.slice(0, 2000),
    status: "posted",
  };

  const { error: leErr } = await sb.from("tenant_ledger_entries").insert(ledgerInsert);
  if (leErr) {
    if (String(leErr.message || "").includes("duplicate") || String(leErr.code) === "23505") {
      return { ok: true };
    }
    return { ok: false, error: leErr.message };
  }

  const { error: upErr } = await sb
    .from("ticket_cost_entries")
    .update({ ledger_posted_at: new Date().toISOString() })
    .eq("id", costRow.id);
  if (upErr) return { ok: false, error: upErr.message };

  await insertTimeline(
    sb,
    ticket.id,
    "tenant_charge_decision",
    "Tenant charge posted to ledger",
    moneyDetailLine(amt, ledgerInsert.currency),
    actorLabel || "Portal"
  );

  return { ok: true };
}

async function voidLedgerForCostEntry(sb, costId) {
  const { data: rows } = await sb
    .from("tenant_ledger_entries")
    .select("id")
    .eq("source_type", "ticket_cost_entry")
    .eq("source_id", costId)
    .eq("status", "posted")
    .limit(5);
  for (const r of rows || []) {
    await sb
      .from("tenant_ledger_entries")
      .update({ status: "voided", updated_at: new Date().toISOString() })
      .eq("id", r.id);
  }
  await sb
    .from("ticket_cost_entries")
    .update({ ledger_posted_at: null })
    .eq("id", costId);
}

/**
 * @param {string} entryId — ticket_cost_entries.id
 */
async function updateTicketCostEntryForPortal(entryId, body) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const eid = normStr(entryId);
  if (!eid || !TICKET_ROW_UUID_RE.test(eid)) return { ok: false, error: "invalid_entry_id" };

  const { data: existing, error: exErr } = await sb
    .from("ticket_cost_entries")
    .select("*")
    .eq("id", eid)
    .maybeSingle();
  if (exErr || !existing) return { ok: false, error: "not_found" };

  const ticket = await fetchTicketRow(sb, existing.ticket_id);
  if (!ticket) return { ok: false, error: "ticket_not_found" };
  if (ticket.is_imported_history === true) {
    return { ok: false, error: "imported_history_read_only" };
  }

  const patch = {};
  if ("workItemId" in body || "work_item_id" in body) {
    patch.work_item_id = normStr(body.workItemId || body.work_item_id) || null;
  }
  if ("targetKind" in body || "target_kind" in body || "unitCatalogId" in body) {
    const merged = {
      target_kind: body.targetKind || body.target_kind || existing.target_kind,
      unit_catalog_id: body.unitCatalogId ?? body.unit_catalog_id ?? existing.unit_catalog_id,
      location_id: body.locationId ?? body.location_id ?? existing.location_id,
    };
    const vt = validateTargetPayload(merged);
    if (!vt.ok) return { ok: false, error: vt.error };
    patch.target_kind = vt.target_kind;
    patch.unit_catalog_id = normStr(merged.unit_catalog_id) || null;
    patch.location_id = normStr(merged.location_id) || null;
  }
  if ("unitLabelSnapshot" in body || "unit_label_snapshot" in body) {
    patch.unit_label_snapshot = normStr(body.unitLabelSnapshot || body.unit_label_snapshot);
  }
  if ("locationLabelSnapshot" in body || "location_label_snapshot" in body) {
    patch.location_label_snapshot = normStr(
      body.locationLabelSnapshot || body.location_label_snapshot
    );
  }
  if ("entryType" in body || "entry_type" in body) {
    const et = normStr(body.entryType || body.entry_type).toLowerCase();
    if (!ENTRY_TYPES.has(et)) return { ok: false, error: "invalid_entry_type" };
    patch.entry_type = et;
  }
  if ("amountCents" in body || "amount_cents" in body) {
    const ac = Math.round(Number(body.amountCents ?? body.amount_cents));
    if (!Number.isFinite(ac) || ac < 0) return { ok: false, error: "invalid_amount_cents" };
    patch.amount_cents = ac;
  }
  if ("currency" in body) patch.currency = normStr(body.currency).slice(0, 8) || "USD";
  if ("vendorName" in body || "vendor_name" in body) {
    patch.vendor_name = normStr(body.vendorName || body.vendor_name).slice(0, 240);
  }
  if ("description" in body) patch.description = normStr(body.description).slice(0, 2000);
  if ("paidBy" in body || "paid_by" in body) {
    patch.paid_by = normStr(body.paidBy || body.paid_by).slice(0, 120);
  }
  if ("paidStatus" in body || "paid_status" in body) {
    const ps = normStr(body.paidStatus || body.paid_status).toLowerCase();
    if (!PAID_STATUSES.has(ps)) return { ok: false, error: "invalid_paid_status" };
    patch.paid_status = ps;
  }
  if ("attachmentUrls" in body || "attachment_urls" in body) {
    const a = body.attachmentUrls || body.attachment_urls;
    patch.attachment_urls = Array.isArray(a) ? a : existing.attachment_urls;
  }
  if ("tenantChargeAmountCents" in body || "tenant_charge_amount_cents" in body) {
    const tc =
      body.tenantChargeAmountCents != null || body.tenant_charge_amount_cents != null
        ? Math.round(Number(body.tenantChargeAmountCents ?? body.tenant_charge_amount_cents))
        : null;
    if (tc != null && (!Number.isFinite(tc) || tc < 0)) {
      return { ok: false, error: "invalid_tenant_charge_amount_cents" };
    }
    patch.tenant_charge_amount_cents = tc;
  }
  if ("tenantChargeStatus" in body || "tenant_charge_status" in body) {
    const cs = normStr(body.tenantChargeStatus || body.tenant_charge_status).toLowerCase();
    if (!CHARGE_STATUSES.has(cs)) return { ok: false, error: "invalid_tenant_charge_status" };
    patch.tenant_charge_status = cs;
  }
  if ("tenantChargeReason" in body || "tenant_charge_reason" in body) {
    patch.tenant_charge_reason = normStr(
      body.tenantChargeReason || body.tenant_charge_reason
    ).slice(0, 2000);
  }

  const prevCharge = normStr(existing.tenant_charge_status).toLowerCase();
  const nextCharge = normStr(
    patch.tenant_charge_status != null ? patch.tenant_charge_status : existing.tenant_charge_status
  ).toLowerCase();

  if (
    patch.tenant_charge_status &&
    (nextCharge === "approved" || nextCharge === "charged" || nextCharge === "paid")
  ) {
    patch.charge_decision_at = new Date().toISOString();
    patch.charge_decision_by = normStr(
      body.chargeDecisionBy || body.charge_decision_by || body.createdBy || body.created_by
    ).slice(0, 200);
  }

  if (Object.keys(patch).length === 0) {
    return { ok: true, entry: mapRowToApi(existing) };
  }

  const { data: updated, error } = await sb
    .from("ticket_cost_entries")
    .update(patch)
    .eq("id", eid)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };

  const chargeChanged =
    patch.tenant_charge_status != null || patch.tenant_charge_amount_cents != null;
  if (chargeChanged) {
    await insertTimeline(
      sb,
      ticket.id,
      "tenant_charge_decision",
      "Tenant charge updated",
      `${prevCharge} → ${nextCharge}`,
      normStr(body.createdBy || body.created_by) || "Portal"
    );
  } else {
    await insertTimeline(
      sb,
      ticket.id,
      "cost_updated",
      "Cost entry updated",
      normStr(patch.description || existing.description).slice(0, 280),
      normStr(body.createdBy || body.created_by) || "Portal"
    );
  }

  if (nextCharge === "waived" || nextCharge === "not_chargeable") {
    if (existing.ledger_posted_at) {
      await voidLedgerForCostEntry(sb, eid);
    }
  } else {
    const ledgerOut = await maybePostTicketChargeToLedger(sb, updated, ticket, normStr(body.createdBy || body.created_by));
    if (!ledgerOut.ok) return ledgerOut;
  }

  return { ok: true, entry: mapRowToApi(updated) };
}

module.exports = {
  listTicketCostEntriesForPortal,
  createTicketCostEntryForPortal,
  updateTicketCostEntryForPortal,
  mapRowToApi,
};
