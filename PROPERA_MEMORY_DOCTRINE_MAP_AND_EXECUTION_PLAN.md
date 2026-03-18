# Propera — Memory End-Goal Doctrine, Map & Phased Execution Plan

**Purpose:** Single document that (1) states the memory end-goal doctrine, (2) maps the codebase against the target memory domains with current state and gaps, and (3) defines a phased execution plan. Memory is the **structured continuity layer** so Propera can act with context over time — not to make chat better, but to make orchestration continuous, building-aware, and staff-assisted.

**Constraint (North Compass):** Adapters do not decide. Memory does not decide. AI does not decide. The operational brain (resolver + lifecycle + policy) decides. Memory **provides context**; the brain applies policy, state, and responsibility logic.

---

## Part 1 — Memory End-Goal Doctrine (Summary)

### Purpose of the memory layer

- Remember **who and what** is being dealt with (identity, property, unit, channel).
- Preserve **continuity** across time and channels (conversation + operational state).
- Support **live responsibility state** (who owns what, what is blocked, what is waiting).
- Retrieve **relevant historical context** (prior tickets, prior actions, prior outcomes).
- Accumulate **building/unit nuance** (recurring issues, asset quirks, access peculiarities).
- Support **staff with grounded operational intelligence** (e.g. “This unit had two similar issues in 90 days”).
- **Improve over time** in a controlled, inspectable way (patterns, recurrence, likely causes) — advisory, not governing.

### What memory is not

- A second policy engine.
- A freeform AI black box.
- A duplicate of live operational state.
- A place where AI silently changes behavior.
- A subjective profile store for tenants or staff.

### Four end-goal memory classes

| Class | Purpose | Examples |
|-------|---------|----------|
| **Identity** | Durable relationship facts | tenant ↔ property ↔ unit, staff/vendor identity, phone/channel mappings |
| **State** | Live operational + conversational continuity | pending stage, active draft, open work, owner, lifecycle state, follow-up timers |
| **Historical** | Durable record of what happened | prior issues, notes, actions, schedules, resolutions, reopen history |
| **Intelligence** | Derived, reusable operational learning | recurrence counters, repeated failures, common resolution paths, likely-cause suggestions — **advisory only** |

### Target flow (mature memory)

```
Receive signal
  → identify actor/context (Identity)
  → load relevant live state (State)
  → retrieve relevant history (Historical)
  → include building/unit/asset facts + derived patterns (Intelligence)
  → hand all to the brain
  → brain decides deterministically
  → persist updated facts/state/events
  → emit outbound intent
```

### North-star sentence

> The end goal of Propera memory is to give the system **durable operational continuity** across people, places, work, and time, so Propera can act with context, remember relevant history, accumulate building intelligence, and improve staff assistance **without surrendering deterministic control**.

### Memory build rule: read model before new storage

**Before adding any new memory table**, first determine whether the needed capability can be delivered through a **read model** over existing sources of truth. New storage is allowed only when:

- existing data **cannot be retrieved efficiently** (e.g. no index, full-scan too costly), or  
- existing data **cannot preserve required semantics** (e.g. derived or aggregated view that must not mutate raw state), or  
- the store represents **derived/advisory memory** that should remain **separate** from raw operational state (e.g. pattern/recurrence tables).

This rule protects against overbuilding and keeps the memory layer anchored to current sources of truth.

### Fact vs state vs inference vs policy (code-review lens)

| Term | Meaning | Use in memory |
|------|--------|----------------|
| **Fact** | Durable reality about an entity or about history (e.g. “unit 311 had two prior drain tickets”). | Historical memory, UnitFacts; not overwritten by live flow. |
| **State** | Current live operational or conversation condition (e.g. “pending stage = UNIT”, “owner = X”). | Session, ctx, WorkItems, Directory; authoritative for “what is happening now.” |
| **Inference** | Advisory conclusion derived from facts or history (e.g. “likely cause: air-gap clog”). | Intelligence memory; may inform, must not govern. |
| **Policy** | Explicit governing rule (e.g. “emergency never goes to SCHEDULE”). | PropertyPolicy, resolver, lifecycle; **never** inferred from data. |

When reviewing memory-related code: label what is fact vs state vs inference vs policy so that state stays authoritative, inference stays advisory, and policy is never replaced by inference.

---

## Part 2 — Codebase Map vs. Target Memory Domains

Mapping is against these **seven target domains** (aligned to doctrine + Cursor mapping ask):

1. Identity memory  
2. Conversation/session memory  
3. Operational state memory  
4. Historical memory  
5. Policy/config memory  
6. Expression/language memory  
7. Derived intelligence / pattern memory  

For each: **current storage**, **source of truth**, **read paths**, **write paths**, **retention type**, **duplication risks**, **missing capabilities**.

---

### 2.1 Identity memory

**Target:** tenant ↔ property ↔ unit, staff/vendor identity, phone/channel mappings, asset associations.

| Aspect | Current state |
|--------|----------------|
| **Storage** | **Directory** sheet (Phone, PropertyCode, PropertyName, …); **Contacts** (ContactID, PhoneE164); **Staff** (StaffId, ContactId, …); **Properties** (PropertyID, PropertyCode, PropertyName, …). |
| **Source of truth** | Directory row per phone (identity + draft pointers); Staff + Contacts for staff; Properties for property list. |
| **Read paths** | `dalGet*_` / Directory lookup by phone; `getActiveProperties_()`, `getPropertyByNameOrCode_()`; Staff/Contacts via resolver and lifecycle. |
| **Write paths** | DAL (`dalSet*_`, `dirSet_`), `ensureDirectoryRowForPhone_`, Staff/Contacts (external or admin). |
| **Retention** | Durable (sheets); Directory row persists until cleaned. |
| **Duplication risks** | Session holds draft property/unit (pre-ticket); Directory holds PendingIssue/PendingUnit/PendingRow. When `pendingRow ≤ 0`, Session can be authoritative for draft; Directory still holds pointer and mirror. Intentional split (Session = pre-ticket detail, Directory = pointer + mirror). |
| **Missing** | No explicit **channel/session identity** (e.g. “this is WhatsApp for this tenant”); no structured **asset ↔ unit** table; no single **identity context object** passed through the pipeline (today: phone + dir row + props). |

---

### 2.2 Conversation/session memory

**Target:** current flow, last question, pending field, active draft, whether “yes” means confirm property/issue/schedule.

| Aspect | Current state |
|--------|----------------|
| **Storage** | **Sessions** sheet (Phone, State, Expected, Intent, Draft*, IssueBufJson, DraftScheduleRaw, ActiveArtifactKey, LastPromptKey, ExpiresAtIso, UpdatedAtIso). **ConversationContext** (ctx): PhoneE164, Lang, ActiveWorkItemId, PendingWorkItemId, PendingExpected, PendingExpiresAt, LastIntent, etc. |
| **Source of truth** | **Sessions**: pre-ticket draft and stage (State, Expected, draft fields). **ctx**: cache for lang, active/pending work item, last intent; can be rebuilt from Session/Directory/WorkItems. |
| **Read paths** | `sessionGet_(phone)`, `sessionScanRowsByPhone_` → `sessionPickNewestAndMerge_`; `ctxGet_(phone)`. Used in `resolveEffectiveTicketState_`, `draftUpsertFromTurn_`, `recomputeDraftExpected_`, Core pipeline. |
| **Write paths** | `sessionUpsert_` / `sessionUpsertNoLock_` (Draft*, stage, expected, expiresAtIso); `ctxUpsert_` (activeWorkItemId, pendingWorkItemId, pendingExpected, pendingExpiresAt, lastIntent). Both behind `withWriteLock_` or inside locked sections. |
| **Retention** | Sessions: durable; merge by newest UpdatedAtIso; one logical row per phone (dupes merged). ctx: durable sheet; in-memory `__CTX_CACHE__` per request. |
| **Duplication risks** | Session vs Directory draft: when `pendingRow ≤ 0`, Session is authoritative for draft detail; Directory holds PendingIssue/PendingUnit etc. Session and ctx both hold “what we’re waiting for” (Expected vs pendingExpected). Documented split: Session = pre-ticket + draft; ctx = work-item and intent continuity. |
| **Missing** | No explicit **conversation thread id** or **channel** on Session/ctx; no structured **last N turns** for disambiguation; **ExpiresAtIso** exists but not always used for session expiry/cleanup. |

---

### 2.3 Operational state memory

**Target:** what is open, who owns it, what is blocked, what is waiting, next step, timers/follow-ups.

| Aspect | Current state |
|--------|----------------|
| **Storage** | **WorkItems** (WorkItemId, Type, Status, State, Substate, OwnerId, TicketRow, MetadataJson, …); **PolicyTimers** (TimerId, WorkItemId, EventType, RunAt, IdempotencyKey, Status, …); **Directory** (PendingRow, PendingStage, ActiveTicketKey); **Sheet1** (ticket status, assignment columns). |
| **Source of truth** | WorkItems for work item state; PolicyTimers for lifecycle timers (EventType LIFECYCLE); Directory for PendingRow/PendingStage; Sheet1 for ticket content. |
| **Read paths** | `workItemGetById_`, `findWorkItemIdByTicketRow_`; `processTicket_`; PolicyTimers via lifecycle (e.g. `processLifecycleTimers_`); Directory via DAL. |
| **Write paths** | `workItemCreate_` / `workItemUpdate_`; `wiEnterState_`, `wiTransition_`, `wiSetWaitTenant_`; `lifecycleWriteTimer_`, `lifecycleCancelTimersForWi_`; DAL for Directory; Sheet1 via finalize/Portal. |
| **Retention** | Durable; timers processed by time trigger. |
| **Duplication risks** | Directory.PendingRow vs WorkItems.TicketRow: both point at ticket; Directory is the “current pending” pointer; WorkItems link WI to ticket. ctx.activeWorkItemId / pendingWorkItemId duplicate “current work” for conversation; acceptable as cache. |
| **Missing** | No single **“operational state summary”** API (open items, blocked, waiting, next action) — assembled on demand from WI + Directory + Sheet1. No explicit **“blocked reason”** or **“waiting on”** field on WI (could live in MetadataJson or notes). |

---

### 2.4 Historical memory

**Target:** prior tickets for unit, prior similar issues for property, prior repairs on asset, prior staff/vendor actions, recurrence/reopen patterns.

| Aspect | Current state |
|--------|----------------|
| **Storage** | **Sheet1** (ticket log) is the only durable record of past tickets (TS, Phone, Property, Unit, MSG, Category, Status, …). **PolicyEventLog** (audit of policy/assignment/lifecycle events). No dedicated “prior issues by unit” or “prior actions by asset” table. |
| **Source of truth** | Sheet1 for ticket history; PolicyEventLog for event audit. |
| **Read paths** | `findTicketRowByTicketId_`, `findTicketRowsByTicketId_`; `processTicket_` for one ticket. **No** current API to “list prior tickets for this unit” or “prior issues for this property” or “reopen history.” |
| **Write paths** | Append/update to Sheet1 (finalize, Portal); append-only PolicyEventLog via `policyLogEventRow_`, `lifecycleLog_`. |
| **Retention** | Permanent (sheet rows); PolicyEventLog append-only. |
| **Duplication risks** | Low; no duplicate history store. |
| **Missing** | **No structured historical memory layer.** No: prior-tickets-by-unit index, prior-issues-by-property, prior-actions-by-asset, reopen/recurrence table. No API to “retrieve relevant history for this unit/property/asset” for the brain or for staff. This is the largest gap for “remember what happened before.” |

---

### 2.5 Policy/config memory

**Target:** rules, escalation, timers, property-scoped and global config.

| Aspect | Current state |
|--------|----------------|
| **Storage** | **PropertyPolicy** (Property, PolicyKey, Value, Type); **PolicyTimers** (lifecycle + policy timers); **ActionPolicy** (action-name → config). |
| **Source of truth** | PropertyPolicy via `ppGet_(propCode, key, fallback)`; PolicyTimers for timer state; ActionPolicy via `getActionPolicy_`. |
| **Read paths** | `ppGet_` (MAIN), `lifecyclePolicyGet_` (LIFECYCLE_ENGINE), POLICY_ENGINE; timer processor for PolicyTimers. |
| **Write paths** | Policy engine / admin; `lifecycleWriteTimer_`, `lifecycleCancelTimersForWi_`. |
| **Retention** | Durable. |
| **Duplication risks** | Policy values can be cached (e.g. in lifecycle); document TTL if any. |
| **Missing** | No **versioning** of policy (who changed what when); no **policy scope** beyond property + GLOBAL. For memory doctrine, policy is “config memory” — already present and used by the brain. |

---

### 2.6 Expression/language memory

**Target:** template keys, phrasing, translation, channel-specific expression.

| Aspect | Current state |
|--------|----------------|
| **Storage** | **Templates** sheet (TemplateID, TemplateKey, TemplateName, TemplateBody); cache via `getTemplateMapCached_()` (ScriptCache ~5 min). **Outgate** resolves intent → templateKey; channel (SMS/WA/voice) drives footer and format. |
| **Source of truth** | Templates sheet (LOG_SHEET_ID workbook); Outgate intent contract (intentType, templateKey, channel, deliveryPolicy). |
| **Read paths** | `getTemplateMapCached_` → `tenantMsg_` / `renderTenantKey_`; Outgate render by channel. |
| **Write paths** | Template rows added/edited in sheet; no code writes template body. |
| **Retention** | Durable sheet; cache 5 min. |
| **Duplication risks** | ByKey vs ByName lookup; allowlists (welcome, compliance) live in code, not sheet. |
| **Missing** | No **per-channel template variants** in sheet (e.g. WA-specific body); no **language variants** (e.g. TemplateKey_es); ctx.lang exists but template selection by lang is not fully wired. |

---

### 2.7 Derived intelligence / pattern memory

**Target:** recurrence counters, repeated asset failures, common resolution paths, building-level issue clusters, likely-cause suggestions — **advisory only**.

| Aspect | Current state |
|--------|----------------|
| **Storage** | **None.** No sheet or table for recurrence, patterns, or learned suggestions. |
| **Source of truth** | N/A. |
| **Read paths** | N/A. |
| **Write paths** | N/A. |
| **Retention** | N/A. |
| **Duplication risks** | N/A. |
| **Missing** | **Full gap.** No: recurrence-by-unit/property/asset, “common fix” or “common failure” store, building-level issue clusters, callback/reopen tendencies, or “likely next checks” derived from history. Filling this must be **inspectable and advisory** — never silently change policy, routing, or urgency. |

---

## Part 3 — Summary Table: Domain vs. Current State

| Domain | Storage | Source of truth | Gap level |
|--------|---------|-----------------|-----------|
| Identity | Directory, Contacts, Staff, Properties | Directory + Staff/Contacts + Properties | Medium (channel/asset identity, single context object) |
| Conversation/session | Sessions, ConversationContext | Sessions (pre-ticket); ctx (work-item continuity) | Low–medium (thread/channel, turn history) |
| Operational state | WorkItems, PolicyTimers, Directory, Sheet1 | WorkItems, PolicyTimers, Directory, Sheet1 | Low (state summary API, blocked reason) |
| Historical | Sheet1, PolicyEventLog | Sheet1, PolicyEventLog | **High** (no prior-by-unit/property/asset, no history API) |
| Policy/config | PropertyPolicy, PolicyTimers, ActionPolicy | ppGet_, PolicyTimers, ActionPolicy | Low |
| Expression/language | Templates, Outgate | Templates sheet, intent + channel | Low–medium (per-channel/lang variants) |
| Derived intelligence | — | — | **Full** (no pattern/recurrence/likely-cause store) |

---

## Part 4 — Phased Execution Plan

Phases are ordered to **stabilize continuity first**, then **add history**, then **add intelligence** — without breaking resolver or lifecycle. Each phase stays within module boundaries and guardrails.

---

### Phase 0: Foundation and map (no code behavior change)

**Goal:** Align docs and invariants; no new sheets or APIs.

- **0.1** Formalize **memory doctrine** in repo (this doc + reference in PROPERA_NORTH_COMPASS / PROPERA_SYSTEM_MAP).
- **0.2** In **PROPERA_DATA_CONTRACT.md**, add a “Memory” subsection: which sheets belong to which memory class (Identity, State, Historical, etc.) and lock discipline.
- **0.3** Document **Session vs Directory vs ctx** authority: when `pendingRow ≤ 0` Session is draft source of truth; Directory holds pointer/mirror; ctx is work-item cache. Add to DATA_CONTRACT or guardrails.
- **0.4** Confirm **PolicyEventLog** and **lifecycleLog_** are the single audit path for lifecycle/policy events; no bypass.

**Exit criteria:** Docs updated; team agrees on map and authority.

---

### Phase 1: Memory read architecture — request-scoped context object

**Goal:** Establish the **memory read architecture** by introducing a single request-scoped **memory context** as the primary deliverable. Once this exists, every later phase gets easier: history can attach to it, facts can attach to it, patterns can attach to it, AI suggestion can consume it, and staff UI can display it. Phase 1 is not just identity/session cleanup; it is the **beginning of a memory read architecture**.

- **1.1** **Primary deliverable — single context object:** Introduce an internal **request-scoped memory context** (e.g. `memoryContext`) built **once per request** from Directory + Session + ctx + Properties (identity + live state). Pass it into Core/orchestration instead of ad-hoc phone + dirRow + session. No new sheet; composition only. This object is the **attachment point** for all future memory (history, facts, patterns).
- **1.2** **Identity:** Add optional **channel** (and if needed **sessionId**) to the payload that flows into this context (e.g. from gateway into `compileTurn_` / ctx). Store in ctx or Session if a column exists. Use for logging and future channel-aware behavior; do not change resolver/lifecycle logic.
- **1.3** **Session/ctx:** Document and enforce **ExpiresAtIso** for session rows (e.g. cleanup job or ignore stale rows when `pendingRow ≤ 0`). Optional: add a “last prompt key” or “last question” to Session/ctx for disambiguation (e.g. “yes” → confirm property vs issue).

**Exit criteria:** One memory context object is built per request and used across the Core path; channel/session identity available where needed; later phases can extend this object with history, facts, and patterns without re-architecting.

---

### Phase 2: Historical memory — read-only layer

**Goal:** “What happened before” available to the brain and staff; **read-only** history layer.

- **2.1** **Prior tickets by unit:** Add API (e.g. `getPriorTicketsByUnit_(propertyCode, unit, limit)`) that reads Sheet1 (same workbook), filters by property+unit, returns list of ticket summaries (id, issue, date, status, category). No new sheet; query existing log.
- **2.2** **Prior tickets by property:** Same idea: `getPriorTicketsByProperty_(propertyCode, limit)` (and optionally by category or date range).
- **2.3** **Reopen / same-ticket history:** Use existing Sheet1 + ticketId (or row) to get updates; optional helper `getTicketHistory_(ticketId)` (e.g. from PolicyEventLog or ticket row history if available). If no row-level history, document limitation and use PolicyEventLog for lifecycle events only.
- **2.4** **Wire into brain:** In maintenance flow (e.g. finalize or staff view), **optionally** call prior-ticket APIs and attach to context passed to resolver/policy or to staff UI. Do **not** let history change assignment or urgency by default; expose as “prior context” only.

**Exit criteria:** APIs exist and are used in at least one path (e.g. staff view or maintenance continuation); no new write path to history.

---

### Phase 3: Historical memory — durable index (optional)

**Goal:** If Sheet1 query-by-unit is too slow or needs richer semantics, add a **read-only maintained index** (e.g. “PriorTicketsByUnit” or “UnitHistory”) updated on ticket create/update.

- **3.1** Design a **UnitHistory** (or similar) sheet: e.g. PropertyCode, Unit, TicketId, CreatedAt, Category, Summary. Populated by finalize/Portal when a ticket is created or status changed.
- **3.2** **Write path:** Only from existing canonical paths (finalize, Portal); no new event system. Keep PolicyEventLog as audit.
- **3.3** **Read path:** Replace or complement `getPriorTicketsByUnit_` with index lookup. Keep API contract same so callers do not change.

**Exit criteria:** Fast “prior tickets for this unit” (and optionally property) without full Sheet1 scan; single write path from existing lifecycle.

---

### Phase 4: Building/unit nuance (durable facts)

**Goal:** Store and retrieve **durable operational facts** (e.g. “recurring plumbing stack issue,” “known boiler quirk”) — still **advisory**.

- **4.1** **Schema:** Add table (e.g. **UnitFacts** or **BuildingFacts**): PropertyCode, Unit (optional), FactType (e.g. RECURRING_ISSUE, ACCESS_NOTE, ASSET_QUIRK), Summary, Source (e.g. STAFF_ENTERED, DERIVED), UpdatedAt. Optional: AssetId if asset model exists.
- **4.2** **Write path:** Only from staff-facing action or from a **reviewed** derived suggestion (e.g. “suggest adding fact: recurring drain issue” → staff confirms → write). No AI auto-write.
- **4.3** **Read path:** `getUnitFacts_(propertyCode, unit)` / `getBuildingFacts_(propertyCode)`. Attach to context for resolver or staff UI. Do **not** let facts override policy; use for hints and display only.

**Exit criteria:** Facts table exists; write path is staff-or-review-only; read path integrated in one place (e.g. maintenance continuation or staff view).

---

### Phase 5: Derived intelligence — advisory only

**Goal:** Reusable patterns (recurrence, likely causes, common fixes) in an **inspectable, advisory** way.

- **5.1** **Schema:** Add **PatternMemory** (or **Recurrence**) table: e.g. PropertyCode, Unit, CategoryOrAsset, PatternType (RECURRENCE, COMMON_FIX, LIKELY_CAUSE), PayloadJson, Count, LastUpdated. Populated by **deterministic** aggregation from Sheet1 + PolicyEventLog (e.g. “same unit + same category in 90 days” → recurrence count). No LLM writing directly.
- **5.2** **Write path:** Batch job or trigger that **computes** from existing data (tickets, events); or “propose fact” that staff approves (then write to UnitFacts or PatternMemory). No silent policy change.
- **5.3** **Read path:** `getRecurrenceForUnit_(propertyCode, unit)` / `getLikelyCauses_(propertyCode, category)` (or similar). Return as **suggestions** only; resolver and policy do not read these for routing/urgency unless explicitly designed (e.g. a policy key “USE_RECURRENCE_HINT” that is opt-in).
- **5.4** **Governance:** Document in guardrails: “Intelligence memory is advisory. Policy and resolver remain the single source of truth for assignment, urgency, and routing.”

**Exit criteria:** Pattern/recurrence store exists; write path is batch or staff-approved; read path used for staff assistance or optional hints; guardrails updated.

---

### Phase 6: Maintenance memory end state (Jarvis path)

**Goal:** Full maintenance memory behavior as in doctrine: “Unit 311 had two prior drain complaints. Last repair cleared the hose. Similar units had recurring air-gap clogs. Recommended first checks: …”

- **6.1** **Compose:** For maintenance flow, assemble one **maintenance context** from: Identity (unit, property, tenant) + State (open work, owner) + Historical (prior tickets for unit, prior actions) + UnitFacts (recurring issues, access notes) + PatternMemory (recurrence, likely causes, common fixes).
- **6.2** **Surface to staff:** Expose in staff UI or outbound summary (e.g. in lifecycle or portal): “Prior issues: …; Recurrence: …; Suggested checks: ….” Keep wording as suggestion, not directive.
- **6.3** **Optional AI:** If AI is used for “recommended first checks,” it consumes this context as **input** only; output is suggestion. Brain still decides next step and routing.

**Exit criteria:** One maintenance flow uses full memory stack; staff sees prior context + suggestions; no policy/resolver bypass.

---

### Phase 7: Learning doctrine and hardening

**Goal:** Lock down “acceptable vs unacceptable” learning and retention.

- **7.1** **Docs:** In guardrails, add “Memory learning doctrine”: acceptable = summarize patterns, count recurrence, surface history, suggest causes/checks, propose facts for review; unacceptable = silently change policy, urgency, routing, invent facts, subjective judgments, mutate behavior without governance.
- **7.2** **Audit:** Ensure no code path lets PatternMemory or UnitFacts **override** resolver, policy, or lifecycle. Add a simple checklist or test: “policy decision unchanged when pattern store is empty vs populated.”
- **7.3** **Retention:** Document retention for Session (e.g. expire after N days), PolicyEventLog (append-only, no delete), PatternMemory (refresh from source data, no ad-hoc delete unless admin).

**Exit criteria:** Learning doctrine in guardrails; one negative test for “no policy override”; retention documented.

---

## Part 5 — Phase Overview Table

| Phase | Focus | New storage | New APIs / behavior | Risk |
|-------|--------|-------------|----------------------|------|
| 0 | Foundation, docs | None | None | None |
| 1 | **Memory read architecture** (context object) | Optional column (channel) | **Request-scoped memory context** (primary); session semantics | Low |
| 2 | Historical (read-only) | None | Prior tickets by unit/property, ticket history | Low |
| 3 | Historical index | UnitHistory (optional) | Same API, index-backed | Low (single write path) |
| 4 | Building/unit facts | UnitFacts / BuildingFacts | getUnitFacts_, staff-or-review write | Low |
| 5 | Derived intelligence | PatternMemory / Recurrence | getRecurrence_, getLikelyCauses_; batch/review write | Medium (must stay advisory) |
| 6 | Maintenance memory | — | Compose + staff surface + optional AI suggestion | Low if 5 is advisory |
| 7 | Learning doctrine | — | Guardrails, audit, retention | None |

---

## Part 6 — What Cursor Should Map Against (Checklist)

When mapping or refactoring, use this checklist per domain:

- [ ] **Identity:** Where is tenant/property/unit/channel stored? Single context object?
- [ ] **Conversation/session:** Where is stage, expected, draft, last prompt? Session vs ctx authority?
- [ ] **Operational state:** Where are open work, owner, timers? Single state summary?
- [ ] **Historical:** Where are prior tickets/actions? Who writes? Who reads?
- [ ] **Policy/config:** Where are policy keys and timers? Who may change?
- [ ] **Expression:** Where are templates and channel rules? Who may add template?
- [ ] **Intelligence:** Where are patterns/recurrence? Write path = batch or staff-approved only; read = advisory only.

---

## Part 7 — Cursor Mapping Ask (Strict Source-of-Truth Map) — ✅ Completed

Cursor was used to produce a strict source-of-truth and read/write map against this document. The result is captured in Part 8.

Focus questions (completed):

1. **Where is authority split today** between Session, Directory, ctx, WorkItems, and Sheet1? (By scenario: pre-ticket draft, post-ticket live work, timers, continuation.)
2. **What exact helper functions** already assemble partial memory context? (e.g. `resolveEffectiveTicketState_`, `sessionGet_` + `ctxGet_` + Directory read — list call sites and composed shape.)
3. **What historical data already exists** but has **no reusable retrieval API**? (e.g. Sheet1 has ticket history but no `getPriorTicketsByUnit_`; PolicyEventLog has events but no standard “history for this unit” reader.)
4. **What should never become duplicated storage?** (Canonical list: e.g. PendingRow lives in Directory; draft detail when `pendingRow ≤ 0` in Session; work item state only in WorkItems; no second “current stage” store that could diverge.)

The output is the **map** in Part 8 (tables and sections) that future patches can use to stay on the right side of authority and avoid new duplication.

---

## Part 8 — Current System Authority Map (Cursor Output)

**Instruction:** Do not propose redesigns. Do not propose new tables. Only map what exists. This section is a forensic architecture map — a system X-ray.

---

### 8.1 Authority Map by Scenario

| Scenario | Source of truth | Sheet / store | Notes |
|----------|-----------------|---------------|--------|
| **Pre-ticket draft** (no ticket yet) | **Session** (when `pendingRow ≤ 0`) | Sessions | State, Expected, Draft*, IssueBufJson, DraftScheduleRaw. Session is authoritative for draft stage and draft fields when there is no ticket row. |
| **Pending pointer** (which ticket row is “current”) | **Directory** | Directory | PendingRow, PendingStage. Directory is always the source for “do we have a ticket?” and “which row.” |
| **Draft mirror** (pre-ticket) | **Directory** (mirror) | Directory | PendingIssue, PendingUnit, DraftScheduleRaw mirrored from Session when still in draft; Directory also written by draft accumulator and finalize. |
| **Live work state** | **WorkItems** | WorkItems | State, Substate, OwnerId, TicketRow. Lifecycle and resolver read/write here. |
| **Ticket record** | **Sheet1** | Sheet1 (LOG_SHEET_ID) | TS, Phone, Property, Unit, MSG, Category, EMER, Status, TICKET_ID, assignment columns, etc. One row per ticket. |
| **Lifecycle timers** | **PolicyTimers** | PolicyTimers | EventType LIFECYCLE; WorkItemId, RunAt, IdempotencyKey. Written by lifecycleWriteTimer_; processed by processLifecycleTimers_. |
| **Conversation cache** (work-item continuity) | **ctx** (ConversationContext) | ConversationContext | ActiveWorkItemId, PendingWorkItemId, PendingExpected, PendingExpiresAt, LastIntent, Lang. Cache; can be rebuilt from Session/Directory/WI. |

**Where they interact:**

- **Resolving “what stage are we in?”**  
  `resolveEffectiveTicketState_(dir, dirRow, ctx, session)` uses: Directory (PendingRow, PendingStage) first; then when `pendingRow ≤ 0`, Session (stage, expected); then Directory again for draft stages if Session did not apply; then ctx for self-heal (pendingExpected). Ticket-bound continuation uses Directory.PendingStage and Sheet1/WorkItems for emergency. No single “state” store — composition only.

- **Finalize (create ticket):** Directory (read draft pointers + mirror), Session (read draft issue/schedule when `existingPendingRow < 2`), Sheet1 (append new row), Directory (set PendingRow, PendingStage, clear draft mirror), Session (clear draft on close), WorkItems (create WI), ctx (set activeWorkItemId, etc.).

- **Continuation (existing ticket):** Directory.PendingRow → Sheet1 row; findWorkItemIdByTicketRow_(ticketRow) → WorkItems; ctx holds activeWorkItemId/pendingWorkItemId for tenant continuity.

---

### 8.2 Identity Authority Map

| Identity element | Source of truth | Read path | Write path |
|------------------|-----------------|-----------|------------|
| Phone → directory row | Directory | findDirectoryRowByPhone_(dir, phone), ensureDirectoryRowForPhone_(dir, phone) | ensureDirectoryRowForPhone_ (creates stub row via dalWithLock_) |
| Property/unit (dir row) | Directory | dalGetPendingProperty_, dalGetPendingUnit_, dalGetUnit_ | dalSetPendingPropertyNoLock_, dalSetPendingUnitNoLock_; finalize sets Directory row |
| Staff/contact identity | Staff + Contacts | Resolver, lifecycle, isManager_, isVendor_, isStaffSender_ | External/admin (not in MAIN) |
| Property list | Properties | getActiveProperties_(), getPropertyByNameOrCode_() | Portal/admin |

---

### 8.3 Session / Draft Authority Map

| Concern | When authoritative | Read path | Write path |
|---------|--------------------|-----------|------------|
| Draft stage (pre-ticket) | When `pendingRow ≤ 0` | sessionGet_(phone) → stage, expected | sessionUpsert_, sessionUpsertNoLock_ (stage, expected, draft*, issueBufJson, draftScheduleRaw, expiresAtIso) |
| Draft fields (issue, unit, property, schedule) | When `pendingRow ≤ 0` | sessionGet_(phone) → draftIssue, draftUnit, draftProperty, draftScheduleRaw, issueBuf | sessionUpsertNoLock_ (called from applySchemaIssuesToDraft_, draftUpsertFromTurn_, recomputeDraftExpected_) |
| Pending stage (pointer) | Always | dalGetPendingStage_(dir, dirRow) | dalSetPendingStage_, dalSetPendingStageNoLock_; finalize sets nextStage |
| Pending row (ticket pointer) | Always | dalGetPendingRow_(dir, dirRow) | dalSetPendingRowNoLock_ (finalize, clearMaintenanceDraftResidue_, CMD_GLOBAL_RESET, etc.) |
| Issue buffer (Directory) | Directory | getIssueBuffer_(dir, dirRow) (reads DIR_COL.ISSUE_BUF_JSON) | appendIssueBufferItem_, setIssueBuffer_; finalize clears |

Session and Directory both hold draft-related data; authority is conditional on `pendingRow`: when `pendingRow ≤ 0`, Session is the source for draft stage and draft field values; Directory remains source for PendingRow/PendingStage and holds mirror (PendingIssue, PendingUnit, DraftScheduleRaw) for resilience and single-row view.

---

### 8.4 Operational State Authority Map

| Concern | Source of truth | Read path | Write path |
|---------|-----------------|-----------|------------|
| Work item state | WorkItems | workItemGetById_(wiId) | workItemCreate_, workItemUpdate_; wiTransition_, wiSetWaitTenant_ |
| Ticket → work item link | WorkItems (TicketRow column) | findWorkItemIdByTicketRow_(ticketRow) | workItemCreate_ (ticketRow); syncActiveWorkItemFromTicketRow_ (updates WI ticketRow/propertyId/unitId) |
| Active/pending WI for phone | ConversationContext | ctxGet_(phone) → activeWorkItemId, pendingWorkItemId | ctxUpsert_ (set by finalize, lifecycle, router) |
| Lifecycle timers | PolicyTimers | processLifecycleTimers_ (time trigger) | lifecycleWriteTimer_; lifecycleCancelTimersForWi_ |
| Assignment (ticket) | Sheet1 (Assigned*, etc.) + WorkItems (OwnerId) | processTicket_ reads sheet; workItemGetById_ | finalize writes Sheet1 assignment columns; workItemUpdate_ for OwnerId |

---

### 8.5 Historical Data Inventory

| Data | Exists in | Reusable retrieval API? | Notes |
|------|-----------|--------------------------|--------|
| Ticket history (all tickets) | Sheet1 | No | findTicketRowByTicketId_, findTicketRowsByTicketId_ look up by ticket id only. No API to list “prior tickets for this unit” or “prior tickets for this property.” |
| Lifecycle/assignment events | PolicyEventLog | No | lifecycleLog_, policyLogEventRow_ append. No standard reader for “events for this unit” or “events for this work item.” |
| Reopen / status changes | Sheet1 (Status, etc.) | No | Status and other columns updated in place; no row-level history table. Reopen inferred from status/flow, not from a dedicated history API. |
| Visit records | Visits | No (not used for history retrieval) | createVisit_ appends; used for scheduling/audit, not exposed as “prior visits for unit.” |

---

### 8.6 Read Path Graph (How Context Is Assembled Today)

**Effective ticket state (stage + type):**

```
resolveEffectiveTicketState_(dir, dirRow, ctx, session)
  ← dir, dirRow (caller has Directory row)
  ← ctx (caller passed ctxGet_(phone))
  ← session (caller passed sessionGet_(phone))
  → reads: dalGetPendingRow_(dir, dirRow), dalGetPendingStage_(dir, dirRow)
  → then: session.stage, session.expected (when pendingRow ≤ 0)
  → then: ctx.pendingExpected (self-heal)
  → then: isEmergencyContinuation_(dir, dirRow, ctx, phone) (reads Directory, ctx, possibly ticket/WI)
  → returns { stateType, stage }
```

**Draft / recompute (pre-ticket):**

```
recomputeDraftExpected_(dir, dirRow, phone, sessionOpt)
  → dalGetPendingRow_, dalGetPendingStage_, dalGetPendingIssue_, dalGetPendingProperty_, dalGetUnit_, dalGetPendingUnit_
  → session from sessionOpt || sessionGet_(phone)
  → dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW) for hasSchedule
  → writes: sessionUpsert_, ctxUpsert_, dalSetPendingStage_
```

**Core pipeline (handleSmsCore_):**

```
Directory row: findDirectoryRowByPhone_(dir, phone) or ensureDirectoryRowForPhone_(dir, phone)
Session: sessionGet_(phone) — loaded once per inbound, passed through
ctx: ctxGet_(phone) — loaded once per inbound, passed through
Effective state: resolveEffectiveTicketState_(dir, dirRow, ctx, session)
Ticket row: Directory.PendingRow → sheet.getRange(pendingRow, COL.*) for ticket fields
Work item: findWorkItemIdByTicketRow_(pendingRow) → workItemGetById_(wiId)
```

**Finalize (ticket creation):**

```
Read: dalGetPendingRow_, dalGetPendingStage_, dalGetPendingProperty_, dalGetPendingUnit_, dalGetPendingIssue_
Read (if existingPendingRow < 2): sessionGet_(phone) for issue, draftScheduleRaw
Write: Sheet1 appendRow (ticket), Directory row update (PendingRow, PendingStage, clear draft mirror), Session clear (sessionUpsert_), WorkItems (workItemCreate_), ctx (ctxUpsert_ activeWorkItemId, etc.), PolicyEventLog (policyLogEventRow_)
```

---

### 8.7 Write Path Graph

| Target | Canonical write entry points | Lock / discipline |
|--------|------------------------------|-------------------|
| **Session** | sessionUpsert_(phone, patch, reason) → sessionUpsertNoLock_ | sessionUpsert_ uses withWriteLock_("SESSION_UPSERT", …). sessionUpsertNoLock_ called only inside existing lock (e.g. draft accumulator). |
| **ConversationContext (ctx)** | ctxUpsert_(phoneAny, patch, traceTag) | withWriteLock_("CTX_UPSERT", …). Manager/vendor cannot set pendingExpected/pendingWorkItemId (guard in ctxUpsert_). |
| **Directory** | dalSetPendingRowNoLock_, dalSetPendingStageNoLock_, dalSetPendingIssueNoLock_, dalSetPendingUnitNoLock_, dalSetPendingPropertyNoLock_, dalSetLastUpdatedNoLock_, dalSetPendingStage_; dirSet_ | DAL helpers; callers must hold lock (dalWithLock_ or withWriteLock_). ensureDirectoryRowForPhone_ uses dalWithLock_("DIR_CREATE_STUB"). |
| **WorkItems** | workItemCreate_(obj), workItemUpdate_(wiId, patch) | workItemUpdate_ uses withWriteLock_("WI_UPDATE", …). workItemCreate_ called from finalize (inside lock) or lifecycle. wiTransition_, wiSetWaitTenant_ call workItemUpdate_. |
| **Sheet1** | finalizeDraftAndCreateTicket_ (append + row update), portalPm*, processTicket_ (row update) | Writes inside withWriteLock_ or equivalent; finalize batches Directory + Sheet1 + Session + WI in one lock. |
| **PolicyTimers** | lifecycleWriteTimer_(wiId, prop, timerType, runAt, payload), lifecycleCancelTimersForWi_(wiId) | LIFECYCLE_ENGINE; lifecycleWriteTimer_ appends; processor reads in time trigger. |
| **PolicyEventLog** | policyLogEventRow_(…), lifecycleLog_(eventType, propCode, workItemId, facts) | Append-only. No update/delete. |

---

### 8.8 Do-Not-Duplicate List (Permanent Guardrail)

Do **not** introduce a second store or parallel path for the following. Authority lives in one place only.

| Do not duplicate | Single home | Rationale |
|------------------|-------------|-----------|
| **Directory.PendingRow** | Directory | The “current ticket row” pointer. A second pointer would diverge. |
| **Directory.PendingStage** | Directory | The “current stage” for the pending ticket. Session/ctx hold draft/continuation hints when appropriate; Directory is the durable stage pointer. |
| **Session.Draft*** (draftIssue, draftUnit, draftProperty, draftScheduleRaw, issueBuf) | Session (when `pendingRow ≤ 0`) | Pre-ticket draft detail. Directory holds mirror for resilience; Session is authoritative for draft content when no ticket exists. |
| **WorkItems.State / Substate** | WorkItems | Lifecycle and resolver depend on one state machine. No second “current WI state” store. |
| **PolicyTimers.RunAt / IdempotencyKey** | PolicyTimers | Timers are consumed by one processor. Duplicate timer store would double-fire or desync. |
| **Ticket record (row content)** | Sheet1 | One row per ticket. No shadow ticket table. |
| **Ticket history (past tickets)** | Sheet1 | Ticket log is the history. Do not duplicate into a second “history” table without explicit design (Phase 3 index is a maintained view over Sheet1, not a second truth). |
| **Templates (tenant-facing messaging)** | Templates sheet | getTemplateMapCached_ reads from Templates. No second template store for same keys. |
| **Policy (property-scoped)** | PropertyPolicy | ppGet_ is the reader. No duplicate policy cache that could diverge. |
| **Audit events (lifecycle/policy)** | PolicyEventLog | lifecycleLog_ / policyLogEventRow_ only. No parallel audit log. |

---

### 8.9 Authority Rules in One Sentence

One-line-per-store summary for quick reference:

| Store | Authority rule |
|-------|-----------------|
| **Directory** | Pointer/state anchor for pending ticket continuity. |
| **Session** | Pre-ticket draft detail when no ticket row exists. |
| **ctx** (ConversationContext) | Request/conversation continuity cache; rebuildable from Session/Directory/WI. |
| **WorkItems** | Live responsibility + lifecycle state. |
| **Sheet1** | Canonical ticket record + durable ticket history. |
| **PolicyTimers** | Canonical timer execution store. |
| **PolicyEventLog** | Canonical audit/event log. |
| **Templates** | Canonical message text store. |
| **PropertyPolicy** | Canonical governing rule store. |

---

*Last updated: Part 7 wording tightened; Part 8.9 Authority Rules in One Sentence added. Memory doctrine, read-model-before-storage rule, fact/state/inference/policy lens, Phase 1 as memory read architecture, Part 8 forensic map, and 8.8 Do-Not-Duplicate List. Aligns with PROPERA_NORTH_COMPASS.md and PROPERA_DATA_CONTRACT.md.*
