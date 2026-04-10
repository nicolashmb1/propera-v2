/**
 * Telegram Bot API Update → InboundSignal (transport only).
 * Mirrors the parse half of GAS telegramWebhook_ — no routing, no lifecycle.
 * @see ../../../02_TELEGRAM_ADAPTER.gs (repo root)
 */

const { createInboundSignal, CHANNEL_TELEGRAM } = require("../../signal/inboundSignal");

/**
 * @param {unknown} payload — parsed JSON body from Telegram
 * @returns {object | null} InboundSignal or null if nothing to hand to brain
 */
function normalizeTelegramUpdate(payload) {
  if (!payload || typeof payload !== "object") return null;

  const msg = /** @type {any} */ (payload).message || /** @type {any} */ (payload).edited_message;
  if (!msg || !msg.from) return null;

  const from = msg.from;
  const userId = String(from.id ?? "").trim();
  if (!userId) return null;

  const chat = msg.chat || {};
  const chatId = chat.id != null ? String(chat.id) : "";

  const text = String(msg.text || msg.caption || "").trim();
  const updateId = payload.update_id != null ? Number(payload.update_id) : null;
  const messageId = msg.message_id != null ? Number(msg.message_id) : null;

  return createInboundSignal({
    channel: CHANNEL_TELEGRAM,
    transport: {
      update_id: updateId,
      message_id: messageId,
      chat_id: chatId,
      telegram_user_id: userId,
      username: from.username ? String(from.username) : null,
      is_edited: !!payload.edited_message,
    },
    body: {
      text,
      caption: msg.caption ? String(msg.caption) : null,
    },
  });
}

module.exports = { normalizeTelegramUpdate };
