/** Parse Leasehold snapshot payload fragments — brain-only, no app dependency. */

/**
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {Array<{ category: string; label: string; amount_cents: number | null; last_posted_at: string | null; recurring: boolean; source?: string }>}
 */
function parseAccountingAncillaryCharges(payload) {
  const raw = payload?.ancillary_charges;
  if (!Array.isArray(raw)) return [];

  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const amountRaw = row.amount_cents;
    const amountCents =
      amountRaw == null || amountRaw === ""
        ? null
        : Number.isFinite(Number(amountRaw))
          ? Math.round(Number(amountRaw))
          : null;
    const date = String(row.last_posted_at ?? "").trim().slice(0, 10);
    out.push({
      category: String(row.category ?? "other").trim().toLowerCase() || "other",
      label: String(row.label ?? row.category ?? "Charge").trim() || "Charge",
      amount_cents: amountCents,
      last_posted_at: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      recurring: row.recurring !== false,
      source: row.source != null ? String(row.source) : undefined,
    });
  }
  return out;
}

/**
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {Array<{ date: string; kind: string; description: string; amount_cents: number | null; balance_after_cents: number | null }>}
 */
function parseAccountingPostedTransactions(payload) {
  const raw = payload?.posted_transactions;
  if (!Array.isArray(raw)) return [];

  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const date = String(row.date ?? "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const amountRaw = row.amount_cents;
    const balanceRaw = row.balance_after_cents;
    const amountCents =
      amountRaw == null || amountRaw === ""
        ? null
        : Number.isFinite(Number(amountRaw))
          ? Math.round(Number(amountRaw))
          : null;
    const balanceAfterCents =
      balanceRaw == null || balanceRaw === ""
        ? null
        : Number.isFinite(Number(balanceRaw))
          ? Math.round(Number(balanceRaw))
          : null;

    out.push({
      date,
      kind: String(row.kind ?? "other").trim().toLowerCase() || "other",
      description: String(row.description ?? row.kind ?? "Posted").trim().slice(0, 200) || "Posted",
      amount_cents: amountCents,
      balance_after_cents: balanceAfterCents,
    });
  }
  return out;
}

module.exports = {
  parseAccountingAncillaryCharges,
  parseAccountingPostedTransactions,
};
