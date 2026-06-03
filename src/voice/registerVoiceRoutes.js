/**
 * Voice routes — Max (Twilio phone) + Jarvis (portal live voice).
 * POST /webhooks/twilio/voice — TwiML → Media Stream WebSocket
 * WS   /voice/stream         — Twilio ↔ OpenAI Realtime bridge
 * WS   /voice/jarvis         — Portal browser ↔ OpenAI Realtime (staff Jarvis)
 */
const {
  voiceEnabled,
  jarvisVoiceEnabled,
  properaPublicBaseUrl,
} = require("../config/env");
const { emit } = require("../logging/structuredLog");
const { verifyPortalWebSocketRequest } = require("./portalWsAuth");

function registerVoiceRoutes(app, httpServer) {
  const upgradeRoutes = [];

  if (voiceEnabled()) {
    const { createTwilioVoiceWss } = require("./voiceWebSocketBridge");
    const twilioWss = createTwilioVoiceWss();
    upgradeRoutes.push({
      path: "/voice/stream",
      wss: twilioWss,
      verify: null,
    });

    app.post("/webhooks/twilio/voice", expressUrlencoded(), (req, res) => {
      const body = req.body || {};
      const callerPhone = String(body.From || "").trim();
      const callSid = String(body.CallSid || "").trim();

      emit({
        level: "info",
        log_kind: "voice_webhook",
        event: "inbound_call",
        data: { from: callerPhone, callSid },
      });

      const baseUrl = properaPublicBaseUrl() || "";
      const wsBase = baseUrl
        ? baseUrl.replace(/^https?:\/\//, (m) => (m.startsWith("https") ? "wss://" : "ws://"))
        : "";
      const streamUrl = wsBase ? `${wsBase}/voice/stream` : "/voice/stream";

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="callerPhone" value="${escapeXml(callerPhone)}"/>
      <Parameter name="callSid" value="${escapeXml(callSid)}"/>
    </Stream>
  </Connect>
</Response>`;

      res.type("text/xml").send(twiml);
    });

    emit({
      level: "info",
      log_kind: "voice",
      event: "voice_routes_registered",
      data: { webhook: "/webhooks/twilio/voice", stream: "/voice/stream" },
    });
  } else {
    emit({
      level: "info",
      log_kind: "voice",
      event: "voice_disabled",
      data: { reason: "PROPERA_VOICE_ENABLED not set" },
    });
  }

  if (jarvisVoiceEnabled()) {
    const { createJarvisVoiceWss } = require("./jarvisVoiceWebSocketBridge");
    const jarvisWss = createJarvisVoiceWss();
    upgradeRoutes.push({
      path: "/voice/jarvis",
      wss: jarvisWss,
      verify: verifyPortalWebSocketRequest,
    });

    emit({
      level: "info",
      log_kind: "jarvis_voice",
      event: "jarvis_voice_registered",
      data: { stream: "/voice/jarvis" },
    });
  }

  if (upgradeRoutes.length && httpServer) {
    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url, "http://localhost");
      for (const route of upgradeRoutes) {
        if (url.pathname !== route.path) continue;
        if (route.verify && !route.verify(request)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        route.wss.handleUpgrade(request, socket, head, (ws) => {
          route.wss.emit("connection", ws, request);
        });
        return;
      }
    });
  }
}

function expressUrlencoded() {
  const express = require("express");
  return express.urlencoded({ extended: false });
}

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

module.exports = { registerVoiceRoutes };
