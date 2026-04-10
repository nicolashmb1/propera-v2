/**
 * Telegram Bot API sendMessage — transport only (Outgate / adapter outbound).
 * No routing or policy here.
 */

const { telegramBotToken } = require("../config/env");
const { emit } = require("../logging/structuredLog");

const API = "https://api.telegram.org";

/**
 * @param {{ chatId: string, text: string, traceId?: string | null }} opts
 * @returns {Promise<{ ok: boolean, error?: string, messageId?: number }>}
 */
async function sendTelegramMessage(opts) {
  const token = telegramBotToken();
  if (!token) {
    return { ok: false, error: "no_bot_token" };
  }
  const chatId = String(opts.chatId || "").trim();
  const text = String(opts.text || "").trim();
  if (!chatId || !text) {
    return { ok: false, error: "missing_chat_or_text" };
  }

  const url = `${API}/bot${encodeURIComponent(token)}/sendMessage`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : "fetch_failed";
    emit({
      level: "error",
      trace_id: opts.traceId || null,
      log_kind: "telegram_outbound",
      event: "send_failed",
      data: { error: msg },
    });
    return { ok: false, error: msg };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const desc = data.description || res.statusText || "telegram_api_error";
    emit({
      level: "warn",
      trace_id: opts.traceId || null,
      log_kind: "telegram_outbound",
      event: "send_rejected",
      data: { status: res.status, description: desc },
    });
    return { ok: false, error: desc };
  }

  const messageId = data.result && data.result.message_id;
  emit({
    level: "info",
    trace_id: opts.traceId || null,
    log_kind: "telegram_outbound",
    event: "sent",
    data: { chat_id: chatId, message_id: messageId },
  });
  return { ok: true, messageId };
}

module.exports = { sendTelegramMessage };
