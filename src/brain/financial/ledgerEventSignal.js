/**
 * Canonical ledger event signals — channel-agnostic contract (Step 2).
 * Brain validates; adapters (LH import, cockpit, Jarvis) produce this shape.
 */

const { ALLOWED_SOURCE_CHANNELS } = require("./leaseTermsSyncSignal");

const LEDGER_EVENT_KINDS = new Set([
  "payment_received",
  "monthly_billing",
  "late_fee",
  "fine",
  "one_time_charge",
  "adjustment",
]);

const SCHEMA_VERSION = 1;

const IDEMPOTENCY_KEY_KIND_SHORT = {
  payment_received: "payment",
  monthly_billing: "billing",
  late_fee: "late_fee",
  fine: "fine",
  one_time_charge: "charge",
  adjustment: "adjustment",
};

function parseDateOnly(raw) {
  const text = String(raw ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeCents(value) {
  if (value == null || value === "") return null;
  if (!Number.isFinite(Number(value))) return null;
  return Math.round(Number(value));
}

/**
 * @param {{ sourceSystem?: string; propertyCode: string; unitLabel: string; effectiveDate: string; signalKind: string; amountCents: number | null; postedSequence?: number | null; reference?: string | null }} opts
 */
function buildLedgerEventIdempotencyKey(opts) {
  const source = String(opts.sourceSystem ?? "leasehold").trim().toLowerCase() || "leasehold";
  const property = String(opts.propertyCode ?? "").trim().toUpperCase();
  const unit = String(opts.unitLabel ?? "").trim() || "unknown";
  const date = parseDateOnly(opts.effectiveDate) || "unknown";
  const kindShort = IDEMPOTENCY_KEY_KIND_SHORT[opts.signalKind] ?? "event";
  const amount = normalizeCents(opts.amountCents);
  const amountPart = amount != null ? String(Math.abs(amount)) : "0";
  const seq =
    opts.postedSequence != null && Number.isFinite(Number(opts.postedSequence))
      ? `seq${Math.round(Number(opts.postedSequence))}`
      : null;
  const ref = String(opts.reference ?? "").trim();
  const tail = seq || (ref ? `ref${ref.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)}` : "seq0");
  return `${source}:${property}:${unit}:${date}:${kindShort}:${amountPart}:${tail}`;
}

function signalKindToEntryKind(signalKind) {
  const k = String(signalKind ?? "").trim();
  if (k === "payment_received") return "payment";
  if (k === "late_fee") return "fee";
  if (k === "adjustment") return "adjustment";
  if (k === "monthly_billing" || k === "one_time_charge" || k === "fine") return "charge";
  return "charge";
}

function validateLedgerEventBody(kind, body) {
  if (!body || typeof body !== "object") return "missing_body";

  const effectiveDate = parseDateOnly(body.effective_date ?? body.effectiveDate);
  if (!effectiveDate) return "invalid_effective_date";

  const amountCents = normalizeCents(body.amount_cents ?? body.amountCents);
  if (amountCents == null || amountCents === 0) return "invalid_amount_cents";

  if (kind === "adjustment") {
    return null;
  }
  if (amountCents < 0) return "invalid_amount_cents";

  return null;
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {{ ok: true; signal: Record<string, unknown> } | { ok: false; error: string }}
 */
function validateLedgerEventSignal(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_signal" };

  const kind = String(raw.kind ?? "").trim();
  if (!LEDGER_EVENT_KINDS.has(kind)) return { ok: false, error: "invalid_kind" };

  const sourceChannel = String(raw.source_channel ?? raw.sourceChannel ?? "").trim();
  if (!ALLOWED_SOURCE_CHANNELS.has(sourceChannel)) return { ok: false, error: "invalid_source_channel" };

  const propertyCode = String(raw.property_code ?? raw.propertyCode ?? "").trim().toUpperCase();
  if (!propertyCode) return { ok: false, error: "missing_property_code" };

  const unitCatalogId = String(raw.unit_catalog_id ?? raw.unitCatalogId ?? "").trim();
  if (!unitCatalogId) return { ok: false, error: "missing_unit_catalog_id" };

  const idempotencyKey = String(raw.idempotency_key ?? raw.idempotencyKey ?? "").trim();
  if (!idempotencyKey || idempotencyKey.length > 220) return { ok: false, error: "invalid_idempotency_key" };
  if (idempotencyKey.includes(":lease_terms:")) return { ok: false, error: "invalid_idempotency_key_format" };

  const effectiveAt = String(raw.effective_at ?? raw.effectiveAt ?? "").trim();
  if (!effectiveAt || !Number.isFinite(new Date(effectiveAt).getTime())) {
    return { ok: false, error: "invalid_effective_at" };
  }

  const body = raw.body && typeof raw.body === "object" ? raw.body : null;
  const bodyErr = validateLedgerEventBody(kind, body);
  if (bodyErr) return { ok: false, error: bodyErr };

  const amountCents = normalizeCents(body.amount_cents ?? body.amountCents);
  const effectiveDate = parseDateOnly(body.effective_date ?? body.effectiveDate);

  return {
    ok: true,
    signal: {
      schema_version: SCHEMA_VERSION,
      kind,
      source_channel: sourceChannel,
      property_code: propertyCode,
      unit_catalog_id: unitCatalogId,
      unit_label: String(raw.unit_label ?? raw.unitLabel ?? "").trim() || null,
      idempotency_key: idempotencyKey,
      effective_at: new Date(effectiveAt).toISOString(),
      body: {
        effective_date: effectiveDate,
        amount_cents: amountCents,
        description: String(body.description ?? kind).trim().slice(0, 200) || kind,
        reference: body.reference != null ? String(body.reference).trim().slice(0, 80) || null : null,
        balance_after_cents: normalizeCents(body.balance_after_cents ?? body.balanceAfterCents),
        recurring: body.recurring === true,
        lh_kind: body.lh_kind != null ? String(body.lh_kind).trim() : null,
        posted_sequence:
          body.posted_sequence != null && Number.isFinite(Number(body.posted_sequence))
            ? Math.round(Number(body.posted_sequence))
            : null,
        confidence: "high",
      },
    },
  };
}

function isLedgerEventKind(kind) {
  return LEDGER_EVENT_KINDS.has(String(kind ?? "").trim());
}

module.exports = {
  LEDGER_EVENT_KINDS,
  SCHEMA_VERSION,
  buildLedgerEventIdempotencyKey,
  signalKindToEntryKind,
  validateLedgerEventSignal,
  isLedgerEventKind,
};
