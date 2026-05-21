/**
 * Signed short-lived tokens for medium-confidence expense capture confirm.
 * @see docs/FINANCIAL_INTAKE_V1.md
 */

const crypto = require("crypto");
const { portalApiToken } = require("../../config/env");

const TTL_MS = 10 * 60 * 1000;

function confirmSecret() {
  const t = portalApiToken();
  return t || "propera-expense-confirm-dev-only";
}

/**
 * @param {object} payload
 * @returns {string}
 */
function signExpenseConfirmPayload(payload) {
  const json = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", confirmSecret()).update(json).digest("hex");
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString("base64url");
}

/**
 * @param {string} token
 * @returns {object | null}
 */
function verifyExpenseConfirmToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  try {
    const j = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!j || typeof j !== "object" || !j.p || !j.s) return null;
    const json = JSON.stringify(j.p);
    const expected = crypto.createHmac("sha256", confirmSecret()).update(json).digest("hex");
    if (expected !== String(j.s)) return null;
    const exp = Number(j.p.exp);
    if (!Number.isFinite(exp) || Date.now() > exp) return null;
    return j.p;
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} proposal
 * @returns {string}
 */
function buildExpenseConfirmToken(proposal) {
  const payload = {
    ...proposal,
    exp: Date.now() + TTL_MS,
  };
  return signExpenseConfirmPayload(payload);
}

module.exports = {
  buildExpenseConfirmToken,
  verifyExpenseConfirmToken,
  TTL_MS,
};
