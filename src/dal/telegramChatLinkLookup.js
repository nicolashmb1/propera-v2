/**
 * Resolve Telegram `chat_id` for an E.164 phone (ops / outbound bridge).
 */
const { getSupabase } = require("../db/supabase");

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

module.exports = { getTelegramChatIdForPhoneE164 };
