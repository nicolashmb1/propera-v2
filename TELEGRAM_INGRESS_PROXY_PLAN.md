# Telegram Ingress Proxy — Minimal Plan

**Goal:** Terminate the Telegram webhook on an HTTPS endpoint that does not redirect, then forward the raw POST body to the existing Propera Apps Script Web App. No changes to shared brain or adapter logic.

---

## 1. Why a proxy

- **Telegram** calls one URL. It must get a fast **200** with a valid response (e.g. JSON) or it retries.
- **Apps Script** can be slow or flaky under load; a proxy can:
  - Return **200 OK** immediately to Telegram (stop retries), then forward to Apps Script in the background, or
  - Forward synchronously and return the Apps Script response to Telegram (simplest; Telegram gets 200 when Apps Script returns 200).
- The proxy is **transport-only**: no parsing of `update_id` or message content, no business logic.

---

## 2. Contract

| Layer        | Responsibility |
|-------------|----------------|
| **Telegram** | POST to proxy URL. Body: JSON (`update_id`, `message` / `edited_message` / `callback_query`). Content-Type: `application/json`. |
| **Proxy**    | Accept POST on a fixed path. Read raw body. POST same body to Propera Web App URL. Optionally return 200 immediately or return Apps Script response. |
| **Propera**  | Unchanged. `doPost(e)` receives a POST with `e.postData.contents` = same JSON. Existing Telegram detection and fast-ack/adapter behavior apply. |

---

## 2.1 Final ingress architecture (lock this shape)

This is the correct ingress architecture for Telegram (and the same pattern can be reused for future channels):

```text
Telegram        →  Proxy           →  200 immediately
Proxy           →  forward raw JSON to Apps Script
Apps Script     →  existing Telegram detection / dedupe / queue
Queue processor →  shared brain
```

- One shared brain; Telegram stays transport-only; proxy stays at the transport edge.
- Future channels can use the same pattern (proxy → 200, forward to Apps Script, adapter dedupe/queue → brain).

---

## 3. Proxy requirements (minimal)

1. **HTTPS** — Telegram only allows HTTPS webhook URLs.
2. **No redirects** — Webhook URL must respond in place (200). No 301/302 to Apps Script (Telegram does not follow redirects for webhooks).
3. **POST in, POST out** — Proxy receives POST; forwards with:
   - **URL:** Propera Web App `doPost` URL (e.g. `https://script.google.com/macros/s/.../exec`).
   - **Method:** POST.
   - **Headers:** `Content-Type: application/json`.
   - **Body:** Raw request body (binary-safe), unchanged.
4. **Response to Telegram — use Option B (async):**
   - **Recommended:** Proxy returns **200** and `{"ok":true}` to Telegram **immediately**, then forwards the raw body to Apps Script in the background (fire-and-forget).
   - This removes Telegram timing pressure completely; Apps Script can be slow without triggering retries.
   - Propera already has dedupe (TelegramAccepted) and queue; no change needed there.
   - **Option A (sync)** is possible but not recommended: Telegram may retry if Apps Script is slow.

**Best shape:**  
`Telegram → Proxy → 200 immediately`  
`Proxy → forward raw JSON to Apps Script` (async)

---

## 4. What the proxy may and must not do

**Allowed — minimal transport validation only:**
- Request is POST.
- Content-Type is application/json (or body looks like JSON).
- Optional: secret/header match (e.g. query param or `X-Webhook-Secret`) to lock the endpoint.

**Forbidden — proxy remains transport-only:**
- No parsing for business logic (no `update_id` interpretation, no message content).
- No routing logic, no state decisions.
- No changing request body or adding query params (so that `doPost` sees the same shape and Telegram detection still works).
- No retries or queueing inside the proxy (unless you explicitly want a second queue; not required for minimal).

---

## 5. What stays unchanged in Propera

- **doPost(e)** — Already detects Telegram by body shape and calls `telegramWebhook_(e)`. No change.
- **telegramWebhook_(e)** — Already fast-ack: dedupe, enqueue, return 200 JSON. No change.
- **processTelegramQueue_** — Already runs shared brain path. No change.
- **Shared brain / resolver / lifecycle** — No change.

Only the **first hop** changes: Telegram → Proxy → Apps Script instead of Telegram → Apps Script.

---

## 6. Best minimal production path

- **Vercel serverless function** (or equivalent).
- **One route:** e.g. `POST /telegram-webhook`.
- **Behavior:**
  1. Immediate **200** and `{"ok":true}` to Telegram.
  2. Fire-and-forget forward of raw body to Apps Script Web App URL (POST, `Content-Type: application/json`).
  3. Log only **transport** success/failure (e.g. “forward started”, “forward failed: …”); no business logging.

```text
Telegram webhook URL:  https://your-proxy.vercel.app/telegram-webhook
Propera Web App URL:  https://script.google.com/macros/s/SCRIPT_ID/exec

On POST /telegram-webhook:
  1. (Optional) Validate: method is POST, content-type is JSON, optional secret.
  2. Return 200 and {"ok":true} to Telegram immediately.
  3. Forward raw body to Propera URL (async); do not await for response to Telegram.
  4. Log transport outcome only.
```

Other options: Netlify, Cloud Run, Cloud Function, or a small Node server — same contract.

---

## 6.1 Implementation rules

**1. Keep the forward target in config (no hardcoding)**  
- Do not hardcode the Apps Script URL inside handler logic.  
- Use one env variable, e.g. **`PROPERA_TELEGRAM_FORWARD_URL`** (the Web App `exec` URL).  
- Optional: **`PROPERA_PROXY_SECRET`** for validating webhook calls (query param or header).  
- Makes cutover and rollback easy (change env, redeploy).

**2. Proxy request id (transport tracing only)**  
- Proxy generates a **proxyRequestId** (e.g. UUID) per request.  
- Log it locally (e.g. “received webhook proxyRequestId=…”).  
- Optionally send header **`X-Propera-Proxy-Id`** on the forward to Apps Script.  
- Use only for tracing: Telegram hit → proxy forward → Apps Script arrival. No business logic.

---

## 6.2 Operational caution (async fire-and-forget)

Because the proxy returns 200 to Telegram before the forward completes, **do not swallow forward failures silently**.

- No retries required in the proxy, but **do** log transport outcomes, e.g.:
  - **received webhook** (with proxyRequestId)
  - **acked Telegram** (200 sent)
  - **forward started**
  - **forward success** / **forward failed** (with error or status)
- Transport logs only. Nothing operational (no update_id, no message content, no routing).

---

## 7. Security (optional)

- **Secret in URL or header** — If you want to lock the proxy URL, add a query param or header (e.g. `X-Webhook-Secret`) and validate it in the proxy; do not change body. Apps Script can also validate a secret if you send it in the body or header.
- **IP allowlist** — Optional: restrict proxy to Telegram’s IP ranges if your host supports it.

---

## 8. Cutover when switching to the proxy

When you point Telegram at the proxy URL:

1. **Set Telegram webhook** to the proxy URL (e.g. `setWebhook` to `https://your-proxy.vercel.app/telegram-webhook`).
2. **Use `drop_pending_updates=true`** so Telegram does not replay old updates.
3. **Send a fresh Telegram message** after cutover.

Otherwise Telegram may keep trying to deliver the same stale `update_id` from its queue.

---

## 9. Phased rollout

| Phase | Action |
|-------|--------|
| **1** | Build the proxy only (env: `PROPERA_TELEGRAM_FORWARD_URL`, optional `PROPERA_PROXY_SECRET`; transport logs; optional `X-Propera-Proxy-Id`). |
| **2** | Point Telegram webhook to proxy URL with **`drop_pending_updates=true`**. |
| **3** | Send a fresh message and verify: one proxy hit, one Propera intake, new `update_id`, no replay loop. |
| **4** | Only after ingress is stable, implement outbound Telegram send. |

---

## 10. Success criteria (verify after cutover)

- **New `update_id`** — each new message gets a new update.
- **One proxy hit** per message.
- **One Propera intake** per message (DebugLog: DOPOST_TOP → TELEGRAM_DETECTED → TELEGRAM_ACCEPTED → TELEGRAM_ENQUEUED → TELEGRAM_RETURN_OK_FAST).
- **No repeated replay loop** — same update is not retried by Telegram.

---

## Final direction

This plan is **Compass-aligned**, **low-risk**, **channel-neutral**, and **future-proof** without overbuilding. Use the locked shape in §2.1; follow the implementation rules and phased rollout; then add outbound only once ingress is stable.

*Minimal plan — no code in Propera; proxy is implemented outside the Apps Script project.*
