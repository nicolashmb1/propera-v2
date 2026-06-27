/**
 * Step 1 — post one opening_balance row per unit (ledger pilot properties).
 * Converts LH window prior into a Propera fact; new leases skip (clean start).
 */

const { parseAccountingPostedTransactions } = require("./accountingLedgerParse");
const {
  FINANCE_LEDGER_PILOT_PROPERTIES,
} = require("./financeLedgerPilot");

const PROPERA_LEDGER_OPENING_PROPERTIES = FINANCE_LEDGER_PILOT_PROPERTIES;

const OPENING_KEY_SUFFIX = ":opening_balance:v1";

function parseDateOnly(raw) {
  const text = String(raw ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function addDaysIso(dateIso, days) {
  const d = new Date(`${dateIso}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return dateIso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(startIso, endIso) {
  const a = new Date(`${startIso}T12:00:00.000Z`).getTime();
  const b = new Date(`${endIso}T12:00:00.000Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function buildOpeningIdempotencyKey(propertyCode, unitLabel) {
  const property = String(propertyCode ?? "").trim().toUpperCase();
  const unit = String(unitLabel ?? "").trim() || "unknown";
  return `propera:${property}:${unit}${OPENING_KEY_SUFFIX}`;
}

function entryDeltaCents(entry) {
  const kind = String(entry.entry_kind ?? "").trim().toLowerCase();
  const amount = Math.round(Number(entry.amount_cents) || 0);
  if (kind === "opening_balance" || kind === "charge" || kind === "fee") return amount;
  if (kind === "payment" || kind === "credit" || kind === "waiver") return -amount;
  if (kind === "adjustment") return amount;
  return 0;
}

function netWindowDeltaCents(entries) {
  let total = 0;
  for (const row of entries) {
    if (String(row.status ?? "").toLowerCase() === "voided") continue;
    if (String(row.entry_kind ?? "").trim().toLowerCase() === "opening_balance") continue;
    total += entryDeltaCents(row);
  }
  return total;
}

function firstEventDate(entries) {
  let first = null;
  for (const row of entries) {
    if (String(row.status ?? "").toLowerCase() === "voided") continue;
    if (String(row.entry_kind ?? "").trim().toLowerCase() === "opening_balance") continue;
    const d = parseDateOnly(row.effective_date) || parseDateOnly(row.created_at);
    if (!d) continue;
    if (!first || d < first) first = d;
  }
  return first;
}

/**
 * New tenancy: first ledger activity on/after lease start — no LH prior register.
 * @param {string | null} leaseStart
 * @param {string | null} firstEvent
 */
function isNewLeaseCleanStart(leaseStart, firstEvent) {
  if (!leaseStart || !firstEvent) return false;
  if (firstEvent < leaseStart) return false;
  const span = daysBetween(leaseStart, firstEvent);
  if (span == null) return false;
  return span <= 120;
}

/**
 * @param {Record<string, unknown> | null | undefined} payload
 */
function parsePostedWithPrior(payload) {
  const raw = payload?.posted_transactions;
  if (!Array.isArray(raw)) return [];

  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const date = parseDateOnly(row.date);
    if (!date) continue;
    const priorRaw = row.prior_balance_cents;
    const prior =
      priorRaw == null || priorRaw === ""
        ? null
        : Number.isFinite(Number(priorRaw))
          ? Math.round(Number(priorRaw))
          : null;
    const amountRaw = row.amount_cents;
    const amountCents =
      amountRaw == null || amountRaw === ""
        ? null
        : Number.isFinite(Number(amountRaw))
          ? Math.round(Number(amountRaw))
          : null;
    out.push({ date, prior_balance_cents: prior, amount_cents: amountCents });
  }

  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/**
 * @param {{ standingBalanceCents: number | null; payload: Record<string, unknown> | null; mimicEntries: Array<Record<string, unknown>>; leaseStart: string | null; firstEvent: string | null }} ctx
 */
function resolveOpeningBalanceCents(ctx) {
  const { standingBalanceCents, payload, mimicEntries, leaseStart, firstEvent } = ctx;

  if (isNewLeaseCleanStart(leaseStart, firstEvent)) {
    return { openingCents: null, reason: "new_lease_clean_start" };
  }

  const posted = parsePostedWithPrior(payload);
  const firstPosted = posted[0] ?? null;
  if (firstPosted?.prior_balance_cents != null && firstPosted.prior_balance_cents > 0) {
    return {
      openingCents: firstPosted.prior_balance_cents,
      reason: "lh_first_line_prior",
      anchorDate: firstPosted.date,
    };
  }

  if (standingBalanceCents != null && Number.isFinite(Number(standingBalanceCents))) {
    const net = netWindowDeltaCents(mimicEntries);
    const opening = Math.round(Number(standingBalanceCents)) - net;
    if (opening > 0) {
      return {
        openingCents: opening,
        reason: "standing_minus_window_net",
        anchorDate: firstEvent || firstPosted?.date || null,
      };
    }
    if (opening === 0) {
      return { openingCents: null, reason: "zero_opening" };
    }
  }

  return { openingCents: null, reason: "no_opening_computed" };
}

function isMigrationMissing(message) {
  return /opening_balance|import_idempotency_key|tenant_ledger_entries|does not exist/i.test(
    String(message ?? "")
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ propertyCode: string; unitCatalogId: string; unitLabel: string; openingCents: number; effectiveDate: string; syncedAt: string }} opts
 */
async function postLedgerOpeningBalance(sb, opts) {
  const propertyCode = String(opts.propertyCode ?? "").trim().toUpperCase();
  const unitCatalogId = String(opts.unitCatalogId ?? "").trim();
  const unitLabel = String(opts.unitLabel ?? "").trim();
  const openingCents = Math.round(Number(opts.openingCents));
  const effectiveDate = parseDateOnly(opts.effectiveDate);
  if (!propertyCode || !unitCatalogId || !unitLabel || !effectiveDate) {
    return { ok: false, error: "invalid_opening_args", action: "rejected" };
  }
  if (!Number.isFinite(openingCents) || openingCents <= 0) {
    return { ok: true, action: "skipped_non_positive", unit_catalog_id: unitCatalogId };
  }

  const idempotencyKey = buildOpeningIdempotencyKey(propertyCode, unitLabel);
  const existing = await sb
    .from("tenant_ledger_entries")
    .select("id")
    .eq("import_idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existing.error) {
    if (isMigrationMissing(existing.error.message)) {
      return { ok: false, error: "migration_missing", action: "rejected" };
    }
    return { ok: false, error: existing.error.message, action: "rejected" };
  }
  if (existing.data?.id) {
    return { ok: true, action: "skipped_existing", idempotency_key: idempotencyKey };
  }

  const insertRes = await sb
    .from("tenant_ledger_entries")
    .insert({
      property_code: propertyCode,
      unit_catalog_id: unitCatalogId,
      tenant_roster_id: null,
      ticket_id: null,
      source_type: "accounting_import",
      source_id: null,
      import_idempotency_key: idempotencyKey,
      entry_kind: "opening_balance",
      amount_cents: openingCents,
      currency: "USD",
      description: "Opening balance (register start)",
      notes: `Propera register anchor · ${propertyCode} baseline`,
      status: "posted",
      effective_date: effectiveDate,
    })
    .select("id")
    .maybeSingle();

  if (insertRes.error) {
    if (/duplicate key|unique constraint/i.test(insertRes.error.message)) {
      return { ok: true, action: "skipped_existing", idempotency_key: idempotencyKey };
    }
    if (isMigrationMissing(insertRes.error.message)) {
      return { ok: false, error: "migration_missing", action: "rejected" };
    }
    return { ok: false, error: insertRes.error.message, action: "rejected" };
  }

  return {
    ok: true,
    action: "created",
    idempotency_key: idempotencyKey,
    ledger_entry_id: insertRes.data?.id ?? null,
    unit_catalog_id: unitCatalogId,
    opening_cents: openingCents,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {string} syncedAt
 */
async function ensureLedgerOpeningBalances(sb, propertyCode, syncedAt) {
  const code = String(propertyCode ?? "").trim().toUpperCase();
  if (!PROPERA_LEDGER_OPENING_PROPERTIES.has(code)) {
    return {
      opening_created: 0,
      opening_skipped_existing: 0,
      opening_skipped_new_lease: 0,
      opening_skipped_no_mimic: 0,
      opening_rejected: 0,
      skipped_property: true,
    };
  }

  const unitsRes = await sb
    .from("units")
    .select("id, unit_label")
    .eq("property_code", code);
  if (unitsRes.error) throw new Error(unitsRes.error.message);

  const snapshotsRes = await sb
    .from("tenant_account_snapshots")
    .select("unit_catalog_id, balance_cents, payload_json")
    .eq("property_code", code)
    .eq("source_system", "leasehold");
  if (snapshotsRes.error && !isMigrationMissing(snapshotsRes.error.message)) {
    throw new Error(snapshotsRes.error.message);
  }

  const leasesRes = await sb
    .from("unit_leases")
    .select("unit_catalog_id, lease_start")
    .eq("property_code", code);
  if (leasesRes.error) throw new Error(leasesRes.error.message);

  const ledgerRes = await sb
    .from("tenant_ledger_entries")
    .select("unit_catalog_id, entry_kind, amount_cents, effective_date, created_at, status, source_type")
    .eq("property_code", code)
    .eq("source_type", "accounting_import")
    .neq("status", "voided");
  if (ledgerRes.error) {
    if (isMigrationMissing(ledgerRes.error.message)) {
      return {
        opening_created: 0,
        opening_skipped_existing: 0,
        opening_skipped_new_lease: 0,
        opening_skipped_no_mimic: 0,
        opening_rejected: 1,
        errors: ["migration_missing"],
      };
    }
    throw new Error(ledgerRes.error.message);
  }

  const snapByUnit = new Map(
    (snapshotsRes.data ?? []).map((r) => [String(r.unit_catalog_id), r])
  );
  const leaseByUnit = new Map(
    (leasesRes.data ?? []).map((r) => [String(r.unit_catalog_id), r])
  );
  const entriesByUnit = new Map();
  for (const row of ledgerRes.data ?? []) {
    const uid = String(row.unit_catalog_id ?? "");
    if (!uid) continue;
    const list = entriesByUnit.get(uid) ?? [];
    list.push(row);
    entriesByUnit.set(uid, list);
  }

  let opening_created = 0;
  let opening_skipped_existing = 0;
  let opening_skipped_new_lease = 0;
  let opening_skipped_no_mimic = 0;
  let opening_rejected = 0;
  const errors = [];

  for (const unit of unitsRes.data ?? []) {
    const unitId = String(unit.id ?? "");
    const unitLabel = String(unit.unit_label ?? "").trim();
    if (!unitId || !unitLabel) continue;

    const entries = entriesByUnit.get(unitId) ?? [];
    const mimicEntries = entries.filter(
      (e) => String(e.entry_kind ?? "").trim().toLowerCase() !== "opening_balance"
    );
    if (!mimicEntries.length) {
      opening_skipped_no_mimic += 1;
      continue;
    }

    const hasOpeningRow = entries.some(
      (e) => String(e.entry_kind ?? "").trim().toLowerCase() === "opening_balance"
    );
    if (hasOpeningRow) {
      opening_skipped_existing += 1;
      continue;
    }

    const snap = snapByUnit.get(unitId);
    const lease = leaseByUnit.get(unitId);
    const leaseStart = parseDateOnly(lease?.lease_start);
    const firstEvent = firstEventDate(mimicEntries);
    const standing =
      snap?.balance_cents != null && Number.isFinite(Number(snap.balance_cents))
        ? Math.round(Number(snap.balance_cents))
        : null;
    const payload =
      snap?.payload_json && typeof snap.payload_json === "object"
        ? /** @type {Record<string, unknown>} */ (snap.payload_json)
        : null;

    const resolved = resolveOpeningBalanceCents({
      standingBalanceCents: standing,
      payload,
      mimicEntries,
      leaseStart,
      firstEvent,
    });

    if (resolved.reason === "new_lease_clean_start" || resolved.openingCents == null) {
      if (resolved.reason === "new_lease_clean_start") opening_skipped_new_lease += 1;
      continue;
    }

    const anchor = resolved.anchorDate || firstEvent || parseDateOnly(syncedAt) || "2020-01-01";
    const effectiveDate = addDaysIso(anchor, -1);

    const posted = await postLedgerOpeningBalance(sb, {
      propertyCode: code,
      unitCatalogId: unitId,
      unitLabel,
      openingCents: resolved.openingCents,
      effectiveDate,
      syncedAt,
    });

    if (!posted.ok) {
      opening_rejected += 1;
      if (posted.error) errors.push(String(posted.error));
      continue;
    }
    if (posted.action === "created") opening_created += 1;
    else if (posted.action === "skipped_existing") opening_skipped_existing += 1;
  }

  return {
    opening_created,
    opening_skipped_existing,
    opening_skipped_new_lease,
    opening_skipped_no_mimic,
    opening_rejected,
    errors: [...new Set(errors)],
  };
}

module.exports = {
  PROPERA_LEDGER_OPENING_PROPERTIES,
  buildOpeningIdempotencyKey,
  isNewLeaseCleanStart,
  resolveOpeningBalanceCents,
  postLedgerOpeningBalance,
  ensureLedgerOpeningBalances,
};
