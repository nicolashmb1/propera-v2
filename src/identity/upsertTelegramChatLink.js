/**
 * Persist Telegram chat ↔ user ids for routing (phone filled later when linked).
 */

const { getSupabase } = require("../db/supabase");
const { emit } = require("../logging/structuredLog");

const PREVIEW_MAX = 240;

/**
 * @param {object} signal — InboundSignal from Telegram adapter
 * @param {string | null} traceId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function upsertTelegramChatLink(signal, traceId) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "db_not_configured" };

  const t = signal.transport || {};
  const chatId = t.chat_id != null ? String(t.chat_id) : "";
  const userId = t.telegram_user_id != null ? String(t.telegram_user_id) : "";
  if (!chatId) return { ok: false, error: "no_chat_id" };

  const text = signal.body && signal.body.text ? String(signal.body.text) : "";
  const preview = text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + "…" : text;

  const row = {
    telegram_chat_id: chatId,
    telegram_user_id: userId,
    last_text_preview: preview,
    updated_at: new Date().toISOString(),
  };

  const { error } = await sb.from("telegram_chat_link").upsert(row, {
    onConflict: "telegram_chat_id",
  });

  if (error) {
    emit({
      level: "warn",
      trace_id: traceId || null,
      log_kind: "telegram_chat_link",
      event: "upsert_failed",
      data: { error: error.message },
    });
    return { ok: false, error: error.message };
  }

  emit({
    level: "info",
    trace_id: traceId || null,
    log_kind: "telegram_chat_link",
    event: "upserted",
    data: { telegram_chat_id: chatId, telegram_user_id: userId },
  });
  return { ok: true };
}

module.exports = { upsertTelegramChatLink };
