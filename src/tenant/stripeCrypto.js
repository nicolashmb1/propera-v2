const crypto = require("crypto");
const { stripeCredentialSecret } = require("../config/env");

const PREFIX = "v1:";

function deriveKey() {
  const secret = stripeCredentialSecret();
  if (!secret) return null;
  return crypto.scryptSync(secret, "propera-stripe-v1", 32);
}

/**
 * @param {string} value
 * @returns {string}
 */
function encryptStripeSecret(value) {
  const plain = String(value || "").trim();
  if (!plain) return "";
  const key = deriveKey();
  if (!key) {
    return `${PREFIX}b64:${Buffer.from(plain, "utf8").toString("base64url")}`;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}gcm:${iv.toString("base64url")}:${tag.toString("base64url")}:${enc.toString("base64url")}`;
}

/**
 * @param {string} stored
 * @returns {string}
 */
function decryptStripeSecret(stored) {
  const raw = String(stored || "");
  if (!raw) return "";
  if (!raw.startsWith(PREFIX)) return raw;
  if (raw.startsWith(`${PREFIX}b64:`)) {
    return Buffer.from(raw.slice(`${PREFIX}b64:`.length), "base64url").toString("utf8");
  }
  if (!raw.startsWith(`${PREFIX}gcm:`)) return "";
  const key = deriveKey();
  if (!key) return "";
  const parts = raw.slice(`${PREFIX}gcm:`.length).split(":");
  if (parts.length !== 3) return "";
  const [ivB, tagB, encB] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB, "base64url")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

/**
 * @param {string} secretKey
 * @returns {string}
 */
function maskStripeSecret(secretKey) {
  const s = String(secretKey || "").trim();
  if (!s) return "";
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 7)}…${s.slice(-4)}`;
}

module.exports = {
  encryptStripeSecret,
  decryptStripeSecret,
  maskStripeSecret,
};
