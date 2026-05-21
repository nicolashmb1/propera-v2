const crypto = require("crypto");
const { accessCredentialSecret } = require("../config/env");

const PREFIX = "v1:";

/**
 * @param {string} pin
 * @returns {string}
 */
function encryptCredentialValue(pin) {
  const plain = String(pin || "").trim();
  const secret = accessCredentialSecret();
  if (!secret) {
    return `${PREFIX}b64:${Buffer.from(plain, "utf8").toString("base64url")}`;
  }
  const key = crypto.scryptSync(secret, "propera-access-v1", 32);
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
function decryptCredentialValue(stored) {
  const raw = String(stored || "");
  if (!raw.startsWith(PREFIX)) return raw;
  if (raw.startsWith(`${PREFIX}b64:`)) {
    return Buffer.from(raw.slice(`${PREFIX}b64:`.length), "base64url").toString("utf8");
  }
  if (!raw.startsWith(`${PREFIX}gcm:`)) return "";
  const secret = accessCredentialSecret();
  if (!secret) return "";
  const parts = raw.slice(`${PREFIX}gcm:`.length).split(":");
  if (parts.length !== 3) return "";
  const [ivB, tagB, encB] = parts;
  const key = crypto.scryptSync(secret, "propera-access-v1", 32);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB, "base64url")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

/**
 * @returns {string} 4-digit PIN for noop pilot
 */
function generatePin() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

module.exports = {
  encryptCredentialValue,
  decryptCredentialValue,
  generatePin,
};
