/**
 * Vendor phone directory — lane identity (orchestrator preload only).
 * @see docs/VENDOR_LANE.md
 */

const { getSupabase, isDbConfigured } = require("../db/supabase");

function digitsLast10(s) {
  return String(s || "")
    .replace(/\D/g, "")
    .slice(-10);
}

function isVendorContactsMigrationMissing(error) {
  const msg = String((error && error.message) || "");
  return (
    error &&
    (error.code === "42P01" || error.code === "PGRST205") &&
    /vendor_contacts/i.test(msg)
  );
}

/**
 * @param {string} actorKey — E.164, TG:…, or raw phone
 * @returns {Promise<{ vendorId: string, displayName: string, dispatchPhoneE164: string } | null>}
 */
async function resolveVendorByActorKey(actorKey) {
  if (!isDbConfigured()) return null;
  const sb = getSupabase();
  if (!sb) return null;

  const d10 = digitsLast10(actorKey);
  if (!d10 || d10.length < 10) return null;

  const { data: contacts, error } = await sb
    .from("vendor_contacts")
    .select("vendor_id, phone_e164, active")
    .eq("active", true);

  if (error) {
    if (isVendorContactsMigrationMissing(error)) return null;
    return null;
  }

  for (const row of contacts || []) {
    const phone = String(row.phone_e164 || "").trim();
    if (!phone || row.active === false) continue;
    const rowD10 = digitsLast10(phone);
    if (!rowD10 || rowD10 !== d10) continue;
    const vendorId = String(row.vendor_id || "").trim();
    if (!vendorId) continue;

    const { data: v } = await sb
      .from("vendors")
      .select("vendor_id, display_name, active")
      .eq("vendor_id", vendorId)
      .maybeSingle();
    if (!v || v.active === false) continue;

    const displayName = String(v.display_name || "").trim() || vendorId;
    return {
      vendorId,
      displayName,
      dispatchPhoneE164: phone.startsWith("+") ? phone : `+1${rowD10}`,
    };
  }

  return null;
}

module.exports = {
  resolveVendorByActorKey,
  digitsLast10,
  isVendorContactsMigrationMissing,
};
