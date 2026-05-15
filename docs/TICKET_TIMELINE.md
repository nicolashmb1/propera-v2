# Ticket timeline — portal Activity (V1 baseline + V2 direction)

**Purpose:** Single place for the **staff portal ticket Activity panel**: what is implemented today (Supabase + view + app mapping), what **must not** be duplicated when the brain emits richer events, and how **Timeline V2** should extend the same store.

**Related:** Legacy Sheets tab **Activity** is noted in **`docs/SHEETS_TO_POSTGRES.md`** (mapping context only — not the SSOT for the Postgres design).

---

## 1. What operators see

- **Source of truth for portal reads:** `public.portal_tickets_v1.timeline_json` — JSON array of objects built from `public.ticket_timeline_events`, ordered by time.
- **App mapping:** `propera-app/src/lib/timelineMapping.ts` maps each element to UI rows (`action`, `by`, `time`, `color`, optional `actor_type` / `actor_source`). **Do not** invent a second timeline shape in the portal without updating this doc and the view contract.

---

## 2. Storage (Postgres)

| Object | Role |
|--------|------|
| `public.tickets` | On each mutation path, **`changed_by_actor_type`**, **`changed_by_actor_id`**, **`changed_by_actor_label`**, **`changed_by_source`** (see migration `045_ticket_mutation_audit.sql`) — server-resolved staff or explicit **SYSTEM** channel; **not** client-authoritative display strings. |
| `public.ticket_timeline_events` | Append-only rows: `ticket_id`, `occurred_at`, `event_kind`, `headline`, `detail`, `actor_label`, plus **`actor_type`**, **`actor_id`**, **`actor_source`** (snapshot at insert time). |
| Trigger `public.tickets_log_timeline()` on `public.tickets` | **Timeline V1** — emits events when ticket **columns** change in tracked ways (see §4); copies actor from **`NEW.changed_by_*`** (with legacy fallbacks where older rows lack those columns). |
| `public.portal_tickets_v1` | Exposes tickets plus **`timeline_json`** (never null — coalesce to `[]`); each element includes **`by`** (label) and optional **`actor_type`**, **`actor_id`**, **`actor_source`**. |

**View `action` field (contract):**  
`headline` alone if `detail` is empty; otherwise `headline || ': ' || detail`. Terminal completion rows use **`headline = 'Ticket ' || status`** and **`detail = ''`** so the UI shows e.g. **Ticket Completed**, not a concatenated generic phrase plus status.

**Actor labels:** Raw `POLICY:*` codes from `tickets.assigned_by` are **not** shown to operators — stored/displayed as **`Policy`** (trigger + backfill + app sanitize for stale JSON).

**Portal PM mutations:** propera-app forwards the signed-in user’s Supabase access token as **`Authorization: Bearer`** on webhook and REST ticket writes; V2 resolves **`auth_user_id`** via **`portal_auth_allowlist`** → **`staff`** and sets **`changed_by_*`** before the ticket row update. **`PROPERA_PORTAL_ACTOR_JWT_REQUIRED`** (see `propera-v2/.env.example`) tightens dev vs prod behavior for the gate (`resolvePortalStaffActor.js`).

---

## 3. Timeline V1 (live today)

**Scope:** Audit of **row-visible** changes only: created, assignment, preferred window, vendor/ETA, non-terminal status transitions, terminal resolution/closure.

**What V1 is not:** A full **semantic / operational** flight recorder (tenant messages, lifecycle timer armed/fired, policy-only decisions that never touch a column, orchestrator milestones, etc.). Those belong to **Timeline V2** (§6).

**Migrations (apply in order on Supabase):**

| File | Role |
|------|------|
| `supabase/migrations/034_ticket_timeline_events.sql` | Table, trigger, view `timeline_json`, initial backfill of `created` rows. |
| `035_ticket_timeline_kind_normalize.sql` | Kind string normalization if legacy values exist. |
| `036_ticket_timeline_activity_ux.sql` | Assignment noise fixes, `created` detail empty, backfills. |
| `037_ticket_timeline_display_cleanup.sql` | Policy masking, `resolved_closed` headline/detail shape, backfill existing rows. |
| `045_ticket_mutation_audit.sql` | **`tickets.changed_by_*`**; **`ticket_timeline_events.actor_type/id/source`**; trigger prefers **`changed_by_*`**; non-terminal status headline **`Status changed to …`**; **`portal_tickets_v1.timeline_json`** exposes structured actor fields; index on **`portal_auth_allowlist(auth_user_id)`**. |

**Deployment:** Apply migrations **before** the portal relies on `timeline_json`; reload ticket payloads after SQL changes.

---

## 4. DB-trigger-owned `event_kind` values (contract)

These are the only kinds written by **`tickets_log_timeline`** today. **Keep aligned** with `propera-v2/tests/ticketTimelineV1Kinds.test.js`.

| `event_kind` | Meaning (high level) |
|--------------|----------------------|
| `created` | Ticket row inserted. |
| `assigned` | Assignee fields changed / set at insert. |
| `scheduled` | Preferred window set/changed. |
| `vendor_eta` | Vendor / ETA field changed. |
| `status_changed` | Non-terminal status transition. |
| `resolved_closed` | Terminal status (completed, canceled, closed, etc.). |

---

## 5. Duplicate rule (V1 trigger vs V2 writers — **non-optional**)

If an outcome is **already visible** as a change on `public.tickets` (e.g. status → Completed), the **DB trigger owns** that timeline row.

- **V2 semantic writers** (Node/services) must **not** insert a **second** event for the same completion (e.g. no duplicate “ticket completed” line alongside `resolved_closed` from the trigger).
- Use **distinct `event_kind` values** for V2-only semantics (messages, lifecycle pings, policy decisions not reflected in columns, etc.) and ensure product/design agrees each new kind is **not** redundant with a trigger-owned row.

---

## 6. Timeline V2 (planned extension)

**Goal:** Same append-only table (`ticket_timeline_events`), **new** `event_kind` values and writers from Propera V2 (or portal APIs), without weakening the duplicate rule.

**Examples of future kinds** (names illustrative — define in code + this doc when implemented): inbound message summary, lifecycle state change, SLA/timer event, explicit policy decision row.

**Implementation checklist when adding V2 rows:**

1. Choose a **new** `event_kind` string; document it in this file and add **portal** color mapping in `portal_tickets_v1` (view migration) and **`timelineMapping.ts`** if needed.
2. Confirm **no overlap** with trigger-owned events for the same user-visible fact (§5).
3. Prefer **stable `actor_label`** (human role, channel, or system — not raw internal policy codes).
4. Extend **`ticketTimelineV1Kinds.test.js`** or add a sibling test file if you split “trigger kinds” vs “all known kinds.”

**Distinction:** **`docs/STRUCTURED_LOGS.md`** describes **ops / stdout / event_log** style tracing for debugging and parity — **not** the same product surface as the portal Activity timeline. Timeline V2 is **operator-facing** and **ticket-scoped** in `ticket_timeline_events`.

---

## 7. When you change behavior — update docs

| Change | Update |
|--------|--------|
| New trigger-owned kind or column tracking | `034`+ migration (new file), **`TICKET_TIMELINE.md` §4**, **`ticketTimelineV1Kinds.test.js`**, view color branch in migration for `portal_tickets_v1`. |
| New V2-only kind or writer | **`TICKET_TIMELINE.md` §6**, mapping in **`propera-app` `timelineMapping.ts`**, view colors if needed. |
| Portal payload shape / field names | This file §1–2, **`timelineMapping.ts`** header comment. |

---

*This file is mandatory reading per **`AGENTS.md`**. Stale timeline docs are a bug for the next agent and for portal/GAS parity discussions.*
