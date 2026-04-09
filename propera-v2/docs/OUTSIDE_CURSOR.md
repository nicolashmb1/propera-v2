# Only steps you do **outside Cursor** (browser / accounts)

Everything else (code, migrations in git, `npm install`, running the server) lives in the repo and does not need a separate guide.

---

## A. Supabase (database host)

Do these in your **web browser** at [supabase.com](https://supabase.com):

1. **Sign up / log in.**
2. **New project** → pick organization, name (e.g. `propera-v2-dev`), database password (save it somewhere safe), region → **Create** and wait until the project is **ready** (green / healthy).
3. **Settings** (gear) → **API**:
   - Copy **Project URL** → this is `SUPABASE_URL`.
   - Copy **service_role** `secret` (not the `anon` key) → this is `SUPABASE_SERVICE_ROLE_KEY`.  
     **Treat it like a password.** Never commit it; never put it in frontend code.

4. Put those two values into `propera-v2/.env` on your machine (copy from `.env.example` and fill in). **Never paste secrets into this doc** — they would be committed to git.

5. **Run the first migration in the dashboard** (still browser):  
   - Left menu → **SQL Editor** → **New query**.  
   - Open the file `propera-v2/supabase/migrations/001_core.sql` **in Cursor**, select all, copy.  
   - Paste into the SQL Editor → **Run**.  
   - You should see **Success** (no red errors).

6. Restart `propera-v2` (`npm start`) and open `http://localhost:8080/health`.  
   You want `"db": { "configured": true, "ok": true }`.

**If `/health` says `Could not find the table 'public.conversation_ctx'`:** the migration was not applied to this project. Run step 5 again (full `001_core.sql`) in the **same** project as `SUPABASE_URL` in `.env`. Then confirm **Table Editor** lists `conversation_ctx`.

---

## B. Later (not required yet)

| When | Where (browser) |
|------|-------------------|
| Public HTTPS URL for webhooks | Google Cloud Console → Cloud Run (or similar) |
| Point Twilio / Telegram test webhooks | Twilio Console, Telegram BotFather |

Production **Twilio → GAS** stays as-is until you intentionally change it.

---

## What stays on GAS until you switch

- Live **Sheets** and **Apps Script** deployment for real tenants — unchanged by Supabase alone.
