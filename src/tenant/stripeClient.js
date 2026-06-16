const Stripe = require("stripe");
const { getPropertyStripeSecretKey } = require("./propertyStripeConfig");

/**
 * @param {Record<string, unknown>} propRow
 * @returns {import('stripe').Stripe | null}
 */
function createStripeClientForProperty(propRow) {
  const secretKey = getPropertyStripeSecretKey(propRow);
  if (!secretKey) return null;
  return new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
}

/**
 * @param {import('express').Request} req
 */
function tenantPortalBaseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

module.exports = { createStripeClientForProperty, tenantPortalBaseUrl };
