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

### Minimum paths

- **Telegram + router only (no ticket create):** 001, 002, 003, 005 (002 optional).
- **Core maintenance (finalize + schedule):** 001 → 002 → 003 → **008** → **009** → 005 → **006** → (optional **010** alias seed) → (run **004** or insert `property_policy` rows manually for schedule policy parity).

**Full dev parity (roster + GLOBAL policy seed):** run **004** after `003`; you can still run **008** afterward (no-op for columns already added by 004).
