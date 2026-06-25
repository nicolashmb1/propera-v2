/**
 * Brain — process lease_terms_sync signals (validate → dedupe → post).
 * Channel-agnostic entry for LH import, cockpit, Jarvis, future agents.
 */

const { getSupabase } = require("../../db/supabase");
const { LEASE_TERMS_SYNC_KIND } = require("./leaseTermsSyncSignal");
const {
  postLeaseTermsSync,
  loadExistingLeaseShellsByUnit,
  clearPropertyNetRentDerived,
} = require("./postLeaseTermsSync");
const { matchedFactsToLeaseTermsSignals } = require("../../adapters/leasehold/normalizeLeaseholdFactToLeaseTermsSync");
const { isLedgerEventKind } = require("./ledgerEventSignal");
const {
  postLedgerEventSignal,
  loadExistingImportIdempotencyKeys,
} = require("./postLedgerEventSignal");
const { runAccountingImportPolicies } = require("./accountingImportPolicies");

const UPDATE_CHUNK = 25;

async function runChunked(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    await Promise.all(chunk.map(fn));
  }
}

function normalizeIncomingSignals(body) {
  const raw = Array.isArray(body.signals) ? body.signals : [];
  return raw.filter((s) => s && typeof s === "object");
}

function normalizeMatchedFacts(body) {
  const raw = Array.isArray(body.matched) ? body.matched : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const unitId = String(item.unitId ?? item.unit_id ?? item.unit_catalog_id ?? "").trim();
    const fact = item.fact && typeof item.fact === "object" ? item.fact : item;
    const unitLabel = String(item.unitLabel ?? item.unit_label ?? fact.unit_label ?? "").trim();
    if (!unitId || !fact || typeof fact !== "object") continue;
    out.push({ unitId, fact, unitLabel: unitLabel || undefined });
  }
  return out;
}

/**
 * @param {string} propertyCode
 * @param {Array<Record<string, unknown>>} signals
 */
async function processLeaseTermsSyncSignals(propertyCode, signals) {
  const sb = getSupabase();
  if (!sb) throw new Error("supabase_unavailable");

  const leaseSignals = signals.filter((s) => String(s.kind ?? "").trim() === LEASE_TERMS_SYNC_KIND);
  if (!leaseSignals.length) {
    return {
      created: 0,
      updated: 0,
      skippedVacant: 0,
      skippedUnchanged: 0,
      skippedDuplicateKey: 0,
      rejected: 0,
      netRentEnriched: 0,
      depositsEnriched: 0,
      errors: [],
    };
  }

  const hasLeaseholdImport = leaseSignals.some(
    (s) => String(s.source_channel ?? s.sourceChannel ?? "").trim() === "leasehold_import"
  );
  if (hasLeaseholdImport) {
    await clearPropertyNetRentDerived(sb, propertyCode);
  }

  const loaded = await loadExistingLeaseShellsByUnit(sb, propertyCode);
  if (loaded.migrationMissing) {
    return {
      created: 0,
      updated: 0,
      skippedVacant: 0,
      skippedUnchanged: 0,
      skippedDuplicateKey: 0,
      rejected: leaseSignals.length,
      netRentEnriched: 0,
      depositsEnriched: 0,
      errors: ["migration_missing"],
    };
  }

  const seenKeys = new Set();
  const outcomes = [];

  await runChunked(leaseSignals, UPDATE_CHUNK, async (rawSignal) => {
    const unitId = String(
      rawSignal.unit_catalog_id ?? rawSignal.unitCatalogId ?? ""
    ).trim();
    const existingShell = loaded.byUnit.get(unitId) ?? null;
    const out = await postLeaseTermsSync(sb, rawSignal, {
      existingShell,
      seenIdempotencyKeys: seenKeys,
    });
    outcomes.push(out);
  });

  let created = 0;
  let updated = 0;
  let skippedUnchanged = 0;
  let skippedDuplicateKey = 0;
  let rejected = 0;
  let netRentEnriched = 0;
  let depositsEnriched = 0;
  const errors = [];

  for (const out of outcomes) {
    if (!out.ok) {
      rejected += 1;
      if (out.error) errors.push(String(out.error));
      continue;
    }
    if (out.action === "created") {
      created += 1;
      if (out.has_net_rent) netRentEnriched += 1;
      if (out.has_deposits) depositsEnriched += 1;
    } else if (out.action === "updated") {
      updated += 1;
      if (out.has_net_rent) netRentEnriched += 1;
      if (out.has_deposits) depositsEnriched += 1;
    } else if (out.action === "skipped_unchanged") {
      skippedUnchanged += 1;
    } else if (out.action === "skipped_duplicate_key") {
      skippedDuplicateKey += 1;
    }
  }

  return {
    created,
    updated,
    skippedVacant: 0,
    skippedUnchanged,
    skippedDuplicateKey,
    rejected,
    netRentEnriched,
    depositsEnriched,
    errors: [...new Set(errors)],
  };
}

/**
 * @param {Array<Record<string, unknown>>} signals
 */
async function processLedgerEventSignals(signals) {
  const sb = getSupabase();
  if (!sb) throw new Error("supabase_unavailable");

  const ledgerSignals = signals.filter((s) => isLedgerEventKind(String(s?.kind ?? "").trim()));
  if (!ledgerSignals.length) {
    return {
      ledgerCreated: 0,
      ledgerSkippedExisting: 0,
      ledgerSkippedDuplicateKey: 0,
      ledgerRejected: 0,
      ledgerErrors: [],
    };
  }

  const keys = ledgerSignals.map((s) => String(s.idempotency_key ?? s.idempotencyKey ?? "").trim());
  const existingKeys = await loadExistingImportIdempotencyKeys(sb, keys);
  if (existingKeys === null) {
    return {
      ledgerCreated: 0,
      ledgerSkippedExisting: 0,
      ledgerSkippedDuplicateKey: 0,
      ledgerRejected: ledgerSignals.length,
      ledgerErrors: ["migration_missing"],
    };
  }

  const seenKeys = new Set();
  const outcomes = [];

  const sorted = [...ledgerSignals].sort((a, b) => {
    const da = String(a?.body?.effective_date ?? a?.body?.effectiveDate ?? "").slice(0, 10);
    const db = String(b?.body?.effective_date ?? b?.body?.effectiveDate ?? "").slice(0, 10);
    if (da !== db) return da.localeCompare(db);
    const sa = Number(a?.body?.posted_sequence ?? a?.body?.postedSequence ?? 0);
    const sbSeq = Number(b?.body?.posted_sequence ?? b?.body?.postedSequence ?? 0);
    return sa - sbSeq;
  });

  await runChunked(sorted, UPDATE_CHUNK, async (rawSignal) => {
    const result = await postLedgerEventSignal(sb, rawSignal, {
      seenIdempotencyKeys: seenKeys,
      existingKeys,
    });
    outcomes.push({ signal: rawSignal, result });
  });

  const policyOutcomes = await runAccountingImportPolicies(sb, outcomes);

  let ledgerCreated = 0;
  let ledgerSkippedExisting = 0;
  let ledgerSkippedDuplicateKey = 0;
  let ledgerRejected = 0;
  const ledgerErrors = [];

  for (const item of outcomes) {
    const out = item.result;
    if (!out.ok) {
      ledgerRejected += 1;
      if (out.error) ledgerErrors.push(String(out.error));
      continue;
    }
    if (out.action === "created") ledgerCreated += 1;
    else if (out.action === "skipped_existing") ledgerSkippedExisting += 1;
    else if (out.action === "skipped_duplicate_key") ledgerSkippedDuplicateKey += 1;
  }

  return {
    ledgerCreated,
    ledgerSkippedExisting,
    ledgerSkippedDuplicateKey,
    ledgerRejected,
    ledgerErrors: [...new Set(ledgerErrors)],
    policy: policyOutcomes,
  };
}

/**
 * @param {Record<string, unknown>} body
 */
async function handleAccountingImportSignalsBody(body) {
  const propertyCode = String(body.property_code ?? body.propertyCode ?? "").trim().toUpperCase();
  if (!propertyCode) throw new Error("missing_property_code");

  const syncedAtRaw = String(body.synced_at ?? body.syncedAt ?? "").trim();
  const syncedAt = syncedAtRaw && Number.isFinite(new Date(syncedAtRaw).getTime())
    ? new Date(syncedAtRaw).toISOString()
    : new Date().toISOString();

  let signals = normalizeIncomingSignals(body);
  let skippedVacant = 0;

  if (!signals.length) {
    const matched = normalizeMatchedFacts(body);
    if (!matched.length) throw new Error("empty_signals");

    const sb = getSupabase();
    if (!sb) throw new Error("supabase_unavailable");
    const loaded = await loadExistingLeaseShellsByUnit(sb, propertyCode);
    const converted = matchedFactsToLeaseTermsSignals(
      propertyCode,
      matched,
      syncedAt,
      loaded.byUnit
    );
    signals = converted.signals;
    skippedVacant = converted.skippedVacant;
  }

  if (!signals.length) {
    return {
      ok: true,
      property_code: propertyCode,
      synced_at: syncedAt,
      created: 0,
      updated: 0,
      skipped_vacant: skippedVacant,
      skipped_unchanged: 0,
      skipped_duplicate_key: 0,
      rejected: 0,
      net_rent_enriched: 0,
      deposits_enriched: 0,
      signal_count: 0,
      ledger_created: 0,
      ledger_skipped_existing: 0,
      ledger_skipped_duplicate_key: 0,
      ledger_rejected: 0,
    };
  }

  const leaseSignals = signals.filter(
    (s) => String(s?.kind ?? "").trim() === LEASE_TERMS_SYNC_KIND
  );
  const ledgerSignals = signals.filter((s) => isLedgerEventKind(String(s?.kind ?? "").trim()));

  const result = await processLeaseTermsSyncSignals(propertyCode, leaseSignals);
  const ledgerResult = await processLedgerEventSignals(ledgerSignals);

  const errors = [...result.errors, ...ledgerResult.ledgerErrors];

  return {
    ok: true,
    property_code: propertyCode,
    synced_at: syncedAt,
    created: result.created,
    updated: result.updated,
    skipped_vacant: skippedVacant + result.skippedVacant,
    skipped_unchanged: result.skippedUnchanged,
    skipped_duplicate_key: result.skippedDuplicateKey,
    rejected: result.rejected,
    net_rent_enriched: result.netRentEnriched,
    deposits_enriched: result.depositsEnriched,
    signal_count: signals.length,
    ledger_created: ledgerResult.ledgerCreated,
    ledger_skipped_existing: ledgerResult.ledgerSkippedExisting,
    ledger_skipped_duplicate_key: ledgerResult.ledgerSkippedDuplicateKey,
    ledger_rejected: ledgerResult.ledgerRejected,
    policy: ledgerResult.policy,
    errors: errors.length ? errors : undefined,
  };
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
async function handleAccountingImportSignals(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const result = await handleAccountingImportSignalsBody(body);
    return res.status(200).json(result);
  } catch (err) {
    const msg = String(err?.message || err);
    const status =
      msg === "missing_property_code" || msg === "empty_signals" ? 400 : 500;
    console.error("[financial/accounting-import-signals]", msg);
    return res.status(status).json({ ok: false, error: msg.slice(0, 200) });
  }
}

module.exports = {
  handleAccountingImportSignals,
  handleAccountingImportSignalsBody,
  processLeaseTermsSyncSignals,
  processLedgerEventSignals,
};
