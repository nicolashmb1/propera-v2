# Ticket split — V1 (PM portal)

**Status:** **Spec locked — not implemented.** Two-ticket split from staff ticket detail; same atomic action updates the original and creates one sibling.

**Related:** Intake auto-split (tenant finalize) remains separate — see **`PARITY_LEDGER.md`** §2 (`finalizeTicketGroups`). This doc is **PM-initiated split after the fact**.

---

## Purpose

When one inbound message or one PM-created ticket contains **multiple distinct issues** (e.g. “repair icemaker and tube is clogged”), intake may keep a **single** ticket (`issue1 | issue2` or one combined description). PMs need to **split** without re-entering property, unit, tenant, and assignment manually.

**Product name:** **Split ticket** (not “extract issue”).

**V1 scope:** Exactly **2 tickets** per action — **this ticket** (edited) + **one new ticket**. Three-or-more splits are a later release.

---

## Locked product decisions (V1)

| Decision | Choice |
|----------|--------|
| Atomicity | **Same action** — one confirm updates ticket A and creates ticket B. No “create only, edit original yourself.” |
| Assignment on new ticket | **Copy from ticket 1** (assignee, `assigned_type`, `assigned_id`, `assignment_source`, note fields as on parent at split time). **Later:** revisit (e.g. unassigned on child, or policy re-resolve). Document as **known v1 debt**. |
| Schedule / preferred window | **Do not copy** — new ticket starts without parent schedule unless PM sets it afterward. |
| Notes / service note | **Do not copy** to new ticket (v1). |
| Photos / attachments | **Stay on original only** (v1). **Later:** optional “copy attachments to new ticket.” |
| Costs | **Never move** — all `ticket_cost_entries` remain on original; PM reallocates manually if needed. |
| Program / turnover linkage | **Do not copy** `program_run_id`, `program_line_id`, `turnover_id`, `turnover_item_id` to the child. |
| Channels | **V2 tickets only** (`source === "v2"`). Hide or disable for GAS rows and imported-history tickets. |
| Suggest helper | **Optional** “Suggest split” runs **deterministic** issue grouping only (`buildIssueTicketGroups` / `parseIssueDeterministic` path) — **prefills issue text fields**; PM confirms. Does **not** auto-guess unit vs common area. |

---

## UX — `propera-app`

**Entry:** `TicketDetailPanel` — icon/button **Split ticket** (secondary action near edit/save; not primary).

**Modal title:** `Split ticket {humanTicketId}`

**Layout (two columns on desktop; stacked on narrow):**

1. **Reference (read-only):** Full current `issue` / `message_raw` from the ticket (and unit/location summary line).
2. **Optional:** `[ Suggest split ]` — calls V2 suggest endpoint; fills **Ticket 1** and **Ticket 2** issue text only; PM may edit before confirm.
3. **Ticket 1 — this ticket**
   - Issue (required, pre-filled from current issue or suggest)
   - Location block (see below) — defaults from parent
   - Category, urgency (defaults from parent, editable)
4. **Ticket 2 — new ticket**
   - Issue (required)
   - Location block — defaults from parent; PM may switch to **common area** or **property-wide** per child
   - Category, urgency (defaults from parent, editable)
   - Tenant phone/name: copy from parent when parent is a unit ticket; omit when parent is common-area/property-wide (same rules as **`NewTicketModal`** / `create-ticket`)

**Location block (reuse `NewTicketModal` patterns):**

- `location_kind`: `unit` | `common_area` | `property`
- Unit label + `unit_catalog_id` when `unit`
- `location_id` + `location_label_snapshot` when common area / property (load via `getPropertyLocations`)

**Confirm:** `Split into 2 tickets`  
**Cancel:** no DB changes.

**Success:** Toast + link to new ticket; refresh detail for ticket 1; optional navigation to ticket 2.

**Errors:** Show V2 error string; if create succeeds but patch fails (should not happen if server is transactional), show support message — server must prevent this (see API).

---

## API — `propera-v2`

**Route (planned):**

```
POST /api/portal/tickets/:ticketRowId/split
Authorization: Bearer <portal session JWT>
Content-Type: application/json
```

**Gate:** Same portal auth as other ticket mutations (`resolvePortalStaffActor`, `PROPERA_PORTAL_ACTOR_JWT_REQUIRED` when enabled).

**Request body:**

```json
{
  "splitGroupId": "optional-uuid-client-may-send; server generates if omitted",
  "ticket1": {
    "issueText": "Repair icemaker",
    "category": "Appliance",
    "urgency": "Normal",
    "location_kind": "unit",
    "unit": "402",
    "unit_catalog_id": "uuid-or-empty",
    "location_id": "",
    "location_label_snapshot": "Unit 402"
  },
  "ticket2": {
    "issueText": "Tube clogged",
    "category": "Plumbing",
    "urgency": "Normal",
    "location_kind": "common_area",
    "unit": "",
    "unit_catalog_id": "",
    "location_id": "uuid",
    "location_label_snapshot": "Basement utility chase"
  }
}
```

**Validation:**

- `ticketRowId` resolves to an existing V2 `tickets.id` (uuid).
- Parent not `is_imported_history` (if column exists).
- Both `issueText` non-empty after trim.
- `ticket1` location rules match portal `create_ticket` (unit requires unit label; common area requires `location_id` or label per existing finalize rules).
- Property code **immutable** — taken from parent row only (not accepted from client body for property change).

**Server behavior (single logical transaction):**

1. Load parent ticket + work_item; reject if missing / GAS-only id shape.
2. Generate `split_group_id` (uuid) if not provided.
3. **Patch ticket 1** via existing portal mutation path (`portalTicketMutations` or dedicated patch helper):
   - `message_raw` / issue fields from `ticket1.issueText`
   - Location columns from `ticket1` (`location_kind`, `unit`, `location_id`, `location_label_snapshot`, `unit_catalog_id`, … per migration **032**)
   - Category / urgency if exposed on tickets table
   - Set `split_group_id` on parent (if null, set; if already set from prior split, **reuse or error** — v1: **allow same group** only when re-splitting is out of scope; **v1: set once on first split, child gets same id**)
4. **Create ticket 2** via **`finalizeMaintenanceDraft`** (same as turnover / program line / portal `create_ticket`):
   - `mode: "MANAGER"`
   - `propertyCode` from parent
   - `issueText` from `ticket2`
   - Location + `_portalPayloadJson` aligned with structured create
   - **Copy assignment** from parent snapshot onto new ticket row **after** finalize (respect `ticketAssignmentGuard` — if parent is `PM_OVERRIDE`, child copy is intentional PM action; set `assignment_source` to `PM_OVERRIDE` or `SPLIT_COPY` — **pick `PM_OVERRIDE` with `assigned_by` = portal actor** for v1 simplicity)
   - Set `split_from_ticket_id` = parent human ticket id
   - Set `split_group_id` = shared uuid
5. **Timeline (semantic writers):** Insert **`ticket_split`** events on **both** tickets (see § Timeline). Must **not** duplicate trigger-owned `created` on ticket 1 (already exists).
6. **`appendEventLog`:** `PORTAL_TICKET_SPLIT` with parent id, new id, `split_group_id`, trace id.

**Response:**

```json
{
  "ok": true,
  "splitGroupId": "uuid",
  "ticket1": { "ticketId": "PENN-…", "ticketRowId": "uuid", "ticketKey": "…" },
  "ticket2": { "ticketId": "PENN-…", "ticketRowId": "uuid", "ticketKey": "…", "workItemId": "WI_…" }
}
```

**Suggest endpoint (optional v1, same PR or fast follow):**

```
POST /api/portal/tickets/:ticketRowId/split/suggest
Body: { "issueText": "optional override; default parent issue" }
Response: { "suggestions": [ { "issueText": "…" }, { "issueText": "…" } ] }
```

Implementation: `buildIssueTicketGroups` from `src/brain/core/finalizeTicketGroups.js` — **read-only**, no DB writes.

---

## Schema — migration `061_ticket_split_v1.sql` (planned)

Add to `public.tickets`:

| Column | Type | Notes |
|--------|------|--------|
| `split_group_id` | `uuid` null | Shared by all tickets created in one split action |
| `split_from_ticket_id` | `text` not null default `''` | Human ticket id of parent when this row was created as split child |

Indexes:

- `tickets_split_group_id_idx` where `split_group_id is not null`
- `tickets_split_from_ticket_id_idx` where `split_from_ticket_id <> ''`

**Expose in `portal_tickets_v1`:** `split_group_id`, `split_from_ticket_id` (for related-ticket chip in app).

**Out of v1:** `split_child_ticket_ids` jsonb on parent (can derive via query on `split_from_ticket_id` + `split_group_id`).

---

## Timeline

**New `event_kind`:** `ticket_split` (semantic writer — **not** DB trigger on `tickets` column change).

| Ticket | `headline` | `detail` |
|--------|------------|----------|
| Parent (ticket 1) | `Ticket split` | `New ticket: {childHumanId}` |
| Child (ticket 2) | `Created from split` | `Split from: {parentHumanId}` |

Follow **`TICKET_TIMELINE.md`** §5 — do not duplicate `created` on child (finalize insert may fire trigger `created`; **child gets trigger `created` + optional `ticket_split`** — product: show **one** row; prefer **`ticket_split` only** if we suppress duplicate in UI mapping, or merge copy in `timelineMapping.ts`). **Implementation note:** On child, if trigger emits `created` and writer emits `ticket_split`, map in app to show split line prominently and de-emphasize generic created, **or** skip `ticket_split` on child and only link in parent — **decide at implement time**; default: **both kinds**, UI shows `Created from split` as primary.

Update **`tests/ticketTimelineV1Kinds.test.js`** or add split-specific test for allowed writer kinds.

**`timelineMapping.ts`:** color for `ticket_split` (e.g. purple / neutral).

---

## Code map (implementation checklist)

| Layer | Planned location |
|-------|------------------|
| Spec | This file |
| Migration | `supabase/migrations/061_ticket_split_v1.sql` |
| Split service | `src/portal/splitTicket.js` or `src/dal/portalTicketSplit.js` |
| Suggest helper | `src/portal/suggestTicketSplit.js` (thin wrapper over `buildIssueTicketGroups`) |
| Routes | `src/portal/registerPortalRoutes.js` — `POST …/tickets/:id/split`, optional `…/split/suggest` |
| Patch ticket 1 | Reuse `portalTicketMutations` / existing PATCH patterns + `mergeChangedByIntoTicketPatch` |
| Create ticket 2 | `finalizeMaintenanceDraft` — mirror `createTicketFromProgramLine.js` location resolution |
| Tests | `tests/portalTicketSplit.test.js` — in-memory Supabase inject; two-ticket happy path; validation errors; assignment copy |
| App proxy | `propera-app/src/app/api/pm/tickets/[ticketRowId]/split/route.ts` |
| App UI | `SplitTicketModal.tsx` + wire in `TicketDetailPanel.tsx` |
| Types | Extend `Ticket` with `splitGroupId?`, `splitFromTicketId?`, `relatedTicketIds?` (optional client enrich) |

**Guardrails:**

- **No** `handleInboundCore` / intake session for split.
- **No** adapter or Twilio/Telegram path.
- **No** finance or cost DAL in split transaction.
- Property targeting from **parent row only** — no hardcoded building strings.

---

## `propera-app` proxy

Forward session Bearer to V2:

```
POST {PROPERA_V2_API_URL}/api/portal/tickets/{ticketRowId}/split
```

Require `ticket.ticketRowId` and `ticket.source === "v2"`.

---

## Acceptance criteria (V1 done)

- [ ] PM opens V2 ticket detail → **Split ticket** → modal with two issue fields and per-side location (defaults from parent).
- [ ] Confirm updates original issue/location and creates exactly one new ticket with copied assignment.
- [ ] New ticket appears in ticket list; parent shows link or timeline reference to child.
- [ ] Child timeline or header indicates split from parent id.
- [ ] GAS / imported-history tickets: control hidden or disabled with clear message.
- [ ] Suggest split (if shipped): returns ≥2 issue strings for “icemaker and tube clogged” class text in unit tests.
- [ ] `npm test` in `propera-v2` includes split service tests.
- [ ] **`OUTSIDE_CURSOR.md`** updated with migration **061** apply step.

---

## Deferred (explicitly not V1)

| Item | Notes |
|------|--------|
| 3+ tickets in one action | Add rows in modal + batch finalize |
| Copy attachments to child | Checkbox + storage copy |
| Change assignment policy on split | Replace “copy from parent” with unassigned or policy re-resolve |
| Auto-split on portal create | Still intake/finalize domain |
| Related-ticket graph UI | List all tickets sharing `split_group_id` |
| GAS ticket split | Out of scope |

---

## References

| Topic | Doc / code |
|-------|------------|
| Portal structured create | `buildRouterParameterFromPortal`, `finalizeMaintenanceDraft`, `docs/PARITY_LEDGER.md` portal `create_ticket` |
| Prefill + finalize pattern | `src/pm/createTicketFromProgramLine.js`, `src/dal/turnovers.js` `createTicketFromTurnoverItem` |
| New ticket location UX | `propera-app/src/components/NewTicketModal.tsx` |
| Deterministic issue groups | `src/brain/core/finalizeTicketGroups.js`, `tests/splitIssueGroups.test.js` |
| Timeline contract | `docs/TICKET_TIMELINE.md` |
| PM assignment guard | `docs/PM_ASSIGNMENT_OVERRIDE.md`, `src/dal/ticketAssignmentGuard.js` |

---

*When V1 ships: update this file **Status**, **`HANDOFF_LOG.md`**, and **`AGENTS.md`** “Where everything lives” row.*
