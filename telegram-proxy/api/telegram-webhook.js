/**
 * Propera Telegram Ingress Proxy — Phase 1
 *
 * Transport-only: accept POST, forward raw body to Apps Script, then respond.
 * Telegram only gets 200 after GAS returns success (so Telegram can retry on failure).
 * No business logic. Transport logs only.
 *
 * Env: PROPERA_TELEGRAM_FORWARD_URL (required), PROPERA_PROXY_SECRET (optional)
 */

/** Max time to wait for GAS before aborting (Telegram + proxy stay responsive). */
var GAS_FORWARD_TIMEOUT_MS = 20000;

function generateRequestId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "proxy-" + Date.now() + "-" + Math.random().toString(36).slice(2, 11);
}

function getRawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  return "";
}

export default async function handler(req, res) {
  const proxyRequestId = generateRequestId();

  console.log("received webhook", { proxyRequestId });

  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }

  const forwardUrl = process.env.PROPERA_TELEGRAM_FORWARD_URL;
  if (!forwardUrl || !forwardUrl.trim()) {
    console.log("forward failed", { proxyRequestId, error: "PROPERA_TELEGRAM_FORWARD_URL not set" });
    res.status(500).json({ ok: false });
    return;
  }

  const secret = process.env.PROPERA_PROXY_SECRET;
  if (secret && secret.trim()) {
    const got = req.headers["x-webhook-secret"] || req.query?.secret || "";
    if (String(got).trim() !== secret.trim()) {
      console.log("secret mismatch", { proxyRequestId });
      res.status(403).json({ ok: false });
      return;
    }
  }

  const rawBody = getRawBody(req);
  if (!rawBody || !rawBody.trim()) {
    console.log("forward failed", { proxyRequestId, error: "empty body" });
    res.status(400).json({ ok: false });
    return;
  }

  const url = forwardUrl.trim();
  const headers = {
    "Content-Type": "application/json",
    "X-Propera-Proxy-Id": proxyRequestId,
  };

  console.log("forward started", { proxyRequestId });

  const controller = new AbortController();
  const timeout = setTimeout(function () {
    controller.abort();
  }, GAS_FORWARD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: rawBody,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      var respText = "";
      try {
        respText = await response.text();
      } catch (_) {}
      console.log("forward failed", {
        proxyRequestId: proxyRequestId,
        status: response.status,
        body: respText.slice(0, 500),
      });
      res.status(502).json({ ok: false });
      return;
    }

    console.log("forward success", { proxyRequestId: proxyRequestId, status: response.status });
    res.status(200).json({ ok: true });
  } catch (err) {
    clearTimeout(timeout);
    console.log("forward failed", {
      proxyRequestId: proxyRequestId,
      error: err && err.message ? err.message : String(err),
    });
    res.status(502).json({ ok: false });
  }
}
