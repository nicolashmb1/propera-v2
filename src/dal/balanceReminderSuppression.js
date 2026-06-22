/**
 * Balance reminder suppressions — Step 4 policy outcomes (Propera ops only).
 * Patch Law: DAL only; no SMS sends; no Leasehold write-back.
 */

const { normalizeUnit_ } = require("../brain/shared/extractUnitGas");
const { properaTimezone } = require("../config/env");

function calendarPartsInTz(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const pick = (type) => {
    const part = parts.find((p) => p.type === type);
    return part ? part.value : "";
  };
  return {
    year: pick("year"),
    month: pick("month"),
  };
}

function periodKeyInTimezone(date, timeZone) {
  const parts = calendarPartsInTz(date, timeZone);
  return `${parts.year}-${parts.month}`;
}

function currentPeriodKey() {
  return periodKeyInTimezone(new Date(), properaTimezone() || "America/New_York");
}

function isMigrationMissing(message) {
  return /balance_reminder_suppressions|does not exist/i.test(String(message || ""));
}

function buildUnitKey(propertyCode, unitLabel) {
  const code = String(propertyCode || "").trim().toUpperCase();
  const unit = normalizeUnit_(unitLabel);
  return code && unit ? `${code}::${unit}` : "";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {string} unitCatalogId
 */
async function resolveTenantRosterIdsForUnit(sb, propertyCode, unitCatalogId) {
  const unitId = String(unitCatalogId || "").trim();
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!sb || !unitId || !code) return [];

  const { data: unit, error: unitError } = await sb
    .from("units")
    .select("property_code, unit_label")
    .eq("id", unitId)
    .maybeSingle();
  if (unitError || !unit) return [];

  const unitKey = buildUnitKey(unit.property_code, unit.unit_label);
  if (!unitKey) return [];

  const { data: rosterRows, error: rosterError } = await sb
    .from("tenant_roster")
    .select("id, property_code, unit_label")
    .eq("active", true)
    .eq("property_code", code);
  if (rosterError) return [];

  const ids = [];
  const seen = new Set();
  for (const row of rosterRows || []) {
    const rosterKey = buildUnitKey(row.property_code, row.unit_label);
    if (rosterKey !== unitKey) continue;
    const tenantId = String(row.id || "").trim().toLowerCase();
    if (!tenantId || seen.has(tenantId)) continue;
    seen.add(tenantId);
    ids.push(tenantId);
  }
  return ids;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{
 *   tenantRosterId: string;
 *   periodKey: string;
 *   sourceType: string;
 *   sourceRef: string;
 *   propertyCode: string;
 *   unitCatalogId?: string | null;
 *   paymentAmountCents: number;
 *   paymentEffectiveDate: string;
 *   reason?: string;
 * }} row
 */
async function upsertPaymentSuppression(sb, row) {
  const tenantRosterId = String(row.tenantRosterId || "").trim();
  const sourceRef = String(row.sourceRef || "").trim();
  if (!tenantRosterId || !sourceRef) {
    return { ok: false, error: "missing_tenant_or_source_ref" };
  }

  const insertRow = {
    tenant_roster_id: tenantRosterId,
    period_key: String(row.periodKey || "").trim(),
    reason: String(row.reason || "payment_received").trim() || "payment_received",
    source_type: String(row.sourceType || "").trim(),
    source_ref: sourceRef,
    property_code: String(row.propertyCode || "").trim().toUpperCase(),
    unit_catalog_id: row.unitCatalogId || null,
    payment_amount_cents: Math.round(Number(row.paymentAmountCents) || 0),
    payment_effective_date: String(row.paymentEffectiveDate || "").trim().slice(0, 10),
  };

  const { error } = await sb.from("balance_reminder_suppressions").insert(insertRow);
  if (error) {
    if (/duplicate key|unique constraint/i.test(error.message)) {
      return { ok: true, action: "skipped_existing", source_ref: sourceRef };
    }
    if (isMigrationMissing(error.message)) {
      return { ok: false, error: "migration_missing" };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true, action: "created", source_ref: sourceRef };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{
 *   tenantIds: string[];
 *   periodKey: string;
 *   sourceType: string;
 *   sourceRef: string;
 *   propertyCode: string;
 *   unitCatalogId?: string | null;
 *   paymentAmountCents: number;
 *   paymentEffectiveDate: string;
 *   reason?: string;
 *   coverage_reason?: string;
 * }} opts
 */
async function recordPaidUpReminderSuppressions(sb, opts) {
  const tenantIds = [...new Set((opts.tenantIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!tenantIds.length) {
    return { ok: true, skipped: "no_tenant_roster" };
  }

  const suppressions = [];
  for (const tenantRosterId of tenantIds) {
    const out = await upsertPaymentSuppression(sb, {
      tenantRosterId,
      periodKey: opts.periodKey,
      sourceType: opts.sourceType,
      sourceRef: opts.sourceRef,
      propertyCode: opts.propertyCode,
      unitCatalogId: opts.unitCatalogId,
      paymentAmountCents: opts.paymentAmountCents,
      paymentEffectiveDate: opts.paymentEffectiveDate,
      reason: opts.reason || "payment_received_paid_up",
    });
    suppressions.push({ tenant_roster_id: tenantRosterId, ...out });
  }

  const created = suppressions.filter((s) => s.action === "created").length;
  const skippedExisting = suppressions.filter((s) => s.action === "skipped_existing").length;
  const failed = suppressions.filter((s) => s.ok === false);

  return {
    ok: failed.length === 0,
    policy: "payment_received_reminder_suppression",
    period_key: opts.periodKey,
    tenant_count: tenantIds.length,
    created,
    skipped_existing: skippedExisting,
    coverage_reason: opts.coverage_reason,
    errors: failed.length ? failed.map((f) => f.error).filter(Boolean) : undefined,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string[]} tenantIds
 * @param {string} periodKey
 */
async function loadSuppressedTenantIds(sb, tenantIds, periodKey) {
  const unique = [...new Set(tenantIds.map((id) => String(id || "").trim().toLowerCase()).filter(Boolean))];
  if (!unique.length || !periodKey) return new Set();

  const { data, error } = await sb
    .from("balance_reminder_suppressions")
    .select("tenant_roster_id")
    .eq("period_key", periodKey)
    .in("tenant_roster_id", unique);

  if (error) {
    if (isMigrationMissing(error.message)) return new Set();
    throw new Error(error.message || "suppression_query_failed");
  }

  return new Set(
    (data || [])
      .map((row) => String(row.tenant_roster_id || "").trim().toLowerCase())
      .filter(Boolean)
  );
}

module.exports = {
  periodKeyInTimezone,
  currentPeriodKey,
  resolveTenantRosterIdsForUnit,
  upsertPaymentSuppression,
  recordPaidUpReminderSuppressions,
  loadSuppressedTenantIds,
};
