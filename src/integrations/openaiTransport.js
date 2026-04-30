/**
 * GAS `05_AI_MEDIA_TRANSPORT.gs` slice — shared OpenAI chat/completions with cooldown + retries.
 * Used by vision OCR and intake JSON extraction.
 */

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

/** Process-local global cooldown (GAS `OPENAI_COOLDOWN_UNTIL_MS`). */
let cooldownUntilMs = 0;

function isOpenAiCooldownActive() {
  return Date.now() < cooldownUntilMs;
}

/**
 * @param {number} retryAfterSec — from Retry-After header or default
 */
function extendOpenAiCooldown(retryAfterSec) {
  const sec = Math.min(Math.max(Number(retryAfterSec) || 60, 5), 600);
  cooldownUntilMs = Math.max(cooldownUntilMs, Date.now() + sec * 1000);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryableStatus(status) {
  return (
    status === 429 ||
    status === 503 ||
    status === 500 ||
    status === 408
  );
}

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {object} o.body — full chat/completions JSON body
 * @param {number} [o.timeoutMs]
 * @param {number} [o.maxRetries=2]
 * @returns {Promise<{ ok: boolean, status: number, data: object|null, err?: string }>}
 */
async function openaiChatCompletionsWithRetry(o) {
  const apiKey = String(o.apiKey || "").trim();
  if (!apiKey) return { ok: false, status: 0, data: null, err: "no_key" };

  if (isOpenAiCooldownActive()) {
    return { ok: false, status: 429, data: null, err: "cooldown" };
  }

  const timeoutMs = o.timeoutMs != null ? Number(o.timeoutMs) : 22000;
  const maxRetries =
    o.maxRetries != null && isFinite(Number(o.maxRetries))
      ? Math.min(5, Math.max(0, Number(o.maxRetries)))
      : 2;

  let attempt = 0;
  while (attempt <= maxRetries) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(OPENAI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify(o.body),
        signal: ctrl.signal,
      });
      clearTimeout(t);

      const data = await res.json().catch(() => null);
      const status = res.status;

      if (status === 429) {
        const ra = res.headers.get("retry-after");
        extendOpenAiCooldown(ra ? parseInt(ra, 10) : 90);
      }

      if (res.ok && data) {
        return { ok: true, status, data };
      }

      if (retryableStatus(status) && attempt < maxRetries) {
        await sleep(400 * Math.pow(2, attempt));
        attempt++;
        continue;
      }

      const errMsg =
        data && data.error && data.error.message
          ? String(data.error.message)
          : String(status);
      return { ok: false, status, data, err: errMsg };
    } catch (e) {
      clearTimeout(t);
      const name = e && e.name;
      const retryable =
        name === "AbortError" ||
        (e && String(e.message || "").indexOf("fetch") >= 0);
      if (retryable && attempt < maxRetries) {
        await sleep(400 * Math.pow(2, attempt));
        attempt++;
        continue;
      }
      return {
        ok: false,
        status: 0,
        data: null,
        err: String(e && e.message ? e.message : e),
      };
    }
  }

  return { ok: false, status: 0, data: null, err: "retry_exhausted" };
}

/**
 * Vision OCR — same prompt contract as legacy `enrichTelegramMediaWithOcr`.
 * @param {string} dataUrl — data:image/...;base64,...
 * @param {{ apiKey: string, model: string, timeoutMs?: number, maxRetries?: number }} o
 */
async function openaiVisionOcrFromDataUrl(dataUrl, o) {
  const apiKey = String(o.apiKey || "").trim();
  const model = String(o.model || "gpt-4o-mini").trim();
  if (!apiKey || !dataUrl) return "";

  const r = await openaiChatCompletionsWithRetry({
    apiKey,
    timeoutMs: o.timeoutMs != null ? o.timeoutMs : 18000,
    maxRetries: o.maxRetries != null ? o.maxRetries : 2,
    body: {
      model,
      messages: [
        {
          role: "system",
          content:
            "Extract only legible maintenance-relevant text from this image. Return plain text only.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract text from this screenshot/photo.",
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0,
    },
  });

  if (!r.ok || !r.data) return "";
  const content =
    r.data.choices &&
    r.data.choices[0] &&
    r.data.choices[0].message &&
    r.data.choices[0].message.content;
  return String(content || "").trim();
}

function getCooldownUntilMs() {
  return cooldownUntilMs;
}

module.exports = {
  openaiChatCompletionsWithRetry,
  openaiVisionOcrFromDataUrl,
  isOpenAiCooldownActive,
  getCooldownUntilMs,
  extendOpenAiCooldown,
};
