/**
 * Leasehold adapter — snapshot fact → lease_terms_sync intent signal.
 * Transport/parse only; brain validates and posts.
 */

const { buildLeaseShellLhPatch } = require("../../brain/financial/leaseImportFacts");
const {
  LEASE_TERMS_SYNC_KIND,
  buildLeaseTermsIdempotencyKey,
} = require("../../brain/financial/leaseTermsSyncSignal");

/**
 * @param {{
 *   propertyCode: string;
 *   unitId: string;
 *   unitLabel?: string;
 *   fact: Record<string, unknown>;
 *   syncedAt: string;
 *   existingShell?: Record<string, unknown> | null;
 * }} opts
 * @returns {Record<string, unknown> | null}
 */
function normalizeLeaseholdFactToLeaseTermsSync(opts) {
  const propertyCode = String(opts.propertyCode ?? "").trim().toUpperCase();
  const unitId = String(opts.unitId ?? "").trim();
  const syncedAt = String(opts.syncedAt ?? new Date().toISOString());
  const fact = opts.fact && typeof opts.fact === "object" ? opts.fact : null;
  if (!propertyCode || !unitId || !fact) return null;

  const unitLabel =
    String(opts.unitLabel ?? fact.unit_label ?? "").trim() || unitId.slice(0, 8);

  const built = buildLeaseShellLhPatch(fact, opts.existingShell ?? null, syncedAt);
  if (!built) return null;

  const body = { ...built.patch };
  if (built.hasNetRent && !body.net_rent_derived_at) {
    body.net_rent_derived_at = syncedAt;
  }
  if (built.hasDeposits && !body.deposits_derived_at) {
    body.deposits_derived_at = syncedAt;
  }

  return {
    schema_version: 1,
    kind: LEASE_TERMS_SYNC_KIND,
    source_channel: "leasehold_import",
    property_code: propertyCode,
    unit_catalog_id: unitId,
    unit_label: unitLabel,
    idempotency_key: buildLeaseTermsIdempotencyKey({
      sourceSystem: "leasehold",
      propertyCode,
      unitLabel,
      effectiveAt: syncedAt,
      body,
    }),
    effective_at: syncedAt,
    body,
  };
}

/**
 * @param {string} propertyCode
 * @param {Array<{ unitId: string; fact: Record<string, unknown>; unitLabel?: string }>} matched
 * @param {string} syncedAt
 * @param {Map<string, Record<string, unknown>>} existingByUnit
 */
function matchedFactsToLeaseTermsSignals(propertyCode, matched, syncedAt, existingByUnit) {
  const signals = [];
  let skippedVacant = 0;

  for (const row of matched) {
    const unitId = String(row.unitId ?? "").trim();
    const fact = row.fact && typeof row.fact === "object" ? row.fact : null;
    if (!unitId || !fact) continue;

    const signal = normalizeLeaseholdFactToLeaseTermsSync({
      propertyCode,
      unitId,
      unitLabel: row.unitLabel,
      fact,
      syncedAt,
      existingShell: existingByUnit?.get(unitId) ?? null,
    });

    if (!signal) {
      skippedVacant += 1;
      continue;
    }
    signals.push(signal);
  }

  return { signals, skippedVacant };
}

module.exports = {
  normalizeLeaseholdFactToLeaseTermsSync,
  matchedFactsToLeaseTermsSignals,
};
