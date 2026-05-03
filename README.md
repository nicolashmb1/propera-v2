# Propera V2 (parallel runtime)

This folder is the **Propera V2** server (Node + Supabase). **Staff portal and PM ticket flows default here** when `propera-app` is pointed at V2 (`/webhooks/portal`, gas-compat reads). **Google Apps Script + Sheets** remains **legacy backup** for slices you have not retired — not the default for new portal PM behavior.

**Agents / Cursor:** start with **[AGENTS.md](./AGENTS.md)** — mandatory doc order, freeze stance, parity ledger pointer, commands. **Do not “continue V2” without reading it.**

## What you do **inside Cursor** (this repo)

- Edit Node code under `src/`.
- Run the server locally (see below).
- Commit `propera-v2/` to git when you are happy.
- **Keep docs current:** when behavior or migrations change, update **[docs/BRAIN_PORT_MAP.md](docs/BRAIN_PORT_MAP.md)**, **[docs/PARITY_LEDGER.md](docs/PARITY_LEDGER.md)**, and **[docs/PROPERA_V2_GAS_EXIT_PLAN.md](docs/PROPERA_V2_GAS_EXIT_PLAN.md)** (and **[docs/OUTSIDE_CURSOR.md](docs/OUTSIDE_CURSOR.md)** if operators need new SQL/env steps). **Inbound routing (order, core guards, lane stubs):** **[docs/ORCHESTRATOR_ROUTING.md](docs/ORCHESTRATOR_ROUTING.md)**. **Portal preventive / program runs:** **[docs/PM_PROGRAM_ENGINE_V1.md](docs/PM_PROGRAM_ENGINE_V1.md)**. Logging / flight-recorder: **[docs/STRUCTURED_LOGS.md](docs/STRUCTURED_LOGS.md)**. **Recent session notes:** **[docs/HANDOFF_LOG.md](docs/HANDOFF_LOG.md)**.

## Adding a new channel

Use **[docs/ADAPTER_ONBOARDING.md](docs/ADAPTER_ONBOARDING.md)**.  
It defines the adapter-only boundary, required `InboundSignal`/`RouterParameter` contract, shared `_mediaJson` bridge, and docs/tests required before merge.

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

Copy `.env.example` to **`propera-v2/.env`** if you want to change `PORT` (default **8080**). Env is loaded from the **package root** (`src/config/env.js`), so variables apply even if you start Node from a parent directory.

**Ops dashboard (local):** **`http://127.0.0.1:8080/dashboard`** — reads Supabase **`event_log`** (`GET /api/ops/event-log`). Use **http** (not https) for localhost. **`DASHBOARD_ENABLED`** defaults on in development; optional **`DASHBOARD_TOKEN`** query param or `Authorization: Bearer`. See **[docs/HANDOFF_LOG.md](docs/HANDOFF_LOG.md)** for UI behavior (outcome-first cards, collapsed raw events).

**Brain port (GAS → Node):** see **[docs/BRAIN_PORT_MAP.md](docs/BRAIN_PORT_MAP.md)**. **Do not rewrite business rules** — port from GAS per **[docs/PORTING_FROM_GAS.md](docs/PORTING_FROM_GAS.md)**. Run **`npm test`** for router precursor parity tests. **Scenario / intake testing plan:** **[docs/TESTING_STRATEGY.md](docs/TESTING_STRATEGY.md)**.

### Port already in use (`EADDRINUSE`)

Something else is using **8080** (often a previous `node` you forgot to stop).

1. **Quick switch:** create `.env` with `PORT=8081` (or another free port — **not 3000** if `propera-app` is running) and run `npm start` again.
2. **Free 8080 on Windows (PowerShell):**  
   `netstat -ano | findstr :8080` — note the **PID** in the last column, then if it is `node.exe`:  
   `taskkill /PID <that_number> /F`

## Current runtime scope (what V2 does today)

- Express app: `GET /`, `GET /health`, **`POST /webhooks/telegram`**, **`POST /webhooks/twilio`**, **`POST /webhooks/sms`** (Twilio SMS + WhatsApp share the Twilio handler).
- **Postgres (Supabase)** when `SUPABASE_*` are set — see **`supabase/migrations/README.md`** for required migrations.
- **Shared inbound pipeline:** **`src/inbound/runInboundPipeline.js`** — staff context → **precursors** → **lane** (`src/inbound/routeInboundDecision.js`) → SMS compliance / opt-out (SMS only) → optional **vendor/system lane stub** → **`handleInboundCore`** (maintenance) → **Outgate** **`dispatchOutbound`** (Telegram or Twilio). **Do not** call transport senders from brain code. Order and guards: **`docs/ORCHESTRATOR_ROUTING.md`**.
- **Portal preventive / program runs (not inbound brain):** `GET/POST /api/portal/program-*` (templates, runs, **preview**, line complete/reopen, run **delete**) — **`src/portal/registerPortalRoutes.js`**, **`src/dal/programRuns.js`**, **`src/pm/expandProgramLines.js`**. **`properties.program_expansion_profile`** (**019**) drives floor + common line expansion. **Spec + roadmap** (building structure reuse for tenant/staff/ops): **`docs/PM_PROGRAM_ENGINE_V1.md`**. **Where it lives vs router:** **`docs/BRAIN_PORT_MAP.md`** (Portal: preventive / program runs).
- Dockerfile for later Cloud Run deploy.

**Identity (dev):** After **`003_identity.sql`** (and **`008_properties_dal_columns.sql`** or **`004_roster_and_policy_seed.sql`** so `properties.legacy_property_id` exists), try  
`GET /api/dev/resolve-actor?phone=+19085550101` — expects **STAFF** for the seeded dev contact (edit seed SQL to match your real test phone). Migration order: **`supabase/migrations/README.md`**.

**Telegram on V2:** `POST /webhooks/telegram` — validates optional `TELEGRAM_WEBHOOK_SECRET`, normalizes to **InboundSignal**, upserts **`telegram_chat_link`** (migration **005**), then **same pipeline as SMS** (`runInboundPipeline`). With **`CORE_ENABLED=1`** and DB + migrations **006** (+ **008** or **004** for property columns), **`handleInboundCore`** can create **tickets** / **work_items** (maintenance slice), run deterministic **attach classify** during merge, and latch **`ATTACH_CLARIFY`** on **`conversation_ctx`** when GAS would ask “same issue vs new?” (full GAS parity still tracked in **`docs/PARITY_LEDGER.md`**). Optional **`TELEGRAM_OUTBOUND_ENABLED=1`** + **`TELEGRAM_BOT_TOKEN`** sends replies via Outgate.

**Twilio SMS/WhatsApp on V2:** `POST /webhooks/twilio` or `/webhooks/sms` — builds **`RouterParameter`** from form body, **`transportChannel`** `sms` vs `whatsapp`; TCPA compliance + **`sms_opt_out`** (migration **011**) apply **only to SMS**, not WhatsApp. See **`docs/ORCHESTRATOR_ROUTING.md`** and **`PROPERTY_POLICY_PARITY.md`** (SMS section).

**Moving the bot webhook from GAS to V2 (one bot = one webhook):**

1. Deploy or expose V2 over **HTTPS** (ngrok for dev, Cloud Run etc. for prod).
2. In `.env`: `TELEGRAM_BOT_TOKEN`, optional `TELEGRAM_WEBHOOK_SECRET` (match Telegram `secret_token`), optional `TELEGRAM_OUTBOUND_ENABLED=1`.
3. Call Telegram `setWebhook` with your **V2** URL ending in `/webhooks/telegram`. That **replaces** the previous webhook (GAS stops receiving updates for that bot).
4. Run **`005_telegram_chat_link.sql`** in Supabase if you want chat rows persisted.

GAS stays production for channels you have not cut over; full brain parity is incremental — see **BRAIN_PORT_MAP.md**.
