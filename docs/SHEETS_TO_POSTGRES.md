# Sheets → Postgres mapping (draft v1)

**Purpose:** Single place to see how Google Sheets data in Propera maps to relational tables in V2 (Supabase/Postgres).  
**Status:** Living document — adjust as we implement migrations.  
**Sources (repo root):** `01_PROPERA MAIN.gs` (`COL`), `14_DIRECTORY_SESSION_DAL.gs` (`DIR_COL`), `11_TICKET_FINALIZE_ENGINE.gs` (`ensureWorkBackbone_`), `apps-script/ProperaPortalAPI.gs`.

---

## 1. Sheet inventory (names in your spreadsheet)

| Sheet tab | Role in GAS |
|-----------|----------------|
| **Sheet1** | Ticket log (maintenance rows) — `COL` indices |
| **Directory** | Per-phone draft: pending stage, issue buffer, property, unit, pointer to ticket row |
| **ConversationContext** | Short-lived routing ctx: lang, work item ids, pending expected stage, channel |
| **Sessions** | Session-shaped draft: stage, expected, lane, issue buffer JSON, schedule raw |
| **WorkItems** | Work item spine: WI id, status, state, ticket row link, assignment, ticket key |
| **Templates** | Template keys → bodies (`TEMPLATES_SHEET_NAME` in DAL) |
| **PropertyPolicy** | `ppGet_`: Property, PolicyKey, Value, Type |
| **Tenants** | Tenant directory for portal |
| **Activity** | Ticket timeline (portal) |
| **Users**, **Staff**, **Contacts**, **StaffAssignments** | Portal RBAC + staff resolver inputs |
| **Properties** | Active property list (resolution) |
| **Visits**, **Amenities**, … | Domain-specific — migrate after core path |

---

## 2. Ticket row (`Sheet1`) ↔ `tickets` (or `maintenance_tickets`)

GAS uses **1-based column indices** in `COL` (see `01_PROPERA MAIN.gs`). Postgres uses **named columns** — same meaning, stable IDs.

| COL / meaning | Suggested Postgres column | Notes |
|---------------|---------------------------|--------|
| TS | `created_at` / `logged_at` | timestamptz |
| PHONE | `tenant_phone_e164` | text, indexed |
| PROPERTY, UNIT | `property_code`, `unit_label` | text |
| MSG | `message_raw` | text |
| CAT … through SCHEDULED_END_AT | `category`, `emergency`, `urgency`, `confidence`, … `scheduled_end_at` | flatten or JSON for rarely used |
| TICKET_ID | `ticket_id` | text, unique business id (e.g. WEST-…) |
| STATUS, ASSIGNED_*, DUE_BY, … | operational columns | match portal filters |
| TICKET_KEY | `ticket_key` | UUID string, immutable link to WI |
| … | | Full parity with portal `getTicketsFromSheet` expectations |

**Rule:** Portal and finalize both assume **one row per ticket** with a known column set — V2 migrations must list **exact** portal fields and add columns before cutover.

---

## 3. Directory ↔ `directory_rows` + draft blobs

`DIR_COL` in `14_DIRECTORY_SESSION_DAL.gs`:

| Column (sheet) | Field | Postgres |
|----------------|-------|----------|
| A PHONE | `phone_e164` | PK or unique |
| B–C | `property_code`, `property_name` | text |
| D | `last_updated` | timestamptz |
| E–H | `pending_issue`, `pending_unit`, `pending_row`, `pending_stage` | text / int |
| I–L | handoff, welcome, active ticket key, issue buffer | text / JSON |
| M–N | `draft_schedule_raw`, etc. | text |
| O UNIT | `canonical_unit` | text |

**Option A:** One table `directory` with JSON `issue_buffer` matching current JSON string.  
**Option B:** Normalize issue buffer into child table later — **not required for V1 parity.**

---

## 4. ConversationContext ↔ `conversation_ctx`

Headers from `ensureWorkBackbone_` in `11_TICKET_FINALIZE_ENGINE.gs`:

`PhoneE164`, `Lang`, `ActiveWorkItemId`, `PendingWorkItemId`, `PendingExpected`, `PendingExpiresAt`, `LastIntent`, `UpdatedAt`, `PreferredChannel`, `TelegramChatId`, `LastActorKey`, `LastInboundAt`

→ Single row per phone → table **`conversation_ctx`** with same logical fields (snake_case in SQL).

---

## 5. Sessions ↔ `intake_sessions` (name TBD)

Headers: `Phone`, `Stage`, `Expected`, `Lane`, `DraftProperty`, `DraftUnit`, `DraftIssue`, `IssueBufJson`, `DraftScheduleRaw`, `ActiveArtifactKey`, `ExpiresAtIso`, `UpdatedAtIso`

→ Table with `phone_e164` key + JSON where GAS stores JSON strings today.

---

## 6. WorkItems ↔ `work_items`

Headers from `ensureWorkBackbone_`:  
`WorkItemId`, `Type`, `Status`, `State`, `Substate`, `PhoneE164`, `PropertyId`, `UnitId`, `TicketRow`, `MetadataJson`, `CreatedAt`, `UpdatedAt`, `OwnerType`, `OwnerId`, `AssignedByPolicy`, `AssignedAt`, `TicketKey`

→ Table **`work_items`** — core lifecycle spine; `ticket_row` may become FK to `tickets.id` instead of sheet row number over time.

---

## 7. Templates ↔ `templates`

Rows: template **key**, language, body, allowlist metadata as today. Seed from **Templates** sheet or CSV in repo.

---

## 8. PropertyPolicy ↔ `property_policy`

Columns: **Property**, **PolicyKey**, **Value**, **Type** (see `ppGet_` in [`17_PROPERTY_SCHEDULE_ENGINE.gs`](../..//17_PROPERTY_SCHEDULE_ENGINE.gs)).  
→ Table with composite uniqueness `(property_code, policy_key)` + typed value (see `ppGet_` in `17_PROPERTY_SCHEDULE_ENGINE.gs`).

---

## 9. Portal-only sheets

| Sheet | Use |
|-------|-----|
| **Tenants** | List/detail for portal API |
| **Activity** | Timeline rows keyed by `ticket_id` |
| **Users** | Portal login / role |
| **Staff**, **Contacts**, **StaffAssignments** | Resolver + `me` payload |

→ Tables: `tenants`, `ticket_activity`, `portal_users`, `staff`, `contacts`, `staff_assignments` (names align with existing Supabase draft if present).

---

## 10. What we do **not** do in SQL alone

- **Locks:** `dalWithLock_` / `withWriteLock_` become **transactions** or **advisory locks** in Postgres.
- **Brain authority:** Portal or SMS writes **commands** → lifecycle → then rows update — never raw UPDATE for ticket state from the API layer (see migration plan).

---

## 11. Next implementation steps

1. ~~Add **`supabase/migrations/001_core.sql`**~~ **Done** — run it in Supabase SQL Editor (see `docs/OUTSIDE_CURSOR.md`).
2. Seed **PropertyPolicy** + **properties** from exports.
3. ~~Wire **`/health`** DB ping when `SUPABASE_*` is set~~ **Done** — `db.configured` + `db.ok` in JSON.

---

*Last updated: schema-map pass (draft v1).*
