const { getSupabase } = require("../db/supabase");
const { normalizePhoneE164 } = require("../utils/phone");
const { normalizeUnit_ } = require("../brain/shared/extractUnitGas");
const { getBrandContext, getAudienceLabel } = require("./brandContextService");

function normalizeAudienceKind(raw) {
  return String(raw || "").trim().toUpperCase() || "PROPERTY";
}

function normalizeAudienceFilter(filter) {
  const src = filter && typeof filter === "object" ? filter : {};

  const propertyCodes = [];
  const propertySeen = new Set();
  for (const raw of Array.isArray(src.property_codes) ? src.property_codes : []) {
    const code = String(raw || "").trim().toUpperCase();
    if (!code || propertySeen.has(code)) continue;
    propertySeen.add(code);
    propertyCodes.push(code);
  }

  const floors = [];
  const floorSeen = new Set();
  for (const raw of Array.isArray(src.floors) ? src.floors : []) {
    const floor = String(raw || "").trim();
    if (!floor || floorSeen.has(floor)) continue;
    floorSeen.add(floor);
    floors.push(floor);
  }

  const unitIds = [];
  const unitSeen = new Set();
  for (const raw of Array.isArray(src.unit_ids) ? src.unit_ids : []) {
    const id = String(raw || "").trim().toLowerCase();
    if (!id || unitSeen.has(id)) continue;
    unitSeen.add(id);
    unitIds.push(id);
  }

  const tenantIds = [];
  const tenantSeen = new Set();
  for (const raw of Array.isArray(src.tenant_ids) ? src.tenant_ids : []) {
    const id = String(raw || "").trim().toLowerCase();
    if (!id || tenantSeen.has(id)) continue;
    tenantSeen.add(id);
    tenantIds.push(id);
  }

  const includeTenantPortal = src.include_tenant_portal !== false;
  const deliveryModeRaw = String(src.delivery_mode || "").trim().toLowerCase();
  const deliveryMode = deliveryModeRaw === "portal_only" ? "portal_only" : "sms_and_portal";

  return {
    property_codes: propertyCodes,
    floors,
    unit_ids: unitIds,
    tenant_ids: tenantIds,
    include_tenant_portal: includeTenantPortal,
    delivery_mode: deliveryMode,
  };
}

function buildUnitKey(propertyCode, unitLabel) {
  const code = String(propertyCode || "").trim().toUpperCase();
  const unit = normalizeUnit_(unitLabel);
  return code + "::" + unit;
}

function normalizePreferredChannel(raw) {
  const ch = String(raw || "").trim().toLowerCase();
  return ch === "whatsapp" ? "whatsapp" : "sms";
}

function buildAudiencePreview(input) {
  const opts = input && typeof input === "object" ? input : {};
  const recipients = Array.isArray(opts.recipients) ? opts.recipients : [];
  const brandContext = opts.brandContext || { properties: {} };
  const audienceKind = normalizeAudienceKind(opts.audienceKind);
  const audienceFilter = normalizeAudienceFilter(opts.audienceFilter);

  let willSend = 0;
  let skippedNoPhone = 0;
  let skippedOptOut = 0;
  let skippedNoUnit = Number.isFinite(opts.skippedNoUnit) ? opts.skippedNoUnit : 0;
  const byPropertyMap = new Map();

  for (const row of recipients) {
    const propertyCode = String(row.propertyCode || "").trim().toUpperCase();
    const displayName =
      String(
        (brandContext.properties &&
          brandContext.properties[propertyCode] &&
          brandContext.properties[propertyCode].displayName) ||
          row.displayName ||
          propertyCode
      ).trim() || propertyCode;

    let bucket = byPropertyMap.get(propertyCode);
    if (!bucket) {
      bucket = {
        propertyCode,
        displayName,
        total: 0,
        willSend: 0,
        skippedNoPhone: 0,
        skippedOptOut: 0,
      };
      byPropertyMap.set(propertyCode, bucket);
    }

    bucket.total += 1;
    const skipReason = String(row.skipReason || "").trim().toUpperCase();
    if (!skipReason) {
      willSend += 1;
      bucket.willSend += 1;
      continue;
    }
    if (skipReason === "NO_PHONE") {
      skippedNoPhone += 1;
      bucket.skippedNoPhone += 1;
      continue;
    }
    if (skipReason === "OPT_OUT") {
      skippedOptOut += 1;
      bucket.skippedOptOut += 1;
    }
  }

  return {
    audienceLabel: getAudienceLabel(brandContext, audienceKind, audienceFilter),
    total: recipients.length,
    willSend,
    skippedNoPhone,
    skippedOptOut,
    skippedNoUnit,
    byProperty: Array.from(byPropertyMap.values()).sort((a, b) =>
      String(a.propertyCode).localeCompare(String(b.propertyCode))
    ),
  };
}

async function resolveAudience(filter, orgId, input) {
  const sb = (input && input.sb) || getSupabase();
  if (!sb) return { ok: false, error: "no_db", recipients: [] };

  const audienceFilter = normalizeAudienceFilter(filter);
  const portalOnlyDelivery = String(audienceFilter.delivery_mode || "").trim().toLowerCase() === "portal_only";
  const propertyCodes = audienceFilter.property_codes;
  const floorSet = new Set(audienceFilter.floors);
  const unitIdSet = new Set(audienceFilter.unit_ids);
  const tenantIdSet = new Set(audienceFilter.tenant_ids);

  let rosterQuery = sb
    .from("tenant_roster")
    .select(
      "id, property_code, unit_label, phone_e164, resident_name, active, comm_broadcast_opt_out, preferred_channel"
    )
    .eq("active", true);
  if (propertyCodes.length) {
    rosterQuery = rosterQuery.in("property_code", propertyCodes);
  }
  const { data: rosterRows, error: rosterError } = await rosterQuery;
  if (rosterError) {
    return { ok: false, error: rosterError.message || "tenant_roster_query_failed", recipients: [] };
  }

  let unitQuery = sb
    .from("units")
    .select("id, property_code, unit_label, floor");
  if (propertyCodes.length) {
    unitQuery = unitQuery.in("property_code", propertyCodes);
  }
  const { data: unitRows, error: unitError } = await unitQuery;
  if (unitError) {
    return { ok: false, error: unitError.message || "units_query_failed", recipients: [] };
  }

  const unitMap = new Map();
  for (const row of unitRows || []) {
    const key = buildUnitKey(row.property_code, row.unit_label);
    if (!key) continue;
    unitMap.set(key, row);
  }

  const brandContext =
    (input && input.brandContext) ||
    (await getBrandContext({ orgId, propertyCodes }));

  const recipients = [];
  let skippedNoUnit = 0;

  for (const row of rosterRows || []) {
    const tenantId = String(row.id || "").trim().toLowerCase();
    if (tenantIdSet.size && !tenantIdSet.has(tenantId)) continue;

    const propertyCode = String(row.property_code || "").trim().toUpperCase();
    const unit = unitMap.get(buildUnitKey(propertyCode, row.unit_label));
    if (!unit) {
      skippedNoUnit += 1;
      continue;
    }

    const unitId = String(unit.id || "").trim().toLowerCase();
    if (unitIdSet.size && !unitIdSet.has(unitId)) continue;

    const floor = String(unit.floor || "").trim();
    if (floorSet.size && !floorSet.has(floor)) continue;

    const phone = normalizePhoneE164(String(row.phone_e164 || ""));
    let skipReason = "";
    if (!portalOnlyDelivery) {
      if (row.comm_broadcast_opt_out === true) skipReason = "OPT_OUT";
      else if (!phone) skipReason = "NO_PHONE";
    }

    recipients.push({
      tenantId,
      unitId,
      propertyCode,
      displayName:
        (brandContext.properties &&
          brandContext.properties[propertyCode] &&
          brandContext.properties[propertyCode].displayName) ||
        propertyCode,
      unitLabel: String(row.unit_label || "").trim(),
      name: String(row.resident_name || "").trim(),
      phone,
      channel: normalizePreferredChannel(row.preferred_channel),
      skipReason,
    });
  }

  recipients.sort((a, b) => {
    if (a.propertyCode !== b.propertyCode) {
      return a.propertyCode.localeCompare(b.propertyCode);
    }
    if (a.unitLabel !== b.unitLabel) {
      return a.unitLabel.localeCompare(b.unitLabel, undefined, { numeric: true });
    }
    return a.name.localeCompare(b.name);
  });

  return {
    ok: true,
    recipients,
    skippedNoUnit,
    brandContext,
  };
}

async function getAudiencePreview(input) {
  const opts = input && typeof input === "object" ? input : {};
  const audienceKind = normalizeAudienceKind(opts.audienceKind);
  const audienceFilter = normalizeAudienceFilter(opts.audienceFilter);
  const resolved = await resolveAudience(audienceFilter, opts.orgId, {
    sb: opts.sb,
    brandContext: opts.brandContext,
  });
  if (!resolved.ok) return resolved;

  const preview = buildAudiencePreview({
    recipients: resolved.recipients,
    brandContext: resolved.brandContext,
    audienceKind,
    audienceFilter,
    skippedNoUnit: resolved.skippedNoUnit,
  });

  return {
    ok: true,
    ...preview,
    recipients: resolved.recipients,
    brandContext: resolved.brandContext,
  };
}

module.exports = {
  normalizeAudienceKind,
  normalizeAudienceFilter,
  buildAudiencePreview,
  resolveAudience,
  getAudiencePreview,
};
