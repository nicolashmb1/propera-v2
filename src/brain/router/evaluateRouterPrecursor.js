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
