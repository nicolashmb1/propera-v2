const { financeLedgerEnabled } = require("../config/env");

/**
 * Idempotent ledger payment for a succeeded Stripe checkout row.
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {Record<string, unknown>} paymentRow — tenant_stripe_payments row
 */
async function postStripePaymentToLedger(sb, paymentRow) {
  if (!financeLedgerEnabled()) {
    return { ok: true, skipped: true, reason: "ledger_disabled" };
  }

  const paymentId = paymentRow.id;
  if (!paymentId) return { ok: false, error: "missing_payment_id" };
  if (paymentRow.ledger_entry_id) {
    return { ok: true, skipped: true, ledgerEntryId: paymentRow.ledger_entry_id };
  }

  const { data: existing } = await sb
    .from("tenant_ledger_entries")
    .select("id")
    .eq("source_type", "stripe_checkout")
    .eq("source_id", paymentId)
    .maybeSingle();

  if (existing?.id) {
    await sb
      .from("tenant_stripe_payments")
      .update({ ledger_entry_id: existing.id })
      .eq("id", paymentId);
    return { ok: true, skipped: true, ledgerEntryId: existing.id };
  }

  const baseCents = Math.round(Number(paymentRow.base_cents) || 0);
  if (baseCents <= 0) return { ok: false, error: "invalid_base_cents" };

  const methodLabel = paymentRow.payment_method === "card" ? "Card" : "ACH";
  const ref = String(paymentRow.client_reference_id || "").trim();
  const description = ref
    ? `Stripe ${methodLabel} payment — ${ref}`
    : `Stripe ${methodLabel} payment`;

  const row = {
    property_code: String(paymentRow.property_code || "").trim().toUpperCase(),
    unit_catalog_id: paymentRow.unit_catalog_id || null,
    tenant_roster_id: paymentRow.tenant_roster_id || null,
    ticket_id: null,
    source_type: "stripe_checkout",
    source_id: paymentId,
    entry_kind: "payment",
    amount_cents: baseCents,
    currency: "USD",
    description,
    notes: paymentRow.checkout_session_id
      ? `Stripe session ${paymentRow.checkout_session_id}`
      : "",
    status: "posted",
    effective_date: new Date().toISOString().slice(0, 10),
  };

  const { data, error } = await sb.from("tenant_ledger_entries").insert(row).select("id").maybeSingle();
  if (error) return { ok: false, error: error.message };

  await sb
    .from("tenant_stripe_payments")
    .update({ ledger_entry_id: data.id })
    .eq("id", paymentId);

  return { ok: true, ledgerEntryId: data.id };
}

module.exports = { postStripePaymentToLedger };
