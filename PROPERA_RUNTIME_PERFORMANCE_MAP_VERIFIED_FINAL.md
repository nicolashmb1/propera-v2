# PROPERA RUNTIME PERFORMANCE MAP — VERIFIED
Current State · Verified Target Shape · Execution Plan  
Date: 2026-03-19  
Status: VERIFIED AGAINST CODEBASE

Primary sources audited: `PROPERA MAIN.gs`, `LIFECYCLE_ENGINE.gs`, `POLICY_ENGINE.gs`, `OUTGATE.gs`, `STAFF_RESOLVER.gs`, `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`, `TELEGRAM_ADAPTER.gs`, `apps-script/ProperaPortalAPI.gs`. Cross-checked against `PROPERA_NORTH_COMPASS.md` and `PROPERA_GUARDRAILS.md`.

---

## 1. PURPOSE

This document is a **runtime and performance verification** of the live Propera Apps Script project. It **does not** replace architecture doctrine (North Compass / guardrails). It records what the code **actually** does on inbound paths, marks **verified** vs **inferred** claims, corrects errors in `PROPERA_RUNTIME_PERFORMANCE_MAP.md` (draft), and proposes a **conservative execution plan** that keeps a **single backbone** (shared front → domain → commit → outbound intent → outgate) with **early-routing modes inside the front**, not parallel products.

---

## ARCHITECTURAL LINE OF INTEGRITY

Core principle (non-negotiable): **Propera may optimize runtime paths, but it may not fragment operational truth.**  
This plan allows **many processing modes**, but it must never create **many competing architectures**.

Architecture-level constraints for every phase (**STRONG INFERENCE FROM CODE**, supported by the single `doPost`/router/core/outgate pattern in code):

1. **All phases operate inside the existing Propera backbone** (adapter → shared front → domain engines → canonical commit → outbound intent → outgate). **STRONG INFERENCE FROM CODE**
2. **No phase may introduce a separate tenant/staff/media/portal/telegram/channel-specific business pipeline.** Modes are allowed only as **shared-front decision branches** and **post-commit enrichment deferrals**. **VERIFIED IN CODE** (current shared-front and adapter-only patterns)
3. Every phase must preserve one of each truth model: one **canonical signal intake model**, one **shared front layer**, one **responsibility / lifecycle truth model**, one **commit truth**, one **canonical outbound intent model**, and one **outgate / expression layer**. **STRONG INFERENCE FROM CODE** (layering intent in guardrails + observed call structure)
4. Performance gains may come only from: skipping redundant interpretation, deferring non-blocking enrichment, reducing repeated reads/writes, and improving queue/trigger patterns **safely**. **STRONG INFERENCE FROM CODE** (existing queue workers + idempotent patterns)
5. Performance gains may never come from bypassing truth-bearing state transitions, bypassing audit anchors, burying emergency handling, bypassing canonical commit paths, or introducing parallel operational pipelines. **PROVEN BY GUARDRAILS** (`PROPERA_GUARDRAILS.md`) / **STRONG INFERENCE FROM CODE**

Many processing modes are allowed. Many competing architectures are not.  

---

## 2. EXECUTIVE FINDINGS

Summarize what in the draft was correct, what was wrong or overstated, and what the real codebase makes clear for performance work that stays on one architectural line.

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
| **`compileTurn_` contains `domainScore_`, `inferLocation_`** | **NOT FOUND in `compileTurn_`.** **VERIFIED IN CODE:** Compiler does property resolution (`resolvePropertyExplicitOnly_`, optional `getActiveProperties_` scans), `extractUnit_` / `normalizeUnit_`, `evaluateEmergencySignal_`, issue path via `parseIssueDeterministic_` / fallbacks. |
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

If lifecycle disabled: message continues into full tenant router/core — **V** (matches draft concern).

### 3.3 Staff media / screenshot flow (`#…`)

**Entry:** `handleSmsRouter_` detects `#` → `routeToCoreSafe_` with `_staffCapture=1`, `mode: MANAGER`. **V**

Core STAFF_CAPTURE block: `withWriteLock_("STAFF_CAPTURE_INGEST_" + draftId)` **V**; `ensureDirectoryRowForPhone_` for `SCAP:{draftId}` **V**; multiple `dir.getRange` reads **V**; if media → `imageSignalAdapter_` + `mergeMediaIntoBody_` **V**; `compileTurn_` on merged text **V**; `draftUpsertFromTurn_` with `{ staffCapture: true }` **V**; `recomputeDraftExpected_` **V**; optional `finalizeDraftAndCreateTicket_` when triad complete **V**; staff reply `replyTo_(originPhoneStaff, line)` **V**.

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
| P4 | `inferLocationType_` + `classify_` before tenant post-create SMS | `finalizeDraftAndCreateTicket_`, `processTicket_` | LLM/network latency stacks before `dispatchOutboundIntent_` returns from finalize’s **caller** still waiting on full finalize. | **V** | Narrow “fast create” only when operationally sufficient; preserve emergency + policy facts, otherwise defer enrichment **PROPOSED CHANGE**. |
| P5 | Multiple `PropertiesService.getScriptProperties` reads per invocation | `handleSmsCore_`, helpers | Repeated key fetch; minor but real. | **V** | Request-scope cache object **PROPOSED CHANGE**. |
| P6 | `globalThis.__inboundChannel` | `doPost`, core | Channel leak vs canonical signal object. | **V** (draft) | Thread channel on normalized inbound / intent **PROPOSED CHANGE**. |
| P7 | Context keyed by phone | `ctxGet_(phone)` etc. | Non-SMS actors need synthetic keys (`SCAP:`, `PORTAL_PM:`) — works but fragile. | **V** | Canonical actor id on signal **PROPOSED CHANGE** (aligns with draft). |
| P8 | Twilio media field names in router/core | `handleSmsRouter_`, STAFF_CAPTURE | Transport coupling. | **V** (draft) | Adapter normalizes to `media[]` only — partial already in `normalizeInboundEvent_` meta **I**. |
| P9 | Staff `#` skips opt-out / compliance / lane normalization | `handleSmsRouter_` early return | Operational inconsistency; abuse / mis-send surface. | **V** | Re-evaluate whether minimal compliance/auth should run **PROPOSED CHANGE** (human decision). |
| P10 | `draftUpsertFromTurn_` + schema LLM | `draftUpsertFromTurn_` | Extra OpenAI round-trip before lock. | **V** | Gate frequency / move to post-reply enrichment **PROPOSED CHANGE**. |
| P11 | Direct `getRange` in hot paths | `compileTurn_` callers, `handleSmsCore_`, `finalizeDraftAndCreateTicket_`, `processTicket_` | Migration drag + scattered IO. | **V** | DAL consolidation **PROPOSED CHANGE** (draft Phase 6 direction is sound). |
| P12 | `processTicket_` manager/oncall SMS + optional `placeCall_` | `processTicket_` | External side effects before tenant reply is sent from core. | **V** | Policy/escalation ordering review **PROPOSED CHANGE** / human decision. |

---

## EXPECTED OUTCOMES OF THIS PLAN

This plan should produce:
- clearer runtime truth (entry points, blocking points, and where replies actually happen) (**VERIFIED IN CODE**)
- safer optimizations that remain on one architectural line (**STRONG INFERENCE FROM CODE** + guardrails)
- reduced unnecessary synchronous work via redundant interpretation skipping and enrichment deferral (**PROPOSED CHANGE**)
- better observability of bottleneck segments (timing logs and explicit gate logs) (**PROPOSED CHANGE**)
- stronger migration readiness by reducing scattered data IO and clarifying persistence contracts (**PROPOSED CHANGE**)
- preserved architecture integrity: one backbone, many modes (**VERIFIED IN CODE** pattern + guardrails)

This plan should NOT be expected to produce:
- instant full-system speed miracles in one phase (LLM/network calls remain truth-bearing today) (**STRONG INFERENCE FROM CODE**)
- elimination of all synchronous work (some truth-bearing operations must stay sync) (**VERIFIED IN CODE**)
- permission to bypass responsibility/lifecycle truth or audit anchors (**PROVEN BY GUARDRAILS**)
- separate “fast” systems per actor/channel (**PROVEN BY ARCHITECTURAL LINE**)

---

## 5. ARCHITECTURE ALIGNMENT CHECK

Explicitly answer: does the current code already preserve one architecture with multiple modes?

**Does the code preserve one architecture with multiple modes?** **STRONG INFERENCE:** Yes — single `doPost` gateway, `handleSmsRouter_` lane decision, `routeToCoreSafe_` → `handleSmsCore_` orchestrator, shared `finalizeDraftAndCreateTicket_` / `processTicket_`, Outgate intents. Modes: `_mode` (TENANT/MANAGER/VENDOR/SYSTEM), `_staffCapture`, portal/telegram/alexa adapters.

**Where it drifts**

- **Transport globals** (`__inboundChannel`, Twilio param names deep in core). **V**
- **Direct Sheet IO** outside a single DAL file (many `getRange`/`setValues`/`appendRow` in `PROPERA MAIN.gs`). **V**
- **Legacy entry** (`handleSms_` / `handleSmsSafe_`) not wired to Twilio path. **V**
- **Mixed outbound styles:** `dispatchOutboundIntent_` vs `sendSms_` / `replyTo_` / `reply_` still coexist. **V**

**Biggest risks of creating parallel architectures**

- Separate tenant/staff pipelines that skip `finalizeDraftAndCreateTicket_` / `workItemCreate_` / policy hooks. (**PROHIBITED** by this plan)
- Second queue system per channel instead of one idempotent job model. (**PROHIBITED**)
- Hardcoded SMS bodies bypassing Outgate for “speed.” (**PROHIBITED**)

**Safe optimizations inside shared front (conceptual)**

- Deterministic gates that only skip `compileTurn_` / redundant draft writes when provably equivalent and when emergency/policy truth remains reachable.
- Reuse Telegram’s enqueue-then-worker pattern for heavy enrichment (same router entry), keeping one commit truth.

**Would violate Compass / guardrails**

- Skipping responsibility assignment truth for staff-facing acks that imply ownership.
- Skipping lifecycle transitions / policy logging for operations that change WI truth.
- Adapters choosing business outcomes; Outgate choosing routing.

### Non-Negotiable Invariants

List what may never be bypassed even by fast routes.

1. **Canonical create path** for maintenance tickets: `processTicket_` + `workItemCreate_` (and existing policy/lifecycle hooks) — no shadow writers. **V**
2. **State transitions** via approved lifecycle / `workItemUpdate_` / `wiTransition_` patterns — no ad-hoc status cells for operational truth. **V** / **I**
3. **Outbound product language** for migrated intents: `dispatchOutboundIntent_` + templates (Outgate). **V**
4. **No business routing in pure adapters** — normalization only at webhook edge. **I** (doctrine + `OUTGATE.gs` comments)
5. **Emergency evaluation must remain reachable for messages that are emergencies regardless of “fast path.”** **V** / **I**
6. **Emergency detection is a universal interrupt, not a lane-specific optimization step.** **VERIFIED IN CODE** (emergency evaluation checks exist in shared compilation/handlers; gates must not suppress them)
7. **Dedupe** — respect `inboundKey` / locks in `processTicket_` and staff capture keys. **V**

---

## 6. VERIFIED EARLY-ROUTING GATES

Do NOT invent fantasy gates. Define only gates that are actually plausible given the current code and constrained to the **shared front as modes** (not competing systems).

For every gate, the architecture rule applies: **modes are allowed; truth fragmentation is not.** (**PROVEN BY ARCHITECTURAL LINE OF INTEGRITY**)

| Gate | Trigger | Existing code that already supports part of it | What can be skipped | What may never be skipped | Risk |
|------|---------|----------------------------------------------------|------------------------|-----------------------------|------|
| **Staff operational (non-`#`)** | `isStaffSender_` && staff lifecycle command match | `handleSmsRouter_` already routes to `staffHandleLifecycleCommand_` when lifecycle GLOBAL | `compileTurn_` / tenant draft | Emergency reporting path for staff-originated emergencies; audit for lifecycle actions (**I**) | Low when lifecycle on; high when lifecycle off (known gap). |
| **Continuation gate** | `ctx.pendingExpected` + strong stage match | `handleSmsRouter_` has deterministic `pendingExpected` handling and stage-shaped override logic | Re-running full `compileTurn_` / redundant draft writes **only if** exact stage advance is unambiguous and emergency/policy truth is unaffected (**PROPOSED CHANGE**) | Emergency handling; stage audit; single commit truth | Medium — requires parity tests. |
| **Complete-signal fast create gate** | Signal is **operationally sufficient for direct create**, meaning property is confidently resolved, unit is confidently resolved, issue is operationally sufficient for work item creation, no ambiguity requires clarification, and no emergency/policy-required fact is missing for that issue class. | No dedicated `evaluateFastCreate_` exists today; `handleSmsCore_` already decides missing stages via `draftDecideNextStage_` and only finalizes on `READY`. | **PROPOSED:** skip redundant interpretation when state is already “READY-equivalent”, while preserving the canonical create / classify / dedupe / lifecycle hooks | Emergency evaluation; canonical finalize path (`finalizeDraftAndCreateTicket_` → `processTicket_` / `workItemCreate_`), dedupe, policy hooks, and canonical outbound intent. **Also required (DECISION LOCK):** location classification must remain reliable (no broad UNIT default; deterministic shortcut only for clearly unambiguous cases; otherwise still invoke `inferLocationType_`). | High until safety proof exists. |
| **Media deferral gate (staff capture and/or tenant media)** | Incoming message includes image/screenshot that triggers `imageSignalAdapter_` | `imageSignalAdapter_` exists and `enqueueAiEnrichment_` / Telegram worker patterns exist | Defer vision fetch/AI synthesis until after an allowed commit truth; patch draft/ticket via idempotent `wiPatch_` style (**PROPOSED CHANGE**) | Ticket/WI truth-bearing fields and policy anchors; emergency interrupt; no second operational pipeline | High — requires idempotent patch + UX/templates. |
| **Staff `#` compliance / opt-out handling gate** | Any `#` message | **VERIFIED IN CODE:** early `#` branch returns before tenant STOP/HELP compliance / opt-out suppression logic | Skip tenant SMS consumer compliance flows (STOP/HELP, opt-out suppression) as per **DECISION LOCK** | Minimal shared-front validation (identity + parsing safety) and emergency interrupt remains reachable (no lane-specific burying); must still converge on canonical commit truth | Low (product rule locked). |

Gate not recommended without redesign: blanket “skip `processTicket_` classify” on fast path. Classification drives EMER/URG and oncall behavior (**VERIFIED IN CODE**), so skipping it without an equivalent truth source is unsafe.

---

## 7. SYNC VS DEFERRED CLASSIFICATION

Conservative — aligned to current truth-bearing writes and this plan’s single-architecture line.

### 7.1 Safe to Defer

- **Secondary AI enrichment already enqueued** — `enqueueAiEnrichment_` worker processing **V**.
- **Non-blocking staff-cap tenant identity enrichment** — `enrichStaffCapTenantIdentity_` documented as non-blocking in finalize **V**.
- **Analytics-style post-processing** that does not change WI assignment or tenant schedule obligation — **I** (if explicitly isolated).

### 7.2 Conditionally Deferrable

- **Vision / media synthesis** — deferrable only with: idempotent patching, clear pending semantics, and no staff promise that contradicts later state (**PROPOSED CHANGE**).

Shell work item definition (critical for single-commit truth):  
**A shell work item is not a placeholder record or alternate pipeline. It is a valid canonical work item created through the normal create path with an explicitly allowed pending-analysis state.** **STRONG INFERENCE FROM CODE** (create path already supports work state/substate; media deferral must still use canonical create/write verbs).

- **Resolver / assignment (early-response deferral)** — **DECISION LOCK** allows emitting certain tenant responses before assignment is resolved, but only when the response does not depend on assignee/vendor identity and does not imply ownership/dispatch/escalation; canonical assignment truth must still be committed before any truth-bearing staff/vendor communication (**PROPOSED CHANGE**, constrained by the decision lock).
- **Location classification** — **DECISION LOCK**: do NOT broadly default location to `UNIT`. Deterministic shortcuts may be introduced only for clearly unambiguous cases; otherwise ambiguous cases must still invoke `inferLocationType_` as the AI fallback. (**PROPOSED CHANGE**, conservative for reliability).

### 7.3 Must Remain Synchronous (today)

- Hard dedupe inside `processTicket_` lock before duplicate row **V**.
- Ticket row creation + classification path that sets EMER/URG when policy relies on it **V**.
- `workItemCreate_` + assignment fields that downstream lifecycle uses in same request **V** / **I**.
- Staff lifecycle commands that assert WI ownership — until async queue is proven safe **I**.
- STOP/START compliance mutations (router) **V**.

---

## 8. GAS REALITY CHECK

What “async” means in this actual codebase:  
No true background threads per request. Patterns are: time-driven triggers (`aiEnrichmentWorker`, Telegram worker **V**), sheet queues, `PropertiesService` / `CacheService` dedupe, `UrlFetchApp` with sync wait.

Realistic queue model: extend existing sheet-row + 1-minute trigger pattern (`enqueueAiEnrichment_`, Telegram queue **V**). New work should reuse one idempotent processor style, keeping one commit truth.

Trigger limitations: quotas, concurrency, and “at most once per minute” granularity — design jobs to be small, idempotent, retry-safe.

Idempotency: `processTicket_` uses `inboundKey` scan **V**; staff capture uses `STAFFCAP:…` keys **V**; WI ids UUID-based **V**. Any new queue must carry stable keys and tolerate duplicate delivery.

Delay until queue safety exists: broad resolver deferral, multi-step staff promises split across executions, anything that could double-notify staff.

---

## 9. PERSISTENCE / DAL HARDENING MAP

Audit direct Sheets usage and coupling.

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

### Minimum contract needed before migration

Stable verbs already partially exist: ticket create via `processTicket_`, WI via `workItemCreate_`/`workItemUpdate_`, directory via `dal*`, context via `ctx*`, policy log via `policyLogEventRow_`. **I:** Missing a single module that owns all remaining raw `getRange` in `PROPERA MAIN.gs` orchestrator.

### Recommended order of hardening

1. Inventory all `SpreadsheetApp` / `getRange` in `PROPERA MAIN.gs` (automated grep). **V**
2. Wrap directory reads in STAFF_CAPTURE behind `dalReadDraftSnapshot_` **PROPOSED**
3. Isolate ticket row classification writes (already partially batched in `processTicket_`) **V**
4. Move Staff/Contacts reads behind cached service **PROPOSED**
5. Only then swap storage backend behind DAL **I**

---

## 10. VERIFIED TARGET RUNTIME SHAPE

Describe the corrected target runtime shape in Propera-aligned language while keeping one architecture backbone.

`Adapter → Canonical Signal → Shared Front (lanes + early gates/modes) → Domain (policy/resolver/lifecycle) → Commit (ticket + WI + ctx) → Outbound Intent → Outgate → Channel`

Explicit placement rules (architecture line of integrity):

- **Early routing is inside the Shared Front** and is implemented as **processing modes**, not as separate systems. **STRONG INFERENCE FROM CODE**
- **Staff handling is an early interpretation mode** (e.g. `#` capture branch / staff lifecycle command) that still routes through the shared commit/lifecycle/outgate backbone. **VERIFIED IN CODE**
- **Continuation handling is a front-door optimization** (stage-shaped parsing) that may reduce redundant interpretation but must not create a second conversation engine. **VERIFIED IN CODE** (continuations still call core)
- **Media deferral is deferred enrichment around the same commit truth**, not a separate media workflow/pipeline. The canonical create path still commits a valid state first, then enrichment patches. **PROPOSED CHANGE** constrained by shell work item rule

Where early response happens safely: emit a templated outbound intent only when stored operational state already supports it; otherwise use explicit pending states for deferred analysis (e.g. media). **STRONG INFERENCE FROM CODE**

---

## 11. EXECUTION PLAN

Create a phased execution plan with invariant preservation and clear architectural justification.

### Phase 0 — Verification lock

- Goal: Baseline traces and invariants locked (this document).  
- Touches: None. **V**  
- Invariants: All documented non-negotiables.  
- Risk: None.  
- Dependency order: must precede any “gate eligibility” claims and any code edits. **STRONG INFERENCE FROM CODE**
- Architectural reason this phase is valid: it improves runtime truth and observability without changing the backbone (no new mode/system). **VERIFIED IN CODE** (doc-only)
- Validation: Grep-based maps + manual read of `finalizeDraftAndCreateTicket_` / `processTicket_` / STAFF_CAPTURE.

### Phase 1 — Entry / observability truth

- Goal: Align docs/dashboards with real entry (`doPost` → `handleSmsRouter_`), and instrument crash-handling differences between `doPost` and `handleSmsSafe_` before unifying behavior; preserve current runtime behavior initially, then converge only after observed failure-mode parity. Also instrument adapter convergence (SMS vs Portal/Telegram) for lifecycle/policy timing relative to commit truth (**PROPOSED CHANGE**)  
- Touches: `PROPERA MAIN.gs` (`doPost`).  
- Risk: Low–medium (error handling semantics).  
- Depends on: Phase 0.
- Architectural reason this phase is valid: it improves shared-front observability and adapter convergence checks without changing truth ownership or creating parallel pipelines. **STRONG INFERENCE FROM CODE**
- Validation: error-path tests and dev log checks that confirm reply behavior remains on the same backbone.

### Phase 2 — Staff front door hardening

- Goal: Reduce tenant draft pollution from staff without `#` when lifecycle disabled — deterministic staff classifier or lifecycle default policy (**human**). **PROPOSED CHANGE**  
- Touches: `handleSmsRouter_`, possibly `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`.  
- Risk: Medium.  
- Validation: Staff SMS matrix logs.
- Architectural reason this phase is valid: it moves staff interpretation into shared-front routing modes while keeping the same lifecycle/responsibility/commit backbone. **STRONG INFERENCE FROM CODE**

### Phase 3 — Continuation lane

- Goal: Skip redundant `compileTurn_` when `pendingExpected` + strong match + safety checks. **PROPOSED CHANGE**  
- Touches: `handleSmsRouter_` or top of `handleSmsCore_`.  
- Risk: Medium.  
- Validation: Stage regression harness; emergency injection tests.
- Architectural reason this phase is valid: it reduces redundant interpretation inside the shared front without creating a second state machine or commit path. **STRONG INFERENCE FROM CODE**

### Phase 4 — Media deferral

- Goal: Ack first, queue vision job, patch draft/ticket — mirror `TELEGRAM_ADAPTER` / `enqueueAiEnrichment_`. **PROPOSED CHANGE**  
- Touches: STAFF_CAPTURE block, new sheet or reuse queue, worker trigger, Outgate templates.  
- Risk: High.  
- Depends on: idempotency design.
- Architectural reason this phase is valid: it defers enrichment while preserving the same commit truth (create first via canonical path; patch later), avoiding a parallel media pipeline. **PROPOSED CHANGE**

### Phase 5 — Fast create (tenant)

- Goal: Bypass draft accumulator only when the signal is **operationally sufficient for direct create** and when canonical safety facts remain available; additionally allow tenant replies that are structurally valid without assignment, while still committing assignment before any ownership/escalation implication (**PROPOSED CHANGE**, constrained by decision lock).
- Risk: High.  
- Depends on: Phase 3–4 learnings.
- Architectural reason this phase is valid: it treats fast create as a shared-front optimization gate, not as a new create architecture; it must still converge on `finalizeDraftAndCreateTicket_` / `processTicket_` / lifecycle hooks before any truth-bearing staff/vendor communication, while allowing early tenant-only outbound replies only when they do not imply ownership/dispatch/escalation. **STRONG INFERENCE FROM CODE**
- Validation: equivalence tests across emergency + policy classes + dedupe scenarios.

### Phase 6 — DAL sweep

- Goal: Remove raw `dir.getRange` / hot-path scans from orchestrator. **PROPOSED CHANGE**  
- Risk: Medium (surface area).  
- Depends on: grep inventory.
- Architectural reason this phase is valid: it hardens persistence contracts without changing behavior or splitting truth ownership; it keeps one commit truth and one data-access layer. **STRONG INFERENCE FROM CODE**

---

## 12. SURGICAL EXECUTION CHECKLIST

- [ ] Fix internal docs/diagrams: Twilio entry = `handleSmsRouter_`, not `handleSms_`. **V**
- [ ] Grep `getRange\(|appendRow\(|setValues\(` in `PROPERA MAIN.gs`; tag owner module per row. **V**
- [ ] Add timing logs: `compileTurn_`, `draftUpsertFromTurn_`, `inferLocationType_`, `processTicket_` (classify on/off), `imageSignalAdapter_`. **PROPOSED**
- [ ] Enforce product rule: staff `#` skips tenant STOP/HELP compliance/opt-out logic (shared-front mode only; no new pipeline). **DECISION LOCK**
- [ ] Prototype continuation fast path behind feature flag property. **PROPOSED**
- [ ] Reuse `enqueueAiEnrichment_` pattern for media jobs or extend with typed job column. **PROPOSED**
- [ ] Add tests / SIM harness for: staff capture with image, tenant complete create, pending SCHEDULE reply. **PROPOSED**
- [ ] Cache `getScriptProperties()` once per request object. **PROPOSED**

---

## 13. OPEN QUESTIONS / NEEDS HUMAN DECISION
All items previously listed in this section are resolved by the current **DECISION LOCK**:
- staff `#` skips tenant SMS compliance/opt-out flows (shared-front mode only)
- deferred assignment is allowed only for tenant responses that do not imply ownership/dispatch/escalation
- location classification must stay reliable (no broad UNIT default; AI fallback preserved for ambiguity)
- crash-handling unification proceeds via instrumentation first (preserve behavior until parity is observed)
- portal vs SMS must converge on lifecycle/policy timing relative to commit truth

---

## 14. FINAL RECOMMENDATION

Proceed with a multi-phase plan ONLY because the phases remain on one architectural line (shared front → shared commit → shared outbound intent → outgate) and **Propera may optimize runtime paths, but it may not fragment operational truth.**

If a future implementation idea cannot be expressed as an optimization inside the shared front / shared commit / shared outbound architecture, it is out of scope for this plan.

Proceed with performance work **only** as surgical early-routing and deferral inside the existing gateway and orchestrator — not new parallel stacks.

Do first: Phase 0–1 (truth on entry + timing logs) and Phase 3 scoping (continuation) — highest ROI / lower risk while `inferLocationType_` + `classify_` remain truth-bearing in finalize/process.

Do not do yet: blanket fast-create that skips `processTicket_` segments without a proven equivalence map for emergency, dedupe, and policy. Defer resolver deferral until queue idempotency is production-proven.

---

*Verified against repository snapshot; re-run grep when merging large branches.*

