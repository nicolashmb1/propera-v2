/**
 * Phase 4 — portal structured `create_ticket` → maintenance fastDraft (or validation failure).
 * Tenant path continues to use `parseMaintenanceDraftAsync` here so dispatch stays one call site.
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const { emitTimed } = require("../../logging/structuredLog");
const { buildStructuredPortalCreateDraft } = require("./portalStructuredCreateDraft");
const { parseMaintenanceDraftAsync } = require("./parseMaintenanceDraft");
const { isPortalCreateTicketRouter } = require("./handleInboundCoreScheduleHints");
const { outgateMeta } = require("./handleInboundCoreMechanics");

/**
 * @param {object} o
 * @param {'TENANT'|'MANAGER'} o.mode
 * @param {Record<string, string | undefined>} o.p — `routerParameter`
 * @param {Set<string>} o.known
 * @param {object[]} o.propertiesList
 * @param {string} o.traceId
 * @param {number | null} o.traceStartMs
 * @param {string} o.effectiveBody
 * @param {unknown[]} o.mediaSignals
 * @param {() => object} o.staffMeta
 * @returns {Promise<{ ok: true, fastDraft: object } | { ok: false, result: object }>}
 */
async function buildFastDraftForMaintenanceCore(o) {
  const {
    mode,
    p,
    known,
    propertiesList,
    traceId,
    traceStartMs,
    effectiveBody,
    mediaSignals,
    staffMeta,
  } = o;

  if (mode === "MANAGER" && isPortalCreateTicketRouter(p)) {
    const structured = buildStructuredPortalCreateDraft(p, known, propertiesList);
    if (!structured) {
      await appendEventLog({
        traceId,
        event: "PORTAL_CREATE_VALIDATION_FAILED",
        payload: { mode },
      });
      emitTimed(traceStartMs, {
        level: "warn",
        trace_id: traceId,
        log_kind: "brain",
        event: "PORTAL_CREATE_VALIDATION_FAILED",
        data: { crumb: "portal_create_validation_failed" },
      });
      return {
        ok: false,
        result: {
          ok: false,
          brain: "portal_create_invalid",
          replyText:
            "Portal create_ticket failed validation: unknown property, or missing unit/message.",
          ...staffMeta(),
          ...outgateMeta("MAINTENANCE_ERROR_PORTAL_VALIDATION", {}),
        },
      };
    }
    return { ok: true, fastDraft: structured };
  }

  const fastDraft = await parseMaintenanceDraftAsync(effectiveBody, known, {
    traceId,
    traceStartMs,
    propertiesList,
    mediaSignals,
  });
  return { ok: true, fastDraft };
}

module.exports = { buildFastDraftForMaintenanceCore };
