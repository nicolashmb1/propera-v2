/**
 * Central env read — fail soft in dev so `npm start` works with zero secrets.
 *
 * Load `.env` from the **propera-v2 package root** (`…/propera-v2/.env`), not only `process.cwd()`.
 * Otherwise `npm start` run from a parent folder (e.g. monorepo root) never sees INTAKE_COMPILE_TURN
 * and intake stays on `regex_only`.
 */
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "..", ".env"),
});

// Schedule parsing uses `Date#setHours` / `getHours` (Node's `TZ`) and `Intl` with `PROPERA_TZ`.
// If those diverge, tenant copy can show the wrong clock time (e.g. "1–4 PM" for "tomorrow morning")
// and policy sees the wrong `startHour`/`endHour`. Canonical property zone: align `TZ` with `PROPERA_TZ`.
const _properaTz = String(process.env.PROPERA_TZ || "").trim();
if (_properaTz) process.env.TZ = _properaTz;

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
  const tzEnv = env("TZ", "");
  if (tzEnv) return tzEnv;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch (_) {
    return "UTC";
  }
}

/** GAS `ppGet_('GLOBAL','SCHED_LATEST_HOUR',17)` — `parsePreferredWindowShared` AFTER branch. */
function scheduleLatestHour() {
  const n = parseInt(env("PROPERA_SCHED_LATEST_HOUR", "17"), 10);
  if (isFinite(n) && n >= 0 && n <= 23) return n;
  return 17;
}

/**
 * Boolean env flag. When unset or empty → `defaultWhenUnset`.
 * Truthy: `1`, `true`, `yes`, `on` (trimmed, case-insensitive).
 * Falsy: `0`, `false`, `no`, `off`.
 * Other values → `defaultWhenUnset` (safe default off for intake flags).
 */
function envFlagTrue(name, defaultWhenUnset = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultWhenUnset;
  const v = String(raw).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return defaultWhenUnset;
}

/** GAS `compileTurn_` + `properaBuildIntakePackage_` path for maintenance draft (deterministic + optional LLM). */
function intakeCompileTurnEnabled() {
  return envFlagTrue("INTAKE_COMPILE_TURN", false);
}

/** When set with `OPENAI_API_KEY`, run structured-signal LLM extraction (GAS `properaExtractStructuredSignalLLM_`). */
function intakeLlmEnabled() {
  return envFlagTrue("INTAKE_LLM_ENABLED", false);
}

function openaiApiKey() {
  return String(env("OPENAI_API_KEY", "")).trim();
}

/** GAS `OPENAI_MODEL_EXTRACT` — default matches GAS fallback `gpt-4.1-mini` / Node-friendly `gpt-4o-mini`. */
function openaiModelExtract() {
  return String(env("OPENAI_MODEL_EXTRACT", "gpt-4o-mini")).trim() || "gpt-4o-mini";
}

/** Optional OCR-on-media during intake (adapter can enrich `_mediaJson.ocr_text`). */
function intakeMediaOcrEnabled() {
  return envFlagTrue("INTAKE_MEDIA_OCR_ENABLED", false);
}

/** Vision-capable model for OCR extraction from images. */
function openaiModelVision() {
  return String(env("OPENAI_MODEL_VISION", "gpt-4o-mini")).trim() || "gpt-4o-mini";
}

/**
 * `GET /dashboard` + `GET /api/ops/event-log` — flight recorder UI.
 * - `DASHBOARD_ENABLED=0` → always off.
 * - `DASHBOARD_ENABLED=1` → always on (if token passes when set).
 * - Unset → on in **development** only (so local `npm start` works without editing `.env`).
 */
function dashboardEnabled() {
  const d = env("DASHBOARD_ENABLED", "");
  if (d === "0") return false;
  if (d === "1") return true;
  return env("NODE_ENV", "development") === "development";
}

/** If set, dashboard and API require `?token=` or `Authorization: Bearer` to match. */
function dashboardToken() {
  return String(env("DASHBOARD_TOKEN", "")).trim();
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
  intakeCompileTurnEnabled,
  intakeLlmEnabled,
  openaiApiKey,
  openaiModelExtract,
  intakeMediaOcrEnabled,
  openaiModelVision,
  dashboardEnabled,
  dashboardToken,
};
