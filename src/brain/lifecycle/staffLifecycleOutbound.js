/**
 * Staff pings from lifecycle — `REQUEST_STAFF_UPDATE` / unscheduled reminder.
 */
const { appendEventLog } = require("../../dal/appendEventLog");
const { getStaffPhoneE164ByStaffId } = require("../../dal/staffPhoneByStaffId");
const { dispatchLifecycleOutbound } = require("../../outgate/dispatchLifecycleOutbound");
const {
  loadStaffWorkItemPingContext,
  formatStaffWorkItemPingBody,
} = require("./staffWorkItemPingMessage");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} o
 * @param {string} o.traceId
 * @param {string} o.ownerId — `staff.staff_id`
 * @param {string} o.workItemId
 * @param {string} o.propertyCode
 * @param {string} o.templateKey — see `outgate/lifecycleMessageSpecs.js`
 */
async function dispatchStaffLifecycleReminder(sb, o) {
  const traceId = String(o.traceId || "").trim();
  const ownerId = String(o.ownerId || "").trim();
  const wiId = String(o.workItemId || "").trim();
  const prop = String(o.propertyCode || "").trim().toUpperCase() || "GLOBAL";
  const templateKey = String(o.templateKey || "STAFF_UPDATE_REMINDER").trim();

  if (!ownerId || !wiId) {
    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: "STAFF_LIFECYCLE_OUTBOUND_SKIP",
      payload: { reason: "missing_owner_or_wi", template_key: templateKey },
    });
    return { ok: false, skipped: true };
  }

  const phone = await getStaffPhoneE164ByStaffId(sb, ownerId);
  if (!phone) {
    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: "STAFF_LIFECYCLE_NO_PHONE",
      payload: {
        wi_id: wiId,
        owner_id: ownerId,
        template_key: templateKey,
      },
    });
    return { ok: false, skipped: true, error: "no_staff_phone" };
  }

  let replyTextOverride = null;
  if (
    templateKey === "STAFF_UNSCHEDULED_REMINDER" ||
    templateKey === "STAFF_UPDATE_REMINDER" ||
    templateKey === "STAFF_TENANT_NEGATIVE_FOLLOWUP"
  ) {
    const ctx = await loadStaffWorkItemPingContext(sb, wiId);
    replyTextOverride = formatStaffWorkItemPingBody(templateKey, ctx);
  }

  return dispatchLifecycleOutbound({
    sb,
    traceId,
    templateKey,
    recipientPhoneE164: phone,
    replyTextOverride: replyTextOverride || undefined,
    correlationIds: {
      work_item_id: wiId,
      property_code: prop,
      staff_id: ownerId,
    },
  });
}

/**
 * Tenant said issue not resolved → ping assigned staff.
 */
async function dispatchStaffTenantNegativeFollowup(sb, o) {
  return dispatchStaffLifecycleReminder(sb, {
    traceId: o.traceId,
    ownerId: o.ownerId,
    workItemId: o.workItemId,
    propertyCode: o.propertyCode,
    templateKey: "STAFF_TENANT_NEGATIVE_FOLLOWUP",
  });
}

module.exports = {
  dispatchStaffLifecycleReminder,
  dispatchStaffTenantNegativeFollowup,
};
