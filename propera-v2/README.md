# Propera V2 (parallel runtime)

This folder is the **new** Propera server. **Production today** is still Google Apps Script + Sheets — nothing here replaces that until you deliberately cut over.

## What you do **inside Cursor** (this repo)

- Edit Node code under `src/`.
- Run the server locally (see below).
- Commit `propera-v2/` to git when you are happy.

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

Open **http://localhost:8080/health** — you should see JSON with `"ok": true`.

Copy `.env.example` to `.env` if you want to change `PORT` (default **8080**).

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

Next steps (later phases): Supabase project + schema, then Telegram/Twilio webhooks pointing at a **deployed** URL (still not production GAS).
