/**
 * Lightweight locale detection for tenant free text (portal maintenance).
 * Heuristic only — no LLM. @see docs/TENANT_PORTAL_I18N.md
 */

const SPANISH_CHARS = /[ñáéíóúü¿¡]/i;

/** High-signal Spanish tokens (maintenance + function words). */
const SPANISH_WORDS = new Set([
  "el", "la", "los", "las", "un", "una", "de", "del", "al", "en", "y", "o", "no", "hay", "esta",
  "este", "está", "estan", "están", "son", "es", "por", "para", "con", "sin", "que", "mi", "su",
  "agua", "fuga", "gotea", "goteando", "roto", "rota", "funciona", "funcionan", "grifo", "baño",
  "bano", "cocina", "nevera", "refrigerador", "calefaccion", "calefacción", "aire", "ascensor",
  "puerta", "cerradura", "luz", "luces", "electricidad", "plomeria", "plomería", "humedad",
  "moho", "filtracion", "filtración", "techo", "ventana", "apartamento", "piso", "unidad",
  "emergencia", "urgente", "problema", "arreglar", "reparar", "mantenimiento", "desde", "ayer",
  "hoy", "manana", "mañana", "necesito", "tenemos", "tiene",
]);

/** Obvious English maintenance tokens. */
const ENGLISH_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "my", "our", "not", "no", "water", "leak",
  "leaking", "broken", "fix", "repair", "kitchen", "bathroom", "toilet", "sink", "faucet",
  "heater", "heat", "ac", "hvac", "elevator", "door", "lock", "light", "lights", "power",
  "outlet", "ceiling", "window", "unit", "apartment", "emergency", "urgent", "issue",
  "problem", "since", "today", "yesterday", "need", "working", "work", "doesnt", "don't",
]);

/**
 * @param {string} text
 * @returns {"en"|"es"|"unknown"}
 */
function detectLanguage(text) {
  const raw = String(text || "").trim();
  if (raw.length < 4) return "unknown";

  const lower = raw.toLowerCase();
  const tokens = lower
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (!tokens.length) return "unknown";

  let esHits = 0;
  let enHits = 0;
  for (const tok of tokens) {
    if (SPANISH_WORDS.has(tok)) esHits += 1;
    if (ENGLISH_WORDS.has(tok)) enHits += 1;
  }

  if (SPANISH_CHARS.test(raw)) esHits += Math.max(2, Math.ceil(tokens.length * 0.35));

  const esRatio = esHits / tokens.length;
  const enRatio = enHits / tokens.length;

  if (esRatio >= 0.2 && esRatio > enRatio) return "es";
  if (enRatio >= 0.15 && enRatio >= esRatio) return "en";
  if (SPANISH_CHARS.test(raw)) return "es";
  if (esHits > 0 && enHits === 0) return "es";
  if (enHits > 0 && esHits === 0) return "en";

  return "unknown";
}

/**
 * Profile + detect per TENANT_PORTAL_I18N.md.
 * @param {"en"|"es"|"unknown"} detected
 * @param {"en"|"es"} uiLocale
 * @returns {"en"|"es"}
 */
function resolveEffectiveContentLocale(detected, uiLocale) {
  const ui = uiLocale === "es" ? "es" : "en";
  if (detected === "es" || detected === "en") return detected;
  return ui;
}

module.exports = {
  detectLanguage,
  resolveEffectiveContentLocale,
};
