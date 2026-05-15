/**
 * Post-OCR pass: transcribe canonical audio items on `_mediaJson`, mutate `transcript` + status fields.
 */

const { getSupabase } = require("../../db/supabase");
const { appendEventLog } = require("../../dal/appendEventLog");
const { emit } = require("../../logging/structuredLog");
const {
  isAudioMediaItem,
  transcribeInboundAudioMediaItem,
} = require("../../media/audioTranscriptionProvider");
const {
  intakeAudioEnabled,
  intakeAudioTranscriptionEnabled,
  openaiAudioTranscriptionEnabled,
} = require("../../config/env");

/**
 * @param {unknown[]} mediaList
 * @param {object} opts
 * @param {string} [opts.traceId]
 * @param {string} [opts.transportChannel]
 * @param {object} [opts.deps]
 * @param {(list: unknown[], o: object) => Promise<unknown[]>} [opts.deps.enrichInboundMediaWithAudioTranscription]
 * @param {(item: object, buf: Buffer) => Promise<{ ok: boolean, text?: string, language?: string, err?: string }>} [opts.deps.callTranscribe]
 * @returns {Promise<unknown[]>}
 */
async function enrichInboundMediaWithAudioTranscription(mediaList, opts) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  const traceId = String(opts && opts.traceId || "").trim();
  const transportChannel = String(opts && opts.transportChannel || "").trim().toLowerCase();
  const inj =
    opts && opts.deps && typeof opts.deps.enrichInboundMediaWithAudioTranscription === "function"
      ? opts.deps.enrichInboundMediaWithAudioTranscription
      : null;
  if (inj) {
    return inj(list, { traceId, transportChannel, deps: opts && opts.deps });
  }

  const audioIdx = [];
  for (let i = 0; i < list.length; i++) {
    if (isAudioMediaItem(list[i])) audioIdx.push(i);
  }
  if (!audioIdx.length) return list;

  if (traceId) {
    await appendEventLog({
      traceId,
      log_kind: "inbound",
      event: "AUDIO_MEDIA_RECEIVED",
      payload: { count: audioIdx.length, transport: transportChannel },
    });
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "inbound",
      event: "AUDIO_MEDIA_RECEIVED",
      data: { count: audioIdx.length, transport: transportChannel },
    });
  }

  if (!intakeAudioEnabled()) {
    if (traceId) {
      await appendEventLog({
        traceId,
        log_kind: "inbound",
        event: "AUDIO_TRANSCRIPTION_SKIPPED_DISABLED",
        payload: { reason: "INTAKE_AUDIO_ENABLED", transport: transportChannel },
      });
    }
    return list;
  }

  if (!intakeAudioTranscriptionEnabled() || !openaiAudioTranscriptionEnabled()) {
    if (traceId) {
      await appendEventLog({
        traceId,
        log_kind: "inbound",
        event: "AUDIO_TRANSCRIPTION_SKIPPED_DISABLED",
        payload: {
          transport: transportChannel,
          intakeAudioTranscriptionEnabled: intakeAudioTranscriptionEnabled(),
          openaiAudioTranscriptionEnabled: openaiAudioTranscriptionEnabled(),
        },
      });
    }
    return list;
  }

  const sb = getSupabase();
  for (const i of audioIdx) {
    const raw = list[i];
    const item = raw && typeof raw === "object" ? { ...raw } : {};

    if (traceId) {
      await appendEventLog({
        traceId,
        log_kind: "inbound",
        event: "AUDIO_TRANSCRIPTION_STARTED",
        payload: { index: i, mime: item.mimeType || item.mime_type },
      });
    }

    const ctx = {
      transportChannel,
      sb,
      callTranscribe: opts && opts.deps && opts.deps.callTranscribe,
    };
    const result = await transcribeInboundAudioMediaItem(item, ctx);

    if (result.ok && result.transcript) {
      item.transcript = result.transcript;
      item.transcription_provider = result.provider;
      item.transcription_language = result.language || "";
      item.transcription_confidence = result.confidence;
      item.transcription_status = "completed";
      list[i] = item;
      if (traceId) {
        await appendEventLog({
          traceId,
          log_kind: "inbound",
          event: "AUDIO_TRANSCRIPTION_COMPLETED",
          payload: {
            index: i,
            provider: result.provider,
            language: result.language,
            transcript_len: result.transcript.length,
          },
        });
        await appendEventLog({
          traceId,
          log_kind: "inbound",
          event: "AUDIO_TRANSCRIPT_COMPOSED_INTO_TURN",
          payload: { index: i },
        });
      }
    } else {
      item.transcription_status = "failed";
      item.transcription_error_code = result.errorCode || "AUDIO_TRANSCRIPTION_FAILED";
      list[i] = item;
      if (traceId) {
        const ev =
          result.errorCode === "AUDIO_TRANSCRIPTION_SKIPPED_UNSUPPORTED_MIME"
            ? "AUDIO_TRANSCRIPTION_SKIPPED_UNSUPPORTED_MIME"
            : result.errorCode === "AUDIO_TRANSCRIPTION_SKIPPED_TOO_LARGE"
              ? "AUDIO_TRANSCRIPTION_SKIPPED_TOO_LARGE"
              : result.errorCode === "AUDIO_TRANSCRIPTION_SKIPPED_DISABLED"
                ? "AUDIO_TRANSCRIPTION_SKIPPED_DISABLED"
                : "AUDIO_TRANSCRIPTION_FAILED";
        await appendEventLog({
          traceId,
          log_kind: "inbound",
          event: ev,
          payload: {
            index: i,
            errorCode: result.errorCode,
          },
        });
      }
    }
  }

  return list;
}

module.exports = { enrichInboundMediaWithAudioTranscription };
