/**
 * GLOBAL TENANT COMMAND LAYER — command detection only.
 * Ported from GAS: detectTenantCommand_
 * @see ../../../16_ROUTER_ENGINE.gs lines 47–73
 *
 * @returns {string|null} e.g. CMD_MY_TICKETS, CMD_HELP, …
 */
function detectTenantCommand(text) {
  if (!text) return null;

  const t = String(text).trim().toLowerCase();

  if (t === "my tickets" || t === "my ticket" || t === "tickets" || t === "requests")
    return "CMD_MY_TICKETS";

  if (t === "status" || t === "ticket status") return "CMD_STATUS";

  if (t === "change time" || t === "update time" || t === "reschedule")
    return "CMD_CHANGE_TIME";

  if (
    t === "cancel" ||
    t === "cancel ticket" ||
    t === "cancel tickets" ||
    t === "cancel request"
  )
    return "CMD_CANCEL";

  if (t === "start over" || t === "startover" || t === "reset" || t === "restart")
    return "CMD_START_OVER";

  if (t === "options" || t === "menu") return "CMD_OPTIONS";

  if (t === "help") return "CMD_HELP";

  return null;
}

module.exports = { detectTenantCommand };
