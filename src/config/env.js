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

/** Max voice agent — PROPERA_VOICE_ENABLED=1 + OPENAI_API_KEY + PROPERA_PUBLIC_BASE_URL */
function voiceEnabled() {
  return envFlagTrue("PROPERA_VOICE_ENABLED", false);
}

/** Jarvis staff live voice — portal WS /voice/jarvis + JARVIS_ASK_ENABLED recommended */
function jarvisVoiceEnabled() {
  return envFlagTrue("JARVIS_VOICE_ENABLED", false);
}

/** Comma-separated portal login emails allowed to manage per-staff Jarvis toggles. */
function jarvisSettingsAdminEmails() {
  const raw = String(env("PROPERA_JARVIS_SETTINGS_ADMIN_EMAILS", "")).trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * @param {{ source?: string, emailLower?: string }} org — from portalOrgFromReq
 */
function canManageJarvisStaffSettings(org) {
  if (!org || org.source !== "jwt") return false;
  const allowed = jarvisSettingsAdminEmails();
  if (!allowed.size) return false;
  const email = String(org.emailLower || "").trim().toLowerCase();
  return !!email && allowed.has(email);
}

function voiceModel() {
  return String(env("PROPERA_VOICE_MODEL", "gpt-realtime-2")).trim();
}

const OPENAI_REALTIME_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);

function voiceAgentVoice() {
  let v = String(env("PROPERA_VOICE_AGENT_VOICE", "alloy")).trim().toLowerCase();
  if (v === "shimer") v = "shimmer";
  if (!OPENAI_REALTIME_VOICES.has(v)) return "alloy";
  return v;
}

/** Spoken display name for tenant maintenance voice (e.g. greeting: "Hi — Max with …"). */
function voiceAgentName() {
  const v = String(env("PROPERA_VOICE_AGENT_NAME", "Max")).trim();
  return v.slice(0, 32) || "Max";
}

/** Spoken display name for staff Jarvis live voice. */
function jarvisAgentName() {
  const v = String(env("PROPERA_JARVIS_AGENT_NAME", "Jarvis")).trim();
  return v.slice(0, 32) || "Jarvis";
}

/** Voice delivery accent/style — british | american | australian | neutral (default). */
function voiceSpeakingStyle() {
  const v = String(env("PROPERA_VOICE_SPEAKING_STYLE", "neutral")).trim().toLowerCase();
  if (v === "british" || v === "uk" || v === "en-gb" || v === "en_gb") return "british";
  if (v === "american" || v === "us" || v === "en-us" || v === "en_us") return "american";
  if (v === "australian" || v === "au" || v === "en-au" || v === "en_au") return "australian";
  return "neutral";
}

/** semantic_vad eagerness: low | medium | high — default low to avoid cutting callers off mid-thought */
function voiceVadEagerness() {
  const v = String(env("PROPERA_VOICE_VAD_EAGERNESS", "low")).trim().toLowerCase();
  if (v === "medium" || v === "high") return v;
  return "low";
}

/** server_vad | semantic_vad — server_vad waits for silence; better when callers pause mid-answer */
function voiceTurnDetectionMode() {
  const v = String(env("PROPERA_VOICE_TURN_DETECTION", "server_vad")).trim().toLowerCase();
  if (v === "semantic_vad" || v === "semantic") return "semantic_vad";
  return "server_vad";
}

/** Milliseconds of silence before the model takes its turn (server_vad). Higher = more patient. */
function voiceSilenceDurationMs() {
  const n = parseInt(env("PROPERA_VOICE_SILENCE_MS", "1200"), 10);
  if (isFinite(n) && n >= 400 && n <= 3000) return n;
  return 1200;
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

/** Anthropic API key — used when PROPERA_EXPENSE_SCAN_PROVIDER=anthropic. */
function anthropicApiKey() {
  return String(env("ANTHROPIC_API_KEY", "")).trim();
}

/**
 * Vision provider for expense bill scan: "openai" (default) or "anthropic".
 * Selects which API + key to use for photo → structured expense extraction.
 */
function expenseScanProvider() {
  const v = String(env("PROPERA_EXPENSE_SCAN_PROVIDER", "openai")).trim().toLowerCase();
  return v === "anthropic" ? "anthropic" : "openai";
}

/**
 * Model override for expense scan vision.
 * Defaults: gpt-4o-mini (openai) / claude-haiku-4-5-20251001 (anthropic).
 */
function expenseScanModel() {
  const explicit = String(env("PROPERA_EXPENSE_SCAN_MODEL", "")).trim();
  if (explicit) return explicit;
  return expenseScanProvider() === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-4o-mini";
}

/** Vision provider for unit asset nameplate scan — defaults to expense scan provider. */
function unitAssetScanProvider() {
  const explicit = String(env("PROPERA_UNIT_ASSET_SCAN_PROVIDER", "")).trim().toLowerCase();
  if (explicit === "anthropic" || explicit === "openai") return explicit;
  return expenseScanProvider();
}

/** Model override for unit asset nameplate scan — defaults to expense scan model. */
function unitAssetScanModel() {
  const explicit = String(env("PROPERA_UNIT_ASSET_SCAN_MODEL", "")).trim();
  if (explicit) return explicit;
  return expenseScanModel();
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

/** Open deck day chart `GET /api/portal/tickets/day-curve` — opt-in (`PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1`). */
function openDeckDayChartEnabled() {
  return env("PROPERA_OPEN_DECK_DAY_CHART_ENABLED", "") === "1";
}

/** Turnover Engine `/api/portal/turnovers*` — opt-in until GA (`PROPERA_TURNOVER_ENGINE_ENABLED=1`). */
function turnoverEngineEnabled() {
  return env("PROPERA_TURNOVER_ENGINE_ENABLED", "") === "1";
}

/** Unit lifecycle (occupancies V1+) — `/api/portal/occupancies*` (`PROPERA_UNIT_LIFECYCLE_ENABLED=1`). */
function unitLifecycleEnabled() {
  return env("PROPERA_UNIT_LIFECYCLE_ENABLED", "") === "1";
}

/** Leasing Engine `/api/portal/leasing/*` — opt-in (`PROPERA_LEASING_ENGINE_ENABLED=1`). */
function leasingEngineEnabled() {
  return env("PROPERA_LEASING_ENGINE_ENABLED", "") === "1";
}

/** Access Engine `/api/portal/access/*` — amenity reservations (`PROPERA_ACCESS_ENGINE_ENABLED=1`). */
function accessEngineEnabled() {
  return env("PROPERA_ACCESS_ENGINE_ENABLED", "") === "1";
}

/** Tenant portal en/es UI + translate layers (`PROPERA_TENANT_I18N_ENABLED=1`). Phase 1 static UI works without flag. */
function tenantI18nEnabled() {
  return env("PROPERA_TENANT_I18N_ENABLED", "") === "1";
}

/** Model for tenant portal translate-on-write / display (`PROPERA_TENANT_TRANSLATE_MODEL`). */
function tenantTranslateModel() {
  const m = String(env("PROPERA_TENANT_TRANSLATE_MODEL", "")).trim();
  return m || openaiModelExtract();
}

/** Encrypt access PINs at rest (`ACCESS_CREDENTIAL_SECRET`). Dev may omit (base64 only). */
function accessCredentialSecret() {
  return String(env("ACCESS_CREDENTIAL_SECRET", "")).trim();
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

/** Chat/marker `$$` expense capture (`PROPERA_FINANCE_COST_CAPTURE_CHAT=1`). */
function financeCostCaptureChatEnabled() {
  return financeTicketCostsEnabled() && env("PROPERA_FINANCE_COST_CAPTURE_CHAT", "") === "1";
}

/**
 * Financial capture via portal_chat_mode=financial — natural language expense/payment/charge.
 * Requires `PROPERA_FINANCE_ENABLED=1` + `PROPERA_FINANCIAL_CAPTURE_ENABLED=1`.
 */
function financialCaptureEnabled() {
  return financeCoreEnabled() && env("PROPERA_FINANCIAL_CAPTURE_ENABLED", "") === "1";
}

/**
 * Optional comma-separated property codes; empty = all properties when chat capture on.
 * @returns {Set<string>|null} null = no allowlist filter
 */
function financeCostCapturePropertyAllowlist() {
  const raw = env("PROPERA_FINANCE_COST_CAPTURE_PROPERTIES", "").trim();
  if (!raw) return null;
  const set = new Set();
  for (const p of raw.split(",")) {
    const c = p.trim().toUpperCase();
    if (c) set.add(c);
  }
  return set.size ? set : null;
}

/** Communication Engine portal routes + broadcast SMS engine (`/api/communications/*`, `/webhooks/communications/*`). */
function communicationEngineEnabled() {
  return env("PROPERA_COMMUNICATION_ENGINE_ENABLED", "") === "1";
}

/** Conflict Mediation Engine — CME-1 portal read routes (`/api/conflict/*`). */
function conflictMediationEngineEnabled() {
  return env("PROPERA_CONFLICT_MEDIATION_ENABLED", "") === "1";
}

/** Staff portal Web Push (`PROPERA_PORTAL_PUSH_ENABLED=1` + VAPID keys). */
function portalPushEnabled() {
  return env("PROPERA_PORTAL_PUSH_ENABLED", "") === "1";
}

function vapidPublicKey() {
  return String(env("PROPERA_VAPID_PUBLIC_KEY", "")).trim();
}

function vapidPrivateKey() {
  return String(env("PROPERA_VAPID_PRIVATE_KEY", "")).trim();
}

function vapidSubject() {
  return String(env("PROPERA_VAPID_SUBJECT", "mailto:ops@usepropera.com")).trim();
}

/** Dedicated Twilio number for broadcast SMS (separate from maintenance main number). */
function twilioBroadcastFrom() {
  return String(env("TWILIO_BROADCAST_FROM", "")).trim();
}

/** Single-org V1 brand id used by communication campaigns unless a route provides one. */
function communicationOrgId() {
  return defaultOrgId();
}

/** Default management-company org when portal JWT/header does not resolve one (dev + single-tenant). */
function defaultOrgId() {
  const explicit = String(env("PROPERA_DEFAULT_ORG_ID", "")).trim().toLowerCase();
  if (explicit) return explicit;
  return String(env("COMM_ORG_ID", "")).trim().toLowerCase();
}

function commReplyWindowHours() {
  const n = parseInt(env("COMM_REPLY_WINDOW_HOURS", "72"), 10);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

function openaiCommDraftModel() {
  return String(env("OPENAI_COMM_DRAFT_MODEL", "gpt-4o-mini")).trim() || "gpt-4o-mini";
}

/** Resident portal JWT (`/api/tenant/*`). */
function tenantJwtSecret() {
  return String(env("TENANT_JWT_SECRET", "")).trim();
}

function tenantOtpTtlMinutes() {
  const n = parseInt(env("TENANT_OTP_TTL_MINUTES", "10"), 10);
  return isFinite(n) && n > 0 ? n : 10;
}

function tenantOtpMaxAttempts() {
  const n = parseInt(env("TENANT_OTP_MAX_ATTEMPTS", "3"), 10);
  return isFinite(n) && n > 0 ? n : 3;
}

function tenantOtpRateLimitPer15Min() {
  const n = parseInt(env("TENANT_OTP_RATE_LIMIT_PER_15MIN", "3"), 10);
  return isFinite(n) && n > 0 ? n : 3;
}

function tenantSessionDays() {
  const n = parseInt(env("TENANT_SESSION_DAYS", "30"), 10);
  return isFinite(n) && n > 0 ? n : 30;
}

function tenantDocsBucket() {
  return String(env("SUPABASE_TENANT_DOCS_BUCKET", "tenant-documents")).trim();
}

function commMainNumberDisplay() {
  const d = String(env("COMM_MAIN_NUMBER_DISPLAY", "")).trim();
  if (d) return d;
  return twilioSmsFrom();
}

/** Broadcast SMS footer only — explicit COMM_MAIN_NUMBER_DISPLAY; no TWILIO_SMS_FROM fallback. */
function commBroadcastFooterMainNumber() {
  return String(env("COMM_MAIN_NUMBER_DISPLAY", "")).trim();
}

function devOrgSubdomain() {
  return String(env("DEV_ORG_SUBDOMAIN", "")).trim().toLowerCase();
}

/** MO-4 — public company signup wizard (requires shared secret on bootstrap routes). */
function orgSignupEnabled() {
  return env("PROPERA_ORG_SIGNUP_ENABLED", "") === "1";
}

function orgSignupSecret() {
  return String(env("PROPERA_ORG_SIGNUP_SECRET", "")).trim();
}

/** Phase 2 — Team & routing owns maintenance assignee at create (see resolveAssignee.js). Set 0 to use ASSIGN_DEFAULT_OWNER policy. */
function responsibilityResolverEnabled() {
  return envFlagTrue("PROPERA_USE_RESPONSIBILITY_RESOLVER", true);
}

/** Public HTTPS base for V2 (webhook URLs in Settings → Channels). No trailing slash. */
function properaPublicBaseUrl() {
  return String(env("PROPERA_PUBLIC_BASE_URL", "")).trim().replace(/\/+$/, "");
}

/**
 * Local dev only — skip SMS; expose fixed OTP on request-otp and accept on verify.
 * Hard-off when NODE_ENV=production even if env is set.
 */
function tenantDevOtpBypass() {
  if (env("NODE_ENV", "development") === "production") return false;
  return envFlagTrue("TENANT_DEV_OTP_BYPASS", false);
}

function tenantDevOtpCode() {
  const c = String(env("TENANT_DEV_OTP_CODE", "000000")).trim();
  return /^\d{6}$/.test(c) ? c : "000000";
}

/** Outgate Phase 4 — property header, SMS footer, Telegram Markdown at dispatch. */
function outgateChannelRenderEnabled() {
  return envFlagTrue("OUTGATE_CHANNEL_RENDER", true);
}

/** Tenant Agent adapter — default off (legacy slot machine). */
function tenantAgentEnabled() {
  return envFlagTrue("TENANT_AGENT_ENABLED", false);
}

/** Vendor Agent adapter on vendorLane — default off; deterministic handleVendorInbound first. */
function vendorAgentEnabled() {
  return envFlagTrue("VENDOR_AGENT_ENABLED", false);
}

function tenantAgentLlmEnabled() {
  return envFlagTrue("TENANT_AGENT_LLM_ENABLED", false);
}

/** @returns {string[]} uppercased property codes; empty = all properties when agent on */
function tenantAgentPropertyAllowlist() {
  const raw = String(env("TENANT_AGENT_PROPERTY_ALLOWLIST", "")).trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);
}

function tenantAgentMaxTurns() {
  const n = parseInt(env("TENANT_AGENT_MAX_TURNS", "12"), 10);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

function tenantAgentLlmModel() {
  const m = String(env("TENANT_AGENT_LLM_MODEL", "")).trim();
  return m || openaiModelExtract();
}

function tenantAgentFallbackToLegacy() {
  return envFlagTrue("TENANT_AGENT_FALLBACK_TO_LEGACY", false);
}

/** Portal Jarvis Ask — read-only staff Q&A (`portal_chat_mode: jarvis_ask`). */
function jarvisAskEnabled() {
  return envFlagTrue("JARVIS_ASK_ENABLED", false);
}

/** Portal Jarvis Plan — propose → confirm (`portal_chat_mode: jarvis_plan`). */
function jarvisPlanEnabled() {
  return envFlagTrue("JARVIS_PLAN_ENABLED", false);
}

/** Jarvis tenant broadcast — allow audience_scope=portfolio (all properties). Default off. */
function jarvisCommPortfolioEnabled() {
  return envFlagTrue("PROPERA_JARVIS_COMM_PORTFOLIO_ENABLED", false);
}

/** Jarvis / agent-initiated comm default: sms_only | sms_and_portal | portal_only */
function jarvisCommDefaultDeliveryMode() {
  const raw = String(env("PROPERA_JARVIS_COMM_DELIVERY_MODE", "sms_only")).trim().toLowerCase();
  if (raw === "portal_only" || raw === "sms_and_portal") return raw;
  return "sms_only";
}

/** Jarvis operator thread state (`jarvis_operator_threads`). */
function jarvisThreadEnabled() {
  return envFlagTrue("JARVIS_THREAD_ENABLED", false);
}

/** Optional LLM wording on top of deterministic Jarvis Ask facts (requires OPENAI_API_KEY). */
function jarvisAskLlmEnabled() {
  return envFlagTrue("JARVIS_ASK_LLM_ENABLED", false);
}

function jarvisAskLlmModel() {
  const m = String(env("JARVIS_ASK_LLM_MODEL", "")).trim();
  return m || openaiModelExtract();
}

/**
 * Max wait for the optional Ask LLM wording pass before falling back to the
 * deterministic reply. Bounds portal-chat P95 (was a hardcoded 20s). Clamped [2s, 30s].
 */
function jarvisAskLlmTimeoutMs() {
  const n = parseInt(env("JARVIS_ASK_LLM_TIMEOUT_MS", "10000"), 10);
  if (!Number.isFinite(n)) return 10000;
  return Math.min(Math.max(n, 2000), 30000);
}

/** Adapter conversation row TTL (hours). Default 48; 0 = disable lazy expiry. */
function tenantAgentConversationTtlHours() {
  const raw = env("TENANT_AGENT_CONVERSATION_TTL_HOURS", "48");
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 48;
  return n;
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
  voiceEnabled,
  jarvisVoiceEnabled,
  jarvisSettingsAdminEmails,
  canManageJarvisStaffSettings,
  voiceModel,
  voiceAgentVoice,
  voiceAgentName,
  jarvisAgentName,
  voiceSpeakingStyle,
  voiceVadEagerness,
  voiceTurnDetectionMode,
  voiceSilenceDurationMs,
  coreEnabled,
  properaTimezone,
  scheduleLatestHour,
  intakeCompileTurnEnabled,
  intakeLlmEnabled,
  openaiApiKey,
  openaiModelExtract,
  intakeMediaOcrEnabled,
  outgateChannelRenderEnabled,
  tenantAgentEnabled,
  vendorAgentEnabled,
  tenantAgentLlmEnabled,
  tenantAgentPropertyAllowlist,
  tenantAgentMaxTurns,
  tenantAgentLlmModel,
  tenantAgentFallbackToLegacy,
  tenantAgentConversationTtlHours,
  jarvisAskEnabled,
  jarvisAskLlmEnabled,
  jarvisAskLlmModel,
  jarvisAskLlmTimeoutMs,
  jarvisPlanEnabled,
  jarvisCommPortfolioEnabled,
  jarvisCommDefaultDeliveryMode,
  jarvisThreadEnabled,
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
  openDeckDayChartEnabled,
  turnoverEngineEnabled,
  unitLifecycleEnabled,
  leasingEngineEnabled,
  accessEngineEnabled,
  tenantI18nEnabled,
  tenantTranslateModel,
  accessCredentialSecret,
  financeCoreEnabled,
  financialCaptureEnabled,
  financeTicketCostsEnabled,
  financeLedgerEnabled,
  financeCostCaptureChatEnabled,
  financeCostCapturePropertyAllowlist,
  communicationEngineEnabled,
  conflictMediationEngineEnabled,
  portalPushEnabled,
  vapidPublicKey,
  vapidPrivateKey,
  vapidSubject,
  twilioBroadcastFrom,
  communicationOrgId,
  defaultOrgId,
  commReplyWindowHours,
  openaiCommDraftModel,
  intakeAudioEnabled,
  intakeAudioTranscriptionEnabled,
  openaiAudioTranscriptionEnabled,
  intakeAudioChannelsRaw,
  intakeAudioMaxSeconds,
  intakeAudioMaxBytes,
  intakeAudioStorageBucket,
  intakeAudioStoragePathPrefix,
  openaiAudioTranscriptionModel,
  anthropicApiKey,
  expenseScanProvider,
  expenseScanModel,
  unitAssetScanProvider,
  unitAssetScanModel,
  tenantJwtSecret,
  tenantOtpTtlMinutes,
  tenantOtpMaxAttempts,
  tenantOtpRateLimitPer15Min,
  tenantSessionDays,
  tenantDocsBucket,
  commMainNumberDisplay,
  commBroadcastFooterMainNumber,
  devOrgSubdomain,
  orgSignupEnabled,
  orgSignupSecret,
  responsibilityResolverEnabled,
  properaPublicBaseUrl,
  tenantDevOtpBypass,
  tenantDevOtpCode,
};
