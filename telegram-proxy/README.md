# Propera Telegram Ingress Proxy (Phase 1)

Minimal HTTPS proxy for Telegram webhooks. Returns 200 to Telegram immediately, forwards raw JSON to Propera Apps Script. Transport-only; no business logic.

## Architecture

```
Telegram  →  POST /api/telegram-webhook  →  200 + {"ok":true}
Proxy     →  POST body to PROPERA_TELEGRAM_FORWARD_URL  (async)
```

## Deploy on Vercel

1. **Install Vercel CLI** (optional): `npm i -g vercel`

2. **Set environment variables** in [Vercel Dashboard](https://vercel.com) → Project → Settings → Environment Variables:
   - `PROPERA_TELEGRAM_FORWARD_URL` — your Apps Script Web App URL (e.g. `https://script.google.com/macros/s/.../exec`)
   - `PROPERA_PROXY_SECRET` (optional) — if set, requests must send this in header `X-Webhook-Secret` or query `?secret=...`

3. **Deploy:**
   ```bash
   cd telegram-proxy
   vercel
   ```
   Or connect the repo in Vercel and deploy from Git.

4. **Webhook URL for Telegram:**  
   `https://<your-vercel-app>.vercel.app/api/telegram-webhook`  
   (or with custom domain if configured)

## Transport logs

- `received webhook` — request arrived (with proxyRequestId)
- `acked Telegram` — 200 sent to Telegram
- `forward started` — forward to Apps Script started
- `forward success` / `forward failed` — outcome (no retries in proxy)

Optional: forward includes header `X-Propera-Proxy-Id` so you can correlate proxy → Apps Script in logs.

## Phase 2

Point Telegram at this URL via `setWebhook` with `drop_pending_updates=true`, then send a fresh message and verify one proxy hit and one Propera intake.
