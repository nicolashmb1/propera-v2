/**
 * Central env read — fail soft in dev so `npm start` works with zero secrets.
 */
require("dotenv").config();

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

function identityApiEnabled() {
  if (env("IDENTITY_API_ENABLED", "") === "0") return false;
  if (env("NODE_ENV", "development") === "development") return true;
  return env("IDENTITY_API_ENABLED", "") === "1";
}

/** Optional; if set, POST /webhooks/telegram must send X-Telegram-Bot-Api-Secret-Token */
function telegramWebhookSecret() {
  return env("TELEGRAM_WEBHOOK_SECRET", "");
}

/** Outbound Telegram API (sendMessage); not required to receive webhooks */
function telegramBotToken() {
  return env("TELEGRAM_BOT_TOKEN", "");
}

/** Set to 1 to send a short ack in Telegram after each handled message (needs TELEGRAM_BOT_TOKEN) */
function telegramOutboundEnabled() {
  return env("TELEGRAM_OUTBOUND_ENABLED", "") === "1" && !!telegramBotToken();
}

/** Core intake + finalize (Postgres). Off if CORE_ENABLED=0 */
function coreEnabled() {
  return env("CORE_ENABLED", "1") !== "0";
}

/** IANA tz for schedule parser labels (`Intl`) — align with GAS `Session.getScriptTimeZone()`. `TZ` also drives local `Date` math in Node. */
function properaTimezone() {
  const t = env("PROPERA_TZ", "");
  if (t) return t;
  return env("TZ", "UTC");
}

/** GAS `ppGet_('GLOBAL','SCHED_LATEST_HOUR',17)` — `parsePreferredWindowShared` AFTER branch. */
function scheduleLatestHour() {
  const n = parseInt(env("PROPERA_SCHED_LATEST_HOUR", "17"), 10);
  if (isFinite(n) && n >= 0 && n <= 23) return n;
  return 17;
}

module.exports = {
  env,
  nodeEnv: env("NODE_ENV", "development"),
  port: parseInt(env("PORT", "8080"), 10) || 8080,
  supabaseUrl: env("SUPABASE_URL", ""),
  supabaseServiceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY", ""),
  identityApiEnabled,
  telegramWebhookSecret,
  telegramBotToken,
  telegramOutboundEnabled,
  coreEnabled,
  properaTimezone,
  scheduleLatestHour,
};
