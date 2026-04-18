/**
 * Per-request inbound identity for structured logs — survives async/await without threading `ctx`
 * through every function. Use with `runWithInboundLogCtx` around the Telegram handler body.
 *
 * @see structuredLog.js — `emit` merges `getInboundLogCtx()` as top-level `ctx` on each line.
 */
const { AsyncLocalStorage } = require("async_hooks");

const inboundLogAls = new AsyncLocalStorage();

/**
 * @param {object} signal — InboundSignal (Telegram)
 * @param {Record<string, string>|null|undefined} routerParameter — after buildRouterParameterFromTelegram
 */
function buildTelegramInboundCtx(signal, routerParameter) {
  const t = signal && signal.transport ? signal.transport : {};
  const p = routerParameter || {};
  const uid = t.telegram_user_id != null ? String(t.telegram_user_id) : "";
  const actorKey = String(
    p._phoneE164 || p.From || (uid ? "TG:" + uid : "")
  ).trim();
  const text = String(
    (p.Body != null && p.Body !== "" ? p.Body : "") ||
      (signal.body && signal.body.text != null ? signal.body.text : "") ||
      ""
  );
  return {
    channel: "telegram",
    actor_key: actorKey,
    chat_id: String(p._telegramChatId || t.chat_id || "").trim(),
    update_id: t.update_id != null ? String(t.update_id) : "",
    message_id: t.message_id != null ? String(t.message_id) : "",
    tg_user_id: uid,
    inbound_text_preview: previewText(text, 96),
  };
}

function previewText(s, maxLen) {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, Math.max(0, maxLen - 1)) + "\u2026";
}

function runWithInboundLogCtx(ctx, fn) {
  return inboundLogAls.run(ctx, fn);
}

function getInboundLogCtx() {
  return inboundLogAls.getStore();
}

/**
 * @param {Record<string, string | undefined>} routerParameter
 */
function buildTwilioInboundCtx(routerParameter) {
  const p = routerParameter || {};
  const from = String(p.From || "").trim();
  const isWa = from.toLowerCase().indexOf("whatsapp:") === 0;
  const text = String(p.Body != null ? p.Body : "");
  return {
    channel: isWa ? "whatsapp" : "sms",
    actor_key: String(p._phoneE164 || from || "").trim(),
    chat_id: "",
    update_id: String(p.MessageSid || p.SmsMessageSid || "").trim(),
    message_id: "",
    tg_user_id: "",
    inbound_text_preview: previewText(text, 96),
  };
}

module.exports = {
  buildTelegramInboundCtx,
  buildTwilioInboundCtx,
  previewText,
  runWithInboundLogCtx,
  getInboundLogCtx,
};
