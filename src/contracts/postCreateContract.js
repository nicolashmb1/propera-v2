/**
 * Structured create_ticket — post-finalize operational intent (not transport channel).
 * @see docs/TENANT_AGENT_ADAPTER.md
 */

const SCHEDULE_MODE_NONE = "NONE";
const SCHEDULE_MODE_ASK_OPTIONAL = "ASK_OPTIONAL";

/**
 * @param {Record<string, unknown>} routerParameter
 * @returns {string}
 */
function readPostCreateScheduleMode(routerParameter) {
  const p = routerParameter || {};
  try {
    const j = JSON.parse(String(p._portalPayloadJson || "{}"));
    const pc = j.postCreate && typeof j.postCreate === "object" ? j.postCreate : {};
    const mode = String(pc.scheduleMode || pc.schedule_mode || "")
      .trim()
      .toUpperCase();
    if (mode === SCHEDULE_MODE_ASK_OPTIONAL) return SCHEDULE_MODE_ASK_OPTIONAL;
    return SCHEDULE_MODE_NONE;
  } catch (_) {
    return SCHEDULE_MODE_NONE;
  }
}

/**
 * Structured portal create should skip tenant schedule ask unless payload declares ASK_OPTIONAL.
 * @param {boolean} usesStructured
 * @param {Record<string, unknown>} routerParameter
 * @returns {boolean}
 */
function shouldSkipScheduleAfterStructuredCreate(usesStructured, routerParameter) {
  if (!usesStructured) return false;
  return readPostCreateScheduleMode(routerParameter) !== SCHEDULE_MODE_ASK_OPTIONAL;
}

/**
 * Default postCreate for PM / tenant_portal structured creates.
 * @returns {{ scheduleMode: string }}
 */
function postCreateNone() {
  return { scheduleMode: SCHEDULE_MODE_NONE };
}

/**
 * Tenant agent handoff — optional schedule after ticket exists.
 * @returns {{ scheduleMode: string }}
 */
function postCreateAskOptionalSchedule() {
  return { scheduleMode: SCHEDULE_MODE_ASK_OPTIONAL };
}

module.exports = {
  SCHEDULE_MODE_NONE,
  SCHEDULE_MODE_ASK_OPTIONAL,
  readPostCreateScheduleMode,
  shouldSkipScheduleAfterStructuredCreate,
  postCreateNone,
  postCreateAskOptionalSchedule,
};
