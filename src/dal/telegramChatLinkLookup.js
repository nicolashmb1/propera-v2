/**
 * Telegram ↔ E.164 roster bridge (`telegram_chat_link`).
 * Outbound: phone → chat id; inbound: TG user / chat → linked phone for staff detection.
 */
const { getSupabase } = require("../db/supabase");

/**
 * Inbound Telegram: resolve persisted `phone_e164` when the transport key is `TG:…`
 * and the roster row is keyed by real phone (channel-agnostic identity).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient | null | undefined} sb
 * @param {{ telegramUserIdDigits?: string, telegramChatId?: string }} o
 * @returns {Promise<string>} linked E.164 or ""
 */
async function getLinkedPhoneE164ForTelegramInbound(sb, o) {
  const client = sb || getSupabase();
  if (!client) return "";

  const userDigits = String(o.telegramUserIdDigits || "").replace(/\D/g, "");
  const chatId = String(o.telegramChatId || "").trim();

  if (userDigits) {
    const { data: rows, error } = await client
      .from("telegram_chat_link")
      .select("phone_e164")
      .eq("telegram_user_id", userDigits)
      .order("updated_at", { ascending: false })
      .limit(5);

    if (!error && rows && rows.length) {
      for (const row of rows) {
        const ph = row && String(row.phone_e164 || "").trim();
        if (ph) return ph;
      }
    }
  }

  if (chatId) {
    const { data: row, error: errChat } = await client
      .from("telegram_chat_link")
      .select("phone_e164")
      .eq("telegram_chat_id", chatId)
      .maybeSingle();

    if (!errChat && row && String(row.phone_e164 || "").trim()) {
      return String(row.phone_e164).trim();
    }
  }

  return "";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} [sb]
 * @param {string} phoneE164
 * @returns {Promise<string>} chat id or ""
 */
async function getTelegramChatIdForPhoneE164(sb, phoneE164) {
  const phone = String(phoneE164 || "").trim();
  const client = sb || getSupabase();
  if (!client || !phone) return "";

  const { data, error } = await client
    .from("telegram_chat_link")
    .select("telegram_chat_id")
    .eq("phone_e164", phone)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error || !data || !data.length) return "";
  return String(data[0].telegram_chat_id || "").trim();
}

module.exports = {
  getTelegramChatIdForPhoneE164,
  getLinkedPhoneE164ForTelegramInbound,
};
