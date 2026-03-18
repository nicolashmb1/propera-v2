# Propera Data Contract — Sheets and Ownership

**Purpose:** Single place to see which sheet holds what, who reads/writes it, and critical invariants. Use this to reason about behavior and performance; do not add or reorder columns without updating both code and this doc.

---

## 1. Core operational sheets

| Sheet | Purpose | Key columns (examples) | Primary readers/writers | Invariants |
|-------|---------|------------------------|-------------------------|------------|
| **Sheet1** | Ticket log (maintenance). One row per ticket. | TS, Phone, Property, Unit, MSG, Category, EMER, EMER_TYPE, Status, TICKET_ID, PendingRow, Assigned*, etc. (see COL in MAIN) | processTicket_, finalizeDraftAndCreateTicket_, Portal, policy; Directory.PendingRow points at row | Authoritative for ticket content. EMER/EMER_TYPE set at create; emergency path never goes to SCHEDULE. |
| **Directory** | Identity + draft/ticket pointers. One row per phone. | Phone, PropertyCode, PropertyName, LastUpdated, PendingIssue, PendingUnit, PendingRow, PendingStage, HandoffSent, WelcomeSent, ActiveTicketKey, IssueBufJson, DraftScheduleRaw | DAL (dalGet*_/dalSet*_), Core, stage handlers, finalize | Authoritative for dir row and PendingRow/PendingStage. Pre-ticket draft may live in Session. Read/write only via DAL or documented lock. |
| **WorkItems** | Work items tied to tickets. One row per WI. | WorkItemId, Type, Status, State, Substate, PhoneE164, PropertyId, UnitId, TicketRow, OwnerId, MetadataJson, CreatedAt, UpdatedAt | workItemCreate_/GetById/Update, wiEnterState_, lifecycle, resolver, POLICY_ENGINE | TicketRow links to Sheet1. State/Substate drive lifecycle. Emergency: substate EMERGENCY, state ACTIVE_WORK; never WAIT_TENANT/SCHEDULE for emergency. |
| **PropertyPolicy** | Per-property and GLOBAL policy. Key → Value, Type. | Property, PolicyKey, Value, Type | ppGet_ (MAIN), lifecyclePolicyGet_ (LIFECYCLE_ENGINE), POLICY_ENGINE | Lookup: property-specific then GLOBAL then fallback. Type coerces (BOOL, NUMBER). Do not hardcode tenant/person in code; use policy. |
| **PolicyTimers** | All policy/lifecycle timers. One row per timer. | TimerId, Enabled, WorkItemId, Prop, EventType, RunAt, PayloadJson, IdempotencyKey, Status, Attempts, LastError, CreatedAt, UpdatedAt | lifecycleWriteTimer_, processLifecycleTimers_, lifecycleCancelTimersForWi_; POLICY_ENGINE | Lifecycle EventType = "LIFECYCLE". Column order fixed; see LIFECYCLE_TIMER_AND_POLICY_SECTIONS.md. Do not add/reorder columns without updating writers and processor. |
| **PolicyEventLog** | Audit log for policy/assignment/lifecycle events. | (event-specific) | policyLogEventRow_, lifecycleLog_ | Append-only. Reuse for all important actions; do not bypass. |
| **ActionPolicy** | Action-name → policy (e.g. for portal or triggers). | (action key, config) | getActionPolicy_ (MAIN), POLICY_ENGINE | Used by policy engine and gateway. |

---

## 2. Session and context (cache / pre-ticket state)

| Sheet | Purpose | Key columns (examples) | Primary readers/writers | Invariants |
|-------|---------|------------------------|-------------------------|------------|
| **Sessions** | Pre-ticket source of truth (state, expected, draft fields). One row per phone. | Phone, SessionId, Lane, State, Expected, Intent, Draft*, IssueBufJson, DraftScheduleRaw, ExpiresAtIso, UpdatedAtIso | sessionUpsert_/sessionGet_, draft accumulator, recompute | Merge by newest UpdatedAtIso. Used when pendingRow ≤ 0. |
| **ConversationContext** (ctx) | Cache: lang, active/pending work item, last intent. | PhoneE164, Lang, ActiveWorkItemId, PendingWorkItemId, PendingExpected, FlowMode, etc. | ctxGet_/ctxUpsert_, Core, lifecycle | Cache only; can be rebuilt from Session/Directory/WI. Emergency: flowMode "EMERGENCY"; never resolve to SCHEDULE. |

---

## 3. Identity, staff, and messaging

| Sheet | Purpose | Key columns (examples) | Primary readers/writers | Invariants |
|-------|---------|------------------------|-------------------------|------------|
| **Staff** | Staff records. | StaffId, ContactId, ... | srLoadStaffContact_, resolver, lifecycle (staff phone/lang) | Canonical staff list. ContactId links to Contacts. |
| **Contacts** | Contact records (phone, etc.). | ContactID, PhoneE164, ... | Staff lookup, isStaffSender_, lifecycleResolveStaffIdByPhone_ | Staff.ContactId → Contacts; used for staff phone and tenant identity. |
| **Templates** | Message templates (TemplateKey → body). | TemplateKey, TemplateName, body, ... | getTemplateMapCached_, renderTenantKey_, tenantMsg_ | LOG_SHEET_ID workbook. Cache ~5 min. |
| **Properties** | Property list (code, name, ticket prefix, etc.). | PropertyID, PropertyCode, PropertyName, Active, TicketPrefix, ShortName | getActiveProperties_(), getPropertyByNameOrCode_(), Portal | Used for property resolution and ticket ID prefix. |

---

## 4. Other sheets (reference)

| Sheet | Purpose | Notes |
|-------|---------|------|
| **AmenityDirectory** | Amenity flow state | Amenity branch. |
| **AmenityReservations** | Amenity reservations | Amenity branch. |
| **OptOuts** | Opt-out list | Compliance. |
| **EventLog** | General event log | Inserted if missing. |
| **WebhookLog / WebhookErrors** | Webhook audit | Portal/webhooks. |
| **DebugLog / DevSmsLog** | Debug and dev SMS | Development. |
| **AIQueue** | AI queue (e.g. enrichment) | Time triggers. |
| **ChaosTimeline** | Chaos/testing | Test only. |

---

## 5. Single source of truth (by entity)

| Entity | Source of truth | Notes |
|--------|-----------------|--------|
| Ticket content (issue, status, EMER, etc.) | **Sheet1** | Directory.PendingRow points at row. |
| Draft pointers and pending stage | **Directory** | PendingRow, PendingStage; pre-ticket detail in Session. |
| Work item state | **WorkItems** | State, Substate drive lifecycle and resolver. |
| Policy (property-scoped) | **PropertyPolicy** | ppGet_(propCode, key, fallback). |
| Lifecycle timers | **PolicyTimers** | EventType "LIFECYCLE"; IdempotencyKey = "LIFECYCLE:" + wiId + ":" + timerType. |
| Staff identity / phone | **Staff** + **Contacts** | Staff.ContactId → Contacts; no hardcoded staff in code. |

---

## 6. Lock and write discipline

- **Directory / Session / WorkItems / PolicyTimers / Sheet1** (operational state): Use `withWriteLock_()` or `dalWithLock_()` for any write. See PROPERA_GUARDRAILS.md.
- **PolicyEventLog**: Append-only; use `policyLogEventRow_()` or `lifecycleLog_()`.
- Do not add new sheet write paths without checking canonical helpers (workItemUpdate_, wiEnterState_, lifecycleWriteTimer_, etc.).

---

*Last updated: data contract added for documentation consolidation.*
