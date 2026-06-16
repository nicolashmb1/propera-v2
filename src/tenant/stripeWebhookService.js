const { getSupabase } = require("../db/supabase");
const { getPropertyStripeWebhookSecret } = require("./propertyStripeConfig");
const { postStripePaymentToLedger } = require("./stripeLedgerService");
const { appendEventLog } = require("../dal/appendEventLog");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} paymentId
 * @param {Partial<{ status: string, payment_intent_id: string, failure_message: string | null, ledger_entry_id: string }>} patch
 */
async function updateStripePaymentRow(sb, paymentId, patch) {
  const updates = {};
  if (patch.status) updates.status = patch.status;
  if (patch.payment_intent_id) updates.payment_intent_id = patch.payment_intent_id;
  if (patch.failure_message !== undefined) updates.failure_message = patch.failure_message;
  if (patch.ledger_entry_id) updates.ledger_entry_id = patch.ledger_entry_id;
  if (!Object.keys(updates).length) return { ok: true };
  const { error } = await sb.from("tenant_stripe_payments").update(updates).eq("id", paymentId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} eventId
 * @param {string} paymentId
 */
async function recordStripeEventId(sb, eventId, paymentId) {
  const { data } = await sb
    .from("tenant_stripe_payments")
    .select("stripe_event_ids")
    .eq("id", paymentId)
    .maybeSingle();
  const existing = Array.isArray(data?.stripe_event_ids) ? data.stripe_event_ids : [];
  if (existing.includes(eventId)) return { ok: true, duplicate: true };
  const { error } = await sb
    .from("tenant_stripe_payments")
    .update({ stripe_event_ids: [...existing, eventId] })
    .eq("id", paymentId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, duplicate: false };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ sessionId?: string, paymentIntentId?: string }} keys
 */
async function loadStripePaymentRow(sb, keys) {
  if (keys.sessionId) {
    const { data } = await sb
      .from("tenant_stripe_payments")
      .select("*")
      .eq("checkout_session_id", keys.sessionId)
      .maybeSingle();
    if (data) return data;
  }
  if (keys.paymentIntentId) {
    const { data } = await sb
      .from("tenant_stripe_payments")
      .select("*")
      .eq("payment_intent_id", keys.paymentIntentId)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

/**
 * @param {import('stripe').Stripe.Event} event
 */
async function handleStripeWebhookEvent(event, traceId) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", status: 503 };

  const obj = event.data?.object || {};
  const sessionId =
    event.type.startsWith("checkout.session.")
      ? String(obj.id || "")
      : String(obj.metadata?.checkout_session_id || obj.client_reference_id ? "" : "") ||
        (event.type.startsWith("payment_intent.") ? "" : "");

  let paymentRow = null;
  if (event.type.startsWith("checkout.session.")) {
    paymentRow = await loadStripePaymentRow(sb, { sessionId: String(obj.id || "") });
  } else if (event.type.startsWith("payment_intent.")) {
    paymentRow = await loadStripePaymentRow(sb, { paymentIntentId: String(obj.id || "") });
    if (!paymentRow && obj.metadata?.checkout_session_id) {
      paymentRow = await loadStripePaymentRow(sb, {
        sessionId: String(obj.metadata.checkout_session_id),
      });
    }
  }

  if (!paymentRow) {
    return { ok: true, ignored: true, reason: "payment_row_not_found" };
  }

  const dedupe = await recordStripeEventId(sb, event.id, paymentRow.id);
  if (!dedupe.ok) return { ok: false, error: dedupe.error, status: 500 };
  if (dedupe.duplicate) return { ok: true, duplicate: true };

  let nextStatus = paymentRow.status;
  let failureMessage = paymentRow.failure_message || null;
  const piId = String(obj.payment_intent || obj.id || paymentRow.payment_intent_id || "");

  switch (event.type) {
    case "checkout.session.completed": {
      const paymentStatus = String(obj.payment_status || "");
      nextStatus = paymentStatus === "paid" ? "succeeded" : "processing";
      await updateStripePaymentRow(sb, paymentRow.id, {
        status: nextStatus,
        payment_intent_id: String(obj.payment_intent || "") || piId,
      });
      if (nextStatus === "succeeded") {
        paymentRow = {
          ...paymentRow,
          status: "succeeded",
          payment_intent_id: String(obj.payment_intent || "") || piId,
        };
        await postStripePaymentToLedger(sb, paymentRow);
      }
      break;
    }
    case "payment_intent.processing":
      nextStatus = "processing";
      await updateStripePaymentRow(sb, paymentRow.id, {
        status: "processing",
        payment_intent_id: piId,
      });
      break;
    case "payment_intent.succeeded":
      nextStatus = "succeeded";
      await updateStripePaymentRow(sb, paymentRow.id, {
        status: "succeeded",
        payment_intent_id: piId,
        failure_message: null,
      });
      paymentRow = { ...paymentRow, status: "succeeded", payment_intent_id: piId };
      await postStripePaymentToLedger(sb, paymentRow);
      break;
    case "payment_intent.payment_failed":
      nextStatus = "failed";
      failureMessage =
        String(obj.last_payment_error?.message || "payment_failed").slice(0, 500) || "payment_failed";
      await updateStripePaymentRow(sb, paymentRow.id, {
        status: "failed",
        payment_intent_id: piId,
        failure_message: failureMessage,
      });
      break;
    default:
      return { ok: true, ignored: true, reason: event.type };
  }

  await appendEventLog({
    traceId,
    log_kind: "stripe_webhook",
    event: event.type,
    payload: {
      payment_id: paymentRow.id,
      property_code: paymentRow.property_code,
      status: nextStatus,
      session_id: paymentRow.checkout_session_id,
    },
  });

  return { ok: true, status: nextStatus };
}

/**
 * @param {string} propertyCode
 * @param {Buffer} rawBody
 * @param {string} signatureHeader
 * @param {string} traceId
 */
async function verifyAndHandleStripeWebhook(propertyCode, rawBody, signatureHeader, traceId) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", status: 503 };

  const code = String(propertyCode || "").trim().toUpperCase();
  const { data: prop } = await sb
    .from("properties")
    .select("code, stripe_webhook_secret_enc")
    .eq("code", code)
    .maybeSingle();

  if (!prop) return { ok: false, error: "property_not_found", status: 404 };

  const webhookSecret = getPropertyStripeWebhookSecret(prop);
  if (!webhookSecret) return { ok: false, error: "webhook_not_configured", status: 400 };

  const Stripe = require("stripe");
  let event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
  } catch (err) {
    return { ok: false, error: String(err?.message || "invalid_signature"), status: 400 };
  }

  return handleStripeWebhookEvent(event, traceId);
}

module.exports = {
  handleStripeWebhookEvent,
  verifyAndHandleStripeWebhook,
  loadStripePaymentRow,
};
