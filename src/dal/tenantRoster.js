/**
 * GAS **Tenants** sheet + `findTenantCandidates_` — `14_DIRECTORY_SESSION_DAL.gs` ~2031–2091.
 * Staff #capture tickets must use **resident** phone from roster when uniquely resolvable; never staff phone.
 *
 * Requires migration **`012_tenant_roster.sql`**.
 */
const { normalizeUnit_ } = require("../brain/shared/extractUnitGas");
const { normalizePhoneE164 } = require("../utils/phone");
const {
  scoreNameMatch_,
  extractStaffTenantNameHintCombined,
} = require("../brain/gas/extractStaffTenantNameHintFromText");
const { parseMediaJson, mediaTextHints } = require("../brain/shared/mediaPayload");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {string} unitLabel
 * @param {string} queryName — optional name hint (empty = match unit occupants only)
 * @returns {Promise<Array<{ phone: string, name: string, score: number }>>}
 */
async function findTenantCandidates(sb, propertyCode, unitLabel, queryName) {
  const u = normalizeUnit_(String(unitLabel || ""));
  if (!u || !propertyCode || !sb) return [];

  const code = String(propertyCode).trim().toUpperCase();
  const { data, error } = await sb
    .from("tenant_roster")
    .select("phone_e164, resident_name, unit_label, active")
    .eq("property_code", code)
    .eq("active", true);

  if (error || !data || !data.length) return [];

  const qn = String(queryName || "").trim();
  const qnLower = qn.toLowerCase();
  const found = [];

  for (const row of data) {
    const ru = normalizeUnit_(String(row.unit_label || ""));
    if (ru !== u) continue;
    const rname = String(row.resident_name || "").trim();
    const score = qn ? scoreNameMatch_(qnLower, rname) : 100;
    if (qn && score <= 0) continue;
    const ph = normalizePhoneE164(String(row.phone_e164 || ""));
    if (!ph) continue;
    found.push({ phone: ph, name: rname, score });
  }

  const best = {};
  for (const x of found) {
    if (!best[x.phone] || x.score > best[x.phone].score) best[x.phone] = x;
  }
  return Object.values(best).sort((a, b) => (b.score || 0) - (a.score || 0));
}

/**
 * GAS `enrichStaffCapTenantIdentity_` decision core — single match rules.
 */
function pickResolvedTenantPhone(candidates, queryName) {
  const hasHint = String(queryName || "").trim().length > 0;
  if (hasHint) {
    if (candidates.length === 0) {
      return {
        phoneE164: "",
        status: "NO_MATCH",
        matchedName: null,
      };
    }
    if (candidates.length > 1) {
      return {
        phoneE164: "",
        status: "AMBIGUOUS",
        matchedName: null,
      };
    }
    if ((candidates[0].score || 0) < 85) {
      return {
        phoneE164: "",
        status: "SKIPPED_LOW_CONFIDENCE",
        matchedName: null,
      };
    }
    return {
      phoneE164: candidates[0].phone,
      status: "MATCHED",
      matchedName: candidates[0].name || null,
    };
  }
  if (candidates.length === 0) {
    return {
      phoneE164: "",
      status: "NO_MATCH",
      matchedName: null,
    };
  }
  if (candidates.length > 1) {
    return {
      phoneE164: "",
      status: "AMBIGUOUS",
      matchedName: null,
    };
  }
  return {
    phoneE164: candidates[0].phone,
    status: "MATCHED",
    matchedName: candidates[0].name || null,
  };
}

/**
 * @param {object} o
 * @param {import("@supabase/supabase-js").SupabaseClient} o.sb
 * @param {string} o.propertyCode
 * @param {string} o.unitLabel
 * @param {string} o.bodyText — message + optional OCR (same as merged intake text)
 * @param {string} [o._mediaJson] — from RouterParameter for OCR-first name hints
 */
async function resolveStaffCaptureTenantPhone(o) {
  const sb = o.sb;
  const propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  const unitLabel = String(o.unitLabel || "").trim();
  const bodyText = String(o.bodyText || "").trim();

  let mediaNameHint = "";
  const media = parseMediaJson(o._mediaJson);
  for (const t of mediaTextHints(media)) {
    const h = extractStaffTenantNameHintCombined(t);
    if (h) {
      mediaNameHint = h;
      break;
    }
  }

  let textHint = "";
  if (!mediaNameHint) {
    textHint = extractStaffTenantNameHintCombined(bodyText);
  }

  const finalHint = mediaNameHint || textHint || "";
  const candidates = await findTenantCandidates(
    sb,
    propertyCode,
    unitLabel,
    finalHint
  );
  const picked = pickResolvedTenantPhone(candidates, finalHint);

  return {
    phoneE164: picked.phoneE164,
    meta: {
      tenantNameHint: finalHint,
      tenantNameTrusted: !!mediaNameHint,
      tenantLookupStatus: picked.status,
      tenantLookupMatchedName: picked.matchedName,
    },
  };
}

module.exports = {
  findTenantCandidates,
  pickResolvedTenantPhone,
  resolveStaffCaptureTenantPhone,
};
