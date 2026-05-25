/**
 * Skip duplicate tenant copy-paste resends during gather (Telegram has no body dedupe).
 */
const { parseMediaJson } = require("../../brain/shared/mediaPayload");

const DUPLICATE_WINDOW_MS = 120000;

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeInboundBodyForDedup(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * @param {string} bodyText
 * @param {string} mediaJson
 * @returns {string}
 */
function inboundTurnFingerprint(bodyText, mediaJson) {
  const text = normalizeInboundBodyForDedup(bodyText);
  const mediaCount = parseMediaJson(mediaJson).length;
  return `${text}|m:${mediaCount}`;
}

/**
 * @param {object | null | undefined} conv
 * @param {string} bodyText
 * @param {string} mediaJson
 * @returns {boolean}
 */
function isDuplicateGatherInbound(conv, bodyText, mediaJson) {
  const cur = normalizeInboundBodyForDedup(bodyText);
  const hasMedia = parseMediaJson(mediaJson).length > 0;
  if (!cur && !hasMedia) return false;

  const partial = conv && conv.partial_package ? conv.partial_package : {};
  const fp = inboundTurnFingerprint(bodyText, mediaJson);
  const priorFp = String(partial._last_inbound_fingerprint || "").trim();
  const priorAt = partial._last_inbound_at
    ? new Date(String(partial._last_inbound_at)).getTime()
    : NaN;

  if (
    priorFp &&
    priorFp === fp &&
    isFinite(priorAt) &&
    Date.now() - priorAt < DUPLICATE_WINDOW_MS
  ) {
    return true;
  }

  const messages = Array.isArray(conv && conv.messages) ? conv.messages : [];
  let lastUser = "";
  let lastRole = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    lastRole = m.role === "assistant" ? "assistant" : "user";
    if (m.role === "user") {
      lastUser = normalizeInboundBodyForDedup(m.content);
      break;
    }
  }

  if (!cur || !lastUser || cur !== lastUser) return false;
  if (cur.length >= 40) return true;
  return lastRole === "user";
}

/**
 * @param {object} partial
 * @param {string} bodyText
 * @param {string} mediaJson
 * @returns {object}
 */
function stampInboundTurnFingerprint(partial, bodyText, mediaJson) {
  const pkg = { ...(partial || {}) };
  pkg._last_inbound_fingerprint = inboundTurnFingerprint(bodyText, mediaJson);
  pkg._last_inbound_at = new Date().toISOString();
  return pkg;
}

module.exports = {
  normalizeInboundBodyForDedup,
  inboundTurnFingerprint,
  isDuplicateGatherInbound,
  stampInboundTurnFingerprint,
  DUPLICATE_WINDOW_MS,
};
