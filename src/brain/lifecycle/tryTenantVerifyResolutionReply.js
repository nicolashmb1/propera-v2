/**
 * Deterministic yes/no while WI is VERIFYING_RESOLUTION → `TENANT_REPLY` lifecycle signal.
 */
const { appendEventLog } = require("../../dal/appendEventLog");
const { emitTimed } = require("../../logging/structuredLog");
const { getConversationCtx } = require("../../dal/conversationCtx");
const { lifecycleEnabledForProperty } = require("../../dal/lifecyclePolicyDal");
const { handleLifecycleSignal } = require("./handleLifecycleSignal");

/**
 * Exported for unit tests — not LLM.
 * @param {string} text
 * @returns {boolean|null}
 */
function inferTenantVerifySentiment(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const lower = t.toLowerCase();

  const neg =
    /\b(no|nope|not yet|still|hasn't|hasnt|has not|broken|bad|leak|leaking|issue|problem|wrong)\b/i.test(
      lower
    );
  const pos =
    /\b(yes|yeah|yep|yup|good|great|thanks|thank you|resolved|fixed|fine|perfect|all good|ok|okay)\b/i.test(
      lower
    );

  if (pos && !neg) return true;
  if (neg && !pos) return false;
  if (pos && neg) return null;
  return null;
}

/**
 * @param {object} o
 * @param {import("@supabase/supabase-js").SupabaseClient} o.sb
 * @param {string} o.actorKey
 * @param {string} o.bodyText
 * @param {string} o.traceId
 * @param {number|null} o.traceStartMs
 * @returns {Promise<null | { handled: true, result: object }>}
 */
async function tryTenantVerifyResolutionReply(o) {
  const sb = o.sb;
  const actorKey = String(o.actorKey || "").trim();
  const bodyText = String(o.bodyText || "").trim();
  const traceId = String(o.traceId || "").trim();
  const traceStartMs =
    o.traceStartMs != null && isFinite(Number(o.traceStartMs))
      ? Number(o.traceStartMs)
      : null;

  if (!sb || !actorKey || !bodyText) return null;

  const sentiment = inferTenantVerifySentiment(bodyText);
  if (sentiment === null) return null;

  let wi = null;
  const ctx = await getConversationCtx(actorKey);
  const activeId =
    ctx && ctx.active_work_item_id
      ? String(ctx.active_work_item_id).trim()
      : "";
  if (activeId) {
    const { data: activeRow, error: activeErr } = await sb
      .from("work_items")
      .select("work_item_id, property_id, state")
      .eq("work_item_id", activeId)
      .eq("phone_e164", actorKey)
      .maybeSingle();
    if (
      !activeErr &&
      activeRow &&
      String(activeRow.state || "").trim().toUpperCase() ===
        "VERIFYING_RESOLUTION"
    ) {
      wi = activeRow;
    }
  }

  if (!wi) {
    const { data: rows, error } = await sb
      .from("work_items")
      .select("work_item_id, property_id, state")
      .eq("phone_e164", actorKey)
      .eq("state", "VERIFYING_RESOLUTION")
      .limit(1);

    if (error || !rows || !rows.length) return null;
    wi = rows[0];
  }
  const propertyId =
    String(wi.property_id || "").trim().toUpperCase() || "GLOBAL";
  const enabled = await lifecycleEnabledForProperty(sb, propertyId);
  if (!enabled) return null;

  const r = await handleLifecycleSignal(
    sb,
    {
      eventType: "TENANT_REPLY",
      wiId: String(wi.work_item_id || "").trim(),
      propertyId,
      positive: sentiment,
      rawText: bodyText.slice(0, 500),
      actorType: "TENANT",
      actorId: actorKey,
      reasonCode: "TENANT_VERIFY_REPLY",
    },
    { traceId, traceStartMs: traceStartMs != null ? traceStartMs : undefined }
  );

  await appendEventLog({
    traceId,
    event: "TENANT_VERIFY_REPLY_HANDLED",
    payload: {
      wi_id: wi.work_item_id,
      property_id: propertyId,
      positive: sentiment,
      lifecycle_code: r.code,
    },
  });
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: "TENANT_VERIFY_REPLY_HANDLED",
    data: {
      wi_id: wi.work_item_id,
      positive: sentiment,
      lifecycle_code: r.code,
      crumb: "tenant_verify_reply",
    },
  });

  const replyText = sentiment
    ? "Thanks — we've recorded that you're all set. We'll close this on our side."
    : "Thanks — we'll have maintenance follow up with you.";

  return {
    handled: true,
    result: {
      ok: r.code === "OK" || r.code === "HOLD",
      brain: "lifecycle_tenant_verify",
      replyText,
      outgate: {
        templateKey: "LIFECYCLE_TENANT_VERIFY_REPLY",
        sentiment: sentiment ? "positive" : "negative",
      },
    },
  };
}

module.exports = {
  tryTenantVerifyResolutionReply,
  inferTenantVerifySentiment,
};
