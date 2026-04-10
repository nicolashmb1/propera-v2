/**
 * Optional Telegram setWebhook secret (header X-Telegram-Bot-Api-Secret-Token).
 * @see https://core.telegram.org/bots/api#setwebhook
 */

const crypto = require("crypto");
const { telegramWebhookSecret } = require("../../config/env");

const HEADER = "x-telegram-bot-api-secret-token";

/**
 * @param {import('express').Request} req
 * @returns {boolean} true if request may proceed
 */
function verifyTelegramWebhookSecret(req) {
  const expected = telegramWebhookSecret();
  if (!expected) return true;

  const got = req.get(HEADER) || req.get(HEADER.toUpperCase()) || "";
  const a = Buffer.from(String(got), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyTelegramWebhookSecret, HEADER_TELEGRAM_SECRET: HEADER };
