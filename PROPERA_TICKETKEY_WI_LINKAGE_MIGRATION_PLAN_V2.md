# Propera TicketKey WI Linkage Migration Plan � V2 (Scoped)

**Status: Phase 1 COMPLETED. Migration stops here.**

- **Phase 1 (steps 1�6):** Implemented in code. WorkItems schema has TicketKey; creation paths pass and persist it; `workItemGetById_` returns it; `findTicketRowByTicketKey_` exists; lifecycle and policy use TicketKey-first resolution with TicketRow fallback and **WI_LEGACY_ROW_FALLBACK_USED** logging. Step 7 (backfill) is manual-only � no code.
- **Phase 2 and beyond:** Not in scope. No further code changes planned. Portal, vendor, AppSheet, Directory, AI queue, and reporting remain unchanged.

---

**Objective:** Enable lifecycle to work correctly for active Work Items and ensure all new Work Items are linked canonically going forward.

This is **not** a full system migration, historical cleanup, or refactor of all TicketRow usage. It is **not** about Portal, Vendor, AppSheet, or external APIs. It is **only** about lifecycle stability, correct linkage for active WIs, and correct linkage for all new WIs.

---

## 1. Executive summary (focused on lifecycle enablement)

- **Problem:** Lifecycle and policy depend on WI?ticket linkage. Today that link is `WorkItems.TicketRow` (a Sheet1 row number). Row numbers are unstable (insertions, deletions, sorting). When they are wrong, lifecycle and policy read the wrong ticket or fail.
- **Goal:** For lifecycle and policy, use **TicketKey** (UUID on Sheet1, immutable) as the canonical link. Add `WorkItems.TicketKey`; write it on every new WI; have lifecycle and policy resolve the ticket row via TicketKey when present, with fallback to TicketRow and logging when TicketKey is missing.
- **Outcome:** New WIs are linked correctly. Active WIs that lifecycle operates on can be backfilled manually (TicketKey set once). Lifecycle and policy reads become stable. No change to Portal, vendor, AppSheet, or external contracts in this phase.

---

## 2. Reduced scope definition

### IN SCOPE (Phase 1 � completed)

| Area | What to do |
|------|------------|
| **WorkItems schema** | Add column `TicketKey`. |
| **WI creation path** | When creating a WI from ticket creation (`finalizeDraftAndCreateTicket_`, manager path), pass `ticket.ticketKey` from `processTicket_` into `workItemCreate_` and persist it. Keep writing TicketRow as cache. |
| **Lifecycle read path** | When lifecycle builds facts or needs ticket data, prefer TicketKey: if WI has TicketKey, resolve row via `findTicketRowByTicketKey_(sheet, wi.ticketKey)` and read Sheet1 at that row; else use `wi.ticketRow` and log fallback. Expose `ticketKey` on WI in `workItemGetById_`. |
| **Policy read path** | When policy needs ticket fields (e.g. category, PREF_WINDOW) and they are not on WI, resolve row the same way: TicketKey ? row if present, else TicketRow + log. |
| **Helpers (minimal)** | Introduce `findTicketRowByTicketKey_(sheet, ticketKey)`. Use it only where lifecycle and policy need to go from TicketKey to Sheet1 row. Optionally `findWorkItemIdByTicketKey_(ticketKey)` if lifecycle needs �ticketKey ? WI� in this phase; otherwise defer. |
| **Backfill** | Manual only, for **active/non-terminal** WIs that lifecycle will operate on. No backfill for closed/historical WIs. No automated backfill using TicketRow. |

### OUT OF SCOPE (Phase 2+ � do not touch now)

| Area | Status |
|------|--------|
| Portal flows | No change. |
| Vendor flows | No change. |
| AppSheet / webhook contracts | No change. |
| Directory redesign / ACTIVE_TICKET_KEY | Deferred. |
| AI queue TicketKey | Deferred. |
| Reporting / analytics | No change. |
| System-wide replacement of TicketRow | Deferred. |
| External APIs | No change. |

---

## 3. Corrected TicketRow rule (read vs write)

### WRITE (forbidden)

- **Never** set or backfill `WorkItems.TicketKey` using a value inferred from TicketRow.
- Do not derive TicketKey from row (e.g. �read Sheet1 at row R, get TicketKey, write it to WI� as an automated backfill that uses row as the source of truth for which WI to update). Manual backfill is operator-driven: operator identifies the correct WI and the correct ticket and sets WI.TicketKey to that ticket�s TicketKey.

### READ (allowed for runtime lookup only)

- **Allowed for runtime lookup only:** row ? read Sheet1 ? get TicketKey ? use for resolution in the current operation. This does not authorize writing or repairing WI.TicketKey.
- So: when the system has a row (e.g. from Directory PendingRow, or from `wi.ticketRow`), it may read `Sheet1.TicketKey` at that row and use that TicketKey for resolution in that operation only. Not for silent persistence, repair, or backfill.

**Summary**

| Operation | Rule |
|-----------|------|
| **row ? read Sheet1 ? get TicketKey ? use for lookup** | ? Allowed. |
| **WI.TicketKey = value inferred from WI.TicketRow (or any row)** | ? Forbidden. |

---

## 4. Simplified backfill strategy

- Backfill **only** WIs that lifecycle can still touch (i.e. not in a terminal state).
- **Do not** backfill terminal states: DONE, CANCELED, or equivalent terminal states. Those WIs are irrelevant unless they block something.
- **Do not** attempt to repair closed or historical WIs.
- **No** automated backfill that uses TicketRow to set TicketKey (no script that �for each WI with TicketRow but no TicketKey, read row, write TicketKey�).
- **Manual only:** Operator identifies the correct ticket (e.g. by TicketID or TicketKey in Sheet1) and the correct WI, then sets `WorkItems.TicketKey` for that WI to the ticket�s TicketKey (e.g. via sheet edit or one-off script with explicit input). No over-engineered operator tooling required for Phase 1.

---

## 5. Phase 1 execution plan (completed)

| Step | Action | Status |
|------|--------|--------|
| 1 | **Schema:** Add `TicketKey` column to WorkItems (backbone/header). | Done |
| 2 | **Create path:** In `finalizeDraftAndCreateTicket_` and any manager path that creates a WI from a ticket, pass `ticket.ticketKey` (from `processTicket_` return) into `workItemCreate_`. In `workItemCreate_`, persist `obj.ticketKey` in the new column. Continue to persist TicketRow. | Done |
| 3 | **workItemGetById_:** Include `ticketKey` in the returned WI object (read from WorkItems TicketKey column). | Done |
| 4 | **Helper:** Implement `findTicketRowByTicketKey_(sheet, ticketKey)`: scan Sheet1 COL.TICKET_KEY for matching value; return 1-based row or 0. Use only where lifecycle or policy need TicketKey to row. | Done |
| 5 | **Lifecycle:** In `buildLifecycleFacts_` (or wherever facts need ticket data), if `wi.ticketKey` is present, get row via `findTicketRowByTicketKey_(sheet, wi.ticketKey)` and use that row for any Sheet1 read; else use `wi.ticketRow` and log **WI_LEGACY_ROW_FALLBACK_USED** (with wiId and context). Expose `facts.ticketKey` when available. | Done |
| 6 | **Policy:** Where policy reads Sheet1 by `wi.ticketRow` (e.g. category, PREF_WINDOW), switch to: if `wi.ticketKey` present, get row via `findTicketRowByTicketKey_` and read; else use `wi.ticketRow` and log **WI_LEGACY_ROW_FALLBACK_USED**. | Done |
| 7 | **Backfill:** Manually set TicketKey only on WIs lifecycle can still touch (non-terminal: not DONE, CANCELED, or equivalent). Do not backfill terminal/closed WIs. No automation from TicketRow. | Manual only (no code) |

No changes to Portal, vendor, AppSheet, Directory, AI queue, or reporting in Phase 1. **Migration stops here; Phase 2 is not in scope.**

---

## 6. Future phases (not in scope � migration stopped)

**Phase 2 (deferred / not planned)**

- Expand TicketKey usage across the system (Portal, vendor, AppSheet, etc.).
- Replace TicketRow-based resolution with TicketKey where appropriate.
- Optional: Directory ACTIVE_TICKET_KEY or other Directory use of TicketKey.
- Reduce or remove TicketRow dependency over time.

**Deferred**

- AI queue TicketKey propagation.
- External API changes.
- Performance optimizations (e.g. indexing by TicketKey).
- Full historical cleanup of closed WIs.

---

## 7. Guardrails (unchanged but concise)

- **Never** write or backfill `WI.TicketKey` using a value inferred from TicketRow.
- **Allowed (runtime only):** row ? read Sheet1 ? get TicketKey ? use for resolution in the current operation. Does not authorize writing or repairing WI.TicketKey.
- **New WIs:** Always have TicketKey set at creation from `processTicket_` return.
- **Legacy WIs (no TicketKey):** Lifecycle and policy fall back to TicketRow and log **WI_LEGACY_ROW_FALLBACK_USED**.
- **Deterministic failure:** If lifecycle or policy requires ticket data and resolution fails (e.g. TicketKey points to missing row), log and fail the operation; do not guess or attach to another ticket.

**Identity model (unchanged)**

- **TicketKey** = canonical immutable ticket identity.
- **WorkItemId** = canonical WI identity.
- **TicketID** = display only.
- **TicketRow** = cache only; legacy fallback when TicketKey is missing.

---

**Priority:** Stabilize lifecycle, avoid introducing new corruption, make all new data clean. Not perfect historical reconstruction or full system migration in one step.

---

**Doctrine during execution**

- TicketKey = authority  
- TicketRow = legacy cache  
- New WIs must always get TicketKey  
- Old active WIs get manual repair only  
- Closed history is irrelevant unless it blocks something  
