/**
 * Human-readable staff lifecycle SMS/Telegram pings (ticket id, property, unit, issue).
 */

/**
 * @param {string} raw
 * @param {number} [maxLen]
 */
function clipIssueFirstLine(raw, maxLen) {
  const max = Number(maxLen) > 0 ? Number(maxLen) : 120;
  const line = String(raw || "")
    .split(/\r?\n/)[0]
    .trim();
  if (!line) return "";
  if (line.length <= max) return line;
  return line.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * @typedef {object} StaffWorkItemPingContext
 * @property {string} workItemId
 * @property {string} humanTicketId — display id e.g. PENN-MMDDYY-1234
 * @property {string} propertyLabel
 * @property {string} unitLabel
 * @property {string} issueShort
 */

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} workItemId
 * @returns {Promise<StaffWorkItemPingContext | null>}
 */
async function loadStaffWorkItemPingContext(sb, workItemId) {
  const wid = String(workItemId || "").trim();
  if (!sb || !wid) return null;

  const { data: wi, error: wErr } = await sb
    .from("work_items")
    .select("work_item_id, unit_id, property_id, ticket_key")
    .eq("work_item_id", wid)
    .maybeSingle();

  if (wErr || !wi) return null;

  let humanTicketId = "";
  let propertyDisplay = "";
  let unitLabel = "";
  let messageRaw = "";

  const tk = String(wi.ticket_key || "").trim();
  if (tk) {
    const { data: t } = await sb
      .from("tickets")
      .select("ticket_id, property_display_name, unit_label, message_raw")
      .eq("ticket_key", tk)
      .maybeSingle();
    if (t) {
      humanTicketId = String(t.ticket_id || "").trim().toUpperCase();
      propertyDisplay = String(t.property_display_name || "").trim();
      unitLabel = String(t.unit_label || "").trim();
      messageRaw = String(t.message_raw || "").trim();
    }
  }

  if (!propertyDisplay) {
    const code = String(wi.property_id || "").trim().toUpperCase();
    if (code) {
      const { data: p } = await sb
        .from("properties")
        .select("display_name, short_name, code")
        .eq("code", code)
        .maybeSingle();
      if (p) {
        propertyDisplay =
          String(p.display_name || "").trim() ||
          String(p.short_name || "").trim() ||
          String(p.code || "").trim();
      }
    }
  }

  if (!unitLabel && wi.unit_id) {
    unitLabel = String(wi.unit_id || "").trim();
  }

  const issueShort = clipIssueFirstLine(messageRaw, 120);

  return {
    workItemId: wid,
    humanTicketId,
    propertyLabel: propertyDisplay,
    unitLabel,
    issueShort,
  };
}

/**
 * @param {string} templateKey
 * @param {StaffWorkItemPingContext | null} ctx
 * @returns {string | null}
 */
function formatStaffWorkItemPingBody(templateKey, ctx) {
  const k = String(templateKey || "").trim();
  if (!ctx) return null;

  const issue =
    ctx.issueShort && ctx.issueShort.trim()
      ? ctx.issueShort.trim()
      : "open maintenance request";

  const locParts = [];
  if (ctx.propertyLabel) locParts.push(ctx.propertyLabel);
  if (ctx.unitLabel) locParts.push("apt " + ctx.unitLabel);
  const loc = locParts.join(", ");

  const ref = ctx.humanTicketId
    ? "Ticket " + ctx.humanTicketId
    : "Work item " + ctx.workItemId;

  const headline = loc ? ref + " — " + loc : ref;

  if (k === "STAFF_UNSCHEDULED_REMINDER") {
    return (
      "Reminder: " +
      headline +
      " — " +
      issue +
      ". Still needs scheduling or an update. Please follow up."
    );
  }
  if (k === "STAFF_UPDATE_REMINDER") {
    return (
      "Reminder: " +
      headline +
      " — " +
      issue +
      ". Please send a maintenance update (reply with status)."
    );
  }
  if (k === "STAFF_TENANT_NEGATIVE_FOLLOWUP") {
    return (
      "Follow-up: " +
      headline +
      " — " +
      issue +
      ". The tenant indicated the issue may not be resolved."
    );
  }
  return null;
}

module.exports = {
  clipIssueFirstLine,
  loadStaffWorkItemPingContext,
  formatStaffWorkItemPingBody,
};
