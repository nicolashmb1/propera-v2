/**
 * Resident portal account balance — read-only Leasehold snapshot for the logged-in unit.
 */

const PRIMARY_SOURCE = "leasehold";
const RECENT_TX_LIMIT = 20;

function mapTransaction(tx) {
  return {
    date: String(tx.date || "").slice(0, 10) || null,
    kind: String(tx.kind || "other").trim().toLowerCase() || "other",
    description: String(tx.description || tx.kind || "Posted").trim().slice(0, 120) || "Posted",
    amountCents:
      tx.amount_cents == null || tx.amount_cents === ""
        ? null
        : Number.isFinite(Number(tx.amount_cents))
          ? Math.round(Number(tx.amount_cents))
          : null,
    balanceAfterCents:
      tx.balance_after_cents == null || tx.balance_after_cents === ""
        ? null
        : Number.isFinite(Number(tx.balance_after_cents))
          ? Math.round(Number(tx.balance_after_cents))
          : null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ tenantId: string, unitId?: string, propertyCode?: string }} ctx
 */
async function getTenantAccountBalance(sb, ctx) {
  const unitId = String(ctx.unitId || "").trim();
  const propertyCode = String(ctx.propertyCode || "").trim().toUpperCase();
  if (!unitId) return { ok: false, error: "missing_unit_context" };

  const { data, error } = await sb
    .from("tenant_account_snapshots")
    .select(
      "unit_catalog_id, property_code, source_system, synced_at, rent_cents, balance_cents, balance_status, lease_start, lease_end, last_payment_at, last_payment_cents, payload_json"
    )
    .eq("unit_catalog_id", unitId)
    .eq("source_system", PRIMARY_SOURCE)
    .maybeSingle();

  if (error) {
    if (/tenant_account_snapshots|does not exist/i.test(error.message)) {
      return { ok: true, available: false, reason: "not_configured" };
    }
    return { ok: false, error: error.message };
  }

  if (!data) return { ok: true, available: false, reason: "no_snapshot" };

  const snapshotProperty = String(data.property_code || "").trim().toUpperCase();
  if (propertyCode && snapshotProperty && propertyCode !== snapshotProperty) {
    return { ok: false, error: "property_mismatch" };
  }

  const posted = Array.isArray(data.payload_json?.posted_transactions)
    ? data.payload_json.posted_transactions
    : [];

  const recentTransactions = [...posted]
    .filter((tx) => tx?.date)
    .sort((a, b) => {
      if (a.date !== b.date) return String(b.date).localeCompare(String(a.date));
      return (Number(b.posted_sequence) || 0) - (Number(a.posted_sequence) || 0);
    })
    .slice(0, RECENT_TX_LIMIT)
    .map(mapTransaction);

  return {
    ok: true,
    available: true,
    balanceCents: data.balance_cents != null ? Number(data.balance_cents) : null,
    balanceStatus: String(data.balance_status || "unknown"),
    rentCents: data.rent_cents != null ? Number(data.rent_cents) : null,
    lastPaymentAt: data.last_payment_at || null,
    lastPaymentCents:
      data.last_payment_cents != null ? Number(data.last_payment_cents) : null,
    leaseStart: data.lease_start || null,
    leaseEnd: data.lease_end || null,
    syncedAt: data.synced_at || null,
    recentTransactions,
  };
}

module.exports = { getTenantAccountBalance };
