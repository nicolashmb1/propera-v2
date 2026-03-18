## 1. Purpose

This document is a **current-state architecture truth map** for Propera, based on **actual runtime behavior** observed in logs and the present codebase. It focuses on:

- **Latency**: where time is spent between `DOPOST_HIT` and the first outbound response.
- **Ownership boundaries**: which module actually owns each decision today (adapter, router, domain engine, lifecycle, outgate, AppSheet).
- **Routing correctness**: which flows take the intended lane vs. fall through mixed or legacy paths.

It does **not** propose refactors or patches. It is a **map only**, to support the next phases (Plan → Execution).

---

## 2. Major runtime flows to map

Below, each flow is traced as:

`Input → adapter → router → compile/signal layer → draft/context/session → state resolver → finalize/create → routing/ownership/lifecycle → outgate → carrier delivery`

### 2.1 Tenant SMS maintenance intake (plain text)

- **Input**
  - Inbound Twilio SMS/WhatsApp webhook (tenant phone) hitting `doPost(e)` in `PROPERA MAIN.gs`.
  - Logged as `DOPOST_ENTER` and `DOPOST_HIT` in DevLog and `Executions`.

- **Adapter**
  - `doPost(e)` (M1 Gateway):
    - AppSheet/Alexa early routes short-circuit; non-JSON falls through.
    - Twilio gate via `validateTwilioWebhookGate_(e)` (`WEBHOOK_DENY` on failure).
  - Twilio path sets:
    - `TWIML_OUTBOX_`, `DEV_EMIT_TWIML_`.
    - `globalThis.__bodyOverride` for media-only messages.
    - `globalThis.__inboundChannel` (`SMS` vs `WA`).
  - Calls **`handleSmsRouter_(e)`** as the **shared SMS router**.

- **Router**
  - `handleSmsRouter_(e)`:
    - Normalizes phone via `normalizePhone_`.
    - Staff/tenant detection:
      - `isStaffSender_(phone)` and `routeStaffInbound_` for staff updates.
      - If staff and lifecycle enabled, diverts to lifecycle staff lane, bypassing tenant maintenance core.
    - Builds `inbound` signal via `normalizeInboundEvent_` (actor, body, media metadata, channel).
    - Computes `decision = decideLane_(inbound)` and logs `ROUTER_LANE …`.
    - Lane outcomes:
      - `vendorLane` → `routeToCoreSafe_(e, { mode: "VENDOR" })`.
      - `managerLane` → `routeToCoreSafe_(e, { mode: "MANAGER" })`.
      - `systemLane` → `routeToCoreSafe_(e, { mode: "SYSTEM" })`.
      - Default `tenantLane` continues within router.
    - Global compliance/STOP handling (`STOP/START/HELP`) before anything else.
    - Opt-out suppression (`isSmsOptedOut_`).

- **Compile / signal layer**
  - Context + pending-state:
    - Loads ctx via `ensureWorkBackbone_()` and `ctxGet_(phone)` and logs `ROUTER_CTX`.
    - Global tenant commands (e.g. reset) via `detectTenantCommand_` and `handleTenantCommandGlobal_`.
    - Pending expected override / expiry via `routerInboundStrongStageMatch_`, `ctxUpsert_` (`ROUTER_PENDING_EXPIRED`, `ROUTER_PENDING_OVERRIDE`).
  - Intent gates:
    - Amenity routing (`isAmenityCommand_`, `hasActiveAmenityFlow_`, `handleAmenitySms_`).
    - Leasing lane detection via `isLeasingIntentStrong_`, `detectLeasingIntent_`, `isMaintenanceVeto_`, `isKnownTenantPhone_` and, if hit, delegates to `handleLeasingLane_` (Leasing engine).
    - Domain intent gate (`classifyTenantSignals_`, `isWeakIssue_`, `looksSpecificIssue_`) that sets `pendingExpected="INTENT_PICK"` and prompts for maintenance vs leasing vs amenity, when first-time weak text arrives.
  - For **plain maintenance text** (no staff / amenity / leasing diversion), router falls through to **core tenant maintenance path** by calling `routeToCoreSafe_(e)` → `handleSmsCore_` (M2+).

- **Draft / context / session**
  - Within `handleSmsCore_` (core maintenance intake), for tenant mode:
    - Directory + tenant row lookup via DAL:
      - `ensureDirectoryRowForPhone_`, `getDirPendingStage_`, `dalGetPendingIssue_`, `dalGetPendingUnit_`, `dalGetPendingRow_`, `dalWithLock_`, `dalSetLastUpdatedNoLock_`.
    - Language, welcome, and hints:
      - `getTenantLang_`, `getWelcomeLineOnce_`, `scheduleDayWord_`.
    - **Media adapter**:
      - `mediaFacts = imageSignalAdapter_(e, bodyTrim, originPhone)` (Twilio media fetch + OpenAI vision).
      - `mergedBodyTrim = mergeMediaIntoBody_(bodyTrim, mediaFacts)` with logging `MEDIA_SYNTHETIC_BODY`.
    - **Turn compiler**:
      - `compiled = compileTurn_(mergedBodyTrim, phone, lang, baseVars)`:
        - Extracts property, unit, schedule, normalized issue text, and issue metadata.
      - `turnFacts` built from `compiled` and media metadata; `COMPILE_TURN` logged.
    - **Media facts attachment**:
      - `turnFacts.meta` populated with media flags, URLs, synthetic issue, etc. via `maybeAttachMediaFactsToTurn_`.
    - **Turn timeline**:
      - Writes `TURN` to timeline (issue snippet, property code, unit, schedule flag).

  - **Session and draft recompute**:
    - Loads resolver context and session:
      - `_resolverCtx = ctxGet_(phone)` (post-router copy).
      - `_session = sessionGet_(phone)` (maintenance session aggregate).
    - Classifies tenant signals again (`classifyTenantSignals_`) for tone/priorRef.
    - **Draft accumulation**:
      - `draftUpsertFromTurn_(dir, dirRow, turnFacts, mergedBodyTrim, phone, _session)`.
      - Writes candidate issue / property / unit / schedule drafts into sheet row(s).
    - **Recompute expected**:
      - `recomputeDraftExpected_(dir, dirRow, phone, _session)` to decide next conversational stage (`PROPERTY`, `UNIT`, `ISSUE`, `SCHEDULE`, `CONFIRM_CONTEXT`, etc.).
      - For new sessions, reloads `_session = sessionGet_(phone)` and aligns `_resolverCtx.pendingExpected`.

- **State resolver**
  - `ticketState = resolveEffectiveTicketState_(dir, dirRow, _resolverCtx, _session)`:
    - Determines canonical `ticketState.stage` used by handlers (e.g. `NEW`, `FINALIZE_DRAFT`, `EMERGENCY_DONE`).
  - Logs `STATE` and `HANDLER` timeline events.
  - Stage-advance guard ensures legal transitions for conversational stages, logs `logStageDecision_`.

- **Finalize / create**
  - Handler for `FINALIZE_DRAFT` (within core) performs:
    - Safe dedupe check and **ticket creation** via `ticketCreate_` / `workItemCreate_` and maintenance DAL writes (WorkItems, Tickets sheet).
    - Ownership assignment:
      - Property-based owner resolution via `ppGet_` / policy keys like `ASSIGN_DEFAULT_OWNER`.
    - Writes WorkItem row, sets `ownerId`, `propertyId`, `unitId`, `status`, `state`, `metadataJson`.

- **Routing / ownership / lifecycle**
  - After ticket creation:
    - Ownership/routing logic:
      - `assignDefaultOwner_` (via `ActionPolicy` / `PropertyPolicy`), uses sheets `WorkItems`, `PropertyPolicy`, `Staff`.
    - Lifecycle entry for scheduled work (`onWorkItemActiveWork_`) only after scheduling; not typically part of **first-response** path for plain text maintenance.
    - Some flows may trigger lifecycle timers or overlays later (e.g. `ACTIVE_WORK_ENTERED`), but **not before first tenant ack** in the standard maintenance intake.

- **Outgate**
  - First outbound maintenance reply is typically:
    - Generated via `renderTenantKey_` (template-key messaging).
    - Sent via `reply_` or `sendRouterSms_` depending on context (`TWIML_OUTBOX_` collects last outbound).
  - In `doPost`, after `handleSmsRouter_(e)` returns:
    - **Twilio response** constructed via `twimlWithMessage_(TWIML_OUTBOX_[last])` or empty TwiML.

- **Carrier delivery**
  - Twilio receives the TwiML response and sends SMS to tenant.
  - Any additional follow-up messages (e.g. scheduling prompts) go via `sendSms_` or `dispatchOutboundIntent_` (Outgate) and are independent of the initial TwiML.

---

### 2.2 Staff screenshot capture intake

- **Input**
  - Staff SMS with **leading `#`** and a screenshot attachment:
    - Example: `"#"` body with one image.
  - Hits the same Twilio webhook (`doPost` → `handleSmsRouter_`).

- **Adapter**
  - `handleSmsRouter_(e)`:
    - Detects leading `#`:
      - Strips `#` and whitespace: `stripped = bodyTrim.replace(/^#\s*/, "")`.
      - Builds cloned event: `e2 = cloneEventWithBody_(e, stripped, {})`.
      - Marks `_staffCapture = "1"` on `e2.parameter`.
      - **Immediately routes to core** via `routeToCoreSafe_(e2, { mode: "MANAGER" })`.

- **Router**
  - No lane decision / tenant maintenance routing:
    - For `#` flows, `decideLane_` / tenant path are bypassed.
  - Staff capture is effectively a **special adapter** that forces the payload directly into core with `mode="MANAGER"` and `_staffCapture=1`.

- **Compile / signal layer**
  - Inside `handleSmsCore_` (manager mode, staff capture path):
    - Media adapter and `compileTurn_` are still used:
      - `imageSignalAdapter_(e, bodyTrim, originPhone)` analyzes screenshot via OpenAI.
      - `mergedPayloadText` built from synthetic body + raw text.
      - `turnFacts = compileTurn_(mergedPayloadText, draftPhone, "en", baseVars)`.
    - Comments in code explicitly reference **staff # screenshot** test:
      - Test 3: staff `#` + screenshot chat; `compileTurn_` gets usable text.
  - Staff capture fallback:
    - If `compileTurn_` fails to produce strong issue, there is a **fallback** that uses merged payload to seed an issue in drafts.

- **Draft / context / session**
  - Similar draft/session path as tenant maintenance, but:
    - Uses `mode="MANAGER"` and `_staffCapture` hints when updating drafts and context.
    - Still writes or updates maintenance draft row(s) via `draftUpsertFromTurn_`.
    - `sessionGet_` and `recomputeDraftExpected_` still run to align stages.

- **State resolver**
  - Same `resolveEffectiveTicketState_` path, but:
    - Staff capture typically runs in a context where a maintenance ticket already exists or is being created with staff-attached data.
    - Effective stage often ends in `FINALIZE_DRAFT` or similar ticket-creation/attachment stage using screenshot-derived content.

- **Finalize / create**
  - Handler commits draft into ticket/work item:
    - Writes `WorkItems` row and/or updates existing ticket metadata with screenshot-derived issue text.
    - Ensures `ownerId` and `propertyId` from policy.

- **Routing / ownership / lifecycle**
  - After finalize:
    - Same ownership assignment as tenant maintenance (PropertyPolicy).
    - Lifecycle overlay may later attach timers based on state transitions.

- **Outgate**
  - First response to **staff**:
    - Likely via `dispatchOutboundIntent_` with `recipientType="STAFF"` and templates such as `STAFF_CAPTURE_ACK` or manager-specific confirmations.
  - Tenant may also receive a message if the capture implies tenant-facing activity (e.g. ticket creation).

- **Carrier delivery**
  - Outbound via Twilio SMS to staff, plus any follow-on tenant SMS depending on policy.

---

### 2.3 Staff natural update / completion command (no `#`)

- **Input**
  - Staff sends plain text like `"403 done"` or `"403 b18e2759 done"` from a staff phone.
  - Hits `doPost` → `handleSmsRouter_(e)`.

- **Adapter**
  - `handleSmsRouter_(e)`:
    - Normalizes phone → `phone = normalizePhone_(fromForNormalize)`.
    - Logs **`STAFF_CHECK`** with flags `hasIsStaff`, `hasRoute`, `isStaff`, `lifecycleOn`.

- **Router**
  - Staff lane check:
    - If **non-`#`**, `isStaffSender_(phone)` is true, `routeStaffInbound_` exists, and `lifecycleEnabled_("GLOBAL")` is true:
      - `handled = routeStaffInbound_(phone, bodyTrim);`
      - If `handled`, router **returns early**; no tenant/maintenance routing.
    - If lifecycle disabled or `isStaffSender_` false, falls back to tenant path and may be misrouted through tenant intake.

- **Compile / signal layer (inside lifecycle staff path)**
  - `routeStaffInbound_(phone, bodyTrim)` in `LIFECYCLE_ENGINE.gs`:
    - Resolves staffId from phone via `lifecycleResolveStaffIdByPhone_` (sheet `Staff` + `Contacts`).
    - Lists open work items for owner via `lifecycleListOpenWisForOwner_(ownerId)` from `WorkItems`.
    - **Work item resolution order**:
      1. **WI-id hint** via `lifecycleExtractWorkItemIdHintFromBody_` (handles tokens like `b18e2759`, `WI_b18e2759`).
      2. **Unit hint** via `lifecycleExtractUnitFromBody_` (supports `"403 done"`, `"unit 403"`).
      3. **Property hint** via `lifecycleExtractPropertyHintFromBody_` matched against known property codes (`lifecycleKnownPropertyCodes_` and `getActiveProperties_`).
      4. **Ctx fallback** (`ctxGet_` → `pendingWorkItemId` / `activeWorkItemId`).
    - If unresolved or ambiguous:
      - Logs `STAFF_TARGET_UNRESOLVED` and sends `STAFF_CLARIFICATION` intent via `dispatchOutboundIntent_` (`recipientType="STAFF"`).
    - Outcome normalization:
      - `normalized = lifecycleNormalizeStaffOutcome_(body)`:
        - `"done", "fixed", "completed"` → `COMPLETED`.
        - `"in progress"`, `"working on it"` → `IN_PROGRESS`.
        - `"waiting on parts"` → `WAITING_PARTS` (+ ETA).
        - `"vendor"`, `"dispatch"` → `NEEDS_VENDOR`.
        - `"delayed"` → `DELAYED`.
        - Access issues → `ACCESS_ISSUE`.
        - Otherwise `UNRESOLVED`.
    - If outcome resolved (not `UNRESOLVED`):
      - Builds `signalPayload` with `eventType="STAFF_UPDATE"`, `wiId`, `propertyId`, `outcome`, `rawText`.
      - Calls `handleLifecycleSignal_(signalPayload)` (single lifecycle gateway).
      - Depending on `result` `"OK"` vs `"HOLD"/"REJECTED"`, sends either `STAFF_UPDATE_ACK` or `STAFF_CLARIFICATION` intent.
    - If outcome `UNRESOLVED`:
      - Logs `STAFF_UPDATE_UNRESOLVED` and sends `STAFF_CLARIFICATION`.

- **Draft / context / session**
  - Staff updates **do not** go through maintenance `draftUpsertFromTurn_` / `compileTurn_`.
  - They operate at the **WorkItem + Lifecycle** layer:
    - `workItemGetById_` provides current state, metadata, phoneE164, ticketRow, etc.
    - Lifecycle facts built via `buildLifecycleFacts_`.

- **State resolver (lifecycle)**
  - `evaluateLifecyclePolicy_(facts, signal, "STAFF_UPDATE")`:
    - Uses property-specific `PropertyPolicy` (via `ppGet_`) to decide:
      - Next state: `INHOUSE_WORK`, `WAIT_PARTS`, `VENDOR_DISPATCH`, `VERIFYING_RESOLUTION`, `DONE`, etc.
      - Whether to write timers (e.g. `PING_STAFF_UPDATE`, `TIMER_ESCALATE`, `AUTO_CLOSE`).
      - Whether tenant verification is required (`TENANT_VERIFY_REQUIRED`, `TENANT_VERIFY_HOURS`).
  - `executeLifecycleDecision_`:
    - Applies transition via `wiEnterState_`, enforcing allowed transitions and centralizing timer writes.
    - Logs transitions (`WI_TRANSITION`), timers (`TIMER_WRITTEN`), and escalation events.
    - Can emit tenant verify outbound intent via `dispatchOutboundIntent_` (`TENANT_VERIFY_RESOLUTION`) when state enters `VERIFYING_RESOLUTION`.

- **Finalize / create**
  - No new tickets created; lifecycle **mutates existing WorkItem** state and timers.
  - Staff updates can indirectly cause:
    - Tenant verify messages (lifecycle).
    - Additional follow-up timers (e.g. parts ETA escalation).

- **Routing / ownership / lifecycle**
  - Lifecycle is the **policy executor**, not intake:
    - It only runs after WorkItem exists and is linked to staff.
  - Staff updates are in the **staff operational lane** governed by lifecycle, not tenant intake router.

- **Outgate**
  - Staff-facing intents:
    - `STAFF_UPDATE_ACK`, `STAFF_CLARIFICATION`, `STAFF_UPDATE_REMINDER` sent via `dispatchOutboundIntent_` using `lifecycleOutboundIntent_`.
  - Tenant-facing intents (verify, etc.) may be triggered depending on policy and state transitions.

- **Carrier delivery**
  - All lifecycle-triggered messages go through Outgate and Twilio SMS for staff/tenant.

---

### 2.4 AppSheet MARK_DONE ownership flow

- **Input**
  - AppSheet webhook POST → `doPost(e)` with JSON body including:
    - `action: "MARK_DONE"` (or other ownership actions).
    - `ticketId`, `ticketRow`, `tenantPhone`/`to`, optional `message`.

- **Adapter**
  - `doPost(e)` AppSheet gate:
    - Parses JSON body; if it contains ownership keys, routes to `handleAppSheetWebhook(e)`.
  - `handleAppSheetWebhook(e)`:
    - Parses JSON into `data`.
    - Logs `APPSHEET_WEBHOOK_IN` into DevLog and WebhookLog via `logWebhookRow_`.
    - Dedupes identical `action+ticketId` for 30s using `CacheService`.

- **Router**
  - Ownership dispatch:
    - If `data.action` present, calls `handleOwnershipActionFromAppSheet_(data)` (M9 Ownership Engine).
    - On errors, logs `APPSHEET_OWN_DISPATCH_ERR` but still returns `OK`.

- **Compile / signal layer**
  - Ownership engine uses:
    - `getActionPolicy_(act)` from `ActionPolicy` sheet to decide:
      - `tenantNotify`, `tenantTemplateKey`.
      - `vendorNotify`, `vendorTemplateKey`.
      - `setPendingStage`.
    - Resolves WorkItem via `ticketId` / `ticketRow` and `WorkItems` sheet.
  - For `MARK_DONE`:
    - The relevant branch in `handleOwnershipActionFromAppSheet_`:
      - Interprets `act === "MARK_DONE"` as a deterministic state change to `DONE`.
      - Appends optional staff note into `metadataJson.notes` (with timestamp + actor).

- **Draft / context / session**
  - No use of tenant `draftUpsertFromTurn_` or `sessionGet_`.
  - This is a **direct state change** at WorkItem level, gated by policy.

- **State resolver**
  - In `handleOwnershipActionFromAppSheet_`:
    - Computes `nextState` and `nextSub`:
      - `MARK_DONE` → `nextState="DONE"`, `nextSub=""`, `meta.ownerRole="STAFF"`.
    - Writes patch:
      - `patch = { state: nextState, substate: nextSub, metadataJson, status: "COMPLETED" }`.
    - Calls `workItemUpdate_(wiId, patch)` and logs `OWN_ACT_OK` / `OWN_ACT_WRITE_FAIL`.
  - Lifecycle overlay is **not directly invoked** here:
    - State change is done by ownership engine, not `handleLifecycleSignal_`.

- **Finalize / create**
  - Ownership engine finalizes WorkItem as `DONE` and `COMPLETED`.
  - No new ticket is created; this is a post-create / completion update.

- **Routing / ownership / lifecycle**
  - AppSheet actions are a **direct ownership lane**:
    - `ActionPolicy` decides whether tenant should be notified on `MARK_DONE`.
    - Lifecycle may later see state `DONE` for other purposes (e.g., reporting), but state change originates here.

- **Outgate**
  - Tenant notifications (if allowed):
    - If `nextState === "DONE"` and `phone` present:
      - Policy `tenantNotify` + `tenantTemplateKey` determine outbound template (or explicit `evt.templateKey`).
      - `ownerSendTenantKey_(phone, doneKey, vars, "OWN_DONE")` sends via SMS; else logs `OWN_NO_OUTBOUND`.

- **Carrier delivery**
  - Tenant receives completion SMS produced by AppSheet/ActionPolicy lane, not by lifecycle.

---

## 3. Per-flow step map

This section calls out, per flow:

- **Major functions/files**
- **Sheet reads/writes**
- **Lock usage**
- **Session writes/reloads**
- **AI / media / external calls**
- **Required before first user response**
- **Currently inline but logically post-create/enrichment**

### 3.1 Tenant SMS maintenance intake (plain text)

- **Major functions/files**
  - `PROPERA MAIN.gs`:
    - `doPost(e)` (M1).
    - `handleSmsRouter_(e)` (SMS router).
    - `normalizeInboundEvent_`, `decideLane_`, `routeToCoreSafe_`.
    - `handleSmsCore_` (maintenance core; name inferred from context around `compileTurn_`, `draftUpsertFromTurn_`, `resolveEffectiveTicketState_`; exact function name may differ).
    - `compileTurn_`, `draftUpsertFromTurn_`, `recomputeDraftExpected_`, `resolveEffectiveTicketState_`.
    - `draftUpsertFromTurn_`-related DAL helpers and `sessionGet_` / `sessionUpsert_`.
  - `POLICY_ENGINE.gs`:
    - Policy checking for actions (e.g. valid `MARK_DONE`).
  - `LIFECYCLE_ENGINE.gs`:
    - Not in first-response path for plain tenant intake, but used later when tickets enter `ACTIVE_WORK`.

- **Sheet reads/writes**
  - **Reads**:
    - `DebugLog` (only append; no read for first-response).
    - `Directory` / tenant directory sheet via DAL:
      - `getDirPendingStage_`, `dalGetPendingIssue_`, `dalGetPendingUnit_`, `dalGetPendingRow_`.
    - `PropertyPolicy`, `WorkItems`, `Staff`, `Vendors` (during finalize/owner assign; may be part of first response in some flows).
  - **Writes**:
    - `DebugLog` (`debugLogToSheet_`).
    - Dev log sheet via `logDevSms_` and `flushDevSmsLogs_`.
    - Directory sheet:
      - `dalSetLastUpdatedNoLock_`, `dalSetPendingIssueNoLock_`, etc. under `dalWithLock_`.
    - Sessions sheet via `sessionUpsert_` (maint session state).
    - `WorkItems` + Tickets sheet on ticket creation (`workItemCreate_`).

- **Lock usage**
  - `dalWithLock_` wraps writes to directory row.
  - Other locks (e.g. `withWriteLock_` for invariants and timers) may be touched in finalize, depending on exact path.

- **Session writes/reloads**
  - Writes:
    - `sessionUpsert_` updated when draft recompute changes expected stage or session state.
  - Reload:
    - `_session = sessionGet_(phone)` **reloaded after recompute** when `pendingRow <= 0`.
    - Aligns `_resolverCtx.pendingExpected` with updated session.

- **AI / media / external calls**
  - For **plain text without media**:
    - No vision calls; only classification heuristics, no external AI.
  - For text + image (if present):
    - `fetchTwilioMediaAsDataUrl_` via `UrlFetchApp` to Twilio CDN.
    - `openaiVisionJson_` via `UrlFetchApp` to OpenAI chat completions (`OPENAI_MODEL_VISION`).
    - These are **blocking** calls inside the core before `compileTurn_`.

- **Required before first user response**
  - **Required** (for all inbound, even simple maintenance text):
    - `doPost` Twilio gate and validation.
    - `handleSmsRouter_` path including:
      - Lane decision (`decideLane_`) to tenant lane.
      - Tenant compliance (STOP/START/HELP).
      - Opt-out checks.
      - `ensureWorkBackbone_`, `ctxGet_` read.
    - Inside core:
      - Directory lookup (`ensureDirectoryRowForPhone_`, `getDirPendingStage_`).
      - `getTenantLang_` + template key evaluation for prompts.
      - `compileTurn_` (for deterministic parse).
      - Draft write + recompute:
        - `draftUpsertFromTurn_`, `recomputeDraftExpected_`, `sessionUpsert_` (and `sessionGet_` re-read).
      - `resolveEffectiveTicketState_` and dispatch to stage handler.
      - **State handler for current stage**, which decides whether to:
        - Prompt for missing context.
        - Finalize and create ticket.
      - First response message rendered via `renderTenantKey_` and pushed into `TWIML_OUTBOX_`.

- **Inline but logically post-create/enrichment**
  - **Potentially deferrable** pieces that currently run inline before or during first response:
    - Full **media analysis** (`imageSignalAdapter_` + OpenAI) even when a basic ack or triage could be sent earlier, especially for text-only flows (where media is absent, this path is skipped).
    - Some **domain signal classification** (`buildDomainSignal_`, `routeOperationalDomain_`, `dispatchOperationalDomain_`) that evaluate deep routing/cleaning decisions before ack.
    - **Session reloads** immediately after `recomputeDraftExpected_` just to align resolver context; this could be lazily done or cached.
    - **Property/owner resolution** for ticket creation:
      - Reading `PropertyPolicy` and `WorkItems` for default owner, even when a “we’ve received your request” ack could precede deterministic owner assignment.

---

### 3.2 Staff screenshot capture intake

- **Major functions/files**
  - `PROPERA MAIN.gs`:
    - `doPost(e)` (Twilio gate).
    - `handleSmsRouter_(e)` staff capture adapter (`#` leading).
    - `routeToCoreSafe_(e2, { mode: "MANAGER" })`.
    - Core handler for staff capture (same maintenance engine, `mode="MANAGER"`, `_staffCapture=1`).
    - `imageSignalAdapter_`, `compileTurn_`, `draftUpsertFromTurn_`, `recomputeDraftExpected_`.

- **Sheet reads/writes**
  - Reads:
    - Staff phone resolution may read `Staff` and `Contacts` for `isStaffSender_` (indirectly even though `#` path bypasses lifecycle staff routing).
    - Same directory/session sheets as tenant maintenance to attach screenshot-derived issue to correct tenant row.
  - Writes:
    - Directory row and session (draft + stage).
    - WorkItem row if the screenshot triggers ticket creation.

- **Lock usage**
  - `dalWithLock_` for directory updates.
  - `withWriteLock_` for certain summary writes (e.g. DevLog flush, if any per-branch locks are used).

- **Session writes/reloads**
  - Same pattern as tenant maintenance:
    - Writes to session via `sessionUpsert_`.
    - Reload `_session = sessionGet_(phone)` after recompute when needed.

- **AI / media / external calls**
  - Always uses **media adapter**:
    - `fetchTwilioMediaAsDataUrl_` (Twilio) + `openaiVisionJson_` (OpenAI).
  - These calls can take **~8s** per logs and are **inline** before first response.

- **Required before first user response**
  - Currently, the end-to-end staff screenshot flow **requires**:
    - Twilio gate + router staff capture branch.
    - Image fetch + OpenAI vision (imageSignalAdapter_).
    - `compileTurn_` using merged synthetic text.
    - Draft/session recompute + state resolver.
    - Ticket creation or update.
    - Outbound ack to staff via Outgate.

- **Inline but logically post-create/enrichment**
  - Potentially deferrable:
    - **Full OpenAI vision analysis** for screenshots where a minimal “received screenshot, processing now” ack would suffice.
    - **Deep draft recompute** when the screenshot is primarily used to enrich an already-open WorkItem rather than create one.
    - **Ownership/route finalization** when screenshot is an add-on to an existing ticket (could be appended asynchronously).

---

### 3.3 Staff natural update / completion command

- **Major functions/files**
  - `PROPERA MAIN.gs`:
    - `doPost(e)` and `handleSmsRouter_(e)` staff lane gating.
    - `isStaffSender_` (in `LIFECYCLE_ENGINE.gs`) used here.
  - `LIFECYCLE_ENGINE.gs`:
    - `routeStaffInbound_`, `lifecycleResolveTargetWiForStaff_`.
    - `lifecycleExtractWorkItemIdHintFromBody_`, `lifecycleExtractUnitFromBody_`, `lifecycleExtractPropertyHintFromBody_`.
    - `lifecycleListOpenWisForOwner_`.
    - `lifecycleNormalizeStaffOutcome_`, `lifecycleParsePartsEta_`.
    - `handleLifecycleSignal_`, `evaluateLifecyclePolicy_`, `executeLifecycleDecision_`, `wiEnterState_`.

- **Sheet reads/writes**
  - Reads:
    - `Staff`, `Contacts` for staff identity and phone linking.
    - `WorkItems` for owner’s open work items, current state, unit, property.
    - `PropertyPolicy` and `PolicyTimers` for lifecycle policy and timers.
  - Writes:
    - `WorkItems` row via `workItemUpdate_` inside `wiEnterState_`.
    - `PolicyTimers` (lifecycle timers) via `lifecycleWriteTimer_`.
    - `PolicyEventLog` via `policyLogEventRow_` in `lifecycleLog_`.

- **Lock usage**
  - Uses `withWriteLock_` for:
    - Timer writes (`LIFECYCLE_WRITE_TIMER`).
    - Timer cancel (`LIFECYCLE_CANCEL_TIMER`).
    - Timer processing (`LIFECYCLE_TIMER_MARK_FIRED`).
  - Staff update path itself (`routeStaffInbound_` → `handleLifecycleSignal_`) does not appear to hold long locks beyond per-write operations.

- **Session writes/reloads**
  - No tenant session (`sessionGet_`) involvement.
  - Context is at WorkItem + Lifecycle level.

- **AI / media / external calls**
  - Staff updates **do not** call OpenAI or external AI.
  - Only Sheets and internal policy evaluation.

- **Required before first user response**
  - For staff `"403 done"` flows, **first staff ack** currently waits on:
    - WorkItem resolution (`lifecycleResolveTargetWiForStaff_` including multi-row scans).
    - Outcome normalization (`lifecycleNormalizeStaffOutcome_`).
    - Lifecycle policy evaluation and WorkItem state update (`handleLifecycleSignal_` → `wiEnterState_`).
    - Optional timer writes.
    - Only after lifecycle result is known does router send `STAFF_UPDATE_ACK` via `dispatchOutboundIntent_`.

- **Inline but logically post-create/enrichment**
  - Some **timer writes** and **policy-driven transitions** could be considered post-ack:
    - Example: writing an escalation timer for `DELAYED` or `WAITING_PARTS` might not need to block the `STAFF_UPDATE_ACK`.

---

### 3.4 AppSheet MARK_DONE ownership flow

- **Major functions/files**
  - `PROPERA MAIN.gs`:
    - `doPost(e)` AppSheet gate.
    - `handleAppSheetWebhook(e)`.
    - Ownership engine: `handleOwnershipActionFromAppSheet_`, `getActionPolicy_`, `ownerSendTenantKey_`.
  - `POLICY_ENGINE.gs`:
    - Ensures that `MARK_DONE` is a valid action (`isActionAllowed_` / similar).

- **Sheet reads/writes**
  - Reads:
    - `ActionPolicy` for `TenantNotify`, `TenantTemplateKey`, etc.
    - `PropertyPolicy` as needed.
    - `WorkItems` row for `ticketId` / `ticketRow`.
  - Writes:
    - WorkItem patch via `workItemUpdate_` for `state="DONE"`, `status="COMPLETED"`, updated `metadataJson`.

- **Lock usage**
  - Ownership engine may use `withWriteLock_` around some updates (not fully visible in snippet), but at least:
    - Webhook logging uses `withWriteLock_("WEBHOOK_LOG_APPEND", …)`.

- **Session writes/reloads**
  - No tenant session or lifecycle session writes in this flow.

- **AI / media / external calls**
  - None. This path is purely deterministic / sheet-based.

- **Required before first user response**
  - First-response semantics here are **staff-side UI** (AppSheet) and **optional tenant SMS**:
    - Tenant notification only occurs after ownership engine fully updates the WorkItem.

- **Inline but logically post-create/enrichment**
  - As a completion path, most of its work is already post-create; there is little in this flow that could be moved earlier.

---

## 4. Latency suspicion map

This section ranks suspected latency contributors per flow, using log evidence (37s/36s end-to-end) and code structure. Confidence is explicit.

### 4.1 Tenant SMS maintenance intake (plain text)

1. **Draft/session recompute + resolver chain**
   - **Where**: `draftUpsertFromTurn_`, `recomputeDraftExpected_`, `sessionGet_`/`sessionUpsert_`, `resolveEffectiveTicketState_`, stage handler (e.g. `FINALIZE_DRAFT`).
   - **Evidence**:
     - Logs show ticket creation itself is ~1s, but the gap from `DOPOST_HIT` to `OUT_SMS` is ~37s.
     - Code shows multiple sheet reads/writes, plus session reload and recompute, in a single synchronous block before first response.
   - **Why it matters**: This chain runs on **every** inbound, including simple tenant messages, and touches Sheets heavily.
   - **Affected flows**: Tenant SMS maintenance intake, staff screenshot (when routed via tenant lane), some staff clarification contexts.
   - **Suspected root cause**: Multiple sequential Apps Script operations (sheet I/O) on `Directory`, `Sessions`, `WorkItems`, plus resolver computation, all before response.
   - **Type**: **Structural bottleneck** (architecture puts full draft + resolver in first-response path).
   - **Confidence**: **High**.

2. **Router front-half (lane decision + context, intent gate)**
   - **Where**: `handleSmsRouter_(e)` before `routeToCoreSafe_`.
   - **Evidence**:
     - Router includes: lane decision, compliance/opt-out, `ensureWorkBackbone_` + `ctxGet_`, pendingExpected override, amenity/leasing detection, intent gate, and final log traces.
     - These steps all run before `handleSmsCore_` even starts.
   - **Why it matters**: Each inbound goes through several layers of logic that are mostly deterministic lookups and classification, yet they delay any TwiML from being emitted.
   - **Affected flows**: All SMS/WA flows (tenant, staff, vendor), especially first-time maint intake.
   - **Suspected root cause**: Overloaded shared front path doing both routing and early-stage control/state gating.
   - **Type**: **Structural bottleneck**.
   - **Confidence**: **Medium–High**.

3. **Media adapter (when media present, even with simple text)**
   - **Where**: `imageSignalAdapter_(e, bodyTrim, originPhone)` inside context compiler.
   - **Evidence**:
     - For screenshot/text flows, logs show media understanding ~8s, but total end-to-end ~36–37s, meaning media is significant but not the only contributor.
     - Adapter includes: Twilio media download (HTTP), base64 encoding, OpenAI vision call, JSON parsing.
   - **Why it matters**: For mixed text+image maintenance, no response is sent until both media and turn compilation finish.
   - **Affected flows**: Tenant media maintenance, staff screenshot when routed through tenant lane or core.
   - **Suspected root cause**: External HTTP+AI calls inline in the critical path.
   - **Type**: **External dependency bottleneck**.
   - **Confidence**: **High** for media-heavy flows; **N/A** for plain-text-only flows.

4. **Dev logging + flush**
   - **Where**: `logDevSms_` throughout, and `flushDevSmsLogs_()` in `doPost` finally block.
   - **Evidence**:
     - `flushDevSmsLogs_` is always called at the end of `doPost`, even when early returns happen.
     - If implementation writes multiple rows per turn or hits rate limits, it could add seconds, though typical Apps Script sheet appends are fast.
   - **Why it matters**: Flush is in the `finally` block, so it always runs before request exit; any slow flush delays TwiML return.
   - **Affected flows**: All SMS/AppSheet requests.
   - **Suspected root cause**: Possibly large buffered logs and multiple append operations.
   - **Type**: **Implementation bottleneck** (within structural logging requirement).
   - **Confidence**: **Medium–Low** (no direct log evidence of flush dominating).

5. **Property + ownership resolution at finalize**
   - **Where**: `assignDefaultOwner_`, `ppGet_`, `workItemUpdate_` at create time.
   - **Evidence**:
     - Per description, ticket creation itself is ~1s, suggesting this block is not dominant.
   - **Why it matters**: Still part of critical path where WorkItem is first created.
   - **Affected flows**: Tenant maintenance, staff screenshot when creating new tickets.
   - **Suspected root cause**: Single `WorkItems` write and policy sheet reads; relatively small vs other steps.
   - **Type**: **Implementation bottleneck** (minor).
   - **Confidence**: **Low** as main driver of 37s.

---

### 4.2 Staff screenshot capture intake

1. **OpenAI vision + Twilio media fetch**
   - **Where**: `imageSignalAdapter_` (Twilio fetch + `openaiVisionJson_`).
   - **Evidence**:
     - Logs: media understanding ~8s within ~36s end-to-end.
     - Code: sequential HTTP calls to Twilio and OpenAI with retries/backoff.
   - **Why it matters**: Introduces a predictable fixed cost per screenshot, even if first ack could be earlier.
   - **Affected flows**: Staff screenshot capture, tenant photos used for maintenance.
   - **Suspected root cause**: Network latency + OpenAI model latency + retry logic.
   - **Type**: **External dependency bottleneck**.
   - **Confidence**: **High**.

2. **Shared draft/session/resolver path (same as 4.1 #1)**
   - **Where**: `draftUpsertFromTurn_`, `recomputeDraftExpected_`, `sessionGet_/sessionUpsert_`, `resolveEffectiveTicketState_` executed post-media.
   - **Evidence**:
     - Total ~36s vs ~8s for media alone → remaining ~28s plausibly from the same synchronous draft/resolver work as tenant text.
   - **Why it matters**: Screenshot path reuses the same heavy maintenance pipeline, so it inherits its latency.
   - **Affected flows**: Staff screenshot capture.
   - **Suspected root cause**: Structural reuse of full tenant intake pipeline for staff capture.
   - **Type**: **Structural bottleneck**.
   - **Confidence**: **High**.

3. **Staff capture fallback logic**
   - **Where**: Manager-mode path that re-tries deriving issue text if `compileTurn_` outputs are weak.
   - **Evidence**:
     - Code around `turnFacts` + fallback suggests extra checks and possible additional sheet writes.
   - **Why it matters**: Adds some overhead but likely small compared to media and draft/resolver.
   - **Affected flows**: Staff `#` screenshot flows only.
   - **Suspected root cause**: Additional logic within the same execution.
   - **Type**: **Implementation bottleneck** (minor).
   - **Confidence**: **Low–Medium**.

---

### 4.3 Staff natural update / completion command

1. **WorkItem resolution across owner’s open tickets**
   - **Where**: `lifecycleListOpenWisForOwner_`, `lifecycleResolveTargetWiForStaff_`.
   - **Evidence**:
     - Reads entire `WorkItems` sheet segment under owner filters, with loops in Apps Script.
   - **Why it matters**: For staff with many open tickets, iteration may be noticeable, but still typically << seconds.
   - **Affected flows**: Staff `"403 done"`, `"403 b18e2759 done"`, etc.
   - **Suspected root cause**: Unindexed scans over WorkItems on each staff message.
   - **Type**: **Implementation bottleneck**.
   - **Confidence**: **Medium–Low** (perceived misrouting is correctness more than latency).

2. **Lifecycle policy evaluation + timer writes**
   - **Where**: `handleLifecycleSignal_`, `evaluateLifecyclePolicy_`, `lifecycleWriteTimer_`.
   - **Evidence**:
     - These operations mainly involve a few sheet reads (`PropertyPolicy`, `PolicyTimers`) and writes.
   - **Why it matters**: Part of first-response path for staff ack when lifecycle is enabled.
   - **Affected flows**: Staff updates once a WI has been resolved.
   - **Suspected root cause**: Additional sheet writes prior to ack.
   - **Type**: **Structural bottleneck** (policy decisions combined with first-response).
   - **Confidence**: **Low–Medium** (compared to tenant intake).

---

### 4.4 AppSheet MARK_DONE ownership flow

1. **Ownership dispatch + WorkItem update**
   - **Where**: `handleOwnershipActionFromAppSheet_`, `workItemUpdate_`.
   - **Evidence**:
     - Only a single WorkItem update plus optional tenant SMS; logs show no multi-second delays from this lane.
   - **Why it matters**: This path is **fast** compared to SMS flows; not a dominant end-to-end bottleneck.
   - **Affected flows**: AppSheet mark-done actions.
   - **Suspected root cause**: None significant; mostly O(1) operations.
   - **Type**: **Implementation bottleneck** (negligible).
   - **Confidence**: **High** that this path is not the main latency source.

---

## 5. Critical path vs deferrable path

This section distinguishes work that **must** precede the first response vs. work that **can be deferred**, for **tenant text** and **screenshot** intake.

### 5.1 Tenant SMS maintenance intake (plain text)

- **MUST happen before first response**
  - Twilio webhook validation:
    - `doPost` Twilio gate (`validateTwilioWebhookGate_`, `twimlEmpty_` on deny).
  - Basic router checks:
    - Compliance STOP/START/HELP handling.
    - Opt-out checks (`isSmsOptedOut_`).
    - Lane decision to keep tenant vs. manager/vendor/system lanes coherent.
  - Minimal context load:
    - `ctxGet_(phone)` read so we know if tenant is mid-conversation (e.g. pending schedule).
  - Baseline draft evaluation:
    - At least one **deterministic parse** of text (either via `compileTurn_` or equivalent) to decide whether:
      - We can immediately confirm we “got it”.
      - We must ask a clarifying question (e.g. ask issue or ask schedule).
  - One-step prompt decision:
    - Choosing which **template key** to send (`ASK_ISSUE_GENERIC`, `ASK_WINDOW_SIMPLE`, first ack) and populating required vars.

- **SHOULD happen before first response**
  - Draft write for issue text:
    - Writing the immediate issue text into Directory/Tickets so we do not lose the user’s initial wording.
  - Basic property + unit association:
    - Resolving property from phone/directory/policy so that initial ticket metadata is reasonably correct.
  - Minimal session update:
    - Updating session stage/expected so that the **next inbound** continues logically from this message.

- **CAN happen after first response**
  - **Full recompute of draft state:**
    - Entire `recomputeDraftExpected_` logic including advanced routing for emergency vs standard vs amenity.
  - **Session reload and alignment:**
    - Re-reading `_session = sessionGet_(phone)` after recompute could be delayed, as long as we have enough info to send the first human-facing reply.
  - **Expensive domain routing decisions:**
    - Early cleaning divert (`dispatchOperationalDomain_` with `OPS_DOMAIN.CLEANING`).
  - **Non-critical policy queries:**
    - Some `PropertyPolicy` queries (e.g. default owner) that do not affect the wording of the first ack.

- **SHOULD become async/deferred in target architecture**
  - **Deep draft recompute + finalize**:
    - Ticket creation and owner assignment can be moved just after the first acknowledgment, run by a short follow-up job (within seconds) rather than inside the synchronous Twilio request.
  - **Domain engine heavy evaluation**:
    - `buildDomainSignal_`, `routeOperationalDomain_`, and `dispatchOperationalDomain_` for non-urgent flows.
  - **Lifecycle overlay entry**:
    - `onWorkItemActiveWork_` and any lifecycle timer writes that currently might be triggered inline with intake.

---

### 5.2 Staff screenshot capture intake

- **MUST happen before first response**
  - Twilio verification (`validateTwilioWebhookGate_`).
  - Staff capture detection:
    - Leading `#` detection and redirect to `routeToCoreSafe_(e2, { mode: "MANAGER" })`.
  - Basic phone + staff identity:
    - Enough to know which staff member to acknowledge and which WorkItem or tenant context is in scope (either now or shortly after).

- **SHOULD happen before first response**
  - Minimal **media presence check**:
    - Knowing that a screenshot/image exists and logging its presence (for debugging) is helpful before ack, but not necessarily full AI interpretation.

- **CAN happen after first response**
  - **OpenAI vision + Twilio media fetch**:
    - Full `imageSignalAdapter_` (download + vision) can run after the staff ack, as enrichment for the WorkItem.
  - **Draft/session recompute** that depends heavily on synthetic body:
    - For screenshot-only flows, a simple “received screenshot; processing now” ack does not require a full recompute.
  - **Expanded property/unit extraction from screenshot**:
    - Extracting property/unit hints from screenshot header can be used for better ticket metadata, but ack can be independent.

- **SHOULD become async/deferred in target architecture**
  - **Full media understanding path**:
    - Twilio fetch → OpenAI vision → `compileTurn_` using synthetic text should be **secondary**, not blocking the first staff response.
  - **Ticket enrichment and linking**:
    - Associating screenshot-derived content to WorkItem metadata and attachments can occur after ack.

---

## 6. Routing correctness map

### 6.1 Why plain tenant intake successfully routes to maintenance

- **Reasons**
  - Tenant phones are not recognized as staff (`isStaffSender_` returns false), so router stays in tenant lane.
  - `decideLane_` typically returns `tenantLane` with appropriate reason.
  - Domain intent gate correctly funnels generic tenant maintenance into:
    - `INTENT_PICK` → `MAINT` branch → core.
    - Or directly into **core maintenance** when text is specific enough (`looksSpecificIssue_`).
  - Maintenance guard for leasing ensures that known maintenance phrases (“my sink is clogged”) are not hijacked by leasing.
  - Draft/session logic is **tuned for tenant** flows (PROPERTY/UNIT/ISSUE stages).

### 6.2 Why staff screenshot capture succeeds

- **Reasons**
  - Leading `#` adapter ensures these messages **never hit lifecycle staff lane** in `LIFECYCLE_ENGINE`:
    - Immediate redirect to `routeToCoreSafe_(e2, { mode: "MANAGER" })`.
  - Core path has explicit staff capture logic:
    - `_staffCapture=1` contextualizes the turn as manager/staff input.
    - `imageSignalAdapter_` + `compileTurn_` are intentionally wired to handle screenshot-only payloads.
  - No ambiguous lane decision:
    - Router branch for `#` runs **before** STAFF_CHECK + lifecycle staff handling.

### 6.3 Why staff natural updates like `"403 done"` fail or get misrouted

- **Observed behavior**
  - Some staff texts were previously routed as tenant maintenance or mis-routed; now they enter staff clarification mode but still fail to resolve work item.

- **Root causes in current routing**
  - **Lane selection**:
    - Non-`#` staff messages are correctly sent through staff lifecycle lane when `isStaffSender_` and `lifecycleEnabled_` both true.
    - When lifecycle is disabled or misconfigured, they may fall back to tenant lane, which is not designed for staff commands like `"403 done"`.
  - **WorkItem resolution** constraints:
    - `lifecycleResolveTargetWiForStaff_` requires:
      - Owner mapping from staffId → `WorkItems.ownerId`.
      - Optional WI-id or unit hint match.
      - Context fallback requiring `pendingWorkItemId` or `activeWorkItemId`.
    - Cases where:
      - Multiple open WIs match same unit → returns `CLARIFICATION_MULTI_MATCH`.
      - No open WI found for staff/phone/unit → returns `CLARIFICATION`.
    - For `"403 b18e2759 done"`:
      - If `b18e2759` does not match an active WorkItem id or substring as expected, WI hint fails.
  - **Lifecycle gating**:
    - If lifecycle policy is disabled or missing for a property, `handleLifecycleSignal_` can log `LIFECYCLE_DISABLED` or `POLICY_KEY_MISSING` and return `HOLD`, leading to `STAFF_CLARIFICATION` instead of `STAFF_UPDATE_ACK`.

- **Where this conflicts with desired architecture**
  - Desired behavior:
    - **Staff completion commands** should be a **fast, deterministic lane**, not forced through tenant intent gates or ambiguous lifecycle gating.
  - Current state:
    - Staff updates live inside lifecycle policy engine with:
      - Timer logic, policy lookups, and gating.
      - Dependence on `WorkItems` and `PropertyPolicy` configuration.
    - When lifecycle cannot confidently map or decide, **ack/route correctness suffers**, leading to staff frustration and extra latency.

---

## 7. Architecture boundary violations

Relative to the North Compass doctrine:

- **Adapters should be transport only**
  - **Current behavior**:
    - `doPost` + `handleSmsRouter_(e)` perform:
      - Lane decisions.
      - Intent gating (INTENT_PICK, leasing, amenity).
      - PendingExpected overrides and session gating.
    - Staff `#` adapter is acceptable, but router also handles global tenant commands and domain gating.
  - **Violation**:
    - Shared front is doing **significant domain and policy work**, beyond pure transport/normalization.

- **Shared front should normalize and compile signals, not overload first-response path**
  - **Current behavior**:
    - Context compiler + `compileTurn_` + domain classifier (`buildDomainSignal_`) are all inline before first response.
    - For media, OpenAI vision runs inside this same synchronous block.
  - **Violation**:
    - Front-half is not just normalizing; it is **performing deep domain parsing and even final routing/dispatch decisions** (e.g., cleaning divert).

- **Domain engines should own domain decisions**
  - **Current behavior**:
    - Maintenance domain decisions happen partly in:
      - Router (intent gate, unknown gate, property/issue gating).
      - Core maintenance (draft/resolver).
      - Ownership engine (AppSheet actions).
    - Leasing domain decisions are appropriately in `LEASING_ENGINE.gs`, but gating around them is in router.
  - **Violation**:
    - Some routing choices (e.g., unknown gate + leasing vs maintenance) are implemented inside router instead of a pure domain engine interface.

- **Lifecycle should be a policy executor, not intake/router substitute**
  - **Current behavior**:
    - `routeStaffInbound_` + `handleLifecycleSignal_` own:
      - Staff work-item resolution from text (`403 done`).
      - Outcome normalization and ack vs clarification.
    - Lifecycle is effectively acting as **staff intake + router** for staff SMS commands.
  - **Violation**:
    - Lifecycle path embodies both **signal interpretation** and **policy execution**, rather than purely executing on an already-resolved WorkItem + outcome.

- **Outgate should handle expression/channel delivery**
  - **Current behavior**:
    - Outbound is mostly correct:
      - `dispatchOutboundIntent_` selects templates and channels.
      - Router uses TwiML only as transport.
  - **Minor concern**:
    - Some tenant template handling (e.g. `renderTenantKey_` + `sendRouterSms_`) are intertwined with core logic instead of pure Outgate.

- **Post-create ownership/routing work blocking first response**
  - **Current behavior**:
    - Ticket creation, default ownership assignment, and sometimes cleaning domain dispatch all occur **before** first ack in the same synchronous pipeline.
  - **Violation**:
    - End-architecture prefers **ack first, finalize/route second**, but currently finalize/route are frequently blocking the first response.

- **Repeated session/draft recompute after sufficient facts exist**
  - **Current behavior**:
    - On every inbound, drafts and sessions are recomputed and reloaded, even when the ticket is already known and only a small update is needed.
  - **Violation**:
    - This repeats heavy reads/writes in the critical path instead of treating late messages as light updates after the first ack.

---

## 8. Current-state bottleneck ledger

Each entry is **bottleneck → evidence → why it matters → flows → root cause → structural/implementation**.

- **Draft/session recompute + resolver in maintenance core**
  - **Evidence**: 37s `DOPOST_HIT` → `OUT_SMS` with ticket creation itself ~1s; code shows multi-step sheet I/O, recompute, session reload.
  - **Why it matters**: Affects every maintenance tenant message; central to first-response latency.
  - **Affected flows**: Tenant SMS maintenance, staff screenshot (when routed through tenant lane/core).
  - **Suspected root cause**: Overloaded first-response path with full draft/state pipeline.
  - **Type**: **Structural**.

- **Media adapter (OpenAI vision + Twilio fetch)**
  - **Evidence**: Screenshot flows report ~8s media understanding inside ~36s total; code includes remote HTTP and retries.
  - **Why it matters**: Adds predictable latency for any image, including staff screenshots and tenant photos.
  - **Affected flows**: Staff screenshot capture, tenant media maintenance.
  - **Suspected root cause**: External network latency and synchronous AI calls before first response.
  - **Type**: **External dependency** (structurally inline).

- **Overloaded router front-half**
  - **Evidence**: `handleSmsRouter_` contains lane decisions, pendingExpected rules, amenity/leasing gating, INTENT_PICK menu, global commands, and more before core.
  - **Why it matters**: Every message pays this overhead, even well-structured maintenance issues and staff updates.
  - **Affected flows**: All inbound SMS/WA (tenant, staff, vendor).
  - **Suspected root cause**: Router acting as mini-domain engine instead of pure signal/router.
  - **Type**: **Structural**.

- **Lifecycle as staff intake/router**
  - **Evidence**: Staff updates go to `routeStaffInbound_` and `handleLifecycleSignal_` which resolve WIs and outcomes from raw text (`403 done`).
  - **Why it matters**: Routing correctness and ack timing for staff commands depend on lifecycle configuration and WorkItems sheet shape.
  - **Affected flows**: Staff natural updates/completions.
  - **Suspected root cause**: Lifecycle overextended into parsing/route responsibilities, not just state policy.
  - **Type**: **Structural** (responsibility boundary).

- **Dev log flush and heavy logging**
  - **Evidence**: `flushDevSmsLogs_()` always runs at end of `doPost`; router and core log many events per message.
  - **Why it matters**: Could amplify latency during high volume; necessary for observability but currently synchronous.
  - **Affected flows**: All SMS/AppSheet/Webhook paths.
  - **Suspected root cause**: Sheet-based logging in the same synchronous request.
  - **Type**: **Implementation** (within structural requirement for logging).

- **WorkItems and PolicyTimers scans**
  - **Evidence**: `lifecycleListOpenWisForOwner_`, `processLifecycleTimers_`, and others scan ranges of rows without indexes.
  - **Why it matters**: Grows with portfolio size; may affect staff ack and timer processing times.
  - **Affected flows**: Staff updates, lifecycle timer cron jobs.
  - **Suspected root cause**: Unindexed linear scans in Apps Script.
  - **Type**: **Implementation**.

- **Ownership engine post-create actions in critical path**
  - **Evidence**: AppSheet actions (`TRIAGE_*`, `MARK_DONE`) directly call `workItemUpdate_` and optional tenant outbound; though fast, they are part of the synchronous webhook.
  - **Why it matters**: For AppSheet, delays in the webhook could affect perceived responsiveness in UI.
  - **Affected flows**: AppSheet MARK_DONE / triage actions.
  - **Suspected root cause**: Combining ownership updates and outbound notifications in same execution.
  - **Type**: **Implementation** (minor).

---

## 9. Questions the map must answer next

The following questions should be clarified before designing changes (Plan phase):

- **Critical path dominance**
  - **Which exact functions dominate the wall-clock time between `DOPOST_HIT` and first outbound TwiML for:**
    - Plain tenant maintenance text.
    - Staff screenshot capture.
    - Staff `"403 done"` completion messages.
  - **What are the measured breakdowns** (e.g., Twilio gate, router, media adapter, draft/session, finalize, lifecycle)?

- **Safe deferrals after acknowledgment**
  - **Which operations can move after first ack without breaking:**
    - Deterministic ticket creation.
    - Safety (emergency detection, compliance).
    - Logging/invariants (DebugLog, PolicyEventLog)?
  - **Can ticket creation + owner assignment be reliably run in a follow-up job within a few seconds**, using the same deterministic signals recorded at intake?

- **Fast lanes and specialized paths**
  - **Do staff commands need a dedicated fast lane** (e.g. `STAFF_FAST`, separate from tenant and lifecycle) for messages like `"403 done"` and `"403 b18e2759 done"`?
  - **Should screenshot capture use a lightweight “receipt” lane** that only confirms receipt and queues media understanding?
  - **What is the minimal set of fields needed for a “receipt” ack** vs full ticket/routing work?

- **State/session writes and redundancy**
  - **Which session and draft writes are strictly required** before the first response to avoid data loss?
  - **Where are we recomputing or re-reading the same state twice** (e.g. `sessionGet_` before and after recompute, `ctxGet_` in router and again in core)?
  - **Can we consolidate these reads/writes** or cache within a single request?

- **Routing decision ownership**
  - **Which routing decisions belong at:**
    - **Signal/router layer** (lane, actor type, transport).
    - **Domain engines** (maintenance vs leasing vs amenity).
    - **Lifecycle** (policy over existing WIs).
    - **Ownership engine** (AppSheet / property-driven actions).
  - **Where should staff natural updates live**:
    - Inside lifecycle, but with a thinner, pre-resolved signal?
    - In a dedicated staff domain engine feeding lifecycle?

Answering these questions, with measured timings and clarified boundaries, will allow the next phase (Plan) to carve out **fast lanes**, **async/deferred work**, and **clean module interfaces** without sacrificing determinism, safety, or logging guarantees.

