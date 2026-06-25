/**
 * Canonical lease_terms_sync intent signal — channel-agnostic contract.
 * Brain validates this shape; adapters (LH, cockpit, Jarvis) produce it.
 */

const crypto = require("crypto");

const LEASE_TERMS_SYNC_KIND = "lease_terms_sync";
const SCHEMA_VERSION = 1;

const ALLOWED_SOURCE_CHANNELS = new Set([
  "leasehold_import",
  "portal_lease_edit",
  "portal_ledger_edit",
  "portal_payment",
  "jarvis_confirm",
  "agent_proposal",
]);

const BODY_CENTS_FIELDS = [
  "rent_cents",
  "security_deposit_cents",
  "other_deposit_cents",
  "pet_deposit_cents",
  "key_deposit_cents",
  "tenant_net_rent_cents",
  "rent_subsidy_cents",
];

const BODY_DATE_FIELDS = ["lease_start", "lease_end"];

const CHARGE_LINE_MODES = new Set(["fixed", "variable", "included", "none"]);

/** Keys that may appear in lease_terms_sync body; presence = LH asserted the field. */
const LEASE_TERMS_BODY_KEYS = [
  "rent_cents",
  "lease_start",
  "lease_end",
  "security_deposit_cents",
  "other_deposit_cents",
  "pet_deposit_cents",
  "key_deposit_cents",
  "charge_lines",
  "tenant_net_rent_cents",
  "rent_subsidy_cents",
  "rent_subsidy_label",
  "net_rent_derived_at",
  "deposits_derived_at",
];

/**
 * @param {Record<string, unknown> | null | undefined} rawBody
 * @returns {string[]}
 */
function extractAssertedLeaseTermsFields(rawBody) {
  if (!rawBody || typeof rawBody !== "object") return [];
  return LEASE_TERMS_BODY_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(rawBody, key)
  );
}

function parseDateOnly(raw) {
  const text = String(raw ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeCents(value) {
  if (value == null || value === "") return null;
  if (!Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.round(Number(value)));
}

function stableJson(value) {
  return JSON.stringify(value);
}

function fingerprintLeaseTermsBody(body) {
  const parts = [
    body.rent_cents,
    body.lease_start,
    body.lease_end,
    body.security_deposit_cents,
    body.other_deposit_cents,
    body.pet_deposit_cents,
    body.key_deposit_cents,
    body.tenant_net_rent_cents,
    body.rent_subsidy_cents,
    stableJson(body.charge_lines ?? []),
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
}

/**
 * Stable idempotency key — changes when terms body changes.
 * @param {{ sourceSystem?: string; propertyCode: string; unitLabel: string; effectiveAt: string; body: Record<string, unknown> }} opts
 */
function buildLeaseTermsIdempotencyKey(opts) {
  const source = String(opts.sourceSystem ?? "leasehold").trim().toLowerCase() || "leasehold";
  const property = String(opts.propertyCode ?? "").trim().toUpperCase();
  const unit = String(opts.unitLabel ?? "").trim() || "unknown";
  const date = parseDateOnly(opts.effectiveAt) || String(opts.effectiveAt ?? "").slice(0, 10) || "unknown";
  const fp = fingerprintLeaseTermsBody(opts.body ?? {});
  return `${source}:${property}:${unit}:${date}:lease_terms:${fp}`;
}

function validateChargeLines(lines) {
  if (!Array.isArray(lines)) return "invalid_charge_lines";
  for (const line of lines) {
    if (!line || typeof line !== "object") return "invalid_charge_line";
    const type = String(line.type ?? "").trim();
    if (!type) return "invalid_charge_line_type";
    const mode = String(line.mode ?? "").trim();
    if (!CHARGE_LINE_MODES.has(mode)) return "invalid_charge_line_mode";
    if (line.amount_cents != null && normalizeCents(line.amount_cents) == null) {
      return "invalid_charge_line_amount";
    }
  }
  return null;
}

function validateLeaseTermsBody(body) {
  if (!body || typeof body !== "object") return "missing_body";

  for (const key of BODY_CENTS_FIELDS) {
    if (body[key] != null && normalizeCents(body[key]) == null) {
      return `invalid_${key}`;
    }
  }

  const start = body.lease_start != null ? parseDateOnly(body.lease_start) : null;
  const end = body.lease_end != null ? parseDateOnly(body.lease_end) : null;
  if (body.lease_start != null && body.lease_start !== "" && !start) return "invalid_lease_start";
  if (body.lease_end != null && body.lease_end !== "" && !end) return "invalid_lease_end";
  if (start && end && end < start) return "invalid_lease_date_range";

  const chargeErr = validateChargeLines(body.charge_lines ?? []);
  if (chargeErr) return chargeErr;

  const rent = normalizeCents(body.rent_cents);
  const hasOccupancyHint =
    rent != null && rent > 0 ||
    Boolean(start || end) ||
    BODY_CENTS_FIELDS.slice(1, 5).some((k) => normalizeCents(body[k]) != null);

  if (!hasOccupancyHint) return "vacant_lease_terms";

  return null;
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {{ ok: true; signal: Record<string, unknown> } | { ok: false; error: string }}
 */
function validateLeaseTermsSyncSignal(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_signal" };

  const kind = String(raw.kind ?? "").trim();
  if (kind !== LEASE_TERMS_SYNC_KIND) return { ok: false, error: "invalid_kind" };

  const sourceChannel = String(raw.source_channel ?? raw.sourceChannel ?? "").trim();
  if (!ALLOWED_SOURCE_CHANNELS.has(sourceChannel)) return { ok: false, error: "invalid_source_channel" };

  const propertyCode = String(raw.property_code ?? raw.propertyCode ?? "").trim().toUpperCase();
  if (!propertyCode) return { ok: false, error: "missing_property_code" };

  const unitCatalogId = String(raw.unit_catalog_id ?? raw.unitCatalogId ?? "").trim();
  if (!unitCatalogId) return { ok: false, error: "missing_unit_catalog_id" };

  const idempotencyKey = String(raw.idempotency_key ?? raw.idempotencyKey ?? "").trim();
  if (!idempotencyKey || idempotencyKey.length > 220) return { ok: false, error: "invalid_idempotency_key" };
  if (!idempotencyKey.includes(":lease_terms:")) return { ok: false, error: "invalid_idempotency_key_format" };

  const effectiveAt = String(raw.effective_at ?? raw.effectiveAt ?? "").trim();
  if (!effectiveAt || !Number.isFinite(new Date(effectiveAt).getTime())) {
    return { ok: false, error: "invalid_effective_at" };
  }

  const body = raw.body && typeof raw.body === "object" ? raw.body : null;
  const bodyErr = validateLeaseTermsBody(body);
  if (bodyErr) return { ok: false, error: bodyErr };

  const assertedFields = extractAssertedLeaseTermsFields(body);

  return {
    ok: true,
    signal: {
      schema_version: SCHEMA_VERSION,
      kind: LEASE_TERMS_SYNC_KIND,
      source_channel: sourceChannel,
      property_code: propertyCode,
      unit_catalog_id: unitCatalogId,
      unit_label: String(raw.unit_label ?? raw.unitLabel ?? "").trim() || null,
      idempotency_key: idempotencyKey,
      effective_at: new Date(effectiveAt).toISOString(),
      body: normalizeLeaseTermsBodyForPost(body),
      asserted_fields: assertedFields,
    },
  };
}

/** Normalize body fields for DAL post. */
function normalizeLeaseTermsBodyForPost(body) {
  const out = {
    rent_cents: normalizeCents(body.rent_cents),
    lease_start: body.lease_start != null ? parseDateOnly(body.lease_start) : null,
    lease_end: body.lease_end != null ? parseDateOnly(body.lease_end) : null,
    security_deposit_cents: normalizeCents(body.security_deposit_cents),
    other_deposit_cents: normalizeCents(body.other_deposit_cents),
    pet_deposit_cents: normalizeCents(body.pet_deposit_cents),
    key_deposit_cents: normalizeCents(body.key_deposit_cents),
    charge_lines: Array.isArray(body.charge_lines) ? body.charge_lines.map((l) => ({ ...l })) : [],
  };

  const netRent = normalizeCents(body.tenant_net_rent_cents);
  const subsidy = normalizeCents(body.rent_subsidy_cents);
  if (netRent != null && subsidy != null) {
    out.tenant_net_rent_cents = netRent;
    out.rent_subsidy_cents = subsidy;
    out.rent_subsidy_label = String(body.rent_subsidy_label ?? "Credit").trim() || "Credit";
    out.net_rent_derived_at = body.net_rent_derived_at != null ? String(body.net_rent_derived_at) : null;
  }

  const hasDeposits =
    out.security_deposit_cents != null ||
    out.other_deposit_cents != null ||
    out.pet_deposit_cents != null ||
    out.key_deposit_cents != null;
  if (hasDeposits && body.deposits_derived_at != null) {
    out.deposits_derived_at = String(body.deposits_derived_at);
  }

  return out;
}

module.exports = {
  LEASE_TERMS_SYNC_KIND,
  SCHEMA_VERSION,
  ALLOWED_SOURCE_CHANNELS,
  LEASE_TERMS_BODY_KEYS,
  buildLeaseTermsIdempotencyKey,
  validateLeaseTermsSyncSignal,
  normalizeLeaseTermsBodyForPost,
  fingerprintLeaseTermsBody,
  extractAssertedLeaseTermsFields,
};
