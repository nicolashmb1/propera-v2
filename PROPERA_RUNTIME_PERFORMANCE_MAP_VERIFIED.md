# PROPERA RUNTIME PERFORMANCE MAP — VERIFIED
Current State · Verified Target Shape · Execution Plan  
Date: 2026-03-19  
Status: VERIFIED AGAINST CODEBASE

Primary sources audited: `PROPERA MAIN.gs`, `LIFECYCLE_ENGINE.gs`, `POLICY_ENGINE.gs`, `OUTGATE.gs`, `STAFF_RESOLVER.gs`, `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`, `TELEGRAM_ADAPTER.gs`, `apps-script/ProperaPortalAPI.gs`. Cross-checked against `PROPERA_NORTH_COMPASS.md` and `PROPERA_GUARDRAILS.md`.

---

## 1. PURPOSE

This document is a **runtime and performance verification** of the live Propera Apps Script project. It **does not** replace architecture doctrine (North Compass / guardrails). It records what the code **actually** does on inbound paths, marks **verified** vs **inferred** claims, corrects errors in `PROPERA_RUNTIME_PERFORMANCE_MAP.md` (draft), and proposes a **conservative execution plan** that keeps a **single backbone** (shared front → domain → commit → outbound intent → outgate) with **early-routing modes inside the front**, not parallel products.

---

## 2. EXECUTIVE FINDINGS

### Confirmed

| Topic | Note |
|-------|------|
| **Staff `#` capture** | **VERIFIED IN CODE** — `handleSmsRouter_` branches first on `#`, clones event, sets `_staffCapture`, calls `routeToCoreSafe_(e2, { mode: "MANAGER" })` → `handleSmsCore_` STAFF_CAPTURE block (`PROPERA MAIN.gs`). |
| **Non-`#` staff ops** | **VERIFIED IN CODE** — `isStaffSender_` + `staffHandleLifecycleCommand_` when `lifecycleEnabled_("GLOBAL")`; otherwise message continues tenant flow (`STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`, `handleSmsRouter_`). |
| **`globalThis.__inboundChannel`** | **VERIFIED IN CODE** — Set in `doPost` from Twilio `From` prefix (`WA` vs `SMS`); read widely in `handleSmsCore_` / crash paths. |
| **Twilio `MediaUrlN` / `MediaContentTypeN`** | **VERIFIED IN CODE** — Built into `media` in `handleSmsRouter_` and read again in STAFF_CAPTURE (`PROPERA MAIN.gs`). |
| **Continuation still hits core** | **VERIFIED IN CODE** — Router `pendingExpected` handling often ends in `routeToCoreSafe_(e)`; no separate continuation-only exit that skips `handleSmsCore_`. |
| **Heavy sync AI on create path** | **VERIFIED IN CODE** — `finalizeDraftAndCreateTicket_` calls `inferLocationType_` (OpenAI) before `processTicket_`; `processTicket_` may call `classify_` when `shouldRunLLMClassify_` is true (`PROPERA MAIN.gs`). |
| **Vision + fetch in staff media** | **VERIFIED IN CODE** — `imageSignalAdapter_` → `fetchTwilioMediaAsDataUrl_` + `openaiVisionJson_` (timeouts/retries) (`PROPERA MAIN.gs`). |
| **AI queue worker exists** | **VERIFIED IN CODE** — `enqueueAiEnrichment_` appends sheet `AI_QUEUE_SHEET`; `aiEnrichmentWorker` + `installAiEnrichmentTrigger` (`PROPERA MAIN.gs`). |
| **Telegram deferred processing** | **VERIFIED IN CODE** — `TELEGRAM_ADAPTER.gs`: fast ack, queue, worker calls `handleSmsRouter_(syntheticE)`. |
| **Outgate contract** | **VERIFIED IN CODE** — `OUTGATE.gs` documents intent → template map; core uses `dispatchOutboundIntent_` for many tenant replies. |
| **Lifecycle hook at create** | **VERIFIED IN CODE** — `finalizeDraftAndCreateTicket_` may call `onWorkItemActiveWork_` / `onWorkItemCreatedUnscheduled_` before returning to core (`PROPERA MAIN.gs` + `LIFECYCLE_ENGINE.gs`). |

### Corrected

| Draft claim | Correction |
|-------------|------------|
| **Entry: `doPost` → `handleSms_` → `handleSmsSafe_` → `handleSmsCore_`** | **WRONG for Twilio webhooks.** **VERIFIED IN CODE:** `doPost` calls `handleSmsRouter_(e)` after the Twilio gate; `routeToCoreSafe_` calls `handleSmsCore_`. `handleSms_` / `handleSmsSafe_` exist in `PROPERA MAIN.gs` but are **not referenced** from `doPost` (dead / legacy wrapper). |
| **`compileTurn_` contains `domainScore_`, `inferLocation_`** | **NOT FOUND** in `compileTurn_`. **VERIFIED IN CODE:** Compiler does property resolution (`resolvePropertyExplicitOnly_`, optional `getActiveProperties_` scans), `extractUnit_` / `normalizeUnit_`, `evaluateEmergencySignal_`, issue path via `parseIssueDeterministic_` / fallbacks. |
| **`recomputePendingExpected_` inside `draftUpsertFromTurn_`** | **WRONG name.** **VERIFIED IN CODE:** Separate helper is `recomputeDraftExpected_` (called from core / staff capture, not necessarily inside every `draftUpsertFromTurn_` exit). |
| **Router stage lists `isManager_()`** | **MISPLACED.** **VERIFIED IN CODE:** `isManager_` is used in `decideLane_` / `normalizeInboundEvent_` path and at start of `handleSmsCore_` (`fromIsManager`), not as a numbered step in the excerpted router block before lane decision. |
| **Stage 3 names `resolveResponsibleParty_()`** | **MISLEADING.** **VERIFIED IN CODE:** `finalizeDraftAndCreateTicket_` uses `srBuildWorkItemOwnerPatch_` (STAFF_RESOLVER) or falls back to `resolveWorkItemAssignment_`. The function `resolveResponsibleParty_` exists in `STAFF_RESOLVER.gs` for other resolver flows, not as the direct symbol in this finalize chain. |
| **`policyLogEventRow_()` immediately after `workItemCreate_` in MAIN** | **`policyLogEventRow_` is not called from `PROPERA MAIN.gs`** (grep: no matches). **VERIFIED IN CODE:** Assignment audit goes through `srLogAssignmentEvent_` → `policyLogEventRow_` in `STAFF_RESOLVER.gs` / `POLICY_ENGINE.gs` when that path runs. |
| **Post-create chain: lifecycle then `dispatchOutboundIntent_` in one linear block** | **ORDER WRONG.** **VERIFIED IN CODE:** `onWorkItemActiveWork_` / policy hooks run **inside** `finalizeDraftAndCreateTicket_` **before** return; tenant-visible `dispatchOutboundIntent_` for `TICKET_CREATED_ASK_SCHEDULE` runs in `handleSmsCore_` **after** `finalizeDraftAndCreateTicket_` returns (still same synchronous HTTP request). |
| **Staff screenshot confirm via `sendRouterSms_`** | **WRONG for STAFF_CAPTURE.** **VERIFIED IN CODE:** Staff draft line uses `replyTo_(originPhoneStaff, line)` after ingest. |
| **Exact sheet op count “~24 reads/writes”** | **NOT VERIFIED** — highly path-dependent (schema extract, multi-issue defer, LLM classify, dedupe scan depth, property list size). Treat draft numbers as **illustrative**, not measured. |

### Newly Discovered

| Finding | Evidence |
|---------|----------|
| **Staff `#` path skips router gates** | **VERIFIED IN CODE** — No `chaosInit_`, `normalizeInboundEvent_`, `decideLane_`, compliance, or opt-out suppression on `#` branch (returns before those run). Implies different safety surface vs normal tenant SMS. |
| **`draftUpsertFromTurn_` may call OpenAI (`extractIssuesSchema_`) outside DAL lock** | **VERIFIED IN CODE** — Schema gate runs before `dalWithLock_("DRAFT_UPSERT", …)`; network work can precede sheet lock (`PROPERA MAIN.gs`). |
| **`processTicket_` does Drive save for first media URL** | **VERIFIED IN CODE** — `saveInboundAttachmentToDrive_` in ticket create path can add latency (`PROPERA MAIN.gs`). |
| **Operational domain dispatch (e.g. CLEANING)** | **VERIFIED IN CODE** — `dispatchOperationalDomain_` can short-circuit maintenance draft flow (`handleSmsCore_`). |
| **Telegram already implements “queue approximation”** | **VERIFIED IN CODE** — Pattern to mirror for other async work (`TELEGRAM_ADAPTER.gs`). |
| **`ASYNC_QUEUE.gs` does not exist** | **VERIFIED IN CODE** — Draft Phase 4 file name is aspirational; AI queue is `enqueueAiEnrichment_` / sheet + time trigger today. |

---

## 3. VERIFIED CURRENT RUNTIME MAP

Legend: **V** = verified in code; **I** = strong inference from structure (same request, sequential calls).

### 3.1 Tenant complete-create flow (SMS / WhatsApp via Twilio)

**Entry:** `doPost` → Twilio gate → `handleSmsRouter_(e)` → tenant lane → `routeToCoreSafe_(e)` → `handleSmsCore_(e)`. **V**

**Major chain (typical new maintenance ticket):**

1. **Router (tenant lane):** `chaosInit_`, `writeTimeline_`, `normalizeInboundEvent_`, `decideLane_`, compliance (`complianceIntent_` + locks), opt-out check, `ctxGet_`, tenant command intercept, `pendingExpected` branches (may `ctxUpsert_`, `sendRouterSms_`, or `routeToCoreSafe_`). **V**
2. **Core:** ScriptProperties reads (API keys, Twilio) **V**; `getSheet_` / directory **V**; `isManager_(originPhone)` **V**; SID dedupe / cache logic **V**; media merge via `imageSignalAdapter_` for tenants when media present **V**; `compileTurn_` **V**; `draftUpsertFromTurn_` (locks + sheet; optional schema LLM) **V**; `recomputeDraftExpected_` / `resolveEffectiveTicketState_` **V**; NEW ticket flow → `finalizeDraftAndCreateTicket_` when draft READY **V**.

**Inside `finalizeDraftAndCreateTicket_` (blocking):** multi-issue defer branches; `inferLocationType_` (OpenAI) **V**; `processTicket_` (lock + dedupe scan + row create + optional `classify_` LLM + escalation SMS/call) **V**; directory/session mutations; `enqueueAiEnrichment_` (sheet append — async pickup) **V**; `workItemCreate_` (lock) **V**; `maybePolicyRun_` **V**; Sheet1 assignment columns **V**; `ctxUpsert_` **V**; post-create lifecycle (`onWorkItemActiveWork_` / `onWorkItemCreatedUnscheduled_`) when conditions met **V**.

**After return to core:** `dispatchOutboundIntent_` e.g. `TICKET_CREATED_ASK_SCHEDULE` (Outgate) **V** — **I:** this is the primary tenant-visible reply for the happy path after create.

**Actor-visible reply point:** First tenant SMS/TwiML emission from `dispatchOutboundIntent_` / `reply_` / `replyNoHeader_` branches in `handleSmsCore_` (and router for early exits). **V**

### 3.2 Staff operational update flow (non-`#`)

**Entry:** Same `doPost` → `handleSmsRouter_`. **V**

**Branch:** If `lifecycleEnabled_("GLOBAL")` and `isStaffSender_(phone)` and `staffHandleLifecycleCommand_(phone, bodyTrim)` returns true → **return** (no `handleSmsCore_`). **V**

**Blocking ops:** **I:** Sheets reads for staff/contact linkage in `isStaffSender_` **V**; lifecycle resolver + lifecycle engine transitions/logging **V** (see `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`, `LIFECYCLE_ENGINE.gs`).

**If lifecycle disabled:** message continues into full tenant router/core — **V** (matches draft concern).

### 3.3 Staff media / screenshot flow (`#…`)

**Entry:** `handleSmsRouter_` detects `#` → `routeToCoreSafe_` with `_staffCapture=1`, `mode: MANAGER`. **V**

**Core STAFF_CAPTURE block:** `withWriteLock_("STAFF_CAPTURE_INGEST_" + draftId)` **V**; `ensureDirectoryRowForPhone_` for `SCAP:{draftId}` **V**; multiple `dir.getRange` reads **V**; if media → `imageSignalAdapter_` + `mergeMediaIntoBody_` **V**; `compileTurn_` on merged text **V**; `draftUpsertFromTurn_` with `{ staffCapture: true }` **V**; `recomputeDraftExpected_` **V**; optional `finalizeDraftAndCreateTicket_` when triad complete **V**; staff reply `replyTo_(originPhoneStaff, line)` **V**.

**External / expensive:** Twilio media fetch + OpenAI vision **V**; `finalize` → `inferLocationType_` + `processTicket_` classify path when enabled **V**.

### 3.4 Continuation flow

**Router:** Uses `ctx.pendingExpected`, `routerInboundStrongStageMatch_`, tenant command handling, digit/word picks; often ends with `routeToCoreSafe_(e)` **V**.

**Core:** Still runs full pipeline (`compileTurn_`, draft upsert, `resolveEffectiveTicketState_`, stage handlers). **V** — draft claim that core always re-runs compiler for continuations is **confirmed**.

### 3.5 Portal / non-SMS create flow

**Entry:** `doPost` with `e.parameter.path` → `portalDoPost_` (`apps-script/ProperaPortalAPI.gs`). **V**

**PM create:** Authenticated `pm.createTicket` → `handlePmCreateTicket_` (portal file) — does not synthesize Twilio events. **V** In `PROPERA MAIN.gs`, `portalPmCreateTicketFromForm_` documents “Does NOT call `handleSmsCore_`” and feeds `finalizeDraftAndCreateTicket_`. **V**

**Actor-visible reply:** HTTP JSON to portal client, not SMS TwiML. **V**

### 3.6 Additional important paths

| Path | Summary |
|------|---------|
| **Telegram** | Inbound JSON in `doPost` may call `telegramWebhook_`; adapter enqueues and worker calls `handleSmsRouter_`. **V** |
| **Alexa** | JSON `alexaRequest` branch in `doPost` → `handleAlexaWebhook_`. **V** |
| **AppSheet / JSON ownership** | `handleAppSheetWebhook` from `doPost`. **V** |
| **Vendor / manager / system lanes** | `decideLane_` → `routeToCoreSafe_` with `_mode` / `_channel`. **V** |
| **Cleaning early dispatch** | `dispatchOperationalDomain_` can handle message and return from core. **V** |

---

## 4. VERIFIED PAIN MAP

| ID | Pain Point | Code Location | Why It Matters | Verified / Inference | Suggested Direction |
|----|------------|---------------|----------------|----------------------|---------------------|
| P0 | Twilio path bypasses `handleSmsSafe_` crash shield | `doPost` → `handleSmsRouter_` | Router exceptions caught in `doPost`; core errors rely on other guards — semantics differ from `handleSmsSafe_` wrapper. | **V** | Document actual entry; consider unified wrapper **without** duplicating architecture. |
| P1 | Staff without `#` falls through when lifecycle off | `handleSmsRouter_` | Double-processing / wrong lane risk remains. | **V** (draft) | Early staff identity gate **inside shared front**, still routing into lifecycle or controlled tenant stub — **PROPOSED CHANGE** (design only). |
| P2 | `compileTurn_` on continuations | `handleSmsCore_` | Redundant work + property sheet scans on long messages. | **V** | Continuation handler in front **PROPOSED CHANGE**; must preserve emergency + audit rules. |
| P3 | Vision + HTTP on STAFF_CAPTURE sync path | `imageSignalAdapter_` | Multi-second blocking before `replyTo_`. | **V** (draft) | Deferred enrichment queue **PROPOSED CHANGE**; idempotent patch of draft/ticket fields. |
| P4 | `inferLocationType_` + `classify_` before tenant post-create SMS | `finalizeDraftAndCreateTicket_`, `processTicket_` | LLM/network latency stacks before `dispatchOutboundIntent_` returns from finalize’s **caller** still waiting on full finalize. | **V** | Narrow “fast create” only if safety proofs hold; or defer non-blocking enrich **PROPOSED CHANGE**. |
| P5 | Multiple `PropertiesService.getScriptProperties` reads per invocation | `handleSmsCore_`, helpers | Repeated key fetch; minor but real. | **V** | Request-scope cache object **PROPOSED CHANGE**. |
| P6 | `globalThis.__inboundChannel` | `doPost`, core | Channel leak vs canonical signal object. | **V** (draft) | Thread channel on normalized inbound / intent **PROPOSED CHANGE**. |
| P7 | Context keyed by phone | `ctxGet_(phone)` etc. | Non-SMS actors need synthetic keys (`SCAP:`, `PORTAL_PM:`) — works but fragile. | **V** | Canonical actor id on signal **PROPOSED CHANGE** (aligns with draft). |
| P8 | Twilio media field names in router/core | `handleSmsRouter_`, STAFF_CAPTURE | Transport coupling. | **V** (draft) | Adapter normalizes to `media[]` only — partial already in `normalizeInboundEvent_` meta **I**. |
| P9 | Staff `#` skips opt-out / compliance / lane normalization | `handleSmsRouter_` early return | Operational inconsistency; abuse / mis-send surface. | **V** | Re-evaluate whether minimal compliance/auth should run **PROPOSED CHANGE** (human decision). |
| P10 | `draftUpsertFromTurn_` + schema LLM | `draftUpsertFromTurn_` | Extra OpenAI round-trip before lock. | **V** | Gate frequency / move to post-reply enrichment **PROPOSED CHANGE**. |
| P11 | Direct `getRange` in hot paths | `compileTurn_` callers, `handleSmsCore_`, `finalizeDraftAndCreateTicket_`, `processTicket_` | Migration drag + scattered IO. | **V** | DAL consolidation **PROPOSED CHANGE** (draft Phase 6 direction is sound). |
| P12 | `processTicket_` manager/oncall SMS + optional `placeCall_` | `processTicket_` | External side effects before tenant reply is sent from core. | **V** | Policy/escalation ordering review **PROPOSED CHANGE** / human decision. |

---

## 5. ARCHITECTURE ALIGNMENT CHECK

**Does the code preserve one architecture with multiple modes?** **STRONG INFERENCE:** Yes — single `doPost` gateway, `handleSmsRouter_` lane decision, `routeToCoreSafe_` → `handleSmsCore_` orchestrator, shared `finalizeDraftAndCreateTicket_` / `processTicket_`, Outgate intents. Modes: `_mode` (TENANT/MANAGER/VENDOR/SYSTEM), `_staffCapture`, portal/telegram/alexa adapters.

**Where it drifts**

- **Transport globals** (`__inboundChannel`, Twilio param names deep in core). **V**
- **Direct Sheet IO** outside a single DAL file (many `getRange`/`setValues`/`appendRow` in `PROPERA MAIN.gs`). **V**
- **Legacy entry** (`handleSms_` / `handleSmsSafe_`) not wired to Twilio path. **V**
- **Mixed outbound styles:** `dispatchOutboundIntent_` vs `sendSms_` / `replyTo_` / `reply_` still coexist. **V**

**Biggest parallel-architecture risks if “optimizing” carelessly**

- Separate tenant/staff pipelines that skip `finalizeDraftAndCreateTicket_` / `workItemCreate_` / policy hooks.
- Second queue system per channel instead of one idempotent job model.
- Hardcoded SMS bodies bypassing Outgate for “speed.”

**Safe optimizations inside shared front (conceptual)**

- Deterministic gates that **only skip** `compileTurn_` / redundant draft writes when **provably** equivalent to current semantics.
- Reuse Telegram’s **enqueue-then-worker** pattern for heavy enrichment (same router entry).

**Would violate Compass / guardrails**

- Skipping responsibility assignment truth for staff-facing acks that imply ownership.
- Skipping lifecycle transitions / policy logging for operations that change WI truth.
- Adapters choosing business outcomes; Outgate choosing routing.

### Non-Negotiable Invariants

1. **Canonical create path** for maintenance tickets: `processTicket_` + `workItemCreate_` (and existing policy/lifecycle hooks) — no shadow writers. **V**
2. **State transitions** via approved lifecycle / `workItemUpdate_` / `wiTransition_` patterns — no ad-hoc status cells for operational truth. **V** / **I**
3. **Outbound product language** for migrated intents: `dispatchOutboundIntent_` + templates (Outgate). **V**
4. **No business routing in pure adapters** — normalization only at webhook edge. **I** (doctrine + `OUTGATE.gs` comments)
5. **Emergency evaluation** must remain reachable for messages that are emergencies regardless of “fast path.” **V** / **I**
6. **Dedupe** — respect `inboundKey` / locks in `processTicket_` and staff capture keys. **V**

---

## 6. VERIFIED EARLY-ROUTING GATES

Only gates with **existing hooks** or **clear insertion points** are listed.

| Gate | Trigger | Existing support | May skip (if proven equivalent) | Must never skip | Risk |
|------|---------|------------------|--------------------------------|-----------------|------|
| **Staff operational (non-`#`)** | `isStaffSender_` && lifecycle command match | Already routes to `staffHandleLifecycleCommand_` when lifecycle GLOBAL on **V** | `compileTurn_` / tenant draft | Emergency reporting path for staff-originated emergencies; audit for lifecycle actions **I** | Low when lifecycle on; **high** when lifecycle off (known gap). |
| **Continuation** | `ctx.pendingExpected` + strong parser match | Router branches; still calls core **V** | Re-running full `compileTurn_` / redundant draft writes **PROPOSED** | Emergency text inside “continuation” message; stage audit expectations **I** | Medium — needs parity tests. |
| **Complete-signal fast create** | Property + unit + issue fully known from body+ctx | No dedicated `evaluateFastCreate_` **V** | Draft machine turns **PROPOSED** | `inferLocationType_` / `processTicket_` dedupe / policy hooks unless formally relocated **I** | High until equivalence proven. |
| **Media deferral** | Staff (or tenant) image inbound | `imageSignalAdapter_` synchronous today **V** | Vision + fetch after ack **PROPOSED** | Ticket row truth (must not claim final issue text from vision before commit rules) **I** | High — needs idempotent patch + UX templates. |
| **Staff `#` compliance pre-check** | Any `#` message | None today **V** | N/A | If product requires STOP/HELP parity, gate should exist **PROPOSED** | Medium — product/legal **I** |

**Gate not recommended without redesign:** Blanket “skip `processTicket_` classify” on fast path — classification drives EMER/URG and oncall behavior **V**.

---

## 7. SYNC VS DEFERRED CLASSIFICATION

Conservative — aligned to current truth-bearing writes.

### 7.1 Safe to Defer

- **Secondary AI enrichment already enqueued** — `enqueueAiEnrichment_` worker processing **V**.
- **Non-blocking staff-cap tenant identity enrichment** — `enrichStaffCapTenantIdentity_` documented as non-blocking in finalize **V**.
- **Analytics-style post-processing** that does not change WI assignment or tenant schedule obligation — **I** (if explicitly isolated).

### 7.2 Conditionally Deferrable

- **Vision / media synthesis** — deferrable only with: shell ticket/WI row, idempotent patch, clear `PENDING_MEDIA_ANALYSIS` semantics, no staff promise that contradicts later state **PROPOSED**.
- **Resolver / assignment** — draft’s narrow exception (tenant schedule ask independent of assignee) remains **PROPOSED CHANGE**; must be validated per template/policy **I**.
- **Location LLM (`inferLocationType_`)** — deferrable only if UNIT/COMMON_AREA defaulting is safe for that message class **PROPOSED** (risky for common-area detection).

### 7.3 Must Remain Synchronous (today)

- **Hard dedupe inside `processTicket_` lock** before duplicate row **V**.
- **Ticket row creation + classification path that sets EMER/URG** when policy relies on it **V**.
- **`workItemCreate_` + assignment fields that downstream lifecycle uses in same request** **V** / **I**.
- **Staff lifecycle commands that assert WI ownership** — until async queue is proven **I**.
- **STOP/START compliance mutations** (router) **V**.

---

## 8. GAS REALITY CHECK

**What “async” means here:** No true background threads per request. Patterns are: **time-driven triggers** (`aiEnrichmentWorker`, Telegram worker **V**), **sheet queues**, **PropertiesService / CacheService** for dedupe, **UrlFetchApp** with sync wait.

**Realistic queue model:** Extend existing **sheet row + 1-minute trigger** pattern (`enqueueAiEnrichment_`, Telegram queue **V**). New work should reuse one idempotent processor style.

**Trigger limitations:** Quotas, concurrency, and “at most once per minute” granularity — design jobs to be **small, idempotent, retry-safe**.

**Idempotency:** `processTicket_` uses `inboundKey` scan **V**; staff capture uses `STAFFCAP:…` keys **V**; WI ids UUID-based **V**. Any new queue must carry stable keys and tolerate duplicate delivery.

**Delay until queue safety exists:** Broad resolver deferral, multi-step staff promises split across executions, anything that could double-notify staff.

---

## 9. PERSISTENCE / DAL HARDENING MAP

### Existing DAL-like functions

- **`dal*` / `dalWithLock_` / `dalGetPending*` / `dalSetPending*`** — directory draft columns **V**
- **`workItemCreate_` / `workItemUpdate_` / `workItemGetById_`** — WorkItems sheet **V**
- **`processTicket_`** — ticket row lifecycle (documented as canonical ticket writer) **V**
- **`ctxUpsert_` / `ctxGet_`** — context sheet **V**
- **`policyLogEventRow_`** — `POLICY_ENGINE.gs` **V**

### Direct Sheets violations (representative, not exhaustive)

- **`handleSmsCore_` STAFF_CAPTURE:** multiple `dir.getRange(...)` **V**
- **`draftUpsertFromTurn_`:** `dir.getRange` inside lock **V**
- **`finalizeDraftAndCreateTicket_`:** `dir.getRange`, `sheet.getRange` **V**
- **`processTicket_`:** `sheet.getRange` / `setValues` **V**
- **`workItemUpdate_`:** column `setValue` **V**
- **`isStaffSender_`:** full Staff + Contacts scans **V**

### Minimum contract before DB migration

Stable verbs already **partially** exist: ticket create via `processTicket_`, WI via `workItemCreate_`/`workItemUpdate_`, directory via `dal*`, context via `ctx*`, policy log via `policyLogEventRow_`. **I:** Missing a **single module** that owns all remaining raw `getRange` in `PROPERA MAIN.gs` orchestrator.

### Recommended hardening order

1. Inventory **all** `SpreadsheetApp` / `getRange` in `PROPERA MAIN.gs` (automated grep). **V** method  
2. Wrap directory reads in STAFF_CAPTURE behind `dalReadDraftSnapshot_` **PROPOSED**  
3. Isolate ticket row classification writes (already partially batched in `processTicket_`) **V**  
4. Move Staff/Contacts reads behind cached service **PROPOSED**  
5. Only then swap storage backend behind DAL **I**

---

## 10. VERIFIED TARGET RUNTIME SHAPE

**Framing (architecture-aligned):**

`Adapter → Canonical Signal → Shared Front (lanes + early gates) → Domain (policy/resolver/lifecycle) → Commit (ticket + WI + ctx) → Outbound Intent → Outgate → Channel`

**Where early routing lives:** Inside **shared front** (`handleSmsRouter_` + top of `handleSmsCore_`), as **modes**, not new products.

**Where heavy enrichment moves later:** After **minimal commit** or after **actor ack**, using **existing queue patterns** (AI enrichment sheet **V**, Telegram queue **V**).

**Earlier response without breaking truth:** Emit **templated outbound intent** only when stored operational state already supports it; use explicit pending states for deferred analysis (e.g. media).

---

## 11. EXECUTION PLAN

### Phase 0 — Verification lock

- **Goal:** Baseline traces and invariants locked (this document).  
- **Touches:** None. **V**  
- **Invariants:** All documented non-negotiables.  
- **Risk:** None.  
- **Validation:** Grep-based maps + manual read of `finalizeDraftAndCreateTicket_` / `processTicket_` / STAFF_CAPTURE.

### Phase 1 — Entry / observability truth

- **Goal:** Align docs and dashboards with real entry (`doPost` → `handleSmsRouter_`); optionally route Twilio through `handleSmsSafe_` **only if** behavior is intentionally unified. **PROPOSED CHANGE**  
- **Touches:** `PROPERA MAIN.gs` (`doPost`).  
- **Risk:** Low–medium (error handling semantics).  
- **Depends on:** Phase 0.

### Phase 2 — Staff front door hardening

- **Goal:** Reduce tenant draft pollution from staff without `#` when lifecycle disabled — deterministic staff classifier or lifecycle default policy (**human**). **PROPOSED CHANGE**  
- **Touches:** `handleSmsRouter_`, possibly `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`.  
- **Risk:** Medium.  
- **Validation:** Staff SMS matrix logs.

### Phase 3 — Continuation lane

- **Goal:** Skip redundant `compileTurn_` when `pendingExpected` + strong match + safety checks. **PROPOSED CHANGE**  
- **Touches:** `handleSmsRouter_` or top of `handleSmsCore_`.  
- **Risk:** Medium.  
- **Validation:** Stage regression harness; emergency injection tests.

### Phase 4 — Media deferral

- **Goal:** Ack first, queue vision job, patch draft/ticket — mirror `TELEGRAM_ADAPTER` / `enqueueAiEnrichment_`. **PROPOSED CHANGE**  
- **Touches:** STAFF_CAPTURE block, new sheet or reuse queue, worker trigger, Outgate templates.  
- **Risk:** High.  
- **Depends on:** Idempotency design.

### Phase 5 — Fast create (tenant)

- **Goal:** Bypass draft accumulator only when fields are provably complete **and** downstream safety (`inferLocationType_`, classify, dedupe) is preserved or explicitly replaced. **PROPOSED CHANGE**  
- **Risk:** High.  
- **Depends on:** Phase 3–4 learnings.

### Phase 6 — DAL sweep

- **Goal:** Remove raw `dir.getRange` / hot-path scans from orchestrator. **PROPOSED CHANGE**  
- **Risk:** Medium (surface area).  
- **Depends on:** grep inventory.

---

## 12. SURGICAL EXECUTION CHECKLIST

- [ ] Fix internal docs/diagrams: Twilio entry = `handleSmsRouter_`, not `handleSms_`. **V**
- [ ] Grep `getRange\(|appendRow\(|setValues\(` in `PROPERA MAIN.gs`; tag owner module per row. **V**
- [ ] Log timings: `compileTurn_`, `draftUpsertFromTurn_`, `inferLocationType_`, `processTicket_` (classify on/off), `imageSignalAdapter_`. **PROPOSED**
- [ ] Decide product policy: should `#` staff bypass STOP/HELP? **NEEDS HUMAN**
- [ ] Prototype continuation fast path behind feature flag property. **PROPOSED**
- [ ] Reuse `enqueueAiEnrichment_` pattern for media jobs or extend with typed job column. **PROPOSED**
- [ ] Add tests / SIM harness for: staff capture with image, tenant complete create, pending SCHEDULE reply. **PROPOSED**
- [ ] Cache `getScriptProperties()` once per request object. **PROPOSED**

---

## 13. OPEN QUESTIONS / NEEDS HUMAN DECISION

1. Should **staff `#` messages** go through **SMS compliance / opt-out** handling? Code currently does not (**V**).  
2. Is **deferred assignment** ever acceptable for **non-schedule** tenant intents given current templates? **I**  
3. For **fast create**, can **location classification** default to UNIT without **inferLocationType_** for certain message shapes? **I**  
4. Should **`handleSmsSafe_` wrap** the Twilio router for consistent crash behavior vs `doPost` catch? **I**  
5. **Portal vs SMS** — should portal creates run identical policy hooks timing as SMS (they share finalize **V** but different adapter)? **I**

---

## 14. FINAL RECOMMENDATION

**Proceed** with performance work **only** as **surgical early-routing and deferral** inside the existing gateway and orchestrator — **not** new parallel stacks.

**Do first:** Phase 0–1 (truth on entry + timing logs) and **Phase 3** scoping (continuation) — highest ROI / lower risk than full fast-create while `inferLocationType_` + `classify_` remain in `finalize`/`processTicket_`.

**Do not do yet:** Blanket fast-create that skips `processTicket_` segments without a **proven** equivalence map for emergency, dedupe, and policy. **Defer** resolver deferral (draft Phase 5) until queue idempotency is production-proven.

---

*Verified against repository snapshot; re-run grep when merging large branches.*
