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
  extractScheduleHintStaffCapture,
  extractScheduleHintStaffCaptureFromTurn,
  extractScheduleHintPortalStaff,
  extractScheduleHintPortalStaffMulti,
};
