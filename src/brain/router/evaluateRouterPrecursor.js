/**
 * Deterministic precursors from handleInboundRouter_ — precursor half only; staff context is injected.
 * Ordering matches GAS: # staff capture → non-# staff lifecycle intercept → compliance → tenant commands.
 * @see ../../../16_ROUTER_ENGINE.gs — # 223–241; staff intercept 300–312; compliance 382–398; tenant 555–562
 *
 * Does NOT invoke routeToCoreSafe_, staffHandleLifecycleCommand_, or Sheets. Opt-out **persistence** is in `src/index.js` + `src/dal/smsOptOut.js` (GAS `setSmsOptOut_`).
 */

const { normMsg } = require("./normMsg");
const { complianceIntent } = require("./complianceIntent");
const { detectTenantCommand } = require("./detectTenantCommand");
const {
  parseMediaJson,
  composeInboundTextWithMedia,
} = require("../shared/mediaPayload");
const { parseMediaSignalsJson } = require("../shared/mediaSignalRuntime");

/** Min chars for staff empty-body photo path to enter maintenance core via OCR / media signals. */
const STAFF_MEDIA_INTAKE_MIN_LEN = 8;

function transportAllowsStaffMediaIntake(transportChannel) {
  const t = String(transportChannel || "").trim().toLowerCase();
  return t === "telegram" || t === "whatsapp" || t === "sms";
}

function staffMediaMaintenanceComposedBody(parameter) {
  const p = parameter || {};
  const media = parseMediaJson(p._mediaJson);
  if (!media.length) return "";
  const signals = parseMediaSignalsJson(p._mediaSignalsJson);
  return composeInboundTextWithMedia("", media, 1400, signals).trim();
}

function stripStaffAliasFromHashPayload(stripped) {
  return String(stripped || "")
    .trim()
    .replace(/^staff\b\s*[:\-]?\s*/i, "")
    .trim();
}

/**
 * @param {object} opts
 * @param {Record<string, string | undefined>} opts.parameter — RouterParameter / e.parameter
 * @param {string} [opts.bodyOverride] — global __bodyOverride analog (ATTACHMENT_ONLY)
 * @param {{ isStaff: boolean, staffActorKey?: string }} [opts.staffContext] — from resolveStaffContextFromRouterParameter
 * @param {string} [opts.transportChannel] — `telegram` | `whatsapp` | `sms` gates empty-body media OCR intake
 * @returns {object}
 */
function evaluateRouterPrecursor(opts) {
  const p = (opts && opts.parameter) || {};
  let bodyRaw = String(
    (opts && opts.bodyOverride !== undefined ? opts.bodyOverride : p.Body) || ""
  ).trim();

  if (String(opts && opts.bodyOverride || "").toUpperCase() === "ATTACHMENT_ONLY") {
    bodyRaw = "";
  }

  const bodyTrim = bodyRaw;
  const staffCtx = opts && opts.staffContext;

  if (bodyTrim && bodyTrim.charAt(0) === "#") {
    const stripped = stripStaffAliasFromHashPayload(
      bodyTrim.replace(/^#\s*/, "").trim()
    );
    return {
      outcome: "STAFF_CAPTURE_HASH",
      staffCapture: {
        stripped,
        mode: "MANAGER",
      },
      bodyTrim,
      norm: normMsg(bodyTrim),
      compliance: null,
      tenantCommand: null,
    };
  }

  /**
   * Photo/screenshot with empty caption/text: OCR runs before this precursor; `Body` is still empty,
   * so without this branch staff would hit `STAFF_LIFECYCLE_GATE` and core would stay closed — no reply.
   * When enriched `_mediaJson` / `_mediaSignalsJson` yield a composed narrative, open MANAGER core like `#` capture.
   */
  let staffMediaComposed = "";
  if (
    staffCtx &&
    staffCtx.isStaff &&
    !bodyTrim &&
    transportAllowsStaffMediaIntake(opts && opts.transportChannel)
  ) {
    staffMediaComposed = staffMediaMaintenanceComposedBody(p);
  }
  if (staffMediaComposed.length >= STAFF_MEDIA_INTAKE_MIN_LEN) {
    return {
      outcome: "STAFF_MAINTENANCE_MEDIA_INTAKE",
      staffMaintenanceMedia: { composedPreviewLen: staffMediaComposed.length },
      bodyTrim: "",
      bodyLower: "",
      norm: normMsg(staffMediaComposed.slice(0, 240)),
      compliance: null,
      tenantCommand: null,
    };
  }

  /**
   * Staff senders (phone or Telegram identity in `staff` / `contacts`) must **never** fall through to
   * `PRECURSOR_EVALUATED` tenant maintenance — including **empty body** (media-only, adapter overrides).
   * Non-`#` traffic is staff lifecycle / PM amend / schedule outcomes, not tenant intake.
   */
  if (staffCtx && staffCtx.isStaff) {
    return {
      outcome: "STAFF_LIFECYCLE_GATE",
      staffGate: {
        staffActorKey: String(staffCtx.staffActorKey || "").trim(),
      },
      bodyTrim,
      bodyLower: bodyTrim.toLowerCase().trim(),
      norm: normMsg(bodyTrim),
      compliance: null,
      tenantCommand: null,
    };
  }

  const bodyLower = bodyTrim.toLowerCase().trim();
  const norm = normMsg(bodyTrim);
  const comp = complianceIntent(bodyTrim);
  const tenantCommand = comp ? null : detectTenantCommand(bodyTrim);

  return {
    outcome: "PRECURSOR_EVALUATED",
    bodyTrim,
    bodyLower,
    norm,
    compliance: comp || null,
    tenantCommand,
  };
}

module.exports = { evaluateRouterPrecursor, stripStaffAliasFromHashPayload };
