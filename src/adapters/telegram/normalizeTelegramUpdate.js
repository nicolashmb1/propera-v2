/**
 * Telegram Bot API Update → InboundSignal (transport only).
 * Mirrors the parse half of GAS telegramWebhook_ — no routing, no lifecycle.
 * @see ../../../02_TELEGRAM_ADAPTER.gs (repo root)
 */

const { createInboundSignal, CHANNEL_TELEGRAM } = require("../../signal/inboundSignal");

function normalizeTelegramMedia(msg) {
  const out = [];
  const caption = msg && msg.caption ? String(msg.caption).trim() : "";

  if (Array.isArray(msg && msg.photo) && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1];
    if (best && best.file_id) {
      out.push({
        kind: "image",
        provider: "telegram",
        file_id: String(best.file_id),
        file_unique_id: best.file_unique_id ? String(best.file_unique_id) : "",
        caption,
      });
    }
  }

  if (msg && msg.document && msg.document.file_id) {
    out.push({
      kind:
        String(msg.document.mime_type || "").toLowerCase().indexOf("image/") === 0
          ? "image"
          : "file",
      provider: "telegram",
      file_id: String(msg.document.file_id),
      file_unique_id: msg.document.file_unique_id
        ? String(msg.document.file_unique_id)
        : "",
      mime_type: msg.document.mime_type ? String(msg.document.mime_type) : "",
      file_name: msg.document.file_name ? String(msg.document.file_name) : "",
      caption,
    });
  }

  return out;
}

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
  const media = normalizeTelegramMedia(msg);
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
      media,
    },
  });
}

module.exports = { normalizeTelegramUpdate };
