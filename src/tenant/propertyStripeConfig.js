const { decryptStripeSecret, encryptStripeSecret, maskStripeSecret } = require("./stripeCrypto");

const PAYMENT_STRIPE_COLS =
  "code, stripe_secret_key_enc, stripe_webhook_secret_enc, tenant_pays_stripe_fees";

/**
 * @param {Record<string, unknown>} row
 */
function propertyStripeCheckoutEnabled(row) {
  return !!String(row?.stripe_secret_key_enc || "").trim();
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function getPropertyStripeSecretKey(row) {
  return decryptStripeSecret(String(row?.stripe_secret_key_enc || ""));
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function getPropertyStripeWebhookSecret(row) {
  return decryptStripeSecret(String(row?.stripe_webhook_secret_enc || ""));
}

/**
 * @param {Record<string, unknown>} row
 */
function mapPropertyStripeSettings(row) {
  const secret = getPropertyStripeSecretKey(row);
  const webhook = getPropertyStripeWebhookSecret(row);
  return {
    stripeCheckoutEnabled: propertyStripeCheckoutEnabled(row),
    stripeSecretKeyMasked: secret ? maskStripeSecret(secret) : "",
    stripeWebhookSecretConfigured: !!webhook,
  };
}

/**
 * @param {Record<string, unknown>} patch
 * @param {Record<string, unknown>} updates
 */
function applyStripeSecretPatches(patch, updates) {
  const sk = patch.stripeSecretKey ?? patch.stripe_secret_key;
  if (sk != null && String(sk).trim()) {
    updates.stripe_secret_key_enc = encryptStripeSecret(String(sk).trim());
  }
  const wh = patch.stripeWebhookSecret ?? patch.stripe_webhook_secret;
  if (wh != null && String(wh).trim()) {
    updates.stripe_webhook_secret_enc = encryptStripeSecret(String(wh).trim());
  }
}

module.exports = {
  PAYMENT_STRIPE_COLS,
  propertyStripeCheckoutEnabled,
  getPropertyStripeSecretKey,
  getPropertyStripeWebhookSecret,
  mapPropertyStripeSettings,
  applyStripeSecretPatches,
};
