/**
 * Brain DAL — post one validated ledger event signal to tenant_ledger_entries.
 */

const { validateLedgerEventSignal, signalKindToEntryKind } = require("./ledgerEventSignal");

function isMigrationMissing(message) {
  return /import_idempotency_key|accounting_import|tenant_ledger_entries|does not exist/i.test(
    message
  );
}

function buildDescription(signal) {
  const body = signal.body ?? {};
  const parts = [String(body.description ?? "").trim() || signal.kind];
  if (body.reference) parts.push(`#${body.reference}`);
  return parts.join(" · ").slice(0, 500);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {Record<string, unknown>} rawSignal
 * @param {{ seenIdempotencyKeys?: Set<string>; existingKeys?: Set<string> }} ctx
 */
async function postLedgerEventSignal(sb, rawSignal, ctx = {}) {
  const validated = validateLedgerEventSignal(rawSignal);
  if (!validated.ok) {
    return { ok: false, error: validated.error, action: "rejected" };
  }

  const signal = validated.signal;
  const key = signal.idempotency_key;

  const seen = ctx.seenIdempotencyKeys;
  if (seen) {
    if (seen.has(key)) {
      return { ok: true, action: "skipped_duplicate_key", idempotency_key: key };
    }
    seen.add(key);
  }

  const existingKeys = ctx.existingKeys;
  if (existingKeys?.has(key)) {
    return { ok: true, action: "skipped_existing", idempotency_key: key };
  }

  const entryKind = signalKindToEntryKind(signal.kind);
  const amountCents = Number(signal.body.amount_cents);

  const row = {
    property_code: signal.property_code,
    unit_catalog_id: signal.unit_catalog_id,
    tenant_roster_id: null,
    ticket_id: null,
    source_type: "accounting_import",
    source_id: null,
    import_idempotency_key: key,
    entry_kind: entryKind,
    amount_cents: entryKind === "adjustment" ? amountCents : Math.abs(amountCents),
    currency: "USD",
    description: buildDescription(signal),
    notes: signal.body.lh_kind ? `LH ${signal.body.lh_kind}` : "",
    status: "posted",
    effective_date: signal.body.effective_date,
  };

  const insertRes = await sb.from("tenant_ledger_entries").insert(row).select("id").maybeSingle();

  if (insertRes.error) {
    if (/duplicate key|unique constraint/i.test(insertRes.error.message)) {
      return { ok: true, action: "skipped_existing", idempotency_key: key };
    }
    if (isMigrationMissing(insertRes.error.message)) {
      return { ok: false, error: "migration_missing", action: "rejected" };
    }
    return { ok: false, error: insertRes.error.message, action: "rejected" };
  }

  if (existingKeys) existingKeys.add(key);

  return {
    ok: true,
    action: "created",
    idempotency_key: key,
    ledger_entry_id: insertRes.data?.id ?? null,
    unit_catalog_id: signal.unit_catalog_id,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string[]} keys
 */
async function loadExistingImportIdempotencyKeys(sb, keys) {
  const unique = [...new Set(keys.filter(Boolean))];
  const found = new Set();
  if (!unique.length) return found;

  const CHUNK = 100;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const { data, error } = await sb
      .from("tenant_ledger_entries")
      .select("import_idempotency_key")
      .eq("source_type", "accounting_import")
      .in("import_idempotency_key", slice);

    if (error) {
      if (isMigrationMissing(error.message)) return null;
      throw new Error(error.message);
    }
    for (const row of data ?? []) {
      const k = String(row.import_idempotency_key ?? "").trim();
      if (k) found.add(k);
    }
  }

  return found;
}

module.exports = {
  postLedgerEventSignal,
  loadExistingImportIdempotencyKeys,
};
