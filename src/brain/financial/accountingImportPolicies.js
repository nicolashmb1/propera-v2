/**
 * Step 4 — policy hooks after accounting import signals post successfully.
 * Reacts to mirrored LH facts; does not post competing charges or write back to Leasehold.
 */

const {
  currentPeriodKey,
  resolveTenantRosterIdsForUnit,
  recordPaidUpReminderSuppressions,
} = require("../../dal/balanceReminderSuppression");
const { validateLedgerEventSignal } = require("./ledgerEventSignal");

const PAID_UP_ACTIONS = new Set(["created", "skipped_existing"]);

/**
 * @param {Record<string, unknown>} rawSignal
 * @returns {number | null}
 */
function readBalanceAfterCents(rawSignal) {
  const validated = validateLedgerEventSignal(rawSignal);
  if (!validated.ok) return null;
  const body = validated.signal.body ?? {};
  const value = body.balance_after_cents;
  if (value == null) return null;
  return Number(value);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {Record<string, unknown>} rawSignal
 * @param {{ action?: string }} postResult
 */
async function applyPaymentReceivedReminderPolicy(sb, rawSignal, postResult) {
  const kind = String(rawSignal?.kind ?? "").trim();
  if (kind !== "payment_received") {
    return { ok: true, skipped: "not_payment_received" };
  }
  if (!PAID_UP_ACTIONS.has(String(postResult?.action ?? ""))) {
    return { ok: true, skipped: "not_posted" };
  }

  const balanceAfter = readBalanceAfterCents(rawSignal);
  if (balanceAfter == null) {
    return { ok: true, skipped: "missing_balance_after" };
  }
  if (balanceAfter > 0) {
    return { ok: true, skipped: "partial_balance_remaining" };
  }

  const validated = validateLedgerEventSignal(rawSignal);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const signal = validated.signal;
  const tenantIds = await resolveTenantRosterIdsForUnit(
    sb,
    signal.property_code,
    signal.unit_catalog_id
  );
  if (!tenantIds.length) {
    return { ok: true, skipped: "no_tenant_roster", unit_catalog_id: signal.unit_catalog_id };
  }

  const periodKey = currentPeriodKey();

  return recordPaidUpReminderSuppressions(sb, {
    tenantIds,
    periodKey,
    sourceType: "accounting_import",
    sourceRef: signal.idempotency_key,
    propertyCode: signal.property_code,
    unitCatalogId: signal.unit_catalog_id,
    paymentAmountCents: signal.body.amount_cents,
    paymentEffectiveDate: signal.body.effective_date,
    reason: "payment_received_paid_up",
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {Array<{ signal: Record<string, unknown>; result: Record<string, unknown> }>} outcomes
 */
async function runAccountingImportPolicies(sb, outcomes) {
  if (!sb || !Array.isArray(outcomes) || !outcomes.length) {
    return { payment_suppressions: [] };
  }

  const paymentSuppressions = [];
  for (const item of outcomes) {
    const out = await applyPaymentReceivedReminderPolicy(sb, item.signal, item.result);
    if (
      out.policy ||
      (out.skipped &&
        out.skipped !== "not_payment_received" &&
        out.skipped !== "not_posted")
    ) {
      paymentSuppressions.push(out);
    }
  }

  return { payment_suppressions: paymentSuppressions };
}

module.exports = {
  applyPaymentReceivedReminderPolicy,
  runAccountingImportPolicies,
  readBalanceAfterCents,
};
