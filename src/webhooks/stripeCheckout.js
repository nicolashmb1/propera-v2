const express = require("express");
const { verifyAndHandleStripeWebhook } = require("../tenant/stripeWebhookService");

/**
 * Register Stripe webhook before JSON body parser (raw body required for signature).
 * @param {import('express').Express} app
 */
function registerStripeWebhooks(app) {
  app.post(
    "/webhooks/stripe/:propertyCode",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      try {
        const signature = String(req.headers["stripe-signature"] || "");
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
        const out = await verifyAndHandleStripeWebhook(
          req.params.propertyCode,
          rawBody,
          signature,
          req.traceId
        );
        if (!out.ok) {
          return res.status(out.status || 400).json({ ok: false, error: out.error });
        }
        return res.json({ ok: true, ...out });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err?.message || err) });
      }
    }
  );
}

module.exports = { registerStripeWebhooks };
