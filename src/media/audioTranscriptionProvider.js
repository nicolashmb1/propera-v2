/**
 * Channel-neutral inbound audio: validate, load bytes, transcribe.
 * No Telegram/Twilio imports; no ticket logic.
 */

const {
  intakeAudioMaxBytes,
  intakeAudioMaxSeconds,
  intakeAudioStorageBucket,
  intakeAudioStoragePathPrefix,
  openaiApiKey,
  openaiAudioTranscriptionEnabled,
  openaiAudioTranscriptionModel,
  intakeAudioTranscriptionEnabled,
  intakeAudioEnabled,
  intakeAudioChannelsRaw,
} = require("../config/env");
const { openaiAudioTranscriptionFromBuffer } = require("../integrations/openaiAudioTranscription");

/** MIME types accepted for inbound transcription (portal + future adapters). */
const AUDIO_MIMES_ALLOWED = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/flac",
]);

/**
 * @param {unknown} kind
 * @returns {boolean}
 */
function normalizeAudioKind(kind) {
  const k = String(kind || "").trim().toLowerCase();
  return k === "audio" || k === "voice" || k === "voice_note";
}

/**
 * @param {object | null | undefined} item
 * @returns {boolean}
 */
function isAudioMediaItem(item) {
  if (!item || typeof item !== "object") return false;
  if (normalizeAudioKind(item.kind)) return true;
  const ct = String(item.contentType || item.mime_type || item.mimeType || "")
    .trim()
    .toLowerCase();
  return ct.startsWith("audio/");
}

function parseIntakeAudioChannelSet() {
  const raw = intakeAudioChannelsRaw();
  const set = new Set();
  for (const part of raw.split(",")) {
    const x = part.trim().toLowerCase();
    if (!x) continue;
    if (x === "propera_chat") set.add("portal");
    else set.add(x);
  }
  return set;
}

/**
 * @param {string} transportChannel — e.g. portal, telegram
 */
function audioIntakeAllowedForTransport(transportChannel) {
  if (!intakeAudioEnabled()) return false;
  const t = String(transportChannel || "").trim().toLowerCase();
  const set = parseIntakeAudioChannelSet();
  if (!set.size) return false;
  return set.has(t);
}

function mimeAllowedForAudio(mime) {
  const m = String(mime || "")
    .trim()
    .toLowerCase()
    .split(";")[0];
  if (!m) return false;
  if (AUDIO_MIMES_ALLOWED.has(m)) return true;
  if (m.startsWith("audio/ogg")) return true;
  return false;
}

/**
 * @param {string} storagePath
 * @param {string} prefix — no leading/trailing slashes
 */
function isStoragePathAllowed(storagePath, prefix) {
  const p = String(storagePath || "").trim();
  if (!p || p.includes("..") || p.startsWith("/")) return false;
  const pref = String(prefix || "").replace(/^\/+|\/+$/g, "");
  return p.startsWith(pref + "/") || p === pref;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} bucket
 * @param {string} path
 * @returns {Promise<{ ok: boolean, buffer?: Buffer, errorCode?: string }>}
 */
async function downloadStorageObjectToBuffer(sb, bucket, path) {
  const b = String(bucket || "").trim();
  const p = String(path || "").trim();
  if (!sb || !b || !p) return { ok: false, errorCode: "AUDIO_STORAGE_DOWNLOAD_CONFIG" };
  const { data, error } = await sb.storage.from(b).download(p);
  if (error || !data) {
    return { ok: false, errorCode: "AUDIO_STORAGE_DOWNLOAD_FAILED" };
  }
  const ab = await data.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length) return { ok: false, errorCode: "AUDIO_STORAGE_EMPTY" };
  return { ok: true, buffer: buf };
}

/**
 * @param {object} item — _mediaJson item
 * @param {object} ctx
 * @param {string} ctx.transportChannel
 * @param {import("@supabase/supabase-js").SupabaseClient | null} ctx.sb
 * @param {(item: object, buf: Buffer) => Promise<{ ok: boolean, text?: string, language?: string, err?: string }>} [ctx.callTranscribe] — test injection
 * @returns {Promise<{
 *   ok: boolean,
 *   transcript: string,
 *   language: string,
 *   confidence: number,
 *   provider: string,
 *   durationSeconds: number | null,
 *   warnings: string[],
 *   errorCode?: string,
 *   userSafeReason?: string
 * }>}
 */
async function transcribeInboundAudioMediaItem(item, ctx) {
  const warnings = [];
  const transportChannel = String(ctx && ctx.transportChannel || "").trim().toLowerCase();

  if (!intakeAudioEnabled()) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: null,
      warnings,
      errorCode: "AUDIO_INTAKE_DISABLED",
      userSafeReason: "",
    };
  }

  if (!audioIntakeAllowedForTransport(transportChannel)) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: null,
      warnings,
      errorCode: "AUDIO_CHANNEL_NOT_ALLOWED",
      userSafeReason: "",
    };
  }

  if (!isAudioMediaItem(item)) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: null,
      warnings,
      errorCode: "AUDIO_NOT_AUDIO_ITEM",
      userSafeReason: "",
    };
  }

  const mime = String(item.mimeType || item.mime_type || item.contentType || "")
    .trim()
    .toLowerCase()
    .split(";")[0];
  if (!mimeAllowedForAudio(mime)) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: null,
      warnings,
      errorCode: "AUDIO_TRANSCRIPTION_SKIPPED_UNSUPPORTED_MIME",
      userSafeReason: "I could not understand the audio clearly.",
    };
  }

  const maxBytes = intakeAudioMaxBytes();
  const maxSec = intakeAudioMaxSeconds();
  const dur = item.durationSeconds != null ? Number(item.durationSeconds) : null;
  if (dur != null && isFinite(dur) && dur > maxSec) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: dur,
      warnings,
      errorCode: "AUDIO_TRANSCRIPTION_SKIPPED_TOO_LARGE",
      userSafeReason: "That voice note is too long. Please send a shorter clip or type the issue.",
    };
  }

  const sizeHint = item.sizeBytes != null ? Number(item.sizeBytes) : null;
  if (sizeHint != null && isFinite(sizeHint) && sizeHint > maxBytes) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: dur,
      warnings,
      errorCode: "AUDIO_TRANSCRIPTION_SKIPPED_TOO_LARGE",
      userSafeReason: "That audio file is too large. Please send a smaller clip or type the issue.",
    };
  }

  const bucketConfigured = intakeAudioStorageBucket();
  const pathPrefix = intakeAudioStoragePathPrefix();
  const storagePath = String(item.storagePath || "").trim();
  const bucket = String(item.storageBucket || bucketConfigured || "").trim() || bucketConfigured;

  if (!storagePath) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: dur,
      warnings,
      errorCode: "AUDIO_MISSING_STORAGE_PATH",
      userSafeReason: "I could not understand the audio clearly.",
    };
  }

  if (bucket !== bucketConfigured || !isStoragePathAllowed(storagePath, pathPrefix)) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: dur,
      warnings,
      errorCode: "AUDIO_STORAGE_PATH_REJECTED",
      userSafeReason: "I could not understand the audio clearly.",
    };
  }

  const sb = ctx && ctx.sb ? ctx.sb : null;
  if (!sb) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: dur,
      warnings,
      errorCode: "AUDIO_NO_DATABASE",
      userSafeReason: "I could not understand the audio clearly.",
    };
  }

  const dl = await downloadStorageObjectToBuffer(sb, bucket, storagePath);
  if (!dl.ok || !dl.buffer) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: dur,
      warnings,
      errorCode: dl.errorCode || "AUDIO_DOWNLOAD_FAILED",
      userSafeReason: "I could not understand the audio clearly.",
    };
  }

  if (dl.buffer.length > maxBytes) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: dur,
      warnings,
      errorCode: "AUDIO_TRANSCRIPTION_SKIPPED_TOO_LARGE",
      userSafeReason: "That audio file is too large. Please send a smaller clip or type the issue.",
    };
  }

  if (!intakeAudioTranscriptionEnabled() || !openaiAudioTranscriptionEnabled()) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: dur,
      warnings,
      errorCode: "AUDIO_TRANSCRIPTION_SKIPPED_DISABLED",
      userSafeReason: "",
    };
  }

  const apiKey = openaiApiKey();
  if (!apiKey) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "",
      durationSeconds: dur,
      warnings,
      errorCode: "AUDIO_TRANSCRIPTION_SKIPPED_DISABLED",
      userSafeReason: "",
    };
  }

  const filename =
    String(item.filename || "voice.webm").trim() || "voice.webm";
  const model = openaiAudioTranscriptionModel();

  const call =
    ctx && typeof ctx.callTranscribe === "function"
      ? ctx.callTranscribe
      : async (it, buf) => {
          return openaiAudioTranscriptionFromBuffer({
            apiKey,
            model,
            audioBuffer: buf,
            filename,
            mimeType: mime,
            timeoutMs: 120000,
            maxRetries: 1,
          });
        };

  const tr = await call(item, dl.buffer);
  if (!tr.ok || !String(tr.text || "").trim()) {
    return {
      ok: false,
      transcript: "",
      language: "",
      confidence: 0,
      provider: "openai_whisper",
      durationSeconds: dur,
      warnings,
      errorCode: "AUDIO_TRANSCRIPTION_FAILED",
      userSafeReason: "I could not understand the audio clearly.",
    };
  }

  const transcript = String(tr.text || "").trim();
  return {
    ok: true,
    transcript,
    language: String(tr.language || "").trim(),
    confidence: 0.85,
    provider: "openai_whisper",
    durationSeconds: dur,
    warnings,
  };
}

module.exports = {
  normalizeAudioKind,
  isAudioMediaItem,
  parseIntakeAudioChannelSet,
  audioIntakeAllowedForTransport,
  mimeAllowedForAudio,
  isStoragePathAllowed,
  downloadStorageObjectToBuffer,
  transcribeInboundAudioMediaItem,
};
