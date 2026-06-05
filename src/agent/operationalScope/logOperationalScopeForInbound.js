/**
 * Compile Operational Scope on portal_chat and record OPERATIONAL_SCOPE_COMPILED.
 * Read-only observation seam — does not change routing or writes.
 * @see docs/PROPERA_JARVIS_NORTH_STAR.md § Operational Scope
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const { isDbConfigured } = require("../../db/supabase");
const { compileOperationalScope } = require("./compileOperationalScope");

/**
 * @param {string} transportChannel
 * @param {Record<string, string | undefined>} routerParameter
 */
function isPortalChatInbound(transportChannel, routerParameter) {
  if (String(transportChannel || "").toLowerCase() !== "portal") return false;
  return (
    String(routerParameter._portalAction || "")
      .trim()
      .toLowerCase() === "portal_chat"
  );
}

/**
 * @param {object} opts
 * @param {string} opts.traceId
 * @param {Record<string, string | undefined>} opts.routerParameter
 * @param {string} opts.transportChannel
 * @param {{ isStaff?: boolean, staff?: { staff_id?: string }, staffActorKey?: string }} [opts.staffContext]
 * @param {string} [opts.transportActorKey]
 */
async function logOperationalScopeForPortalChat(opts) {
  const o = opts || {};
  const routerParameter = o.routerParameter || {};
  const transportChannel = String(o.transportChannel || "").toLowerCase();

  if (!isPortalChatInbound(transportChannel, routerParameter)) {
    return { logged: false, reason: "not_portal_chat" };
  }
  // Only compile for the Jarvis situational surfaces that actually use scope.
  // `jarvis_ask` consumes `_operationalScopeJson` (and self-compiles as a
  // fallback if absent); `jarvis_plan` keeps the observation log. Capture modes
  // (staff_capture / cost / financial) never read it — skip the ~4-5 reads.
  const portalChatMode = String(routerParameter._portalChatMode || "")
    .trim()
    .toLowerCase();
  if (portalChatMode !== "jarvis_ask" && portalChatMode !== "jarvis_plan") {
    return { logged: false, reason: "non_jarvis_mode" };
  }
  if (!isDbConfigured()) {
    return { logged: false, reason: "no_db" };
  }

  const staffContext = o.staffContext || {};
  const staffId =
    staffContext.staff && staffContext.staff.staff_id
      ? String(staffContext.staff.staff_id).trim()
      : "";
  const actorRole = staffContext.isStaff ? "staff" : "unknown";
  const actorKey =
    String(staffContext.staffActorKey || o.transportActorKey || "").trim() ||
    String(routerParameter.From || "").trim();

  try {
    const scope = await compileOperationalScope({
      routerParameter,
      actorRole,
      staffId,
      actorKey,
      transportChannel: "portal",
    });

    routerParameter._operationalScopeJson = JSON.stringify(scope);

    await appendEventLog({
      traceId: o.traceId,
      log_kind: "agent",
      event: "OPERATIONAL_SCOPE_COMPILED",
      payload: {
        scope_version: scope.version,
        story: scope.story,
        anchor: scope.anchor,
        active_work_count: (scope.activeWork || []).length,
        property_open_ticket_count: (scope.propertyOpenTickets || []).length,
        focus: scope.focus,
        portal_chat_mode: String(routerParameter._portalChatMode || ""),
      },
    });

    return { logged: true, scope };
  } catch (err) {
    await appendEventLog({
      traceId: o.traceId,
      log_kind: "agent",
      level: "error",
      event: "OPERATIONAL_SCOPE_COMPILE_FAILED",
      payload: {
        message: err && err.message ? String(err.message) : "unknown",
      },
    });
    return { logged: false, reason: "compile_failed" };
  }
}

module.exports = {
  isPortalChatInbound,
  logOperationalScopeForPortalChat,
};
