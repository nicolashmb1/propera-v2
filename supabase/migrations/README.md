# Supabase migrations — order and V2 code alignment

Run SQL files in **numeric order** in the Supabase SQL Editor (same project as `SUPABASE_URL` in `.env`).

| File | Tables / changes | Required by V2 code |
|------|------------------|---------------------|
| **001_core.sql** | `conversation_ctx`, `work_items`, `tickets` (base), `tenant_directory`, `property_policy`, `message_templates`, `intake_sessions` | Core: `appendEventLog` does not use 001 tables except via other paths — **conversation_ctx**, **work_items**, **tickets**, **intake_sessions**, **property_policy** are all used. |
| **002_event_log.sql** | `event_log` | `appendEventLog.js` |
| **003_identity.sql** | `properties`, `contacts`, `staff`, `staff_assignments` | `resolveActor.js`, `resolveStaffContext.js`, `propertyLookup.js` (properties), `intakeSession.listPropertiesForMenu`, `handleInboundCore` property codes |
| **004_roster_and_policy_seed.sql** | Alters (properties columns, `staff_assignments` uniqueness, contacts/staff extras), **seed** properties (incl. GLOBAL), roster, **property_policy** rows | **Schedule policy** (`getSchedPolicySnapshot`): needs `property_policy` rows for production-like parity; optional defaults work without rows. Roster seed for dev staff. **Supersedes** need for 008’s property columns if 004 is applied. |
| **005_telegram_chat_link.sql** | `telegram_chat_link` | `upsertTelegramChatLink.js` |
| **006_tickets_sheet1_columns.sql** | Many `tickets` columns (Sheet1 / COL) | **`finalizeMaintenance.js`** inserts — **required** for maintenance finalize |
| **007_category_final_legacy.sql** | Comment on `tickets.category_final` | Optional |
| **008_properties_dal_columns.sql** | `properties.legacy_property_id`, `address`, `short_name` | **`getPropertyByCode`** — run if you have **003** (and **006**) but have **not** run **004** yet |
| **009_property_aliases.sql** | `property_aliases` (config-driven per-property aliases) | Intake property detection (`listPropertiesForMenu` → `detectPropertyFromBody`) uses this when present; safe fallback if absent |
| **010_property_aliases_seed_from_properties.sql** | Optional seed helper for `property_aliases` from `properties.short_name` / `display_name` / controlled address token | Optional convenience after 009; safe idempotent seed (`ON CONFLICT DO NOTHING`) |
| **011_sms_opt_out.sql** | `sms_opt_out` — compliance STOP/START persistence | **`src/dal/smsOptOut.js`**, **`src/inbound/runInboundPipeline.js`** (SMS-only branch) |
| **012_tenant_roster.sql** | `tenant_roster` — GAS **Tenants** sheet (property + unit + resident phone + name) | **`src/dal/tenantRoster.js`** — staff **`#capture`** resolves **resident** phone for `tickets` / `work_items` (never staff phone) |
| **013_tenant_roster_rls.sql** | **RLS enabled** on `tenant_roster` (no anon policies — PII safe for Supabase API) | Run after **012** if Supabase warns about missing RLS; server uses **service role** (bypasses RLS) |
| **018_program_engine_v1.sql** | `program_templates`, `program_runs`, `program_lines` (PM/Task V1) + seed templates | **`programRuns.js`**, portal routes `/api/portal/program-*` — see **`docs/PM_PROGRAM_ENGINE_V1.md`** |
| **019_properties_program_expansion_profile.sql** | `properties.program_expansion_profile` (jsonb) — per-property PM expansion hints | **`expandProgramLines.js`**: `FLOOR_BASED` uses **`floor_paint_scopes`** then **`common_paint_scopes`**; `UNIT_PLUS_COMMON` appends **`common_paint_scopes`** (or one **Common Area**); `COMMON_AREA_ONLY` uses **`common_paint_scopes`** only — see **`docs/PM_PROGRAM_ENGINE_V1.md`** |
| **020_program_lines_scope_type_common_area_only.sql** | `program_lines`: migrate `SITE` → `COMMON_AREA`; constraint allows only `UNIT`, `COMMON_AREA`, `FLOOR` | **`expandProgramLines.js`** (`COMMON_AREA_ONLY` lines use `COMMON_AREA`) |
| **040_program_lines_proof_photos.sql** | `program_lines.proof_photo_urls` (jsonb array of image URLs) | **`programRuns.js`** complete/reopen + portal **`PATCH .../program-lines/:id/complete`**; **`propera-app`** `/preventive` proof upload |
| **021_portal_auth_allowlist.sql** | `portal_auth_allowlist` — pre-approved emails, `portal_role`, optional `staff_id` FK | **`propera-app`** `POST /api/auth/register`, **`POST /api/auth/login`**, **`portalMeFromSupabase`** (`/api/me`); service role bypasses RLS |
| **031_batch_media_meter_billing.sql** | `batch_media_runs`, `batch_media_assets`, `utility_meters`, `utility_meter_readings`; Storage bucket **`utility-meter-runs`** | **`meterBillingRuns.js`**, **`registerMeterRunRoutes.js`** (`/api/portal/meter-runs`, `utility-meters`); **`propera-app`** `/api/utility-meter-runs/*`, `/api/utility-meter-runs/upload` |
| **041_batch_media_assets_updated_at.sql** | `batch_media_assets.updated_at` + touch trigger | Stuck **PROCESSING** reset, **`POST /internal/cron/meter-runs-process-pending`**, portal resume / snapshot counts |
| **042_operational_finance_v1.sql** | `ticket_cost_entries`, `tenant_ledger_entries`, `portal_ticket_financial_summary_v1`, `portal_property_maintenance_spend_month_v1`; extends **`portal_tickets_v1`** (`ticket_row_id`, finance timeline colors), **`portal_properties_v1`** (UTC-month maintenance columns) | **`ticketCostEntries.js`**, portal `/api/portal/tickets/:id/ticket-cost-entries*`, **`propera-app`** Costs & charges; env: `PROPERA_FINANCE_ENABLED`, `PROPERA_FINANCE_TICKET_COSTS_ENABLED`, `PROPERA_FINANCE_LEDGER_ENABLED` + `NEXT_PUBLIC_PROPERA_FINANCE_ENABLED` |

### Minimum paths

- **Telegram + router only (no ticket create):** 001, 002, 003, 005 (002 optional).
- **Core maintenance (finalize + schedule):** 001 → 002 → 003 → **008** → **009** → 005 → **006** → (optional **010** alias seed) → (run **004** or insert `property_policy` rows manually for schedule policy parity).

**Full dev parity (roster + GLOBAL policy seed):** run **004** after `003`; you can still run **008** afterward (no-op for columns already added by 004).
