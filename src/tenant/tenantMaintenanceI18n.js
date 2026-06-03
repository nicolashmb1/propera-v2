/**
 * Normalize tenant maintenance free text to English before brain/pipeline.
 * @see docs/TENANT_PORTAL_I18N.md Phase 2
 */
const { tenantI18nEnabled } = require("../config/env");
const { normalizeTenantUiLocale } = require("./tenantI18nLocale");
const { detectLanguage, resolveEffectiveContentLocale } = require("./detectTextLanguage");
const { translateToEnglish } = require("./translateTenantText");
const { emit } = require("../logging/structuredLog");

/**
 * @param {object} opts
 * @param {string} opts.description
 * @param {string} [opts.locationDetail]
 * @param {string} [opts.preferredLanguage]
 * @param {string} [opts.traceId]
 * @param {number} [opts.traceStartMs]
 * @returns {Promise<{
 *   description: string,
 *   locationDetail: string,
 *   meta: { detectedLocale: string|null, translated: boolean, uiLocale: string }
 * }>}
 */
async function prepareMaintenanceTextForBrain(opts) {
  const description = String(opts.description || "").trim();
  const locationDetail = String(opts.locationDetail || "").trim();
  const uiLocale = normalizeTenantUiLocale(opts.preferredLanguage);
  const meta = {
    detectedLocale: null,
    translated: false,
    uiLocale,
  };

  if (!tenantI18nEnabled()) {
    return { description, locationDetail, meta };
  }

  const descDetected = detectLanguage(description);
  const locDetected = locationDetail ? detectLanguage(locationDetail) : "unknown";
  const effectiveDesc = resolveEffectiveContentLocale(descDetected, uiLocale);
  const effectiveLoc = locationDetail
    ? resolveEffectiveContentLocale(locDetected, uiLocale)
    : "en";

  meta.detectedLocale = descDetected !== "unknown" ? descDetected : effectiveDesc;

  let outDesc = description;
  let outLoc = locationDetail;

  if (effectiveDesc === "es") {
    const tr = await translateToEnglish({
      text: description,
      sourceLocale: "es",
      traceId: opts.traceId,
      traceStartMs: opts.traceStartMs,
    });
    if (!tr.ok) {
      const err = Object.assign(new Error("translation_unavailable"), {
        code: "TRANSLATION_ERROR",
      });
      throw err;
    }
    outDesc = tr.text;
    meta.translated = true;
  }

  if (locationDetail && effectiveLoc === "es") {
    const trLoc = await translateToEnglish({
      text: locationDetail,
      sourceLocale: "es",
      traceId: opts.traceId,
      traceStartMs: opts.traceStartMs,
    });
    if (!trLoc.ok) {
      const err = Object.assign(new Error("translation_unavailable"), {
        code: "TRANSLATION_ERROR",
      });
      throw err;
    }
    outLoc = trLoc.text;
    meta.translated = true;
  }

  if (meta.translated) {
    emit({
      trace_id: opts.traceId || null,
      trace_start_ms: opts.traceStartMs,
      log_kind: "tenant_maintenance_create",
      event: "TENANT_I18N_WRITE_NORMALIZED",
      data: {
        ui_locale: uiLocale,
        description_detected: descDetected,
        effective_desc: effectiveDesc,
        location_translated: !!(locationDetail && effectiveLoc === "es"),
      },
    });
  }

  return { description: outDesc, locationDetail: outLoc, meta };
}

module.exports = {
  prepareMaintenanceTextForBrain,
};
