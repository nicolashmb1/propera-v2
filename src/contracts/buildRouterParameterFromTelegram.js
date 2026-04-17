/**
 * Maps normalized Telegram InboundSignal + raw update → RouterParameter (e.parameter shape).
 * Source: syntheticE.parameter in processTelegramQueue_
 * @see ../../../02_TELEGRAM_ADAPTER.gs lines 390–476
 */

const { CHANNEL_TELEGRAM } = require("../signal/inboundSignal");

/**
 * @param {object} signal — InboundSignal (channel TELEGRAM)
 * @param {object} rawPayload — original Telegram Update JSON (for postData reference if needed)
 * @returns {Record<string, string>}
 */
function buildRouterParameterFromTelegram(signal, rawPayload) {
  if (!signal || signal.channel !== CHANNEL_TELEGRAM) {
    throw new Error("buildRouterParameterFromTelegram: expected TELEGRAM signal");
  }

  const t = signal.transport || {};
  const body = signal.body || {};
  const text = String(body.text || "").trim();
  const mediaJson =
    Array.isArray(body.media) && body.media.length > 0 ? JSON.stringify(body.media) : "";

  const userId = String(t.telegram_user_id || "").trim();
  const actorId = userId ? "TG:" + userId : "";
  const chatId = t.chat_id != null ? String(t.chat_id) : "";
  const updateId =
    t.update_id != null && t.update_id !== ""
      ? String(t.update_id)
      : "";

  if (!actorId) {
    throw new Error("buildRouterParameterFromTelegram: missing telegram_user_id");
  }

  return {
    _mode: "",
    _internal: "",
    _channel: "TELEGRAM",
    _phoneE164: actorId,
    _telegramChatId: chatId,
    _telegramUpdateId: updateId,
    From: actorId,
    Body: text,
    _mediaJson: mediaJson,
  };
}

module.exports = { buildRouterParameterFromTelegram };
