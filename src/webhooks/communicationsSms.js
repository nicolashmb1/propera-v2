const express = require("express");
const { communicationEngineEnabled } = require("../config/env");
const { handleBroadcastReply } = require("../communication/replyHandler");
const { handleDeliveryCallback } = require("../communication/deliveryTracker");

function registerCommunicationsWebhooks(app) {
  const twilioForm = express.urlencoded({ extended: true });

  function gate(handler) {
    return async (req, res) => {
      if (!communicationEngineEnabled()) {
        return res.status(404).json({ ok: false, error: "communication_engine_disabled" });
      }
      try {
        return await handler(req, res);
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    };
  }

  app.post(
    "/webhooks/communications/sms",
    twilioForm,
    gate(async (req, res) => {
      const out = await handleBroadcastReply(req.body || {}, { traceId: req.traceId });
      if (!out.ok) {
        return res.status(400).type("text/xml").send("<Response></Response>");
      }
      return res.status(200).type("text/xml").send("<Response></Response>");
    })
  );

  app.post(
    "/webhooks/communications/status",
    twilioForm,
    gate(async (req, res) => {
      const out = await handleDeliveryCallback(req.body || {}, { traceId: req.traceId });
      if (!out.ok && out.error !== "recipient_not_found") {
        return res.status(400).json({ ok: false, error: out.error || "delivery_callback_failed" });
      }
      return res.status(200).json({ ok: true });
    })
  );
}

module.exports = { registerCommunicationsWebhooks };
