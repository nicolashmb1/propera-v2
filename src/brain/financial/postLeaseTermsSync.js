/**
 * Brain DAL — post one validated lease_terms_sync signal to unit_leases.
 * Does not parse Leasehold; does not build charge_lines from ancillary.
 */

const { getSupabase } = require("../../db/supabase");
const { validateLeaseTermsSyncSignal } = require("./leaseTermsSyncSignal");
const { leaseShellLhPatchChanged } = require("./leaseImportFacts");
const { hasStaffChargeTemplate } = require("./unitChargePrefill");

function mergeChargeLinesFromIncoming(existingLines, incomingLines) {
  if (!hasStaffChargeTemplate(existingLines)) {
    return Array.isArray(incomingLines) ? incomingLines.map((line) => ({ ...line })) : [];
  }
  const incomingByType = new Map();
  for (const line of incomingLines ?? []) {
    if (!line || typeof line !== "object") continue;
    const type = String(line.type ?? "").trim();
    if (!type) continue;
    incomingByType.set(type, line.amount_cents);
  }
  return existingLines.map((line) => {
    const imported = incomingByType.get(line.type);
    if (imported == null) return { ...line };
    if (line.mode === "none" || line.mode === "included") return { ...line };
    return { ...line, amount_cents: imported };
  });
}

/**
 * Delta mode (leasehold_import + existing row): only asserted body keys are written.
 * Omitted/null in bridge intent → no-op — preserves staff corrections (e.g. WESTFIELD 314 Other $700).
 */
function buildLeaseTermsUpdatePatch(signal, existingShell) {
  const body = signal.body ?? {};
  const asserted = Array.isArray(signal.asserted_fields) ? signal.asserted_fields : null;

  if (!existingShell) {
    return { ...body };
  }

  if (signal.source_channel !== "leasehold_import" || !asserted?.length) {
    const patch = { ...body };
    if (Array.isArray(existingShell.charge_lines)) {
      patch.charge_lines = mergeChargeLinesFromIncoming(
        existingShell.charge_lines,
        body.charge_lines
      );
    }
    return patch;
  }

  const patch = {};
  for (const key of asserted) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    patch[key] = body[key];
  }

  if (
    Object.prototype.hasOwnProperty.call(patch, "charge_lines") &&
    Array.isArray(existingShell.charge_lines)
  ) {
    patch.charge_lines = mergeChargeLinesFromIncoming(
      existingShell.charge_lines,
      patch.charge_lines
    );
  }

  return patch;
}

function isMigrationMissing(message) {
  return /tenant_net_rent_cents|key_deposit_cents|other_deposit_cents|pet_deposit_cents|deposits_derived_at|unit_leases|does not exist/i.test(
    message
  );
}

function rowToExistingShell(row) {
  const chargeRaw = row.charge_lines;
  const charge_lines = Array.isArray(chargeRaw) ? chargeRaw : [];
  return {
    rent_cents: row.rent_cents != null ? Number(row.rent_cents) : null,
    security_deposit_cents:
      row.security_deposit_cents != null ? Number(row.security_deposit_cents) : null,
    other_deposit_cents: row.other_deposit_cents != null ? Number(row.other_deposit_cents) : null,
    pet_deposit_cents: row.pet_deposit_cents != null ? Number(row.pet_deposit_cents) : null,
    key_deposit_cents: row.key_deposit_cents != null ? Number(row.key_deposit_cents) : null,
    lease_start: row.lease_start != null ? String(row.lease_start).slice(0, 10) : null,
    lease_end: row.lease_end != null ? String(row.lease_end).slice(0, 10) : null,
    charge_lines,
    tenant_net_rent_cents:
      row.tenant_net_rent_cents != null ? Number(row.tenant_net_rent_cents) : null,
    rent_subsidy_cents: row.rent_subsidy_cents != null ? Number(row.rent_subsidy_cents) : null,
    rent_subsidy_label: row.rent_subsidy_label != null ? String(row.rent_subsidy_label) : null,
    net_rent_derived_at: row.net_rent_derived_at != null ? String(row.net_rent_derived_at) : null,
    deposits_derived_at: row.deposits_derived_at != null ? String(row.deposits_derived_at) : null,
  };
}

function createdByForChannel(sourceChannel) {
  const ch = String(sourceChannel ?? "").trim();
  if (ch === "leasehold_import") return "leasehold-import";
  if (ch === "portal_lease_edit") return "portal-lease-edit";
  if (ch === "jarvis_confirm") return "jarvis-confirm";
  if (ch === "agent_proposal") return "agent-proposal";
  return "lease-terms-sync";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {Record<string, unknown>} rawSignal
 * @param {{ existingShell?: Record<string, unknown> | null; seenIdempotencyKeys?: Set<string> }} ctx
 */
async function postLeaseTermsSync(sb, rawSignal, ctx = {}) {
  const validated = validateLeaseTermsSyncSignal(rawSignal);
  if (!validated.ok) {
    return { ok: false, error: validated.error, action: "rejected" };
  }

  const signal = validated.signal;
  const seen = ctx.seenIdempotencyKeys;
  if (seen) {
    if (seen.has(signal.idempotency_key)) {
      return { ok: true, action: "skipped_duplicate_key", idempotency_key: signal.idempotency_key };
    }
    seen.add(signal.idempotency_key);
  }

  const existingShell = ctx.existingShell ?? null;
  const patch = buildLeaseTermsUpdatePatch(signal, existingShell);

  if (existingShell && !leaseShellLhPatchChanged(existingShell, patch)) {
    return {
      ok: true,
      action: "skipped_unchanged",
      idempotency_key: signal.idempotency_key,
      unit_catalog_id: signal.unit_catalog_id,
    };
  }

  if (existingShell) {
    const updateRes = await sb
      .from("unit_leases")
      .update(patch)
      .eq("unit_catalog_id", signal.unit_catalog_id)
      .eq("property_code", signal.property_code);

    if (updateRes.error) {
      if (isMigrationMissing(updateRes.error.message)) {
        return { ok: false, error: "migration_missing", action: "rejected" };
      }
      return { ok: false, error: updateRes.error.message, action: "rejected" };
    }

    return {
      ok: true,
      action: "updated",
      idempotency_key: signal.idempotency_key,
      unit_catalog_id: signal.unit_catalog_id,
      has_net_rent: patch.tenant_net_rent_cents != null,
      has_deposits: patch.deposits_derived_at != null,
    };
  }

  const insertRes = await sb.from("unit_leases").insert({
    unit_catalog_id: signal.unit_catalog_id,
    property_code: signal.property_code,
    ...patch,
    notes: "",
    created_by: createdByForChannel(signal.source_channel),
  });

  if (insertRes.error) {
    if (isMigrationMissing(insertRes.error.message)) {
      return { ok: false, error: "migration_missing", action: "rejected" };
    }
    return { ok: false, error: insertRes.error.message, action: "rejected" };
  }

  return {
    ok: true,
    action: "created",
    idempotency_key: signal.idempotency_key,
    unit_catalog_id: signal.unit_catalog_id,
    has_net_rent: patch.tenant_net_rent_cents != null,
    has_deposits: patch.deposits_derived_at != null,
  };
}

async function loadExistingLeaseShellsByUnit(sb, propertyCode) {
  const existingRes = await sb
    .from("unit_leases")
    .select(
      "id, unit_catalog_id, rent_cents, security_deposit_cents, other_deposit_cents, pet_deposit_cents, key_deposit_cents, lease_start, lease_end, charge_lines, tenant_net_rent_cents, rent_subsidy_cents, rent_subsidy_label, net_rent_derived_at, deposits_derived_at"
    )
    .eq("property_code", propertyCode);

  if (existingRes.error) {
    if (isMigrationMissing(existingRes.error.message)) {
      return { ok: false, migrationMissing: true, byUnit: new Map() };
    }
    throw new Error(existingRes.error.message);
  }

  const byUnit = new Map();
  for (const row of existingRes.data ?? []) {
    const unitId = String(row.unit_catalog_id ?? "");
    if (!unitId) continue;
    byUnit.set(unitId, rowToExistingShell(row));
  }
  return { ok: true, migrationMissing: false, byUnit };
}

async function clearPropertyNetRentDerived(sb, propertyCode) {
  const clearRes = await sb
    .from("unit_leases")
    .update({
      tenant_net_rent_cents: null,
      rent_subsidy_cents: null,
      rent_subsidy_label: "",
      net_rent_derived_at: null,
    })
    .eq("property_code", propertyCode)
    .not("net_rent_derived_at", "is", null);

  if (clearRes.error && !isMigrationMissing(clearRes.error.message)) {
    throw new Error(clearRes.error.message);
  }
}

module.exports = {
  postLeaseTermsSync,
  loadExistingLeaseShellsByUnit,
  clearPropertyNetRentDerived,
  rowToExistingShell,
  buildLeaseTermsUpdatePatch,
};
