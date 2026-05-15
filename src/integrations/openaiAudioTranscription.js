/**
 * OpenAI speech-to-text — used only from shared media intake (not channel adapters).
 * @see https://platform.openai.com/docs/api-reference/audio/createTranscription
 */

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {Buffer} o.audioBuffer
 * @param {string} o.filename — filename hint for MIME sniffing
 * @param {string} [o.mimeType]
 * @param {number} [o.timeoutMs]
 * @param {number} [o.maxRetries=1]
 * @returns {Promise<{ ok: boolean, text?: string, language?: string, err?: string, status?: number }>}
 */
async function openaiAudioTranscriptionFromBuffer(o) {
  const apiKey = String(o.apiKey || "").trim();
  if (!apiKey) return { ok: false, err: "no_key" };

  const model = String(o.model || "whisper-1").trim() || "whisper-1";
  const buf = o.audioBuffer;
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 16) {
    return { ok: false, err: "empty_audio" };
  }

  const filename = String(o.filename || "audio.webm").trim() || "audio.webm";
  const mime = String(o.mimeType || "application/octet-stream").trim();
  const timeoutMs = o.timeoutMs != null ? Number(o.timeoutMs) : 120000;
  const maxRetries =
    o.maxRetries != null && isFinite(Number(o.maxRetries))
      ? Math.min(3, Math.max(0, Number(o.maxRetries)))
      : 1;

  const body = new FormData();
  const ab = new Uint8Array(buf);
  const blob = new Blob([ab], { type: mime || "application/octet-stream" });
  body.append("file", blob, filename);
  body.append("model", model);

  let attempt = 0;
  while (attempt <= maxRetries) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(OPENAI_TRANSCRIBE_URL, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
        },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(t);

      const data = await res.json().catch(() => null);
      const status = res.status;

      if (status >= 200 && status < 300 && data && typeof data.text === "string") {
        return {
          ok: true,
          text: String(data.text || "").trim(),
          language: data.language != null ? String(data.language).trim() : "",
        };
      }

      const errMsg =
        data && typeof data.error === "object" && data.error && data.error.message
          ? String(data.error.message)
          : `http_${status}`;
      if (status === 429 || status === 503 || status === 500) {
        attempt++;
        if (attempt <= maxRetries) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
      }
      return { ok: false, err: errMsg, status };
    } catch (e) {
      clearTimeout(t);
      const msg = e && e.name === "AbortError" ? "timeout" : String(e && e.message ? e.message : e);
      attempt++;
      if (attempt <= maxRetries) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      return { ok: false, err: msg };
    }
  }
  return { ok: false, err: "exhausted_retries" };
}

module.exports = { openaiAudioTranscriptionFromBuffer };
