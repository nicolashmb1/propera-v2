# Propera TicketKey WI Linkage Migration Plan

**Status: Phase 1 (scoped) COMPLETED. Migration stops here.**

- **Completed (Phase 1, per V2):** WorkItems schema has TicketKey; creation paths pass and persist it; `workItemGetById_` returns ticketKey; `findTicketRowByTicketKey_` implemented; lifecycle (`buildLifecycleFacts_`) and policy (buildPolicyFacts_, ASSIGN_VENDOR_BY_POLICY) use TicketKey-first resolution with TicketRow fallback and **WI_LEGACY_ROW_FALLBACK_USED** logging. Backfill is manual-only.
- **Not in scope / stopped:** Phases 2–6 below (Portal, vendor, AppSheet, Directory, findWorkItemIdByTicketKey_, full call-site rollout, etc.) are not planned. No further code changes.

---

**MAP + EXECUTION PLAN — Phase 1 executed; remainder is reference only.**

**Critical constraint:** No backfill or migration may rely on TicketRow. TicketRow cannot be trusted and must not be used to derive TicketKey. Backfill will be manual or via safe alternative methods.

**Goal:** Migrate WI↔Ticket linkage from `WorkItems.TicketRow → Sheet1 row` (UNSAFE) to `WorkItems.TicketKey → Sheet1.TicketKey` (CANONICAL).

---

## 1. Executive summary

- **Current state:** The only link between a Work Item and a Sheet1 ticket is `WorkItems.TicketRow` (a 1-based row number). Row numbers are positional, can change with insertions/deletions/sorting, and are not immutable identity. TicketKey exists on Sheet1 (COL 51, UUID) but is not stored on WorkItems and is not used for linkage anywhere.
- **Target state:** `WorkItems.TicketKey` holds the same UUID as `Sheet1.TicketKey`. That becomes the **only authoritative** WI↔Ticket link. TicketRow remains as an optional cache for performance; it is never used to derive or validate TicketKey.
- **Approach:** Add TicketKey to WorkItems schema; write it at WI creation from `processTicket_`’s return value; introduce dual-mode read (primary by TicketKey, fallback by TicketRow with logging); never derive TicketKey from TicketRow; no automated backfill from row; manual repair only; phased rollout with clear guardrails and log events.

---

## 2. Current dependency map (TicketRow / findWorkItemIdByTicketRow_ / row-based linkage)

All references are to **PROPERA MAIN.gs** unless noted. Line numbers are approximate (main file).

### Create-time

| Location | What depends on TicketRow | Notes |
|----------|----------------------------|--------|
| `finalizeDraftAndCreateTicket_` | `workItemCreate_({ ..., ticketRow: loggedRow })` | WI is created with TicketRow only; no TicketKey passed. |
| Manager-created ticket path | `workItemCreate_({ ..., ticketRow: loggedRow })` (mgr queue) | Same pattern. |
| `syncActiveWorkItemFromTicketRow_(phoneAny, ticketRow, ...)` | `workItemUpdate_(wi, { ..., ticketRow: Number(ticketRow) })` | Updates WI’s TicketRow from Directory PendingRow (row number). Called when stage/Directory points to a ticket row. |

### Read-time (WI from ticket or ticket from WI)

| Location | Function / usage | Notes |
|----------|-------------------|--------|
| Portal PM: get ticket | `findWorkItemIdByTicketRow_(row)` after `findTicketRowByTicketId_(sheet, ticketId)` | Returns WI for Portal ticket fetch; row from TicketID. |
| Portal PM: update category | `findWorkItemIdByTicketRow_(row)` (line ~3585) | Policy rerun after category change; row from sheet. |
| Portal PM: complete ticket | `findWorkItemIdByTicketRow_(row)` (line ~3628) | WI transition to DONE; row from TicketID. |
| Portal PM: delete ticket | `findTicketRowsByTicketId_` then logic; WI resolution may use row. | Delete path. |
| AppSheet / webhook OWN_DISPATCH | `ticketRow = Number(data.ticketRow)`; `wiId = findWorkItemIdByTicketRow_(ticketRow)` (line ~7839) | External payload sends ticketRow; used to resolve WI. |
| Manager SETSTATUS (close) | `resolveTicketRow_(sheet, cmdObj.ref)` → `rowIndex`; `closeWiId = findWorkItemIdByTicketRow_(rowIndex)` (line ~14323) | When status set to done/closed, WI is looked up by row and transitioned. |
| Queue advance (next queued ticket) | `findNextQueuedTicketRow_(sheet, tenantPhone)` → `nextRow`; then scan WorkItems by `TicketRow` matching `claimed.nextRow` (line ~10567) | Matches WI to ticket by row number. |
| `workItemGetById_` return | `ticketRow: v_("TicketRow")` | Every WI read exposes TicketRow; consumers (e.g. POLICY_ENGINE, LIFECYCLE) use it. |

### Lifecycle

| Location | What depends on TicketRow | Notes |
|----------|----------------------------|--------|
| **LIFECYCLE_ENGINE.gs** | `buildLifecycleFacts_`: `facts.ticketRow = wi.ticketRow` (line ~132) | Lifecycle facts carry TicketRow from WI; used for policy/timers (e.g. Sheet1 reads in policy). |
| POLICY_ENGINE (facts) | Uses `wi.ticketRow` only to **read** Sheet1 (CAT, PREF_WINDOW) when category/schedule not on WI (lines 280, 300) | Read-only use of row to read ticket columns; not linkage per se but depends on row being correct. |

### Resolver

| Location | What depends on TicketRow | Notes |
|----------|----------------------------|--------|
| Staff lifecycle / STAFF_LIFECYCLE_COMMAND_RESOLVER | No direct use of TicketRow for linkage. | Resolver uses WI list from lifecycle; WI object has ticketRow; no `findWorkItemIdByTicketRow_` in resolver. |
| POLICY_ENGINE | `wi.ticketRow` to read Sheet1 for category and hasSchedule (see above). | Resolver/policy facts depend on WI having a valid row to read ticket fields. |

### Reporting / tenant-facing

| Location | What depends on TicketRow | Notes |
|----------|----------------------------|--------|
| `findTenantTicketRows_` | Returns row numbers for a phone. | Used for ticket list; row-based. |
| `findNextQueuedTicketRow_` | Returns next queued ticket row. | Queue logic. |
| `resolveTicketRow_(sheet, ref)` | Resolves ref (e.g. ticketId or row) to row index. | Manager commands. |
| Vendor/decision flows (lines ~19550, 19692, 19707, 19734, 19749, 19760, 19787, 19802, 19829) | `findTicketRowById_(sheet, ticketId)` → row; then `findWorkItemIdByTicketRow_(row)` | Multiple vendor/approval paths: resolve ticket by ID to row, then WI by row. |

### Legacy / external

| Location | What depends on TicketRow | Notes |
|----------|----------------------------|--------|
| Directory | `PendingRow` (column 7) stores Sheet1 row number. | Directory points to “current” ticket by row. |
| Session | `activeArtifactKey` can be `"ROW:" + loggedRow`. | Session can key by row. |
| `enqueueAiQForTicketCreate_(ticketRow, payload, src)` | Idempotency/dedupe key uses ticketRow; queue row stores TicketRow. | AI queue schema. |
| Portal API response | Returns `ticketRow` to client. | apps-script/ProperaPortalAPI.gs. |
| AppSheet / webhook | Inbound `data.ticketRow` from external system. | Legacy contract. |

---

## 3. Target model

| Concept | Role |
|---------|------|
| **TicketKey** | Canonical immutable ticket identity (UUID). Single source of truth for “which ticket” in Sheet1. Authoritative for WI↔Ticket link when stored on WorkItems. |
| **WorkItemId** | Canonical WI identity. Unchanged. |
| **TicketID** | Display / human-facing (e.g. PENN-031626-0245). May mutate (e.g. UNK upgrade). Not used for authoritative linkage. |
| **TicketRow** | Non-authoritative cache. Optional on WI and Directory. Used only for performance (e.g. direct sheet access) when TicketKey is also present. Never used to derive TicketKey or to infer linkage. |

**Invariants:**

- For every WI that represents a ticket: `WorkItems.TicketKey` = `Sheet1.TicketKey` for that ticket’s row.
- Linkage resolution: **primary** by TicketKey (Sheet1 and WorkItems); **fallback** by TicketRow only when TicketKey is missing on the WI, with logging.
- No code path may derive or backfill TicketKey from TicketRow.

---

## 4. Schema changes

### WorkItems sheet

- **Add column:** `TicketKey` (string, UUID). Position: after `TicketRow` (or as defined by backbone header order). Ensure `ensureWorkBackbone_` / `getOrCreateSheet_(WORKITEMS_SHEET, [...])` includes `"TicketKey"` in the header list so new sheets and upgrades get it.
- **TicketRow:** Remain. Semantics change to **cache-only**. Still written at creation and optionally updated when Directory PendingRow is set (e.g. syncActiveWorkItemFromTicketRow_), but not used for authoritative linkage. Read path uses TicketRow only when TicketKey is missing (legacy fallback).

### Sheet1

- No schema change. `COL.TICKET_KEY` (51) already exists; TicketKey is written at creation in `processTicket_`.

### Directory

- **ACTIVE_TICKET_KEY (column 11):** Evaluate only.
  - **Option A — Ignore:** Leave column 11 unused. Do not read or write it. Directory continues to use PendingRow (row number) as the “current ticket” pointer; accept that it is cache-only and may be wrong if rows shift.
  - **Option B — Activate:** Define that column 11 holds the **TicketKey** of the active ticket for that phone. When setting PendingRow (e.g. finalize, queue advance), also set column 11 to the ticket’s TicketKey. Lookups that currently use PendingRow to find the ticket could then optionally resolve by TicketKey first (e.g. findTicketRowByTicketKey_) and fall back to row. Requires DAL helpers to write/read column 11.
- **Recommendation:** Defer activation until after WorkItems.TicketKey and dual-mode read are in place. Then, if desired, add Directory.TicketKey write in the same code paths that set PendingRow, and use it for “current ticket” resolution where appropriate.

---

## 5. Creation path (new authoritative flow)

**Single authoritative path:** All ticket creation goes through `processTicket_`; all WI creation for that ticket goes through callers that receive `ticket.ticketKey` and pass it into `workItemCreate_`.

| Step | Owner | Action |
|------|--------|--------|
| 1 | `processTicket_` | Already returns `{ ..., ticketKey }` (and rowIndex, ticketId). No change to return shape. |
| 2 | `finalizeDraftAndCreateTicket_` | Receives `ticket` from `processTicket_`. When calling `workItemCreate_`, pass **ticketKey** and **ticketRow** (loggedRow): `workItemCreate_({ ..., ticketKey: ticket.ticketKey || "", ticketRow: loggedRow })`. TicketKey is required for new WIs; TicketRow is optional cache. |
| 3 | Manager-created ticket path | Same: when creating WI for the ticket (e.g. mgr queue or after finalize), pass `ticket.ticketKey` and `loggedRow` into `workItemCreate_`. |
| 4 | `workItemCreate_` | Accept `obj.ticketKey`. Persist it: add to row array in the correct column (TicketKey). Persist `obj.ticketRow` as today (cache). Ensure backbone has TicketKey column. |
| 5 | `syncActiveWorkItemFromTicketRow_` | When updating WI with a new ticket row (e.g. queue advance), if the caller can provide the TicketKey for that row, pass it and update `workItemUpdate_(wi, { ticketKey, ticketRow })`. If caller only has row, update only `ticketRow` (cache) and leave TicketKey unchanged; do not derive TicketKey from row. |

**Rule:** Every path that creates a WI for a ticket must have access to the ticket’s TicketKey (from `processTicket_` return or from Sheet1 read by TicketKey). No WI creation for a ticket may set TicketKey from TicketRow or leave it blank when the ticket row is known at creation (blank only for legacy/WIs created before this plan).

---

## 6. Read path (dual mode, safe)

### Primary: resolve by TicketKey

- **findWorkItemIdByTicketKey_(ticketKey)**  
  - Input: TicketKey (UUID string).  
  - Behavior: Scan WorkItems sheet for row where TicketKey column equals `ticketKey`. Return WorkItemId of that row, or "" if not found.  
  - Use: Whenever a ticket is identified by TicketKey (e.g. from Sheet1, Directory, or API) and the WI is needed.

- **findTicketRowByTicketKey_(sheet, ticketKey)**  
  - Input: Sheet (Sheet1), TicketKey (UUID string).  
  - Behavior: Scan Sheet1 COL.TICKET_KEY for matching value; return 1-based row number, or 0 if not found.  
  - Use: When the system has TicketKey and needs the Sheet1 row (e.g. to read/update ticket cells).

### Fallback: TicketRow only when TicketKey is missing

- When a WI has no TicketKey (empty or missing column), callers that need to resolve “ticket → WI” or “WI → ticket” may use the **existing** `findWorkItemIdByTicketRow_(ticketRow)` or WI.ticketRow, with **mandatory logging**: log **WI_LEGACY_ROW_FALLBACK_USED** with identifiers (workItemId and/or ticketRow, context).
- When a caller has only a row number (e.g. Directory PendingRow, external payload):  
  - Prefer: Resolve row → TicketKey (read Sheet1 at that row, COL.TICKET_KEY), then use findWorkItemIdByTicketKey_(ticketKey). If TicketKey is blank at that row, treat as legacy; fall back to findWorkItemIdByTicketRow_(row) and log WI_LEGACY_ROW_FALLBACK_USED.  
  - Never: Derive or “backfill” TicketKey from the row number.

### Never

- Do not infer or generate TicketKey from TicketRow at runtime.
- Do not auto-heal or “repair” linkage by setting WI.TicketKey from the row’s TicketKey in an automated backfill that is triggered by “missing” TicketKey (that would require trusting row; out of scope for this plan).

### Call site strategy (high level)

- **Portal PM, manager SETSTATUS, vendor flows, queue advance, AppSheet:** Where the code today uses `findWorkItemIdByTicketRow_(row)`, change to: if row is known, read Sheet1 at row for COL.TICKET_KEY; if present, call findWorkItemIdByTicketKey_(thatKey); else call findWorkItemIdByTicketRow_(row) and log WI_LEGACY_ROW_FALLBACK_USED. Where the code has TicketKey (e.g. from WI), use findTicketRowByTicketKey_(sheet, ticketKey) instead of relying on TicketRow when TicketKey is present.
- **POLICY_ENGINE / LIFECYCLE:** When building facts or reading ticket fields, if WI has TicketKey, prefer findTicketRowByTicketKey_ to get row (or read ticket by TicketKey); if TicketKey missing, use wi.ticketRow and log WI_LEGACY_ROW_FALLBACK_USED.

---

## 7. Manual backfill strategy (no automated backfill using TicketRow)

**No automated backfill that uses TicketRow to set TicketKey.** TicketRow is not trusted; any such backfill could attach WIs to wrong tickets if rows have shifted or data is corrupted.

### System behavior when WI.TicketKey is missing

- **Reads:** Allow legacy fallback (resolve by TicketRow) and **log every time**: **WI_LEGACY_ROW_FALLBACK_USED** with workItemId, ticketRow, and context (e.g. caller name or intent).
- **Writes:** When updating a ticket (e.g. status, category) and the WI has no TicketKey, continue to resolve by TicketRow for the update; log WI_LEGACY_ROW_FALLBACK_USED. Do not write TicketKey from row.
- **Lifecycle / policy:** When WI has no TicketKey, use ticketRow for reads (e.g. Sheet1 CAT, PREF_WINDOW) and log WI_LEGACY_ROW_FALLBACK_USED so operators can see which WIs are legacy.

### When linkage cannot be resolved

- If resolution by TicketKey returns no WI and fallback by TicketRow also returns no WI (or is not allowed in that code path), log **WI_TICKET_LINK_UNRESOLVED** with available context (ticketKey, ticketRow, ticketId, intent) and fail the operation deterministically (e.g. do not create or update WI; return error or no-op as appropriate).

### Manual repair

- **Operator** identifies the correct ticket (e.g. by TicketID, TicketKey, or row in UI) and the correct WI.
- **Repair action:** Set `WorkItems.TicketKey` for that WI to the ticket’s TicketKey (e.g. via script, sheet edit, or future admin tool). No automatic derivation from row.
- Optional: When repairing, set TicketRow to the current row for cache consistency; still do not derive TicketKey from it.

### Logging events (define and use)

| Event | When | Payload (example) |
|-------|------|--------------------|
| **WI_TICKETKEY_MISSING** | When a WI is read or used and has no TicketKey (empty/missing). | workItemId, context (e.g. "lifecycle", "policy", "portal_complete"). |
| **WI_LEGACY_ROW_FALLBACK_USED** | When resolution or ticket read uses TicketRow because TicketKey is missing or not used. | workItemId, ticketRow, context. |
| **WI_TICKET_LINK_UNRESOLVED** | When a required WI↔ticket resolution fails (by TicketKey and, where allowed, by TicketRow). | ticketKey if any, ticketRow if any, ticketId if any, intent/operation. |

---

## 8. Safety / logging plan

### System must NEVER

- Derive TicketKey from TicketRow (no formula, no “look up row and set WI.TicketKey” in automated backfill).
- Guess linkage from unit/property/text or other heuristics to set TicketKey.
- Silently reassign WIs to a different ticket (any change of WI↔ticket link must be explicit or logged).

### System MUST

- Log all **WI_TICKETKEY_MISSING** cases when a WI without TicketKey is used.
- Log all **WI_LEGACY_ROW_FALLBACK_USED** when TicketRow is used for linkage or ticket read.
- Fail deterministically when linkage is required and cannot be resolved (log **WI_TICKET_LINK_UNRESOLVED** and abort the operation or return error).

### Deterministic failure

- If an operation requires “the WI for this ticket” or “the ticket for this WI” and resolution (by TicketKey, then by TicketRow if allowed) fails, do not create a new WI, do not guess, do not attach to another ticket. Return a clear result (e.g. ok: false, reason: "WI_TICKET_LINK_UNRESOLVED") and ensure the log event is emitted.

---

## 9. Rollout phases

| Phase | Content | Status |
|-------|--------|--------|
| **1. Schema** | Add TicketKey column to WorkItems (backbone/header). No behavior change yet; column may be empty. | Done |
| **2. Write** | All new WIs created from ticket creation paths persist TicketKey (from processTicket_ return). TicketRow still written as cache. Existing WIs unchanged. | Done |
| **3. Dual read** | Introduce findWorkItemIdByTicketKey_ and findTicketRowByTicketKey_. Call sites that need “ticket → WI” or “WI → ticket” use TicketKey first; if WI has no TicketKey or resolution fails, fall back to TicketRow and log WI_LEGACY_ROW_FALLBACK_USED. Add WI_TICKETKEY_MISSING and WI_TICKET_LINK_UNRESOLVED where appropriate. | Done for lifecycle + policy only |
| **4. Manual cleanup** | Operators identify legacy WIs (from logs or report) and manually set TicketKey where the correct ticket is known. No automated backfill from row. | Manual only; migration stopped |
| **5. Reduce TicketRow dependency** | Over time, prefer TicketKey in new features; keep TicketRow fallback with logging for legacy WIs. Optionally: when updating WI (e.g. syncActiveWorkItemFromTicketRow_), set TicketKey if the caller provides it (e.g. from Sheet1 read at that row). | Not in scope |
| **6. Final state** | TicketRow is cache-only (or removable later). All linkage semantics are by TicketKey. Legacy WIs without TicketKey continue to work via fallback with logging until manually repaired or retired. | Not in scope |

---

## 10. Risks

| Risk | Mitigation |
|------|------------|
| Legacy WIs never get TicketKey | Accept dual-mode indefinitely; log fallback use; manual repair as needed; no silent wrong linkage. |
| Directory PendingRow / external systems still send row | Keep fallback: row → read Sheet1.TicketKey at row → findWorkItemIdByTicketKey_; if Sheet1 cell empty, fallback findWorkItemIdByTicketRow_ + log. Do not derive TicketKey from row. |
| Performance (scan WorkItems by TicketKey) | WorkItems sheet is one table; scan by TicketKey column is O(n). If n grows large, consider indexing (e.g. separate lookup sheet or script-side cache) later. TicketRow fallback keeps existing row-based lookup for legacy. |
| Corrupted or duplicate TicketRow on WI | Once TicketKey is authoritative, wrong TicketRow only affects cache (e.g. wrong row read for category). Logging and manual repair still apply; no backfill from row. |
| createTicketFromPendingIssue_ or other legacy paths | Remove or fix to use Utilities.getUuid() for TicketKey so no non-UUID keys are introduced (see Part 8 below). |

---

## 11. Deprecated path fix (createTicketFromPendingIssue_)

- **createTicketFromPendingIssue_** (PROPERA MAIN.gs) is deprecated and currently sets TicketKey from `ctx.inboundKey || ctx.ticketKey || "PHONE:...|TS:..."` (non-UUID).
- **Required:** Either remove the function and all references, or change it so that when it creates a row it sets `TicketKey = Utilities.getUuid()` (and never derives from inboundKey/ctx for TicketKey). No non-UUID TicketKeys are allowed for canonical linkage.

---

## 12. Final recommendation

- **Proceed** with the migration as mapped: add WorkItems.TicketKey, wire creation path, implement dual-mode read with findWorkItemIdByTicketKey_ and findTicketRowByTicketKey_, and adopt the logging and guardrails above.
- **Do not** implement any backfill that derives TicketKey from TicketRow; treat TicketRow as untrusted for identity.
- **Contain** legacy: new data is clean (TicketKey set at creation); old data uses fallback with logging until manually repaired.
- **Defer** Directory.ACTIVE_TICKET_KEY activation until Phase 3 or later, then decide whether to store TicketKey there and use it for “active ticket” resolution.
- **Fix or remove** createTicketFromPendingIssue_ so that no new tickets get non-UUID TicketKeys.

This plan keeps the system safe under the assumption that TicketRow may already be partially corrupted and avoids introducing further corruption by never trusting row for identity.
