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
   - **Staff `#capture` tenant lookup (GAS Tenants sheet parity):** **`012_tenant_roster.sql`** — then seed rows (`property_code`, `unit_label`, `phone_e164`, `resident_name`, `active`). Without this table, staff-created tickets still save **empty** tenant phone (safe; no crash).
   - **Portal Supabase signup (propera-app):** **`021_portal_auth_allowlist.sql`** after **`003_identity.sql`** (FK to `staff.staff_id`). Then insert allowlist rows in SQL Editor (`email_lower`, `portal_role`, optional `staff_id`). **`propera-app`** register checks this table before `auth.admin.createUser`.
   - **Preventive checklist proof photos:** after **`018_program_engine_v1.sql`** (and ticket photo bucket **`026_pm_attachments_storage_bucket.sql`** for uploads), run **`040_program_lines_proof_photos.sql`** — adds **`program_lines.proof_photo_urls`**.
   - **Preventive Activity timeline:** after **`018`**, run **`059_program_timeline_v1.sql`** — **`program_timeline_events`** (append-only; writers in V2 DAL). Optional with lines add/remove/reorder (no extra migration for those).
   - **Preventive → ticket bridge:** after **`059`**, run **`060_program_line_ticket_bridge.sql`** — links checklist lines to maintenance tickets.
   - **Open deck day chart:** optional **`061_open_deck_day_chart_note.sql`** (comment-only). Enable **`PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1`** on V2 and **`NEXT_PUBLIC_PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1`** on propera-app (no schema required).
   - **Propera Chat voice notes:** after **`026`**, run **`054_pm_attachments_audio_mime.sql`** — adds audio (and PDF) MIME types to **`pm-attachments`**; without it, `/api/portal/chat-audio-upload` fails with “mime type not allowed”.
  - **Communication Engine:** run **`055_communication_engine.sql`** after **`012`** + **`030`**, then run **`065_communication_agent_initiated.sql`** (agent audit flag on campaigns). Set **`PROPERA_COMMUNICATION_ENGINE_ENABLED=1`**, **`TWILIO_OUTBOUND_ENABLED=1`**, **`COMM_ORG_ID`**, **`TWILIO_BROADCAST_FROM`**, and **`COMM_MAIN_NUMBER_DISPLAY`** in `propera-v2/.env`. Provision a **second** Twilio number; point its webhook to `https://<host>/webhooks/communications/sms` and status URL to `.../webhooks/communications/status` (not `/webhooks/sms`). See **`docs/COMMUNICATION_ENGINE.md`**.
  - **Access Engine lifecycle completion:** after **`057_access_engine_v1.sql`** (and **`058`** if you already use the current access stack), run **`066_access_lifecycle_jobs.sql`** so access reservations can auto-timeout approvals, send reminders, activate on window start, and complete/expire passes on window end.
  - **Amenity program — internal-only locations:** run **`091_access_locations_staff_only.sql`** after **`057`**/**`058`**. Enables **Internal only** on Amenities → Settings (terrace etc. staff-only; hidden from tenant portal and agent).
  - **Cloud Run (staging brain):** see **`docs/CLOUD_RUN_DEPLOY.md`** — deploy `propera-v2-staging` on **`propera-live`** / **`us-east1`**. Does **not** change Vercel or webhook URLs until cutover.
  - **Cloud Run (production brain):** see **`docs/CLOUD_RUN_PROD_CHECKLIST.md`** — deploy **`propera-v2-prod`** with **separate prod secrets**; Vercel / Twilio / Telegram / GitHub cron unchanged until Phase 5 cutover.
  - **Jarvis operator threads (spine layer 2 — pending proposals + receipts):** run **`070_jarvis_operator_threads.sql`**. Required before **`JARVIS_THREAD_ENABLED=1`** so portal Plan / voice confirms survive reconnect and dedupe.
  - **Jarvis atomic confirm claim:** run **`092_jarvis_proposal_transition.sql`** after **`070`**. Adds the `jarvis_transition_proposal` row-locked function so the confirm "claim" (`awaiting_confirm → executing`) is atomic across V2 instances — prevents double brain commit on concurrent confirms. **Until applied, confirms still work** (code falls back to the legacy non-atomic claim, single-instance-safe only); apply it before running more than one V2 instance.
  - **Jarvis open-ticket scope view:** run **`093_portal_open_tickets_v1.sql`** after **`073`** (latest `portal_tickets_v1` definition). Thin open-only projection so Jarvis operational scope can't drop open tickets behind a LIMIT window and stops the 4× portfolio overfetch. Additive (does **not** redefine the base view). **Until applied, scope still works** (code falls back to base view + JS open filter).
   - **Vendor directory + preventive line vendor:** run **`046_vendors_and_program_line_vendor.sql`**, then insert active vendors in SQL Editor, e.g. `insert into public.vendors (vendor_id, display_name, active) values ('VND_PLUMB_CO', 'Acme Plumbing', true) on conflict (vendor_id) do nothing;`
   - **Property operating expenses (Phase 1d — parallel-run finance):** run **`082_property_expenses.sql`** after the properties table exists (`003_identity.sql` or `004`). Creates `property_expenses` — PM-entered costs (tax, insurance, utilities, staff allocation, management fee, etc.) not tied to tickets. Required for the **Expenses tab** on `/financial/properties/[p]` in propera-app. No feature flag needed — the tab is visible when `NEXT_PUBLIC_PROPERA_FINANCIAL_MENU_ENABLED=1`. **Bill scan** (photo → AI extraction) requires `PROPERA_EXPENSE_SCAN_PROVIDER` + key in `propera-v2/.env` (see `.env.example` — provider: `openai` default or `anthropic`; model: `PROPERA_EXPENSE_SCAN_MODEL`).
   - **Leasehold accounting snapshots (Phase 1.5):** run **`094`** → **`095`** → **`096`** → **`097`** (`tenant_account_snapshots`, net rent, security/key deposits, other/pet deposits). Required before **Financial → Imports** or office syncher can populate portfolio KPIs. Adapter lives in **`leasehold-bridge`** (sibling repo). Ops: **`../propera-app/docs/FINANCIAL_LEASEHOLD_SYNC.md`** — never touch `\\lhdata`; office PC copies mirror → staging → import changed properties only.
   - **Leasing Engine V1 (portal ops — renewals + prospects):** run **`085_leasing_engine_v1.sql`** after **`049_unit_leases.sql`**. Set **`PROPERA_LEASING_ENGINE_ENABLED=1`** on V2 and **`NEXT_PUBLIC_PROPERA_LEASING_ENABLED=1`** on propera-app. Not the GAS conversational leasing engine — portal CRM slice only.
   - **Unit occupancies (Phase 1 lifecycle):** run **`087_unit_occupancies_v1.sql`** after **`030_units_catalog_and_portal_views.sql`**, **`012_tenant_roster.sql`**, **`039_turnover_engine_v1.sql`** (FK to turnovers), and **`049_unit_leases.sql`** (backfill reads leases). Set **`PROPERA_UNIT_LIFECYCLE_ENABLED=1`** on V2. Backfills one **`current`** occupancy per unit with an active roster row. See **`docs/UNIT_LIFECYCLE_BUILD_PLAN.md`**.
   - **Unit assets (Phase 3 lifecycle):** run **`088_unit_assets_v1.sql`** after **`087_unit_occupancies_v1.sql`** and **`039_turnover_engine_v1.sql`** (optional FK `source_turnover_id`). Same **`PROPERA_UNIT_LIFECYCLE_ENABLED=1`** flag. No backfill — staff register equipment via unit **Assets** tab.
   - **Nameplate photos (Phase 4):** run **`089_unit_asset_nameplates_storage.sql`**. Nameplate OCR uses V2 vision — configure **`PROPERA_UNIT_ASSET_SCAN_PROVIDER`** / **`PROPERA_UNIT_ASSET_SCAN_MODEL`** or reuse expense scan vars (`PROPERA_EXPENSE_SCAN_*`). Without keys, manual entry still works.
   - **Multi-org spine (MO-1):** run **`074_org_spine_core.sql`** after **`055`** / **`056`** (needs `organizations`). Backfills existing Grand rows to `org_id = 'grand'`. Optional env: **`PROPERA_DEFAULT_ORG_ID=grand`** on V2 and propera-app. See **`docs/MULTI_ORG_ARCHITECTURE.md`**.
   - **Tenant Agent (AI Staff adapter):** run **`063_tenant_conversations.sql`** after **`001_core`** (needs Postgres). Required before **`TENANT_AGENT_ENABLED=1`** in prod. Conversation state only — not a substitute for `intake_sessions`. See **`docs/TENANT_AGENT_ADAPTER.md`**. Env: **`TENANT_AGENT_*`** in `.env.example`.

6. Restart `propera-v2` (`npm start`) and open `http://localhost:8080/health`.  
   You want `"db": { "configured": true, "ok": true }`.

**If `/health` says `Could not find the table 'public.conversation_ctx'`:** the migration was not applied to this project. Run `001_core.sql` in the **same** project as `SUPABASE_URL` in `.env`. Then confirm **Table Editor** lists `conversation_ctx`.

**`conversation_ctx.pending_expected` values:** beyond legacy GAS-style stage strings, V2 may set **`ATTACH_CLARIFY`** (ambiguous attach vs new issue) using the same `001_core.sql` `conversation_ctx` row — **no extra migration** for that latch; core clears it when the clarify path is fully ported.

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

**V2 webhook paths (in-repo, not browser-only):** `POST /webhooks/telegram`, `POST /webhooks/twilio`, `POST /webhooks/sms` — see **`README.md`** and **`docs/ORCHESTRATOR_ROUTING.md`** for behavior (SMS compliance DB requires migration **011**).

---

## Lifecycle timer cron (outside V2 process)

**Timestamps in Postgres do not run lifecycle.** Someone must periodically **`POST /internal/cron/lifecycle-timers`** on the V2 instance that uses your Supabase DB, with header **`x-propera-cron-secret`** matching **`LIFECYCLE_CRON_SECRET`** (must be non-empty in prod). This cron now fans out to both **maintenance lifecycle timers** and **access lifecycle jobs**.

- **Interval:** every 1–5 minutes is typical.
- **Dev / ngrok:** point the caller at your tunnel URL; ngrok hostnames are temporary.
- **Prod:** use a stable V2 URL plus GitHub Actions (workflow in-repo), Google Cloud Scheduler, or another HTTPS cron — see **`docs/LIFECYCLE_CRON_SCHEDULER.md`** for secrets (`PROPERA_LIFECYCLE_CRON_URL`, `LIFECYCLE_CRON_SECRET`), PowerShell smoke test, and alternatives.

---

## What stays on GAS until you switch

- Live **Sheets** and **Apps Script** deployment for real tenants — unchanged by Supabase alone.
