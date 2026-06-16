/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ propertyCode: string, unitId: string, limit?: number }} opts
 */
async function listStripePaymentsForUnit(sb, opts) {
  const propertyCode = String(opts.propertyCode || "").trim().toUpperCase();
  const unitId = String(opts.unitId || "").trim();
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 20));
  if (!propertyCode || !unitId) return { ok: false, error: "missing_context", payments: [] };

  const { data, error } = await sb
    .from("tenant_stripe_payments")
    .select(
      "id, checkout_session_id, payment_intent_id, payment_method, status, base_cents, fee_cents, total_cents, client_reference_id, ledger_entry_id, failure_message, created_at, updated_at"
    )
    .eq("property_code", propertyCode)
    .eq("unit_catalog_id", unitId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return { ok: false, error: error.message, payments: [] };

  return {
    ok: true,
    payments: (data || []).map((row) => ({
      id: row.id,
      sessionId: row.checkout_session_id,
      paymentIntentId: row.payment_intent_id,
      method: row.payment_method,
      status: row.status,
      baseCents: Number(row.base_cents),
      feeCents: Number(row.fee_cents),
      totalCents: Number(row.total_cents),
      clientReferenceId: row.client_reference_id,
      ledgerEntryId: row.ledger_entry_id,
      failureMessage: row.failure_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

module.exports = { listStripePaymentsForUnit };
