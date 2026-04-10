# Propera V2 (parallel runtime)

This folder is the **new** Propera server. **Production today** is still Google Apps Script + Sheets — nothing here replaces that until you deliberately cut over.

**Agents / Cursor:** start with **[AGENTS.md](./AGENTS.md)** — mandatory doc order, freeze stance, parity ledger pointer, commands. **Do not “continue V2” without reading it.**

## What you do **inside Cursor** (this repo)

- Edit Node code under `src/`.
- Run the server locally (see below).
- Commit `propera-v2/` to git when you are happy.
- **Keep docs current:** when behavior or migrations change, update **[docs/BRAIN_PORT_MAP.md](docs/BRAIN_PORT_MAP.md)** and **[docs/PROPERA_V2_GAS_EXIT_PLAN.md](docs/PROPERA_V2_GAS_EXIT_PLAN.md)** (and **[docs/OUTSIDE_CURSOR.md](docs/OUTSIDE_CURSOR.md)** if operators need new SQL/env steps). Logging / flight-recorder parity: **[docs/STRUCTURED_LOGS.md](docs/STRUCTURED_LOGS.md)**.

## What you do **outside Cursor** (browser only)

**[docs/OUTSIDE_CURSOR.md](docs/OUTSIDE_CURSOR.md)** — Supabase signup, copy API keys, run SQL in dashboard. No terminal instructions there; the rest is in-repo.

**Sheets → Postgres (draft):** **[docs/SHEETS_TO_POSTGRES.md](docs/SHEETS_TO_POSTGRES.md)**

**Structured logs (one JSON line per event — for Cursor / LLM debug):** **[docs/STRUCTURED_LOGS.md](docs/STRUCTURED_LOGS.md)**

**Supabase + GitHub (commit migrations, push from Cursor):** **[docs/SUPABASE_AND_GITHUB.md](docs/SUPABASE_AND_GITHUB.md)**

## Ports (don’t clash with the portal)

| App | Default port | Notes |
|-----|----------------|--------|
| **propera-app** (Next.js) | **3000** | Keep this for the staff portal UI. |
| **propera-v2** (this server) | **8080** | API / webhooks during local dev — different port on purpose. |

If you need to move V2 only, use e.g. `8081` in `.env` — **do not use 3000** for V2 while the portal is running.

## Run locally (first success check)

```bash
cd propera-v2
npm install
npm start
```

Use **`npm run dev`** for **`node --watch`** (restarts the process when you save files). **`npm start`** does not auto-reload.

Open **http://localhost:8080/health** — you should see JSON with `"ok": true`.

Copy `.env.example` to `.env` if you want to change `PORT` (default **8080**).

**Brain port (GAS → Node):** see **[docs/BRAIN_PORT_MAP.md](docs/BRAIN_PORT_MAP.md)**. **Do not rewrite business rules** — port from GAS per **[docs/PORTING_FROM_GAS.md](docs/PORTING_FROM_GAS.md)**. Run **`npm test`** for router precursor parity tests. **Scenario / intake testing plan:** **[docs/TESTING_STRATEGY.md](docs/TESTING_STRATEGY.md)**.

### Port already in use (`EADDRINUSE`)

Something else is using **8080** (often a previous `node` you forgot to stop).

1. **Quick switch:** create `.env` with `PORT=8081` (or another free port — **not 3000** if `propera-app` is running) and run `npm start` again.
2. **Free 8080 on Windows (PowerShell):**  
   `netstat -ano | findstr :8080` — note the **PID** in the last column, then if it is `node.exe`:  
   `taskkill /PID <that_number> /F`

## Phase 0 scope

- Express app with `GET /` and `GET /health`.
- Dockerfile for later Cloud Run deploy.
- No database yet; no Twilio yet.

**Identity (dev):** After running `supabase/migrations/003_identity.sql`, try  
`GET /api/dev/resolve-actor?phone=+19085550101` — expects **STAFF** for the seeded dev contact (edit seed SQL to match your real test phone).

**Telegram on V2:** `POST /webhooks/telegram` — validates optional `TELEGRAM_WEBHOOK_SECRET`, normalizes to **InboundSignal**, upserts **`telegram_chat_link`** (run migration `005_telegram_chat_link.sql`), then **router precursors + lane** (`docs/BRAIN_PORT_MAP.md`). With **`CORE_ENABLED=1`** and DB + migration **006**, **`handleInboundCore`** can create **tickets** / **work_items** (maintenance slice). Optional **`TELEGRAM_OUTBOUND_ENABLED=1`** + **`TELEGRAM_BOT_TOKEN`** sends replies in chat (transport only).

**Moving the bot webhook from GAS to V2 (one bot = one webhook):**

1. Deploy or expose V2 over **HTTPS** (ngrok for dev, Cloud Run etc. for prod).
2. In `.env`: `TELEGRAM_BOT_TOKEN`, optional `TELEGRAM_WEBHOOK_SECRET` (match Telegram `secret_token`), optional `TELEGRAM_OUTBOUND_ENABLED=1`.
3. Call Telegram `setWebhook` with your **V2** URL ending in `/webhooks/telegram`. That **replaces** the previous webhook (GAS stops receiving updates for that bot).
4. Run **`005_telegram_chat_link.sql`** in Supabase if you want chat rows persisted.

GAS stays production for channels you have not cut over; full brain parity is incremental — see **BRAIN_PORT_MAP.md**.
