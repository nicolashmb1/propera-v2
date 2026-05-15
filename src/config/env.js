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

/** Twilio REST API — SMS / WhatsApp outbound (`src/outbound/twilioSendMessage.js`) */
function twilioAccountSid() {
  return String(env("TWILIO_ACCOUNT_SID", "")).trim();
}
function twilioAuthToken() {
  return String(env("TWILIO_AUTH_TOKEN", "")).trim();
}
/** E.164, e.g. +15551234567 */
function twilioSmsFrom() {
  return String(env("TWILIO_SMS_FROM", "")).trim();
}
/** WhatsApp sender, e.g. whatsapp:+14155238886 */
function twilioWhatsappFrom() {
  return String(env("TWILIO_WHATSAPP_FROM", "")).trim();
}
function twilioOutboundEnabled() {
  return (
    env("TWILIO_OUTBOUND_ENABLED", "") === "1" &&
    !!twilioAccountSid() &&
    !!twilioAuthToken()
  );
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

/** Optional visual media signal extraction during intake (facts only, no decisions). */
function intakeMediaSignalEnabled() {
  return envFlagTrue("INTAKE_MEDIA_SIGNAL_ENABLED", false);
}

/** Enables live provider calls for media signal extraction. Requires `OPENAI_API_KEY`. */
function intakeMediaVisionEnabled() {
  return envFlagTrue("INTAKE_MEDIA_VISION_ENABLED", false);
}

/** Master gate: portal/Telegram/etc. may attach audio; V2 may load + transcribe when on. */
function intakeAudioEnabled() {
  return envFlagTrue("INTAKE_AUDIO_ENABLED", false);
}

/** When on with `OPENAI_API_KEY` + `OPENAI_AUDIO_TRANSCRIPTION_ENABLED`, run speech-to-text on audio media. */
function intakeAudioTranscriptionEnabled() {
  return envFlagTrue("INTAKE_AUDIO_TRANSCRIPTION_ENABLED", false);
}

/** Second gate for OpenAI transcription API (belt-and-suspenders with INTAKE_AUDIO_TRANSCRIPTION_ENABLED). */
function openaiAudioTranscriptionEnabled() {
  return envFlagTrue("OPENAI_AUDIO_TRANSCRIPTION_ENABLED", false);
}

/**
 * Comma-separated transport/channel ids: `portal` (Propera Chat), `telegram`, `whatsapp`, `sms`.
 * Alias: `propera_chat` → treated as `portal`.
 */
function intakeAudioChannelsRaw() {
  return String(env("INTAKE_AUDIO_CHANNELS", "portal")).trim();
}

function intakeAudioMaxSeconds() {
  const n = parseInt(env("INTAKE_AUDIO_MAX_SECONDS", "120"), 10);
  if (!isFinite(n) || n < 1) return 120;
  return Math.min(n, 600);
}

function intakeAudioMaxBytes() {
  const n = parseInt(env("INTAKE_AUDIO_MAX_BYTES", "25000000"), 10);
  if (!isFinite(n) || n < 1024) return 25000000;
  return Math.min(n, 100 * 1024 * 1024);
}

/** Bucket for portal chat audio uploads (must match app upload route). */
function intakeAudioStorageBucket() {
  return String(env("INTAKE_AUDIO_STORAGE_BUCKET", "pm-attachments")).trim() || "pm-attachments";
}

/** Path prefix required for V2 download (security). */
function intakeAudioStoragePathPrefix() {
  const p = String(env("INTAKE_AUDIO_STORAGE_PATH_PREFIX", "portal-chat-audio")).trim();
  return p.replace(/^\/+|\/+$/g, "") || "portal-chat-audio";
}

function openaiAudioTranscriptionModel() {
  return String(env("OPENAI_AUDIO_TRANSCRIPTION_MODEL", "whisper-1")).trim() || "whisper-1";
}

/** Vision-capable model for OCR extraction from images. */
function openaiModelVision() {
  return String(env("OPENAI_MODEL_VISION", "gpt-4o-mini")).trim() || "gpt-4o-mini";
}

/**
 * Vision model for batch utility-meter photo extraction only (`meterRuns/extractMeterReading`).
 * When unset, uses {@link openaiModelVision} (intake default). Set e.g. `gpt-4o` for higher digit/OCR accuracy vs cost.
 */
function openaiModelMeterBatch() {
  const explicit = String(env("PROPERA_METER_BATCH_VISION_MODEL", "")).trim();
  if (explicit) return explicit;
  return openaiModelVision();
}

/**
 * Meter batch OCR: when true (`PROPERA_METER_REGISTER_LAST_DIGIT_ZERO=1`), post-process may append a trailing 0 when
 * `registerDigitCount` implies a dropped last wheel. Prompt always nudges whole-tens; this gates numeric correction.
 */
function meterRegisterLastDigitZero() {
  return envFlagTrue("PROPERA_METER_REGISTER_LAST_DIGIT_ZERO", false);
}

/**
 * Optional: expected number of visible billing-register positions (wheels) for this portfolio; injected into the refinement extract pass.
 */
function meterExpectedRegisterDigits() {
  const raw = String(env("PROPERA_METER_EXPECTED_REGISTER_DIGITS", "")).trim();
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 24) return null;
  return n;
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

/**
 * POST `/internal/cron/lifecycle-timers` and `/internal/cron/meter-runs-process-pending` —
 * header `X-Propera-Cron-Secret` must match when set.
 */
function lifecycleCronSecret() {
  return String(env("LIFECYCLE_CRON_SECRET", "")).trim();
}

/**
 * Portal read API + portal inbound (`/api/portal/*`, `/webhooks/portal`).
 * Align with GAS `PORTAL_API_TOKEN_PM` / propera-app `PROPERA_PM_TOKEN` when set.
 */
function portalApiToken() {
  return String(
    env("PROPERA_PORTAL_TOKEN", env("PORTAL_API_TOKEN_PM", ""))
  ).trim();
}

/** Turnover Engine `/api/portal/turnovers*` — opt-in until GA (`PROPERA_TURNOVER_ENGINE_ENABLED=1`). */
function turnoverEngineEnabled() {
  return env("PROPERA_TURNOVER_ENGINE_ENABLED", "") === "1";
}

/** Operational finance master — default off (`PROPERA_FINANCE_ENABLED=1`). */
function financeCoreEnabled() {
  return env("PROPERA_FINANCE_ENABLED", "") === "1";
}

/** Ticket cost entries API — requires core + `PROPERA_FINANCE_TICKET_COSTS_ENABLED=1`. */
function financeTicketCostsEnabled() {
  return financeCoreEnabled() && env("PROPERA_FINANCE_TICKET_COSTS_ENABLED", "") === "1";
}

/** Post approved ticket charges to `tenant_ledger_entries` (`PROPERA_FINANCE_LEDGER_ENABLED=1`). */
function financeLedgerEnabled() {
  return financeCoreEnabled() && env("PROPERA_FINANCE_LEDGER_ENABLED", "") === "1";
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
  twilioAccountSid,
  twilioAuthToken,
  twilioSmsFrom,
  twilioWhatsappFrom,
  twilioOutboundEnabled,
  coreEnabled,
  properaTimezone,
  scheduleLatestHour,
  intakeCompileTurnEnabled,
  intakeLlmEnabled,
  openaiApiKey,
  openaiModelExtract,
  intakeMediaOcrEnabled,
  intakeMediaSignalEnabled,
  intakeMediaVisionEnabled,
  openaiModelVision,
  openaiModelMeterBatch,
  meterRegisterLastDigitZero,
  meterExpectedRegisterDigits,
  dashboardEnabled,
  dashboardToken,
  lifecycleCronSecret,
  portalApiToken,
  turnoverEngineEnabled,
  financeCoreEnabled,
  financeTicketCostsEnabled,
  financeLedgerEnabled,
  intakeAudioEnabled,
  intakeAudioTranscriptionEnabled,
  openaiAudioTranscriptionEnabled,
  intakeAudioChannelsRaw,
  intakeAudioMaxSeconds,
  intakeAudioMaxBytes,
  intakeAudioStorageBucket,
  intakeAudioStoragePathPrefix,
  openaiAudioTranscriptionModel,
};
