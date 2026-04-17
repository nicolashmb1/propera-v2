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

   Optional media OCR (Telegram producer path only, core remains channel-agnostic):
   - `INTAKE_MEDIA_OCR_ENABLED=1`
   - `OPENAI_API_KEY=<...>`
   - `TELEGRAM_BOT_TOKEN=<...>` (used to fetch Telegram file bytes before OCR)

5. **Run migrations in order** (still browser — see **`supabase/migrations/README.md`** for the full table and what each file is for):  
   - Left menu → **SQL Editor** → **New query**.  
   - Run **`001_core.sql`**, then **`002_event_log.sql`**, then **`003_identity.sql`**, then **`008_properties_dal_columns.sql`** (adds `properties.legacy_property_id` and related columns expected by `getPropertyByCode` — no-op if you already ran **`004_roster_and_policy_seed.sql`**).  
   - Run **`009_property_aliases.sql`** if you want DB-managed property aliases for intake detection (`property_aliases` table).  
   - Optional convenience seed: **`010_property_aliases_seed_from_properties.sql`** (copies aliases from existing `properties.short_name` / `display_name` and a controlled street token from `address`).
   - For Telegram persistence: **`005_telegram_chat_link.sql`**.  
   - For ticket/work_item create (`finalizeMaintenance`): **`006_tickets_sheet1_columns.sql`** — **required** or inserts fail.  
   - Optional: **`007_category_final_legacy.sql`** (comment only).  
   - For roster + PropertyPolicy seed + same property columns as 008: **`004_roster_and_policy_seed.sql`** (run after `003`; if you use `004`, `008` is still safe to run afterward).

6. Restart `propera-v2` (`npm start`) and open `http://localhost:8080/health`.  
   You want `"db": { "configured": true, "ok": true }`.

**If `/health` says `Could not find the table 'public.conversation_ctx'`:** the migration was not applied to this project. Run `001_core.sql` in the **same** project as `SUPABASE_URL` in `.env`. Then confirm **Table Editor** lists `conversation_ctx`.

**Identity tables (staff / properties):** run `003_identity.sql` after `001` and `002`. Then test: `http://localhost:8080/api/dev/resolve-actor?phone=%2B19085550101` (dev mode — see README).

**`legacy_property_id` on `properties`:** `008_properties_dal_columns.sql` (or `004`, which includes the same alters). Without one of these, **`getPropertyByCode`** / finalize can error on `column legacy_property_id does not exist` if you only ran `003`.

**Property aliases (config in DB):** `009_property_aliases.sql` creates `property_aliases` (`property_code`, `alias`, `active`). Intake detection reads this when present; if not present, detection still uses `properties` (`code`, `display_name`) without crashing.

**Sheet1 / ticket log parity:** `006_tickets_sheet1_columns.sql` extends `public.tickets` for `finalizeMaintenance.js`. **Required** for core finalize.

**Optional (documentation in DB):** `007_category_final_legacy.sql` adds a `COMMENT` on legacy `category_final` (AppSheet-era). Safe to run anytime; not required for inserts.

**Keep docs in sync:** When you add migrations or change first-run steps, update this file and **[BRAIN_PORT_MAP.md](BRAIN_PORT_MAP.md)** in the same change when possible.

---

## B. Ops dashboard (optional — local dev)

If **`npm start`** is running with Supabase configured and migration **`002_event_log.sql`** applied:

- Open **`http://127.0.0.1:8080/dashboard`** (use **http**, not https, for localhost).
- Optional secret: set **`DASHBOARD_TOKEN`** in `.env` and pass `?token=` or `Authorization: Bearer`.

Read-only inspection of **`event_log`**. See **[HANDOFF_LOG.md](./HANDOFF_LOG.md)** for UI notes.

---

## C. Later (not required yet)

| When | Where (browser) |
|------|-------------------|
| Public HTTPS URL for webhooks | Google Cloud Console → Cloud Run (or similar) |
| Point Twilio / Telegram test webhooks | Twilio Console, Telegram BotFather |

Production **Twilio → GAS** stays as-is until you intentionally change it.

---

## What stays on GAS until you switch

- Live **Sheets** and **Apps Script** deployment for real tenants — unchanged by Supabase alone.
