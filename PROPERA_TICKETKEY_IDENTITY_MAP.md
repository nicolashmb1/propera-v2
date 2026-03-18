# Propera TicketKey Identity Map

**Purpose:** Map how `TicketKey` is created, stored, propagated, and read to assess suitability as the canonical immutable parent identity for tickets and for WI↔Ticket linkage. **MAP ONLY — no code changes.**

---

## 1. Executive verdict

**TicketKey is suitable as the canonical immutable parent identity for tickets**, with conditions. It is generated exactly once per new ticket via `Utilities.getUuid()` inside the single canonical creation path (`processTicket_`), written only to Sheet1 at column 51, and no active code path overwrites or clears it. **However**, it is not yet used as the WI↔Ticket link: WorkItems has no TicketKey column (only TicketRow), Directory has an ACTIVE_TICKET_KEY column that is never written in the traced code, and no resolver or DAL uses TicketKey for lookups. One deprecated path (`createTicketFromPendingIssue_`) generates a non-UUID TicketKey (derived from ctx), so legacy or reactivated code could introduce non-canonical keys. **Verdict: Yes with conditions** — promote TicketKey as canonical after adding it to WorkItems and wiring it through creation and lookup; deprecate or remove the deprecated path that does not use UUID.

---

## 2. Ticket creation path map

All active ticket creation flows go through **`processTicket_`** (PROPERA MAIN.gs). Step-by-step:

| Step | Function | Role |
|------|----------|------|
| 1 | Caller (e.g. `finalizeDraftAndCreateTicket_`, `mgrCreateTicketForTenant_`, staff capture finalize) | Builds payload (from, propertyName, unitFromText, messageRaw, inboundKey, etc.) and calls `processTicket_(sheet, sp, creds, payload)`. |
| 2 | `processTicket_(sheet, props, creds, payload)` | Single gateway. Does not write Directory, Session, or send tenant SMS. |
| 3 | Inside `processTicket_`: `withWriteLock_("TICKET_CREATE", () => { ... })` | Atomic block: dedupe or create row. |
| 4 | **DEDUPE BRANCH** (if `inboundKey` and THREAD_ID match in last 120 rows) | Reads existing row: `sheet.getRange(existingRow, ticketKeyCol).getValue()` → returns `{ deduped: true, rowIndex, ticketId, ticketKey: existingTicketKey }`. **TicketKey is not generated; existing value is returned.** |
| 5 | **CREATE BRANCH** (new row) | `rowIndex = sheet.getLastRow() + 1`. Build `newRow` array (MAX_COL). Set TICKET_ID via `makeTicketId_(propForId, now, rowIndex)`. Then `const ticketKey = Utilities.getUuid();` and `setRowCol_(newRow, "TICKET_KEY", ticketKey);`. Single write: `sheet.getRange(rowIndex, 1, 1, MAX_COL).setValues([newRow]);`. Returns `{ deduped: false, rowIndex, ticketId: safeTicketId, ticketKey }`. |
| 6 | After lock (same function) | `createRes.ticketKey` used only to pass through return value. No second write to TicketKey. |
| 7 | Caller (e.g. `finalizeDraftAndCreateTicket_`) | Receives `ticket.ticketId`, `ticket.rowIndex`/`ticket.row`, `ticket.ticketKey`. Uses `loggedRow`, `ticketId` for WI create, Directory, Session, AI enqueue. **TicketKey is not passed to `workItemCreate_` and not written to Directory in the current code.** |

**Entry points that call `processTicket_`:**

- **finalizeDraftAndCreateTicket_** (line ~2901): tenant draft finalization, staff capture finalization, Portal-triggered finalization. Payload includes `inboundKey` (e.g. STAFFCAP:D37:..., or phone-based).
- **mgrCreateTicketForTenant_** (line ~3737): manager-created ticket; then same flow may call `finalizeDraftAndCreateTicket_` again with `syntheticInboundKey`.
- **handleSmsCore_** path (line ~17144): `processTicket_(sheet, sp, creds, {...})` for SMS-driven create.

There is no other active path that creates a Sheet1 ticket row without going through `processTicket_`. The only other writer of `COL.TICKET_KEY` is **createTicketFromPendingIssue_** (line 10904), which is explicitly **DEPRECATED** and not called by the current flows.

---

## 3. TicketKey generation source

| Aspect | Detail |
|--------|--------|
| **Function** | `processTicket_` (PROPERA MAIN.gs), inside `withWriteLock_("TICKET_CREATE", () => { ... })`. |
| **Exact location** | After `setRowCol_(newRow, "TICKET_ID", safeTicketId);`, before `sheet.getRange(rowIndex, 1, 1, MAX_COL).setValues([newRow]);`. Lines 8258–8259 (PROPERA MAIN.gs): `const ticketKey = Utilities.getUuid();` and `setRowCol_(newRow, "TICKET_KEY", ticketKey);`. |
| **Algorithm** | `Utilities.getUuid()` — Google Apps Script built-in; produces a UUID (RFC 4122–style). No custom concatenation, hash, or timestamp. |
| **When** | Only in the **CREATE** branch (new row). Not in the DEDUPE branch (existing row’s TicketKey is read and returned). |
| **Guard** | Generation happens inside the same lock that writes the row; no separate “generate then write” gap. |

**Deprecated path (do not use as canonical):**  
`createTicketFromPendingIssue_(sheet, ctx)` (line 10875):  
`const ticketKey = String(ctx.inboundKey || ctx.ticketKey || "").trim() || ("PHONE:" + phone + "|TS:" + now.getTime());`  
So TicketKey there is **not** a UUID; it is inboundKey, or ctx.ticketKey, or a synthetic key. That function is marked deprecated and replaced by `finalizeDraftAndCreateTicket_` → `processTicket_`.

---

## 4. Storage map

| Location | Has TicketKey? | How it gets there | Read / used as key? |
|----------|----------------|-------------------|----------------------|
| **Sheet1 (ticket log)** | Yes. Column `COL.TICKET_KEY` = 51. | Written once in `processTicket_` via `setRowCol_(newRow, "TICKET_KEY", ticketKey)` then `setValues([newRow])`. | Read in dedupe branch (existing row); read in MaitenanceReport (display fallback when TICKET_ID missing). Not used as authoritative lookup key elsewhere. |
| **WorkItems sheet** | **No.** Headers: WorkItemId, Type, Status, State, Substate, PhoneE164, PropertyId, UnitId, **TicketRow**, MetadataJson, CreatedAt, UpdatedAt, OwnerType, OwnerId, AssignedByPolicy, AssignedAt. | N/A | WI↔Sheet1 link is **TicketRow** only. No TicketKey column. |
| **Directory** | **Defined but not written.** `DIR_COL.ACTIVE_TICKET_KEY = 11`. | No `setValue` or batch write to Directory column 11 was found. The debug snapshot at line 20358 reads `getRange(dirRow, 1, dirRow, 10)` and maps `rowVals[8]` to `ActiveTicketKey` — that is column 9 (HANDOFF_SENT), so the label may be wrong or the column unused. | Read in one debug/status object as `ActiveTicketKey` (from col 9 in that read). Not used for resolution. |
| **Session** | No. | `activeArtifactKey` is set to `ticketId` or `"ROW:" + loggedRow` (line 2995). Not TicketKey. | — |
| **Context (ctx)** | Not persisted as TicketKey. | Ctx has activeWorkItemId, pendingWorkItemId, etc. No TicketKey field in the ctx/DAL contract. | — |
| **AIQueue (enqueueAiEnrichment_)** | No. | Schema is (CreatedAt, TicketId, PropertyCode, PropertyName, Unit, PhoneE164, MessageRaw, Status, …). No TicketKey. | — |
| **AIQueue (enqueueAiQForTicketCreate_)** | Schema comment lists TicketKey (10th column). | `q.appendRow([..., String(P.ticketKey || "")])`. Payload `P` must contain `ticketKey`. **No caller in the codebase passes `ticketKey`** into this function; the main path uses `enqueueAiEnrichment_`, which does not take or store TicketKey. | So TicketKey is only stored there if something outside the traced flow calls this with P.ticketKey. |
| **Portal PM createTicket response** | No. | Returns `ticketId`, `ticketRow`, `workItemId`, `nextStage`, `ownerType`, `ownerId`. TicketKey not in response. | — |
| **processTicket_ return** | Yes (in memory). | Return object: `ticketKey: createRes.ticketKey || ""`. | Callers use `ticket.ticketId`, `ticket.rowIndex`/row; ticketKey is available but not propagated to WI or Directory. |
| **MaitenanceReport.gs** | Read-only. | Reads ticket sheet; column index 50 in that file’s COL. Display: `ticket = r[TICKET_ID] || ("KEY:" + (r[TICKET_KEY] || ""))` — fallback when TICKET_ID missing. | Display only, not as canonical key. |
| **TestHarness / debug** | Read-only. | Snapshot of directory row includes `ActiveTicketKey: String(rowVals[8] || "").trim()` (column 9 in 0-based). | Debug only. |

**Summary:** TicketKey is **stored authoritatively only on Sheet1**. It is **not** stored on WorkItems, and Directory column 11 is not written. It is **not** used as the WI↔Ticket link anywhere; that link is **TicketRow** only.

---

## 5. Immutability audit

| Risk | Finding |
|------|--------|
| **Overwrite after create** | No active code path writes to `COL.TICKET_KEY` (51) after the initial `setValues([newRow])` in `processTicket_`. The only other write is in deprecated `createTicketFromPendingIssue_` (line 10904), which is not on the active path. |
| **Backfill / repair** | No backfill or repair logic was found that sets or updates TicketKey. |
| **upgradeTicketIdIfUnknown_** | Only updates **TICKET_ID** (and only when it starts with `UNK-`). Does not touch TICKET_KEY. |
| **Clone / copy row** | No code was found that clones a ticket row or copies another row’s values into a new row (which could duplicate or reassign TicketKey). |
| **Reopen / cancel / close** | No path was found that creates a new row or reassigns TicketKey when reopening or closing. |
| **Create without TicketKey** | In the CREATE branch of `processTicket_`, TicketKey is always set before the single `setValues([newRow])`. If `colNum_("TICKET_KEY")` were 0 (column missing), `setRowCol_` would no-op and the cell would stay empty — so **theoretical risk**: if COL.TICKET_KEY were removed or misconfigured, new rows could have no TicketKey. Not observed in current COL definition. |
| **Dedupe path** | Dedupe returns the **existing** row’s TicketKey; it does not generate or overwrite. So no mutation. |
| **Two rows same TicketKey** | Only way would be (1) duplicate UUID from `Utilities.getUuid()` (negligible in practice), or (2) a bug or external write. No code path assigns an existing TicketKey to a different row. |

**Conclusion:** In the **active** codebase, TicketKey is written once per new ticket and never mutated. The **deprecated** path uses a different, non-UUID derivation; if that path were ever re-enabled, it would not be “immutable UUID” and could conflict with the canonical rule.

---

## 6. Uniqueness audit

| Aspect | Detail |
|--------|--------|
| **Generator** | `Utilities.getUuid()` — standard UUID. No timestamp or row-based suffix; no explicit uniqueness check in code. |
| **Collision safety** | UUID v4–style randomness is sufficient for canonical system identity. No need for a second uniqueness check for normal operation. |
| **Uniqueness check in code** | None. The code assumes UUID uniqueness. |
| **Backfill / import** | No backfill or import path was found that writes TicketKey. If a future import bypassed `processTicket_` and wrote rows with custom keys, uniqueness would be the importer’s responsibility. |
| **Dedupe** | Dedupe is by **THREAD_ID** (inboundKey), not by TicketKey. So TicketKey is not used to detect duplicates; it is only read from the existing row when dedupe hits. |

**Conclusion:** Uniqueness is guaranteed in practice by `Utilities.getUuid()`. No additional checks are required for promoting TicketKey as canonical identity.

---

## 7. Suitability comparison

| Identity | Role today | Authoritative? | Immutable? | Used for WI↔Ticket? | Safe for row move/delete? | Safe for TicketID change? |
|----------|------------|----------------|------------|---------------------|----------------------------|----------------------------|
| **TicketKey** | UUID on Sheet1 col 51; generated once in `processTicket_`; returned on create/dedupe. | Yes, for the ticket row (single source of truth on Sheet1). | Yes, in active paths. | No. WorkItems and lookups use TicketRow only. | Yes — key is row-invariant. | Yes — independent of TicketID. |
| **TicketID** | Human-facing id (e.g. PENN-031626-0245). Built by `makeTicketId_(property, now, rowIndex)`. Can be upgraded from UNK-… by `upgradeTicketIdIfUnknown_`. | Display and external reference. | No — can change when upgraded from UNK. | Used for findTicketRowByTicketId_; Portal and many APIs use it. | No — row index is in the suffix. | N/A (it is the one that changes). |
| **TicketRow** | 1-based row index on Sheet1. Stored on WorkItems as TicketRow. | Only as storage locator. | No — row can change if rows are inserted/deleted/sorted. | Yes — only current link: WI.TicketRow → Sheet1 row. | No — row numbers shift. | Yes — independent of TicketID. |

**Intended roles (from hypothesis and map):**

- **TicketKey:** Canonical immutable identity. Best for WI↔Ticket link and future DB migration. **Currently underused:** not on WorkItems, not written to Directory, not used in resolvers.
- **TicketID:** Human/display identity. Can mutate (e.g. UNK → property prefix). Should not be the single canonical key for linkage.
- **TicketRow:** Storage locator only. Not acceptable as formal relation because it is positional and can change.

---

## 8. Gap list (to make TicketKey the canonical WI↔Ticket link)

If TicketKey is promoted as the canonical parent identity and used for WI↔Sheet1 linkage:

1. **WorkItems sheet**  
   - Add column **TicketKey** (and ensure header/backbone includes it).  
   - Set it in `workItemCreate_` when creating the WI (e.g. from `ticket.ticketKey` passed from `finalizeDraftAndCreateTicket_`).  
   - Include it in `workItemGetById_` return object and in any patch that updates WI from ticket.

2. **Creation propagation**  
   - `finalizeDraftAndCreateTicket_` (and any other caller that creates a WI from a ticket) must pass `ticket.ticketKey` into `workItemCreate_` and any DAL that persists the WI↔ticket link.

3. **Lookup helpers**  
   - Add **findWorkItemIdByTicketKey_(ticketKey)** that scans WorkItems by TicketKey (and/or add **findTicketRowByTicketKey_(sheet, ticketKey)** that scans Sheet1 COL.TICKET_KEY).  
   - Optionally add **findTicketKeyByTicketRow_** for reads; eventually prefer TicketKey-based lookups over TicketRow where possible.

4. **Directory ACTIVE_TICKET_KEY**  
   - Clarify intent: if Directory should store the “active ticket” key, then the Directory batch write in the finalize path (and any other place that sets “current ticket” for a phone) should set column 11 to the Sheet1 TicketKey (or leave it blank if design is to not use it). Today column 11 is never written in the traced code.

5. **Resolvers / lifecycle**  
   - Any logic that today uses TicketRow to go from ticket → WI or WI → ticket should be able to use TicketKey instead (and fall back to TicketRow only for legacy rows without TicketKey, if a migration is phased).

6. **Deprecated path**  
   - Remove or permanently disable `createTicketFromPendingIssue_`, or change it to use `Utilities.getUuid()` for TicketKey so it does not introduce non-UUID keys.

7. **AI queue (enqueueAiQForTicketCreate_)**  
   - If this function is used, callers should pass `ticketKey` in the payload so the queue has a stable key. The main path uses `enqueueAiEnrichment_`, which does not store TicketKey; that is a separate gap if AI queue is to be keyed by TicketKey.

8. **Portal / external API**  
   - If external systems or Portal need to reference tickets by immutable id, consider exposing TicketKey in responses (e.g. Portal createTicket) and in any APIs that accept ticket references.

---

## 9. Recommended verdict

**Promote TicketKey as canonical after specific safeguards.**

- **Suitability:** TicketKey is **suitable** as the canonical immutable parent identity: single generation point, UUID, written once on Sheet1, never mutated in active code.
- **Safeguards before relying on it for WI linkage:**
  1. Add **TicketKey** to WorkItems and set it at WI creation from `processTicket_`’s return value.  
  2. Implement **findWorkItemIdByTicketKey_** (and optionally findTicketRowByTicketKey_) and use them where today only TicketRow is used.  
  3. Stop writing or reading Directory “ActiveTicketKey” from the wrong column (or define and implement the correct write to column 11).  
  4. Deprecate or fix `createTicketFromPendingIssue_` so it does not introduce non-UUID TicketKeys.

After that, **WorkItems.TicketKey ↔ Sheet1.TicketKey** can be the authoritative WI↔Ticket link, with TicketRow retained only as a cache/locator and TicketID as display identity.

---

## Final recommendation for next step

**Next step: promote TicketKey to the WI linkage plan**, after implementing the safeguards in Section 8 (WorkItems.TicketKey column, propagation at creation, findWorkItemIdByTicketKey_ / findTicketRowByTicketKey_, and deprecation or UUID fix for createTicketFromPendingIssue_). Do not rely on TicketKey as the sole link until WorkItems (and any Directory/context usage) are updated; until then, TicketRow remains the only existing link and remains fragile for row moves and sorting.
