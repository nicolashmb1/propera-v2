const { deriveNetRentFromSnapshotPayload } = require("./netRentEnrichment");
const { parseAccountingAncillaryCharges } = require("./accountingLedgerParse");
const {
  buildPrefilledChargeLines,
  hasStaffChargeTemplate,
  refreshChargeLineAmountsFromAncillary,
} = require("./unitChargePrefill");

function parseDateOnly(raw) {
  const text = String(raw ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function readDepositCents(fact, field) {
  const top = fact[field];
  if (top != null && Number.isFinite(Number(top))) {
    return Math.max(0, Math.round(Number(top)));
  }

  const payload =
    fact.payload && typeof fact.payload === "object" ? /** @type {Record<string, unknown>} */ (fact.payload) : null;
  const deposits =
    payload?.deposits && typeof payload.deposits === "object"
      ? /** @type {Record<string, unknown>} */ (payload.deposits)
      : null;
  const nested = deposits?.[field];
  if (nested != null && Number.isFinite(Number(nested))) {
    return Math.max(0, Math.round(Number(nested)));
  }

  return null;
}

/** Occupied in Leasehold — materialize lease shell for these units only. */
function isOccupiedSnapshotUnit(fact) {
  const name = String(fact.tenant_name ?? "").trim();
  if (name.length > 0) return true;

  const rent = fact.rent_cents != null ? Number(fact.rent_cents) : null;
  if (rent != null && Number.isFinite(rent) && rent > 0) return true;

  if (parseDateOnly(fact.lease_start) || parseDateOnly(fact.lease_end)) return true;

  return false;
}

function validLeaseDatePair(start, end) {
  if (!start || !end) return true;
  return end >= start;
}

function normalizeCents(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.round(Number(value)));
}

function chargeLinesEqual(a, b) {
  return stableJson(a) === stableJson(b);
}

function stableJson(value) {
  return JSON.stringify(value);
}

function nullableEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b;
}

/** True when LH-owned shell fields differ from existing row (skip no-op updates). */
function leaseShellLhPatchChanged(existing, patch) {
  if (!existing) return true;

  const fields = [
    "rent_cents",
    "security_deposit_cents",
    "other_deposit_cents",
    "pet_deposit_cents",
    "key_deposit_cents",
    "lease_start",
    "lease_end",
    "tenant_net_rent_cents",
    "rent_subsidy_cents",
    "rent_subsidy_label",
    "net_rent_derived_at",
    "deposits_derived_at",
  ];

  for (const key of fields) {
    if (!nullableEqual(existing[key], patch[key])) return true;
  }

  const nextLines = patch.charge_lines;
  if (!chargeLinesEqual(existing.charge_lines ?? [], nextLines ?? [])) return true;

  return false;
}

/**
 * Build Leasehold-owned fields for unit_leases. Never includes renewal_status, renewal_notes, or notes.
 */
function buildLeaseShellLhPatch(fact, existing, syncedAt) {
  if (!isOccupiedSnapshotUnit(fact)) return null;

  const payload =
    fact.payload && typeof fact.payload === "object" ? /** @type {Record<string, unknown>} */ (fact.payload) : {};

  const rentCents = normalizeCents(fact.rent_cents != null ? Number(fact.rent_cents) : null);
  let leaseStart = parseDateOnly(fact.lease_start);
  let leaseEnd = parseDateOnly(fact.lease_end);
  if (!validLeaseDatePair(leaseStart, leaseEnd)) {
    leaseStart = existing?.lease_start ?? null;
    leaseEnd = existing?.lease_end ?? null;
  }

  const securityCents = readDepositCents(fact, "security_deposit_cents");
  const otherCents = readDepositCents(fact, "other_deposit_cents");
  const petCents = readDepositCents(fact, "pet_deposit_cents");
  const keyCents = readDepositCents(fact, "key_deposit_cents");
  const hasDeposits =
    securityCents != null || otherCents != null || petCents != null || keyCents != null;

  const pattern = deriveNetRentFromSnapshotPayload(
    payload,
    rentCents ?? (fact.rent_cents != null ? Number(fact.rent_cents) : null)
  );
  const hasNetRent =
    pattern.tenantNetRentCents != null && pattern.subsidyCents != null && pattern.sampleMonths >= 3;

  const ancillary = parseAccountingAncillaryCharges(payload);
  const chargeLines = hasStaffChargeTemplate(existing?.charge_lines)
    ? refreshChargeLineAmountsFromAncillary(existing.charge_lines, ancillary)
    : buildPrefilledChargeLines(null, ancillary, true);

  const patch = {
    rent_cents: rentCents,
    lease_start: leaseStart,
    lease_end: leaseEnd,
    security_deposit_cents: securityCents,
    other_deposit_cents: otherCents,
    pet_deposit_cents: petCents,
    key_deposit_cents: keyCents,
    charge_lines: chargeLines,
  };

  if (hasNetRent) {
    patch.tenant_net_rent_cents = pattern.tenantNetRentCents;
    patch.rent_subsidy_cents = pattern.subsidyCents;
    patch.rent_subsidy_label = "Credit";
    patch.net_rent_derived_at = syncedAt;
  }

  if (hasDeposits) {
    patch.deposits_derived_at = syncedAt;
  }

  return { patch, hasNetRent, hasDeposits };
}

module.exports = {
  parseDateOnly,
  readDepositCents,
  isOccupiedSnapshotUnit,
  leaseShellLhPatchChanged,
  buildLeaseShellLhPatch,
};
