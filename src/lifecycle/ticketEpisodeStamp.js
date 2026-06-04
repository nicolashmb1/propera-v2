/**
 * Ticket episode stamp — link new tickets to current unit_occupancies (Sync V3).
 * Write-only at create; surfaced in unit History, not ticket detail.
 */
const { unitLifecycleEnabled } = require("../config/env");
const { getCurrentUnitOccupancy } = require("../dal/unitOccupancies");
const { getSupabase } = require("../db/supabase");
const { normalizePhoneE164, rosterPhoneLookupCandidates } = require("../utils/phone");
/**
 * @param {object} o
 * @param {string} [o.unitCatalogId]
 * @param {string} [o.tenantPhoneE164]
 * @param {string} [o.traceId]
 * @returns {Promise<{ unit_occupancy_id?: string, tenant_roster_id_at_open?: string }>}
 */
async function resolveTicketEpisodeStamp(o) {
  if (!unitLifecycleEnabled()) return {};

  const unitCatalogId = String(o?.unitCatalogId || "").trim();
  if (!unitCatalogId) return {};

  const current = await getCurrentUnitOccupancy(unitCatalogId);
  if (!current.ok || !current.occupancy) return {};

  const occ = current.occupancy;
  let tenantRosterId = String(occ.tenant_roster_id || "").trim();

  if (!tenantRosterId) {
    const phone = normalizePhoneE164(String(o?.tenantPhoneE164 || ""));
    if (phone) {
      const sb = getSupabase();
      if (sb) {
        const prop = String(occ.property_code || "").trim().toUpperCase();
        const unitLabel = String(occ.unit_label_snapshot || "").trim();
        const candidates = rosterPhoneLookupCandidates(o.tenantPhoneE164);
        const { data: rows } = await sb
          .from("tenant_roster")
          .select("id")
          .eq("property_code", prop)
          .eq("unit_label", unitLabel)
          .in("phone_e164", candidates.length ? candidates : [phone])
          .limit(1);
        if (rows && rows[0] && rows[0].id) {
          tenantRosterId = String(rows[0].id);
        }
      }
    }
  }

  return {
    unit_occupancy_id: String(occ.id || ""),
    tenant_roster_id_at_open: tenantRosterId || null,
  };
}

module.exports = { resolveTicketEpisodeStamp };
