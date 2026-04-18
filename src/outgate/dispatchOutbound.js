/**
 * Phase 1 outbound seam: only this module invokes transport senders for user-facing replies
 * (Telegram / Twilio). Brain code must not import `telegramSendMessage` / `twilioSendMessage`.
 */

const { sendTelegramMessage } = require("../outbound/telegramSendMessage");
const { sendTwilioMessage } = require("../outbound/twilioSendMessage");
const { telegramOutboundEnabled } = require("../config/env");
const { CHANNEL_TELEGRAM } = require("../signal/inboundSignal");
const { appendEventLog } = require("../dal/appendEventLog");

/**
 * @param {object} opts
 * @param {string} [opts.traceId]
 * @param {'telegram' | 'sms' | 'whatsapp'} opts.transportChannel
 * @param {string} opts.body — rendered text
 * @param {object | null} [opts.telegramSignal] — normalized Telegram signal (`transport.chat_id`)
 * @param {string} [opts.twilioTo] — E.164 or whatsapp:… From address for reply
 * @param {object} [opts.dispatchMeta] — merged into `event_log` payload (intentType, outgate meta)
 * @returns {Promise<{ ok: boolean, error?: string, skipped?: boolean, messageId?: number }>}
 */
async function dispatchOutbound(opts) {
  const traceId = opts.traceId || "";
  const transportChannel = String(opts.transportChannel || "").toLowerCase();
  const body = String(opts.body || "").trim();
  if (!body) {
    return { ok: false, error: "empty_body", skipped: true };
  }

  const signal = opts.telegramSignal || null;
  const twilioTo = String(opts.twilioTo || "").trim();

  /** @type {{ ok: boolean, error?: string, skipped?: boolean, messageId?: number }} */
  let result;

  if (transportChannel === "telegram") {
    if (
      !signal ||
      signal.channel !== CHANNEL_TELEGRAM ||
      !signal.transport ||
      !signal.transport.chat_id
    ) {
      result = { ok: false, error: "missing_telegram_target", skipped: true };
    } else if (!telegramOutboundEnabled()) {
      result = { ok: false, error: "telegram_outbound_disabled", skipped: true };
    } else {
      result = await sendTelegramMessage({
        chatId: signal.transport.chat_id,
        text: body,
        traceId,
      });
    }
  } else if (transportChannel === "sms" || transportChannel === "whatsapp") {
    if (!twilioTo) {
      result = { ok: false, error: "missing_twilio_to", skipped: true };
    } else {
      result = await sendTwilioMessage({
        to: twilioTo,
        body,
        traceId,
        channel: transportChannel === "whatsapp" ? "whatsapp" : "sms",
      });
    }
  } else {
    result = { ok: false, error: "unknown_transport", skipped: true };
  }

  const ev =
    result.skipped ? "OUTBOUND_SKIPPED" : result.ok ? "OUTBOUND_SENT" : "OUTBOUND_FAILED";
  await appendEventLog({
    traceId,
    log_kind: "outgate",
    event: ev,
    payload: {
      transport: transportChannel,
      ok: result.ok,
      error: result.error || null,
      skipped: !!result.skipped,
      ...(opts.dispatchMeta && typeof opts.dispatchMeta === "object"
        ? opts.dispatchMeta
        : {}),
    },
  });

  return result;
}

module.exports = { dispatchOutbound };
