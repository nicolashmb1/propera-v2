/**
 * Tenant roster lookup for agent gather — phone / linked Telegram → property + unit + name.
 */
const { getSupabase } = require("../../db/supabase");
const { normalizeUnit_ } = require("../../brain/shared/extractUnitGas");
const { normalizePhoneE164 } = require("../../utils/phone");
const {
  getLinkedPhoneE164ForTelegramInbound,
} = require("../../dal/telegramChatLinkLookup");
const { isPropertyOnTenantAgentPilot } = require("./propertyAllowlist");

/**
 * @param {object[]} propertiesList
 * @param {string} propertyCode
 * @returns {string}
 */
function propertyTenantLabelFromList(propertiesList, propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!code) return "";
  const row = (propertiesList || []).find(
    (p) => String(p.code || "").trim().toUpperCase() === code
  );
  if (!row) return code;
  return (
    String(row.display_name_short || "").trim() ||
    String(row.short_name || "").trim() ||
    String(row.display_name || "").trim() ||
    code
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient | null | undefined} sb
 * @param {Record<string, string>} routerParameter
 * @param {string} tenantActorKey
 * @returns {Promise<string>}
 */
async function resolveInboundPhoneForRosterLookup(sb, routerParameter, tenantActorKey) {
  const rp = routerParameter || {};
  const explicit = String(rp._phoneE164 || "").trim();
  if (explicit && !/^TG:/i.test(explicit)) {
    const n = normalizePhoneE164(explicit);
    if (n) return n;
  }

  const actor = String(tenantActorKey || rp.From || "").trim();
  if (/^TG:/i.test(actor) && sb) {
    const digits = actor.replace(/^TG:/i, "").replace(/\D/g, "");
    const linked = await getLinkedPhoneE164ForTelegramInbound(sb, {
      telegramUserIdDigits: digits,
      telegramChatId: String(rp._telegramChatId || "").trim(),
    });
    if (linked) {
      const n = normalizePhoneE164(linked);
      return n || String(linked).trim();
    }
  }

  if (actor && !/^TG:/i.test(actor)) {
    const n = normalizePhoneE164(actor);
    if (n) return n;
  }
  return "";
}

/**
 * @param {object[]} rows
 * @param {Set<string>} knownPropertyCodesUpper
 * @returns {object | null}
 */
function pickUniqueRosterRow(rows, knownPropertyCodesUpper) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;

  let candidates = list.filter((r) => r && r.active !== false);
  if (knownPropertyCodesUpper && knownPropertyCodesUpper.size) {
    candidates = candidates.filter((r) =>
      knownPropertyCodesUpper.has(String(r.property_code || "").trim().toUpperCase())
    );
  }
  candidates = candidates.filter((r) => isPropertyOnTenantAgentPilot(String(r.property_code || "")));
  if (!candidates.length) return null;

  const byLocation = new Map();
  for (const row of candidates) {
    const key = [
      String(row.property_code || "").trim().toUpperCase(),
      normalizeUnit_(String(row.unit_label || "")),
    ].join("|");
    const prev = byLocation.get(key);
    if (!prev) {
      byLocation.set(key, row);
      continue;
    }
    const prevAt = new Date(prev.updated_at || 0).getTime();
    const rowAt = new Date(row.updated_at || 0).getTime();
    if (rowAt > prevAt) byLocation.set(key, row);
  }

  if (byLocation.size !== 1) return null;
  return byLocation.values().next().value || null;
}

/**
 * @param {string} residentName
 * @returns {string}
 */
function formatResidentSalutation(residentName) {
  const raw = String(residentName || "").trim();
  if (!raw) return "";
  const first = raw.split(/\s+/)[0];
  return first || raw;
}

/**
 * @param {object} rosterContext
 * @param {object[]} propertiesList
 * @returns {string}
 */
function formatRosterLocationLabel(rosterContext, propertiesList) {
  const propertyCode = String(rosterContext.property_code || "").trim().toUpperCase();
  const unit = String(rosterContext.unit_label || "").trim();
  const propertyLabel = propertyTenantLabelFromList(propertiesList, propertyCode);
  if (propertyLabel && unit) return `${propertyLabel}, unit ${unit}`;
  if (propertyLabel) return propertyLabel;
  if (unit && propertyCode) return `${propertyCode}, unit ${unit}`;
  return propertyCode || unit || "";
}

/**
 * @param {object} o
 * @param {import("@supabase/supabase-js").SupabaseClient | null} [o.sb]
 * @param {Record<string, string>} [o.routerParameter]
 * @param {string} [o.tenantActorKey]
 * @param {Set<string>} [o.knownPropertyCodesUpper]
 * @returns {Promise<{ matched: boolean, row?: object, phoneE164?: string }>}
 */
async function lookupTenantRosterForAgent(o) {
  const sb = o.sb || getSupabase();
  if (!sb) return { matched: false };

  const phoneE164 = await resolveInboundPhoneForRosterLookup(
    sb,
    o.routerParameter || {},
    o.tenantActorKey || ""
  );
  if (!phoneE164) return { matched: false };

  const { data, error } = await sb
    .from("tenant_roster")
    .select("id, property_code, unit_label, phone_e164, resident_name, active, updated_at")
    .eq("phone_e164", phoneE164)
    .eq("active", true)
    .order("updated_at", { ascending: false });

  if (error || !data || !data.length) {
    return { matched: false, phoneE164 };
  }

  const row = pickUniqueRosterRow(data, o.knownPropertyCodesUpper);
  if (!row) return { matched: false, phoneE164 };

  return {
    matched: true,
    phoneE164,
    row: {
      roster_id: String(row.id || "").trim(),
      property_code: String(row.property_code || "").trim().toUpperCase(),
      unit_label: String(row.unit_label || "").trim(),
      resident_name: String(row.resident_name || "").trim(),
      phone_e164: phoneE164,
    },
  };
}

/**
 * Seed gather partial from roster when slots are still empty.
 * @param {object} partial
 * @param {{ matched: boolean, row?: object }} lookup
 * @returns {object}
 */
function applyRosterGatherContext(partial, lookup) {
  const next = { ...(partial || {}) };
  next._roster_lookup_done = true;

  if (!lookup || !lookup.matched || !lookup.row) {
    return next;
  }

  const row = lookup.row;
  next._roster_context = { ...row };

  if (!String(next.property || "").trim() && row.property_code) {
    next.property = row.property_code;
  }
  if (
    !String(next.unit || "").trim() &&
    String(next.location_kind || "unit").trim().toLowerCase() !== "common_area" &&
    row.unit_label
  ) {
    next.unit = row.unit_label;
    next.location_kind = "unit";
  }
  return next;
}

/**
 * @param {object} partial
 * @param {object[]} propertiesList
 * @returns {string | null}
 */
function buildRosterAwareGreeting(partial, propertiesList) {
  const roster = partial && partial._roster_context;
  if (!roster || !roster.property_code) return null;

  const first = formatResidentSalutation(roster.resident_name);
  const where = formatRosterLocationLabel(roster, propertiesList);
  if (first && where) {
    return `Hi ${first} — I have you at ${where}. How can I help you today?`;
  }
  if (where) {
    return `Hi — I have you at ${where}. How can I help you today?`;
  }
  return null;
}

/**
 * @param {string | null} missing
 * @param {object} partial
 * @param {object[]} propertiesList
 * @returns {string | null}
 */
function buildRosterMissingFieldPrompt(missing, partial, propertiesList) {
  const roster = partial && partial._roster_context;
  if (!roster) return null;

  const m = String(missing || "").toLowerCase();
  const first = formatResidentSalutation(roster.resident_name);
  const where = formatRosterLocationLabel(roster, propertiesList);

  if (m === "issue" && where) {
    if (first) {
      return `Hi ${first} — I have you at ${where}. What can I help you with today?`;
    }
    return `Hi — I have you at ${where}. What can I help you with today?`;
  }
  if (m === "schedule" && where && first) {
    return `Thanks, ${first}. When works for maintenance to visit unit ${String(roster.unit_label || "").trim() || "your unit"}?`;
  }
  return null;
}

module.exports = {
  resolveInboundPhoneForRosterLookup,
  pickUniqueRosterRow,
  formatResidentSalutation,
  formatRosterLocationLabel,
  lookupTenantRosterForAgent,
  applyRosterGatherContext,
  buildRosterAwareGreeting,
  buildRosterMissingFieldPrompt,
};
