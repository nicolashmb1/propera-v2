/**
 * Step 4 — balance reminder suppressions after successful tenant payments.
 * Propera ops only; no Leasehold write-back.
 */

const {
  currentPeriodKey,
  resolveTenantRosterIdsForUnit,
  recordPaidUpReminderSuppressions,
} = require("../../dal/balanceReminderSuppression");

const ACCOUNTING_SOURCE = String(process.env.PROPERA_ACCOUNTING_SOURCE || "leasehold").trim() || "leasehold";

const LEDGER_POSTED = new Set(["created", "skipped_existing"]);

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {Record<string, unknown>} paymentRow
 */
async function stripePaymentCoversBalanceDue(sb, paymentRow) {
  const baseCents = Math.round(Number(paymentRow.base_cents) || 0);
  if (baseCents <= 0) {
    return { ok: true, paidUp: false, reason: "invalid_base_cents" };
  }

  const unitId = String(paymentRow.unit_catalog_id || "").trim();
  if (!unitId) {
    return { ok: true, paidUp: true, reason: "checkout_balance_due" };
  }

  const { data, error } = await sb
    .from("tenant_account_snapshots")
    .select("balance_cents")
    .eq("unit_catalog_id", unitId)
    .eq("source_system", ACCOUNTING_SOURCE)
    .maybeSingle();

  if (error || !data || data.balance_cents == null) {
    return { ok: true, paidUp: true, reason: "checkout_balance_due" };
  }

  const snapshotBalance = Math.max(0, Math.round(Number(data.balance_cents)));
  if (snapshotBalance === 0) {
    return { ok: true, paidUp: true, reason: "snapshot_already_zero" };
  }
  if (baseCents >= snapshotBalance) {
    return { ok: true, paidUp: true, reason: "covers_snapshot_balance" };
  }
  return { ok: true, paidUp: false, reason: "partial_vs_snapshot" };
}

/**
 * @param {Record<string, unknown>} ledgerResult
 */
function stripeLedgerPostAction(ledgerResult) {
  if (!ledgerResult?.ok) return null;
  if (ledgerResult.skipped && ledgerResult.ledgerEntryId) return "skipped_existing";
  if (ledgerResult.ledgerEntryId) return "created";
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {Record<string, unknown>} paymentRow
 */
async function resolveTenantIdsForStripePayment(sb, paymentRow) {
  const tenantId = String(paymentRow.tenant_roster_id || "").trim().toLowerCase();
  if (tenantId) return [tenantId];

  const propertyCode = String(paymentRow.property_code || "").trim().toUpperCase();
  const unitCatalogId = String(paymentRow.unit_catalog_id || "").trim();
  if (!propertyCode || !unitCatalogId) return [];

  return resolveTenantRosterIdsForUnit(sb, propertyCode, unitCatalogId);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {Record<string, unknown>} paymentRow
 * @param {Record<string, unknown>} ledgerResult
 */
async function applyStripeCheckoutReminderPolicy(sb, paymentRow, ledgerResult) {
  const action = stripeLedgerPostAction(ledgerResult);
  if (!action || !LEDGER_POSTED.has(action)) {
    return { ok: true, skipped: "ledger_not_posted" };
  }

  const paymentId = String(paymentRow.id || "").trim();
  if (!paymentId) {
    return { ok: true, skipped: "missing_payment_id" };
  }

  const coverage = await stripePaymentCoversBalanceDue(sb, paymentRow);
  if (!coverage.paidUp) {
    return { ok: true, skipped: coverage.reason || "not_paid_up" };
  }

  const tenantIds = await resolveTenantIdsForStripePayment(sb, paymentRow);
  if (!tenantIds.length) {
    return { ok: true, skipped: "no_tenant_roster", payment_id: paymentId };
  }

  const baseCents = Math.round(Number(paymentRow.base_cents) || 0);
  const propertyCode = String(paymentRow.property_code || "").trim().toUpperCase();
  const effectiveDate = new Date().toISOString().slice(0, 10);

  return recordPaidUpReminderSuppressions(sb, {
    tenantIds,
    periodKey: currentPeriodKey(),
    sourceType: "stripe_checkout",
    sourceRef: `stripe_checkout:${paymentId}`,
    propertyCode,
    unitCatalogId: paymentRow.unit_catalog_id || null,
    paymentAmountCents: baseCents,
    paymentEffectiveDate: effectiveDate,
    reason: "stripe_checkout_paid_up",
    coverage_reason: coverage.reason,
  });
}

module.exports = {
  stripePaymentCoversBalanceDue,
  stripeLedgerPostAction,
  applyStripeCheckoutReminderPolicy,
};
