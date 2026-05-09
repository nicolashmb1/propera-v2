/**
 * Shared helpers for maintenance core dispatch (`handleInboundCore` Phase 4 extractions).
 * Keep behavior identical to pre-extraction inline definitions.
 */

const { parseMediaJson, composeInboundTextWithMedia } = require("../shared/mediaPayload");
const { parseMediaSignalsJson } = require("../shared/mediaSignalRuntime");
const {
  resolveStaffCaptureTenantPhone,
  isPhoneOnRosterForUnit,
} = require("../../dal/tenantRoster");
const { normalizePhoneE164 } = require("../../utils/phone");
const { isCommonAreaLocation } = require("../shared/commonArea");

/**
 * GAS `enrichStaffCapTenantIdentity_` / `findTenantCandidates_` — resident phone for staff #capture only.
 */
async function resolveManagerTenantIfNeeded(
  sb,
  mode,
  propertyCode,
  unitLabel,
  locationType,
  bodyText,
  routerParameter
) {
  if (isCommonAreaLocation(locationType)) {
    return {
      tenantPhoneE164: "",
      tenantLookupMeta: { tenantLookupStatus: "SKIPPED_COMMON_AREA" },
    };
  }
  if (mode !== "MANAGER") {
    return { tenantPhoneE164: "", tenantLookupMeta: null };
  }
  const p = routerParameter || {};
  const explicitRaw = String(p._tenantPhoneE164 || "").trim();
  const explicitNorm = explicitRaw ? normalizePhoneE164(explicitRaw) : "";
  let portalTenantAudit = null;
  if (explicitNorm) {
    const rosterOk = await isPhoneOnRosterForUnit(
      sb,
      propertyCode,
      unitLabel,
      explicitNorm
    );
    if (rosterOk) {
      return {
        tenantPhoneE164: explicitNorm,
        tenantLookupMeta: {
          portal_explicit_tenant: true,
          roster_validated: true,
        },
      };
    }
    portalTenantAudit = {
      portal_explicit_tenant_rejected: true,
      portal_explicit_tenant_phone_attempted: explicitNorm,
    };
  } else if (explicitRaw) {
    portalTenantAudit = { portal_explicit_tenant_invalid_format: true };
  }

  const merged = composeInboundTextWithMedia(
    bodyText,
    parseMediaJson(p._mediaJson),
    2400,
    parseMediaSignalsJson(p._mediaSignalsJson)
  );
  const r = await resolveStaffCaptureTenantPhone({
    sb,
    propertyCode,
    unitLabel,
    bodyText: merged || bodyText,
    _mediaJson: p._mediaJson,
  });
  const mergedMeta =
    portalTenantAudit || r.meta
      ? { ...(r.meta || {}), ...(portalTenantAudit || {}) }
      : null;
  return {
    tenantPhoneE164: r.phoneE164 || "",
    tenantLookupMeta: mergedMeta && Object.keys(mergedMeta).length ? mergedMeta : null,
  };
}

async function loadPropertyCodesUpper(sb) {
  const { data, error } = await sb.from("properties").select("code");
  if (error || !data) return new Set();
  const set = new Set();
  data.forEach((r) => {
    if (r && r.code) set.add(String(r.code).toUpperCase());
  });
  return set;
}

function hasClarifyingStaffMediaSignal(mediaSignals) {
  const list = Array.isArray(mediaSignals) ? mediaSignals : [];
  return list.some((sig) => {
    if (!sig || typeof sig !== "object") return false;
    if (sig.needsClarification) return true;
    const issueConf =
      sig.confidence && typeof sig.confidence === "object"
        ? Number(sig.confidence.issue)
        : 0;
    const hasIssueText = !!String(
      sig.syntheticBody || sig.issueNameHint || sig.issueDescriptionHint || ""
    ).trim();
    return !hasIssueText && isFinite(issueConf) && issueConf > 0 && issueConf < 0.55;
  });
}

function buildStaffPhotoIssueClarification(draft) {
  const prop = String(draft && draft.draft_property || "").trim();
  const unit = String(draft && draft.draft_unit || "").trim();
  const place = [prop, unit].filter(Boolean).join(" ");
  if (place) {
    return "I received the photo for " + place + ". What issue should I create this for?";
  }
  return "I received the photo. What issue should I create this for?";
}

module.exports = {
  resolveManagerTenantIfNeeded,
  loadPropertyCodesUpper,
  hasClarifyingStaffMediaSignal,
  buildStaffPhotoIssueClarification,
};
