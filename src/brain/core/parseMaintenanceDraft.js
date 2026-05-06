/**
 * Single-turn extraction of property / unit / issue from free text.
 *
 * **Legacy (sync):** regex helpers — `extractPropertyHintFromBody` / `extractUnitFromBody`.
 * **GAS path (async):** `INTAKE_COMPILE_TURN=1` → `properaBuildIntakePackage` + `compileTurn_` shape
 * (`src/brain/intake/`). Optional `OPENAI_API_KEY` + `INTAKE_LLM_ENABLED=1` for structured JSON LLM.
 *
 * See docs/PARITY_LEDGER.md §1–2.
 */
const {
  extractUnitFromBody,
  detectPropertyFromBody,
  extractPropertyHintFromBody,
} = require("../staff/lifecycleExtract");
const {
  inferLocationTypeFromText,
  isCommonAreaLocation,
} = require("../shared/commonArea");
const { intakeCompileTurnEnabled } = require("../../config/env");
const { emitTimed } = require("../../logging/structuredLog");
const { appendEventLog } = require("../../dal/appendEventLog");

/**
 * @param {string} bodyTrim
 * @param {Set<string>} knownPropertyCodesUpper
 * @param {Array<{ code: string, display_name: string }>} [propertiesList]
 * @returns {{ propertyCode: string, unitLabel: string, issueText: string, scheduleRaw: string, openerNext: string, locationType: string }}
 */
function parseMaintenanceDraft(bodyTrim, knownPropertyCodesUpper, propertiesList) {
  const t = String(bodyTrim || "").trim();
  if (!t) {
    return {
      propertyCode: "",
      unitLabel: "",
      issueText: "",
      scheduleRaw: "",
      openerNext: "",
      locationType: "UNIT",
    };
  }

  const propertyCode =
    detectPropertyFromBody(t, propertiesList || [], knownPropertyCodesUpper) ||
    extractPropertyHintFromBody(t, knownPropertyCodesUpper);
  const unitLabel = extractUnitFromBody(t);

  let issue = t;
  if (propertyCode) {
    issue = issue.replace(new RegExp("\\b" + propertyCode + "\\b", "gi"), " ");
  }
  if (unitLabel) {
    const esc = unitLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    issue = issue.replace(new RegExp("\\b" + esc + "\\b", "gi"), " ");
    issue = issue.replace(/\b(?:unit|apt|uni)\s*[:\s]*\s*/gi, " ");
  }
  issue = issue.replace(/\s+/g, " ").trim();

  return {
    propertyCode: propertyCode || "",
    unitLabel: unitLabel || "",
    issueText: issue || t,
    scheduleRaw: "",
    openerNext: "",
    locationType: inferLocationTypeFromText(issue || t),
  };
}

/**
 * @param {string} bodyTrim
 * @param {Set<string>} knownPropertyCodesUpper
 * @param {{ traceId?: string, traceStartMs?: number, propertiesList?: Array<{ code: string, display_name: string }>, mediaSignals?: object[] }} [opts]
 * @returns {Promise<{ propertyCode: string, unitLabel: string, issueText: string, scheduleRaw: string, openerNext: string, locationType: string }>}
 */
async function parseMaintenanceDraftAsync(bodyTrim, knownPropertyCodesUpper, opts) {
  const traceId =
    opts && opts.traceId != null ? String(opts.traceId).trim() : "";
  const traceStartMs =
    opts && opts.traceStartMs != null && isFinite(Number(opts.traceStartMs))
      ? Number(opts.traceStartMs)
      : null;
  const compileOn = intakeCompileTurnEnabled();
  const branch = compileOn ? "compile_turn" : "regex_only";
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId || null,
    log_kind: "brain",
    event: "INTAKE_PARSE_BRANCH",
    data: {
      branch,
      crumb: "intake_parse_branch",
    },
  });
  if (traceId) {
    await appendEventLog({
      traceId,
      log_kind: "brain",
      event: "INTAKE_PARSE_BRANCH",
      payload: { branch },
    });
  }
  if (!compileOn) {
    if (traceId) {
      await appendEventLog({
        traceId,
        log_kind: "brain",
        event: "INTAKE_BRAIN_PATH",
        payload: {
          brain_path: "deterministic_regex",
          llm_structured_used: false,
          intake_compile_turn: false,
          env_INTAKE_COMPILE_TURN:
            process.env.INTAKE_COMPILE_TURN === undefined
              ? null
              : String(process.env.INTAKE_COMPILE_TURN),
          summary:
            "Intake: regex-only parse — compile turn disabled in this process " +
            "(set INTAKE_COMPILE_TURN=1 and restart; if it persists, an env var " +
            "may override .env)",
        },
      });
    }
    const d = parseMaintenanceDraft(
      bodyTrim,
      knownPropertyCodesUpper,
      opts && Array.isArray(opts.propertiesList) ? opts.propertiesList : []
    );
    return { ...d, structuredIssues: null };
  }
  const { compileTurn } = require("../intake/compileTurn");
  const tf = await compileTurn(
    bodyTrim,
    "",
    "en",
    {},
    null,
    {
      knownPropertyCodesUpper,
      propertiesList:
        opts && Array.isArray(opts.propertiesList) ? opts.propertiesList : [],
      traceId,
      traceStartMs,
      mediaSignals:
        opts && Array.isArray(opts.mediaSignals) ? opts.mediaSignals : [],
    }
  );
  const code =
    tf.property && tf.property.code
      ? String(tf.property.code).trim().toUpperCase()
      : "";
  let issueText = String(tf.issue || "").trim();
  if (!issueText) issueText = String(bodyTrim || "").trim();
  const structuredIssues =
    tf.structuredSignal && Array.isArray(tf.structuredSignal.issues)
      ? tf.structuredSignal.issues
      : null;
  return {
    propertyCode: code,
    unitLabel: String(tf.unit || "").trim(),
    issueText,
    structuredIssues,
    scheduleRaw:
      tf && tf.schedule && tf.schedule.raw ? String(tf.schedule.raw).trim() : "",
    openerNext:
      tf &&
      tf.missingSlots &&
      tf.missingSlots.scheduleMissing === true
        ? "SCHEDULE"
        : "",
    locationType:
      tf && tf.location && tf.location.locationType
        ? String(tf.location.locationType).trim().toUpperCase()
        : inferLocationTypeFromText(issueText || bodyTrim),
  };
}

/**
 * @param {{ propertyCode: string, unitLabel: string, issueText: string, locationType?: string }} d
 */
function isMaintenanceDraftComplete(d) {
  if (!d) return false;
  if (!String(d.propertyCode || "").trim()) return false;
  if (
    !isCommonAreaLocation(d.locationType) &&
    !String(d.unitLabel || "").trim()
  )
    return false;
  if (!String(d.issueText || "").trim() || String(d.issueText).trim().length < 2)
    return false;
  return true;
}

module.exports = {
  parseMaintenanceDraft,
  parseMaintenanceDraftAsync,
  isMaintenanceDraftComplete,
};
