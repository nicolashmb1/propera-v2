/**
 * HS256 JWT for resident portal sessions (no external jwt dependency).
 */
const crypto = require("crypto");
const { tenantJwtSecret, tenantSessionDays } = require("../config/env");

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64url");
}

function b64urlDecode(str) {
  return JSON.parse(Buffer.from(str, "base64url").toString("utf8"));
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
function signTenantToken(payload) {
  const secret = tenantJwtSecret();
  if (!secret) throw new Error("TENANT_JWT_SECRET not configured");

  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + tenantSessionDays() * 86400,
  };
  const h = b64url(header);
  const p = b64url(body);
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest("base64url");
  return `${h}.${p}.${sig}`;
}

/**
 * @param {string} token
 * @returns {{ tenantId: string, unitId: string, propertyCode: string, orgId: string, phone: string, unitLabel: string, iat: number, exp: number }}
 */
function verifyTenantToken(token) {
  const secret = tenantJwtSecret();
  if (!secret) throw new Error("TENANT_JWT_SECRET not configured");

  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("invalid_token");

  const [h, p, sig] = parts;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error("invalid_signature");
  }

  const payload = b64urlDecode(p);
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw new Error("token_expired");

  return {
    tenantId: String(payload.tenantId || ""),
    unitId: String(payload.unitId || ""),
    propertyCode: String(payload.propertyCode || "").toUpperCase(),
    orgId: String(payload.orgId || ""),
    phone: String(payload.phone || ""),
    unitLabel: String(payload.unitLabel || "").trim(),
    iat: payload.iat,
    exp: payload.exp,
  };
}

module.exports = { signTenantToken, verifyTenantToken };
