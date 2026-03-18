/**
 * Propera Telegram Ingress Proxy — Phase 1
 *
 * Transport-only: accept POST, return 200 immediately, forward raw body to Apps Script.
 * No business logic. Transport logs only.
 *
 * Env: PROPERA_TELEGRAM_FORWARD_URL (required), PROPERA_PROXY_SECRET (optional)
 */

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

  // Transport log: received
  console.log("received webhook", { proxyRequestId });

  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }

  const forwardUrl = process.env.PROPERA_TELEGRAM_FORWARD_URL;
  if (!forwardUrl || !forwardUrl.trim()) {
    console.log("forward failed", { proxyRequestId, error: "PROPERA_TELEGRAM_FORWARD_URL not set" });
    res.status(200).json({ ok: true });
    return;
  }

  const secret = process.env.PROPERA_PROXY_SECRET;
  if (secret && secret.trim()) {
    const got = req.headers["x-webhook-secret"] || req.query?.secret || "";
    if (got.trim() !== secret.trim()) {
      console.log("acked Telegram (secret mismatch)", { proxyRequestId });
      res.status(200).json({ ok: true });
      return;
    }
  }

  const rawBody = getRawBody(req);
  if (!rawBody || !rawBody.trim()) {
    console.log("acked Telegram (no body)", { proxyRequestId });
    res.status(200).json({ ok: true });
    return;
  }

  // Ack Telegram immediately
  console.log("acked Telegram", { proxyRequestId });
  res.status(200).json({ ok: true });

  // Fire-and-forget forward (do not await; response already sent)
  const url = forwardUrl.trim();
  const headers = {
    "Content-Type": "application/json",
    "X-Propera-Proxy-Id": proxyRequestId,
  };

  (async () => {
    console.log("forward started", { proxyRequestId });
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: rawBody,
      });
      if (response.ok) {
        console.log("forward success", { proxyRequestId, status: response.status });
      } else {
        console.log("forward failed", { proxyRequestId, status: response.status });
      }
    } catch (err) {
      console.log("forward failed", { proxyRequestId, error: err && err.message ? err.message : String(err) });
    }
  })();
}
