/**
 * Step 4 (partial) — flag LH snapshot tenant_name changes for staff review.
 * Ledger pilot properties only; does not auto close/open occupancy.
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const {
  FINANCE_LEDGER_PILOT_PROPERTIES,
  isFinanceLedgerPilotProperty,
} = require("./financeLedgerPilot");

const PROPERA_OCCUPANCY_DRIFT_PROPERTIES = FINANCE_LEDGER_PILOT_PROPERTIES;

function normalizeTenantName(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

/**
 * @param {string} propertyCode
 * @param {string} unitLabel
 * @param {string} previousName
 * @param {string} newName
 * @param {string} syncedAt
 */
function buildTenantNameDriftIdempotencyKey(
  propertyCode,
  unitLabel,
  previousName,
  newName,
  syncedAt
) {
  const prop = String(propertyCode ?? "").trim().toUpperCase();
  const unit = String(unitLabel ?? "").trim();
  const prev = normalizeTenantName(previousName);
  const next = normalizeTenantName(newName);
  const day = String(syncedAt ?? "").trim().slice(0, 10) || "unknown";
  return `leasehold:${prop}:${unit}:occupancy_drift:tenant_name:${prev}:${next}:${day}`;
}

/**
 * @param {unknown} body
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeTenantNameDrifts(body) {
  const raw = Array.isArray(body?.tenant_name_drifts)
    ? body.tenant_name_drifts
    : Array.isArray(body?.tenantNameDrifts)
      ? body.tenantNameDrifts
      : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const unitId = String(
      item.unit_catalog_id ?? item.unitCatalogId ?? ""
    ).trim();
    if (!unitId) continue;
    out.push({
      unit_catalog_id: unitId,
      unit_label: String(item.unit_label ?? item.unitLabel ?? "").trim(),
      previous_tenant_name: String(
        item.previous_tenant_name ?? item.previousTenantName ?? ""
      ).trim(),
      new_tenant_name: String(
        item.new_tenant_name ?? item.newTenantName ?? ""
      ).trim(),
    });
  }
  return out;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {Array<Record<string, unknown>>} drifts
 * @param {string} syncedAt
 * @param {string} [sourceSystem]
 */
async function recordOccupancyTenantNameDrifts(
  sb,
  propertyCode,
  drifts,
  syncedAt,
  sourceSystem = "leasehold"
) {
  const code = String(propertyCode ?? "").trim().toUpperCase();
  if (!isFinanceLedgerPilotProperty(code)) {
    return {
      drift_created: 0,
      drift_skipped_existing: 0,
      drift_skipped_unchanged: 0,
      drift_rejected: 0,
      drift_errors: [],
    };
  }
  if (!sb || !Array.isArray(drifts) || !drifts.length) {
    return {
      drift_created: 0,
      drift_skipped_existing: 0,
      drift_skipped_unchanged: 0,
      drift_rejected: 0,
      drift_errors: [],
    };
  }

  const syncedIso =
    syncedAt && Number.isFinite(new Date(syncedAt).getTime())
      ? new Date(syncedAt).toISOString()
      : new Date().toISOString();
  const source = String(sourceSystem ?? "leasehold").trim().toLowerCase() || "leasehold";

  let driftCreated = 0;
  let driftSkippedExisting = 0;
  let driftSkippedUnchanged = 0;
  let driftRejected = 0;
  const driftErrors = [];

  for (const item of drifts) {
    const unitId = String(item.unit_catalog_id ?? "").trim();
    const unitLabel = String(item.unit_label ?? "").trim();
    const previousName = String(item.previous_tenant_name ?? "").trim();
    const newName = String(item.new_tenant_name ?? "").trim();

    if (!unitId) {
      driftRejected += 1;
      driftErrors.push("missing_unit_catalog_id");
      continue;
    }

    if (normalizeTenantName(previousName) === normalizeTenantName(newName)) {
      driftSkippedUnchanged += 1;
      continue;
    }

    const idempotencyKey = buildTenantNameDriftIdempotencyKey(
      code,
      unitLabel || unitId,
      previousName,
      newName,
      syncedIso
    );

    const row = {
      unit_catalog_id: unitId,
      property_code: code,
      unit_label: unitLabel,
      drift_kind: "tenant_name_change",
      previous_value: previousName,
      new_value: newName,
      source_system: source,
      synced_at: syncedIso,
      idempotency_key: idempotencyKey,
      status: "open",
      payload_json: {
        previous_tenant_name: previousName,
        new_tenant_name: newName,
      },
    };

    const { error } = await sb.from("occupancy_drift_flags").insert(row);
    if (error) {
      if (/duplicate key|unique constraint/i.test(error.message)) {
        driftSkippedExisting += 1;
        continue;
      }
      if (/occupancy_drift_flags|does not exist/i.test(error.message)) {
        return {
          drift_created: driftCreated,
          drift_skipped_existing: driftSkippedExisting,
          drift_skipped_unchanged: driftSkippedUnchanged,
          drift_rejected: drifts.length - driftCreated - driftSkippedExisting - driftSkippedUnchanged,
          drift_errors: ["migration_missing"],
        };
      }
      driftRejected += 1;
      driftErrors.push(error.message.slice(0, 120));
      continue;
    }

    driftCreated += 1;
    await appendEventLog({
      traceId: "",
      log_kind: "brain",
      event: "OCCUPANCY_TENANT_NAME_DRIFT",
      payload: {
        property_code: code,
        unit_catalog_id: unitId,
        unit_label: unitLabel,
        previous_tenant_name: previousName,
        new_tenant_name: newName,
        synced_at: syncedIso,
        idempotency_key: idempotencyKey,
      },
    });
  }

  return {
    drift_created: driftCreated,
    drift_skipped_existing: driftSkippedExisting,
    drift_skipped_unchanged: driftSkippedUnchanged,
    drift_rejected: driftRejected,
    drift_errors: [...new Set(driftErrors)],
  };
}

module.exports = {
  PROPERA_OCCUPANCY_DRIFT_PROPERTIES,
  normalizeTenantName,
  buildTenantNameDriftIdempotencyKey,
  normalizeTenantNameDrifts,
  recordOccupancyTenantNameDrifts,
};
