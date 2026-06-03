/**
 * Tenant portal text translation (expression layer).
 * @see docs/TENANT_PORTAL_I18N.md
 */
const crypto = require("crypto");
const {
  tenantI18nEnabled,
  openaiApiKey,
  tenantTranslateModel,
} = require("../config/env");
const { openaiChatCompletionsWithRetry } = require("../integrations/openaiTransport");
const { emit } = require("../logging/structuredLog");
const { detectLanguage } = require("./detectTextLanguage");

const CACHE_MAX = 400;
const cache = new Map();

/** @type {typeof openaiChatCompletionsWithRetry | null} */
let chatCompletionsFn = null;

function getChatFn() {
  return chatCompletionsFn || openaiChatCompletionsWithRetry;
}

/** Test hook only */
function _setChatCompletionsFnForTest(fn) {
  chatCompletionsFn = fn;
}

function _clearTranslationCacheForTest() {
  cache.clear();
}

function cacheKey(text, sourceLocale, targetLocale) {
  const h = crypto
    .createHash("sha256")
    .update(`${sourceLocale}:${targetLocale}:${text}`)
    .digest("hex")
    .slice(0, 24);
  return h;
}

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function setCached(key, value) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, value);
}

function extractAssistantText(data) {
  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  return String(content || "").trim();
}

/**
 * @param {object} opts
 * @param {string} opts.text
 * @param {"es"} [opts.sourceLocale]
 * @param {string} [opts.traceId]
 * @param {number} [opts.traceStartMs]
 * @returns {Promise<{ ok: boolean, text: string, cached?: boolean, error?: string }>}
 */
async function translateToEnglish(opts) {
  const text = String(opts.text || "").trim();
  if (!text) return { ok: true, text: "" };

  if (!tenantI18nEnabled()) {
    return { ok: true, text, skipped: true };
  }

  const apiKey = openaiApiKey();
  if (!apiKey) {
    return { ok: false, text, error: "no_openai_key" };
  }

  const key = cacheKey(text, opts.sourceLocale || "es", "en");
  const cached = getCached(key);
  if (cached) {
    return { ok: true, text: cached, cached: true };
  }

  const model = tenantTranslateModel();
  const r = await getChatFn()({
    apiKey,
    timeoutMs: 12000,
    maxRetries: 1,
    body: {
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You translate resident maintenance messages to English for property staff. " +
            "Return ONLY the English translation. No quotes, labels, or explanation. " +
            "Preserve meaning, locations, unit numbers, urgency, and times.",
        },
        {
          role: "user",
          content: text,
        },
      ],
    },
  });

  if (!r.ok || !r.data) {
    emit({
      level: "warn",
      trace_id: opts.traceId || null,
      trace_start_ms: opts.traceStartMs,
      log_kind: "tenant_maintenance_create",
      event: "TENANT_I18N_TRANSLATE_FAILED",
      data: { target: "en", error: r.err || r.status, cached: false },
    });
    return { ok: false, text, error: r.err || "translate_failed" };
  }

  const out = extractAssistantText(r.data);
  if (!out) {
    return { ok: false, text, error: "empty_translation" };
  }

  setCached(key, out);
  emit({
    trace_id: opts.traceId || null,
    trace_start_ms: opts.traceStartMs,
    log_kind: "tenant_maintenance_create",
    event: "TENANT_I18N_TRANSLATED",
    data: { target: "en", source: opts.sourceLocale || "es", cached: false },
  });

  return { ok: true, text: out };
}

function displaySystemPrompt(targetLocale) {
  if (targetLocale === "es") {
    return (
      "You translate property management messages into Spanish for residents. " +
      "Return ONLY the Spanish translation. No quotes or explanation. " +
      "Preserve meaning, times, unit numbers, and urgency."
    );
  }
  return (
    "You translate text to English for property staff. " +
    "Return ONLY the English translation. No quotes or explanation."
  );
}

/**
 * Translate stored text for tenant portal display when UI locale differs from content.
 * @param {object} opts
 * @param {string} opts.text
 * @param {"en"|"es"} opts.targetLocale
 * @param {"en"|"es"} [opts.sourceLocale] — inferred via detect when omitted
 * @param {string} [opts.traceId]
 * @returns {Promise<{ ok: boolean, text: string, skipped?: boolean, cached?: boolean, error?: string }>}
 */
async function translateForDisplay(opts) {
  const text = String(opts.text || "").trim();
  const target = opts.targetLocale === "es" ? "es" : "en";
  if (!text || !tenantI18nEnabled()) {
    return { ok: true, text, skipped: true };
  }

  const detected = opts.sourceLocale || detectLanguage(text);
  const source =
    detected === "es" || detected === "en" ? detected : "en";

  if (source === target) {
    return { ok: true, text, skipped: true };
  }

  const apiKey = openaiApiKey();
  if (!apiKey) {
    return { ok: false, text, error: "no_openai_key" };
  }

  const key = cacheKey(text, source, target);
  const cached = getCached(key);
  if (cached) {
    return { ok: true, text: cached, cached: true };
  }

  const model = tenantTranslateModel();
  const r = await getChatFn()({
    apiKey,
    timeoutMs: 12000,
    maxRetries: 1,
    body: {
      model,
      temperature: 0,
      messages: [
        { role: "system", content: displaySystemPrompt(target) },
        { role: "user", content: text },
      ],
    },
  });

  if (!r.ok || !r.data) {
    emit({
      level: "warn",
      trace_id: opts.traceId || null,
      log_kind: "tenant_read",
      event: "TENANT_I18N_DISPLAY_FAILED",
      data: { source, target, error: r.err || r.status },
    });
    return { ok: false, text, error: r.err || "translate_failed" };
  }

  const out = extractAssistantText(r.data);
  if (!out) {
    return { ok: false, text, error: "empty_translation" };
  }

  setCached(key, out);
  return { ok: true, text: out };
}

module.exports = {
  translateToEnglish,
  translateForDisplay,
  _setChatCompletionsFnForTest,
  _clearTranslationCacheForTest,
};
