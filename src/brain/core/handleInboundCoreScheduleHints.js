/**
 * Pure schedule-hint extraction for maintenance core (staff capture + portal create).
 * Split from handleInboundCore for readability — no I/O.
 */
const { MIN_SCHEDULE_LEN } = require("../../dal/ticketPreferredWindow");

function isPortalCreateTicketRouter(routerParameter) {
  return (
    String(routerParameter && routerParameter._portalAction ? routerParameter._portalAction : "")
      .trim()
      .toLowerCase() === "create_ticket"
  );
}

/** `channel` from router param or `_portalPayloadJson`. */
function portalPayloadChannel(routerParameter) {
  const direct = String(
    routerParameter && routerParameter._portalChannel ? routerParameter._portalChannel : ""
  )
    .trim()
    .toLowerCase();
  if (direct) return direct;
  try {
    const j = JSON.parse(
      String(routerParameter && routerParameter._portalPayloadJson ? routerParameter._portalPayloadJson : "{}")
    );
    return String(j.channel || "").trim().toLowerCase();
  } catch (_) {
    return "";
  }
}

/**
 * Resident portal structured create — no synthetic `# prop apt …` NL intake.
 */
function isTenantPortalStructuredCreate(routerParameter) {
  if (!isPortalCreateTicketRouter(routerParameter)) return false;
  if (portalPayloadChannel(routerParameter) === "tenant_portal") return true;
  try {
    const j = JSON.parse(
      String(routerParameter && routerParameter._portalPayloadJson ? routerParameter._portalPayloadJson : "{}")
    );
    return String(j.actor_type || "").trim().toUpperCase() === "TENANT";
  } catch (_) {
    return false;
  }
}

/**
 * PM portal MANAGER create_ticket + tenant_portal structured create (TENANT mode).
 * Uses `buildStructuredPortalCreateDraft` — not `parseMaintenanceDraftAsync`.
 */
function usesStructuredPortalCreateDraft(routerParameter, mode) {
  if (!isPortalCreateTicketRouter(routerParameter)) return false;
  if (mode === "MANAGER") return true;
  return isTenantPortalStructuredCreate(routerParameter);
}

/**
 * `#` staff capture (same turn as report): `compileTurn` `scheduleRaw`, or `Preferred:` line
 * (aligned with `extractScheduleHintPortalStaff` minus portal JSON).
 */
function extractScheduleHintStaffCapture(fastDraft, effectiveBody) {
  const sr = String(fastDraft && fastDraft.scheduleRaw ? fastDraft.scheduleRaw : "").trim();
  if (sr.length >= MIN_SCHEDULE_LEN) return sr;
  const body = String(effectiveBody || "");
  const m = body.match(/(?:^|\n)\s*Preferred:\s*(.+?)(?:\n|$)/im);
  if (m && String(m[1]).trim().length >= MIN_SCHEDULE_LEN) return String(m[1]).trim();
  return "";
}

function extractScheduleHintStaffCaptureFromTurn(merged, fastDraft, effectiveBody) {
  const fromMerge = String(merged && merged.draft_schedule_raw ? merged.draft_schedule_raw : "")
    .trim();
  if (fromMerge.length >= MIN_SCHEDULE_LEN) return fromMerge;
  return extractScheduleHintStaffCapture(fastDraft, effectiveBody);
}

/**
 * Staff PM portal create: schedule from compile `scheduleRaw`, `Preferred:` line, or JSON `preferredWindow`.
 */
function extractScheduleHintPortalStaff(fastDraft, effectiveBody, routerParameter) {
  const sr = String(fastDraft && fastDraft.scheduleRaw ? fastDraft.scheduleRaw : "").trim();
  if (sr.length >= MIN_SCHEDULE_LEN) return sr;
  const body = String(effectiveBody || "");
  const m = body.match(/(?:^|\n)\s*Preferred:\s*(.+?)(?:\n|$)/im);
  if (m && String(m[1]).trim().length >= MIN_SCHEDULE_LEN) return String(m[1]).trim();
  try {
    const j = JSON.parse(String(routerParameter._portalPayloadJson || "{}"));
    const pw = String(j.preferredWindow || "").trim();
    if (pw.length >= MIN_SCHEDULE_LEN) return pw;
  } catch (_) {
    /* ignore */
  }
  return "";
}

function extractScheduleHintPortalStaffMulti(merged, effectiveBody, routerParameter) {
  const sched = String(merged && merged.draft_schedule_raw ? merged.draft_schedule_raw : "").trim();
  if (sched.length >= MIN_SCHEDULE_LEN) return sched;
  return extractScheduleHintPortalStaff(
    { scheduleRaw: "" },
    effectiveBody,
    routerParameter
  );
}

module.exports = {
  isPortalCreateTicketRouter,
  portalPayloadChannel,
  isTenantPortalStructuredCreate,
  usesStructuredPortalCreateDraft,
  extractScheduleHintStaffCapture,
  extractScheduleHintStaffCaptureFromTurn,
  extractScheduleHintPortalStaff,
  extractScheduleHintPortalStaffMulti,
};
