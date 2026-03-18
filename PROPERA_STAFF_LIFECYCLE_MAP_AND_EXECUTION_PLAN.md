## Propera Staff Lifecycle Map and Execution Plan

### 1. Current-State Map

#### 1.1 What currently belongs in `LIFECYCLE_ENGINE.gs` and should stay

**Lifecycle core (policy/state/timers — should stay)**  
Lifecycle-pure functions that match the intended role:

- **Gateway + integration**
  - `onWorkItemActiveWork_(...)`
  - `handleLifecycleSignal_(signal)`
- **Facts / policy / timers**
  - `buildLifecycleFacts_(...)`
  - `lifecyclePolicyGet_(...)`
  - `lifecycleEnabled_(...)`
  - `lifecycleIsInsideContactWindow_(...)`
  - `lifecycleSnapToContactWindow_(...)`
  - `lifecycleTimerRespectsContactHours_(...)`
  - `lifecycleImmediateIntentRespectsContactHours_(...)`
  - `evaluateLifecyclePolicy_(facts, signal, eventType)`
- **Execution / state machine**
  - `executeLifecycleDecision_(decision, facts, signal)`
  - `wiEnterState_(wiId, newState, substate, opts)`
- **Timers**
  - `lifecycleCancelTimersForWi_(wiId)`
  - `lifecycleWriteTimer_(wiId, prop, timerType, runAt, payload)`
  - `processLifecycleTimers_()`
- **Actor + logging helpers**
  - `getActorFacts_(signal)`
  - `lifecycleLog_(eventType, propCode, workItemId, facts)`

**Lifecycle-adjacent helpers that mostly fit**

- **Outbound intent wrapper (lifecycle-driven)**
  - `lifecycleOutboundIntent_(staffId, phone, intentType, templateKey, vars, deliveryPolicy, reasonCode)`
- **Staff / tenant contact & language for lifecycle decisions**
  - `lifecycleResolveStaffPhoneForWi_(wi)`
  - `lifecycleResolveTenantLang_(phone)`
  - `lifecycleResolveStaffLangByStaffId_(staffId)`
  - `lifecycleResolveStaffLangForWi_(wi)`

These are used to execute lifecycle policy (tenant verify, staff pings) and can reasonably remain co-located with lifecycle execution.

#### 1.2 What currently lived in `LIFECYCLE_ENGINE.gs` but does NOT belong there (pre-refactor; now extracted)

**Staff identity & routing (directory/front responsibilities)**

- `isStaffSender_(phone)`
- `lifecycleResolveStaffIdByPhone_(phone)`

These walk `Staff` and `Contacts` sheets and determine staff identity from phone. This is directory/shared front responsibility, not lifecycle.  
✅ **Status:** extracted into `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs` (Phase 2).

**Staff work-item resolution from raw SMS body (resolver logic)**

- `lifecycleResolveTargetWiForStaff_(phone, bodyTrim)`  
  Uses:
  - `lifecycleResolveStaffIdByPhone_`
  - `lifecycleListOpenWisForOwner_(staffId)`
  - `lifecycleExtractWorkItemIdHintFromBody_(body)`
  - `lifecycleExtractUnitFromBody_(body)`
  - `lifecycleExtractPropertyHintFromBody_(body)` + `lifecycleKnownPropertyCodes_()`
  - `ctxGet_` fallback

This is a domain resolver for staff commands, not lifecycle policy.  
✅ **Status:** extracted into `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs` with Phase 3 property+unit bounding applied.

**Staff command outcome normalization (natural-language → outcome)**

- `lifecycleParsePartsEta_(bodyTrim)`
- `lifecycleNormalizeStaffOutcome_(bodyTrim)`

These interpret natural staff text into lifecycle outcomes and parts ETA.  
✅ **Status:** extracted into `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs` (no major behavior redesign yet, still coarse normalization).

**Staff inbound router (from raw SMS into lifecycle & Outgate)**

- `routeStaffInbound_(phone, bodyTrim)`  
  Does:
  - Staff ID resolution (`lifecycleResolveStaffIdByPhone_`)
  - Staff language resolution
  - WI resolution (`lifecycleResolveTargetWiForStaff_`)
  - Outcome normalization (`lifecycleNormalizeStaffOutcome_`)
  - Lifecycle signal construction and `handleLifecycleSignal_(...)` call
  - Outgate ACK / clarification intents

This is full staff inbound command handling and belongs to a dedicated resolver/front module.  
✅ **Status:** logic moved and now exposed as `staffHandleLifecycleCommand_(phone, rawText)` in `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`, and `PROPERA MAIN.gs` calls this directly for non-`#` staff commands.

**Work-item listing for staff**

- `lifecycleListOpenWisForOwner_(ownerId)`  
  Reads `WorkItems` and builds the staff’s open-work-item candidate set.

**Property/unit/ID extractors used for staff resolution**

- `lifecycleExtractUnitFromBody_(body)`
- `lifecycleKnownPropertyCodes_()`
- `lifecycleExtractPropertyHintFromBody_(body)`
- `lifecycleExtractWorkItemIdHintFromBody_(body)`

These are text parsers/resolvers, not lifecycle.  
✅ **Status:** extracted into `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs` and used there.

#### 1.3 Classification of functions (post-Phase-2 state)

**Lifecycle-pure (stay in lifecycle)**

- `handleLifecycleSignal_`
- `buildLifecycleFacts_`
- `lifecyclePolicyGet_`
- `lifecycleEnabled_`
- `lifecycleIsInsideContactWindow_`
- `lifecycleSnapToContactWindow_`
- `lifecycleTimerRespectsContactHours_`
- `lifecycleImmediateIntentRespectsContactHours_`
- `evaluateLifecyclePolicy_`
- `executeLifecycleDecision_`
- `wiEnterState_`
- `lifecycleCancelTimersForWi_`
- `lifecycleWriteTimer_`
- `processLifecycleTimers_`
- `getActorFacts_`
- `lifecycleLog_`

**Resolver/front-layer responsibilities (moved out and now owned by resolver module)**

- `isStaffSender_`
- `lifecycleResolveStaffIdByPhone_`
- `lifecycleListOpenWisForOwner_`
- `lifecycleExtractUnitFromBody_`
- `lifecycleKnownPropertyCodes_`
- `lifecycleExtractPropertyHintFromBody_`
- `lifecycleExtractWorkItemIdHintFromBody_`
- `lifecycleParsePartsEta_`
- `lifecycleNormalizeStaffOutcome_`
- `lifecycleResolveTargetWiForStaff_`
- `routeStaffInbound_` (behavior now in `staffHandleLifecycleCommand_`)

**Phase 3 resolver helpers (in `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`)**

- `staffGetIssueLabelForWi_(wiId)` — issue label from WI `metadataJson` for scoring/prompts
- `scoreCandidatesByIssueHints_(candidates, bodyTrim)` — deterministic scoring with threshold + margin
- `buildSuggestedPromptsForCandidates_(candidates)` — e.g. “403 sink done”, “403 refrigerator done”
- Constants: `STAFF_RESOLVER_SCORE_THRESHOLD_`, `STAFF_RESOLVER_SCORE_MARGIN_`, `STAFF_RESOLVER_MAX_SUGGESTED_PROMPTS_`

✅ **Status:** all of the above live in `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`. `PROPERA MAIN.gs` calls `staffHandleLifecycleCommand_(phone, rawText)` for non-`#` staff messages.

**Outgate-facing helpers**

- `lifecycleOutboundIntent_(...)`
- Calls to `dispatchOutboundIntent_` inside:
  - `executeLifecycleDecision_` (tenant verify, staff pings)
  - `routeStaffInbound_` (staff ACK/clarification)

Outgate calls driven directly from raw text (inside `routeStaffInbound_`) have been moved with the resolver into `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`. Lifecycle now emits outbound intents only from canonical lifecycle decisions, not directly from raw staff text.

#### 1.4 Staff inbound command routing path (post-Phase-2)

**Step 1 — Inbound adapter (`PROPERA MAIN.gs`)**

- Twilio webhook entrypoint reads:
  - `From` → `fromRaw` → `phone = normalizePhone_(...)`
  - `Body` → `bodyTrim`
- Determines staff path vs core path.

**Step 2 — Staff path decision in `PROPERA MAIN.gs`**

Conditions for staff lifecycle path:

- `bodyTrim` present and does **not** start with `"#"` (so `#` remains STAFF CAPTURE).
- `typeof isStaffSender_ === "function"`.
- `typeof staffHandleLifecycleCommand_ === "function"`.
- `lifecycleEnabled_("GLOBAL")` is true or function missing.
- `isStaffSender_(phone)` is true.

If met:

- Calls `handled = staffHandleLifecycleCommand_(phone, bodyTrim)`.
- If `handled` truthy, returns and does not enter tenant/core pipeline.

**Step 3 — Staff inbound handling in `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`**

`staffHandleLifecycleCommand_(phone, bodyTrim)`:

- Resolve staff identity and language:
  - `staffId = lifecycleResolveStaffIdByPhone_(phone)`
  - `staffLang = lifecycleResolveStaffLangByStaffId_(staffId)` (resolver reads staff contact/locale; lifecycle no longer owns this).
- Resolve WI:
  - `resolved = lifecycleResolveTargetWiForStaff_(phone, body)`
    - Open WI set: `lifecycleListOpenWisForOwner_(staffId)` (staff’s open tickets).
    - WI ID hint: `lifecycleExtractWorkItemIdHintFromBody_` (strongest).
    - Property/unit bounding:
      - Unit: `lifecycleExtractUnitFromBody_`
      - Property: `lifecycleExtractPropertyHintFromBody_` + `lifecycleKnownPropertyCodes_()`
    - Fallback: `ctxGet_(phone)` (only after bounded attempts; used as a scoped assist).

- If `wiId` unresolved:
  - Log `STAFF_TARGET_UNRESOLVED` (with `resolved.reason`).
  - When `resolved.suggestedPrompts` is present, pass `vars.options` and `vars.suggestedPrompts` into `STAFF_CLARIFICATION` for Outgate to render (Phase 4).
  - Send `STAFF_CLARIFICATION` via `dispatchOutboundIntent_(lifecycleOutboundIntent_(...))`.
  - Return `true`.

- Else, normalize outcome:
  - `normalized = lifecycleNormalizeStaffOutcome_(body)`
  - `outcome = normalized.outcome || normalized`.

- If outcome resolved:
  - Load `wi = workItemGetById_(wiId)`.
  - Build `signalPayload`:

    ```js
    {
      eventType: "STAFF_UPDATE",
      wiId,
      propertyId,
      outcome,
      phone,
      actorType: "STAFF",
      actorId: phone,
      reasonCode: "STAFF_UPDATE",
      rawText: body.slice(0, 500),
      partsEtaAt?,
      partsEtaText?
    }
    ```

  - Call `result = handleLifecycleSignal_(signalPayload)`.
  - If `result === "OK"`:
    - Send `STAFF_UPDATE_ACK`.
  - Else:
    - Send `STAFF_CLARIFICATION` with reason `"STAFF_HOLD_OR_REJECT"`.

- If outcome `UNRESOLVED`:
  - Log `STAFF_UPDATE_UNRESOLVED`.
  - Send `STAFF_CLARIFICATION`.
  - Return `true`.

#### 1.5 Resolver strengths and remaining gaps (post-Phase 3)

Grounded in **current implementation** after Phase 2 extraction and Phase 3 behavioral upgrades:

- **Property and unit scope first-class (done)**
  - Candidate set is explicitly bounded by property+unit when a property code appears in text.
  - Property extraction supports both “penn 403 done” and “403 penn done” (unit then property).
  - Multiple properties for the same unit yield **CLARIFICATION_MULTI_PROPERTY** with suggested prompts.
  - Context (`ctx.pendingWorkItemId` / `activeWorkItemId`) is used only **after** bounded attempts.

- **Unit extraction (improved)**
  - Handles: `403 done`, `apt 403`, `unit 403`, `#403`, trailing `403`, and “403 penn” / “penn 403” style.
  - Alphanumeric units (e.g. 403a) supported via existing regex. Complex or non-regex units remain a limitation.

- **Issue-hint extraction and scoring (Phase 3 done)**
  - `extractIssueHintsForStaff_` detects fixture nouns (sink, fridge/refrigerator, toilet, etc.) and modifiers (clogged, leaking, etc.).
  - **Wired into scoring:** `scoreCandidatesByIssueHints_` and `staffGetIssueLabelForWi_` (from WI `metadataJson`) with threshold + margin (`STAFF_RESOLVER_SCORE_THRESHOLD_`, `STAFF_RESOLVER_SCORE_MARGIN_`). Clear winner → `ISSUE_HINT_MATCH`; tie → clarification with suggested prompts.

- **Bounded candidates and clarification with options (done)**
  - When multiple candidates remain, resolver returns `suggestedPrompts` (e.g. “403 sink done”, “403 refrigerator done”) and entrypoint passes `vars.options` / `vars.suggestedPrompts` into `STAFF_CLARIFICATION`. Outgate rendering of these options is Phase 4.

- **Outcome normalization still coarse**
  - `lifecycleNormalizeStaffOutcome_` uses simple word-matching (done/complete/fixed, in progress, waiting parts, vendor, delayed, access). No fixture-level synonym normalization in outcome yet; issue hints feed resolution/scoring only.

- **Lifecycle and resolver separation (done)**
  - Resolver and lifecycle are in separate modules; MAIN calls `staffHandleLifecycleCommand_`; lifecycle receives only canonical signals.

- **Context fallback remains a risk**
  - Fallback to `ctx` is only after bounded attempts but is not constrained by the text-bounded candidate set; stale context can still attach to wrong WI in edge cases.

---

### 2. Architectural Misalignment

**Against the compass rules:**

- **Adapters transport-only (addressed for staff path)**
  - MAIN routes staff messages to `staffHandleLifecycleCommand_`; lifecycle is no longer the control layer for staff text.

- **Shared Front vs resolver vs lifecycle (addressed for staff path)**
  - Resolver (`STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`) now owns staff identity, WI resolution, outcome normalization, and clarification payloads. Lifecycle receives only canonical `STAFF_UPDATE` signals. Shared Front / actor normalization remains a future refinement.

- **Lifecycle doing natural-language resolution (resolved)**
  - Staff free-text interpretation lives in the resolver; lifecycle no longer parses staff messages. (Previously:
    - “Lifecycle engine is a policy/state/timer executor, not a natural-language resolver.”

- **Outgate clarification options (Phase 4)**
  - Resolver now provides `vars.options` / `vars.suggestedPrompts` for `STAFF_CLARIFICATION`. Outgate must render these to complete the contract.’s explicit “” outputs.

- **Determinism and bounding (improved in Phase 3)**
  - Candidate set is bounded by staff + property + unit; issue-hint scoring with threshold and margin applies when multiple candidates remain. Context fallback remains a minor risk. “bounded and safe” 
- **Lifecycle contract (restored)**
  - Resolver builds canonical `STAFF_UPDATE` signals and calls `handleLifecycleSignal_`; lifecycle no longer sees raw staff payloads.

---

### 3. Target End-Form

#### 3.1 Where staff natural command resolution should live

**Target modules and roles:**

- **Inbound adapter (unchanged file, clarified role)**
  - `PROPERA MAIN.gs` remains the Twilio adapter and top-level router:
    - Validates transport.
    - Normalizes `phone`, `body`, `channel`.
    - Hands off to Shared Front.

- **Shared Front / actor normalization (new or clarified layer)**
  - A front-layer function that:
    - Detects `actorType` = STAFF using a directory helper (replacing `isStaffSender_` from lifecycle).
    - Assembles a `staffTurn` object with staff and property-scope context.

- **Maintenance staff lifecycle resolver (new module)**
  - Example: `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs` (exact name can be finalized later).
  - Responsibilities:
    - Property scope resolution.
    - Unit extraction from text.
    - Issue-hint extraction and synonym normalization.
    - Bounded candidate retrieval (property+unit).
    - Deterministic scoring + thresholds/margins.
    - Clarifications with natural short commands for disambiguation.
    - Outcome normalization from text to canonical lifecycle outcomes.
  - No direct sheet writes beyond safe reads; no timers/state transitions.

#### 3.2 Lifecycle contract (target)

Lifecycle should receive **canonical signals only**, including but not limited to:

- `ACTIVE_WORK_ENTERED`
- `STAFF_UPDATE`
- `TIMER_FIRE`
- `TENANT_REPLY`

For staff updates, the canonical signal shape:

```js
{
  eventType: "STAFF_UPDATE",
  wiId: "<canonical work item id>",
  propertyId: "<canonical property ID or code>",
  outcome: "COMPLETED" | "IN_PROGRESS" | "WAITING_PARTS" | "NEEDS_VENDOR" | "DELAYED" | "ACCESS_ISSUE",
  partsEtaAt?: Date,
  partsEtaText?: string,
  actorType: "STAFF",
  actorId: "<staffId or canonical identifier>",
  reasonCode: "STAFF_UPDATE",
  rawText?: "<original staff message (for audit only)>"
}
```

Lifecycle:

- Does **not**:
  - Parse raw staff text.
  - Determine `wiId` from phone/body.
- Does:
  - Apply state transition and timers according to policy.
  - Log to `PolicyEventLog`.
  - Trigger tenant/staff Outgate intents when policy dictates (e.g. tenant verify ping, timer-based staff update requests).

#### 3.3 Resolver contract (target)

**Input:**

- `staffTurn` object from Shared Front, e.g.:

```js
{
  actorType: "STAFF",
  actorId: staffId,
  phone,
  rawText,
  channel,
  staffScope: {
    properties: [...],
    units: [...],
    assignments: [...]
  },
  priorCtx: {
    pendingWorkItemId?,
    activeWorkItemId?
  }
}
```

**Output:**

- **Resolved case:**

```js
{
  kind: "RESOLVED",
  wiId,
  propertyId,
  unitId,
  outcome,      // canonical outcome
  parse: {
    propertyHint,
    unit,
    issueHints: [...],
    synonymsUsed: [...],
    boundedSetSize,
    score,
    secondBestScore,
    reason
  },
  lifecycleSignal: { ... },  // canonical signal payload
  ackIntent: { ... }         // Outgate intent config
}
```

- **Clarification case:**

```js
{
  kind: "CLARIFY",
  reason: "MULTIPLE_CANDIDATES" | "LOW_CONFIDENCE" | "NO_MATCH" | "AMBIGUOUS_ISSUE",
  propertyId?,
  unitId?,
  candidates: [
    { wiId, propertyId, unitId, issueTitle, issueHint, ageHours, score }
  ],
  suggestedPrompts: [
    "403 sink done",
    "403 refrigerator done"
  ],
  clarifyIntent: { ... } // Outgate intent config for clarification
}
```

- **Skip/non-lifecycle case (if needed in future):**

```js
{
  kind: "SKIP",
  reason: "NOT_LIFECYCLE" | "NOT_MAINTENANCE" | ...
}
```

The resolver:

- Never calls `wiEnterState_` or writes timers directly.
- Never sends SMS directly; it only defines intent configs.

#### 3.4 Outgate’s role (target)

Outgate remains:

- **The only path for rendering + channel expression**, given intents from lifecycle/resolver.

Examples:

- `STAFF_UPDATE_ACK`:
  - `vars`: `{ outcome, unit, issueTitle }`.
  - recipientType `STAFF`, recipientRef=`staffId`.
- `STAFF_CLARIFY_MULTI`:
  - `vars`: `{ propertyName, unit, options: ["403 sink", "403 refrigerator"] }`.
  - Renders messages like:
    - “I found two open tickets for 403 at Penn: sink or refrigerator. Reply '403 sink done' or '403 refrigerator done'.”

Lifecycle/resolver:

- Decide **what** to say (intent type + vars).
- Outgate decides **how** to say it (templates, language, channel).

#### 3.5 Recommended file / ownership split

**`LIFECYCLE_ENGINE.gs`**

- **Keep:**
  - All lifecycle core functions listed in 1.1.
- **Remove (migrate out):**
  - `isStaffSender_`
  - `lifecycleResolveStaffIdByPhone_`
  - `lifecycleListOpenWisForOwner_`
  - `lifecycleExtractUnitFromBody_`
  - `lifecycleKnownPropertyCodes_`
  - `lifecycleExtractPropertyHintFromBody_`
  - `lifecycleExtractWorkItemIdHintFromBody_`
  - `lifecycleParsePartsEta_`
  - `lifecycleNormalizeStaffOutcome_`
  - `lifecycleResolveTargetWiForStaff_`
  - `routeStaffInbound_`

**`STAFF_RESOLVER.gs`**

- Continues to own:
  - Staff responsibility resolution for **assignment** (owner at creation).
- May share helper infrastructure (property normalization, staff directory), but boundaries between assignment resolver and lifecycle command resolver must be explicit.

**New resolver module (name TBD)**

- Owns:
  - Staff lifecycle command resolution (WI + outcome).
  - Property/unit/issue-hint parsing from staff messages.
  - Candidate bounding/scoring.
  - Clarification payloads for Outgate.

**`OUTGATE.gs`**

- No structural change.
- Gains:
  - Additional intents or template variants for:
    - Staff ACK (with extra vars).
    - Multi-option clarification.

**`PROPERA MAIN.gs`**

- Still handles:
  - Inbound adapter and routing.
- Changes (later):
  - Calls new resolver module instead of lifecycle’s `routeStaffInbound_`.

---

### 4. Staff Cycle End-Form

**Target path:**

> inbound adapter → shared front / actor normalization → maintenance staff resolver → canonical `STAFF_UPDATE` signal → lifecycle engine → outgate

#### 4.1 Property scope resolution

- **Explicit property in text**:
  - Use deterministic property-code/alias map (per `getActiveProperties_`).
  - “penn 403 done” → `propertyId = PENN`.
- **Staff property scope**:
  - If no explicit property:
    - Use staff assignments from `StaffAssignments` or equivalent to get allowed properties.
- **Ambiguous property scope**:
  - If multiple properties remain:
    - Clarify at property level first:
      - “Is this for 403 at Penn or 403 at Morris?”

#### 4.2 Unit extraction (natural order variants)

- Recognize:
  - Leading unit:
    - `"403 done"`, `"403 refrigerator done"`, `"403 main bathroom sink fixed"`.
  - Labeled unit:
    - `"apt 403 done"`, `"unit 403 done"`, `"#403 done"`.
  - Mixed order with property:
    - `"penn 403 done"`, `"penn 403 refrigerator done"`, `"403 penn done"`.

- Normalize unit strings to the canonical form used in `WorkItems.UnitId` with whitespace/case handling.

#### 4.3 Issue-hint extraction

- Detect:
  - Fixture nouns:
    - `sink`, `refrigerator`, `fridge`, `toilet`, `tub`, `shower`, `outlet`, `washer`, `dryer`, `stove`, etc.
  - Problem modifiers:
    - `clogged`, `leaking`, `not working`, `broken`, `fixed`, etc.
- Build an `issueHint` object to feed deterministic scoring against WI titles/summaries.

#### 4.4 Synonym normalization

- Examples:
  - `fridge` → `refrigerator`
  - `tub` → `bathtub`
  - `clogged` → normalized tag `CLOGGED`
  - `fixed` / `done` / `completed` → normalized `COMPLETED` outcome hint

Use a small controlled synonyms table; no fuzzy ML.

#### 4.5 Bounded candidate retrieval

- Steps:
  - **Scope by staff**:
    - Only WIs where staff is assigned/owns the work.
  - **Scope by property**:
    - Explicit property from text wins.
    - Otherwise, staff property scope.
    - If still multiple: property-level clarification.
  - **Scope by unit**:
    - Filter within property to `unitId` extracted from text.

Result: candidate set is **never global**; it is at least `(staff, property, unit)` bounded.

#### 4.6 Deterministic scoring

For each candidate WI:

- Compute score based on:
  - Property+unit match (required to be in the set).
  - Issue noun overlap between `issueHint.fixtures` and WI title/summary/category.
  - Modifier matches (e.g. clogged/leaking).
  - Possibly recency / last-updated signals.

Output:

- `score` for each candidate.
- `bestScore`, `secondBestScore`.

#### 4.7 Confidence threshold + margin

Auto-resolve only when:

- `bestScore >= SCORE_THRESHOLD` (e.g. 0.7).
- `bestScore - secondBestScore >= MARGIN_THRESHOLD` (e.g. 0.2).

Else:

- Do not auto-pick; go to clarification.

#### 4.8 Clarification behavior

- Build operational, human prompts using:
  - Unit and issue nouns.
  - Examples:

    - “I found two open tickets for 403 at Penn: sink or refrigerator. Reply '403 sink done' or '403 refrigerator done'.”

- Resolver returns:
  - Candidates with labels and recommended reply forms:
    - `"403 sink done"`, `"403 refrigerator done"`.

Outgate renders via a specific clarification template using those options.

#### 4.9 Lifecycle canonical signal handoff

- On auto-resolve:
  - Resolver returns `lifecycleSignal` as canonical `{ eventType: "STAFF_UPDATE", wiId, propertyId, outcome, ... }`.
  - Shared front/orchestrator calls:
    - `handleLifecycleSignal_(lifecycleSignal)`.

- Lifecycle:
  - Applies state/timer policy.
  - Logs events.
  - Optionally triggers tenant verify / timer-based staff pings (as it already does).

- Resolver/Shared Front:
  - Based on lifecycle return code (`"OK"`, `"HOLD"`, `"REJECTED"`, `"CRASH"`), chooses which Outgate staff intent to send (ACK vs operational clarification).

---

### 5. Phased Execution Plan

#### Phase 1 — Architecture Cleanup Map (no behavior change)

**Objectives:**

- Catalog functions and mark responsibility boundaries.
- Prepare for extraction without changing behavior.

**Actions:**

- **Tag functions conceptually (no code changes yet):**
  - Mark each function in `LIFECYCLE_ENGINE.gs` as:
    - Lifecycle core.
    - Staff resolver.
    - Staff directory/shared front.
    - Outgate bridge.

- **Define target module homes (on paper):**
  - `STAFF_LIFECYCLE_COMMAND_RESOLVER` for:
    - Command resolution (`routeStaffInbound_`-like responsibilities).
    - WI resolution (`lifecycleResolveTargetWiForStaff_`-like).
    - Outcome normalization / ETA parsing.
    - Unit/property/ID extractors.
  - Shared staff directory module for:
    - `isStaffSender_`.
    - Staff ID-from-phone.
    - Open WI listing for staff.

- **Preserve runtime behavior:**
  - Leave `PROPERA MAIN.gs` calling `routeStaffInbound_` as-is.
  - Do not alter lifecycle evaluation/timers.

#### Phase 2 — Extract / Relocate Staff Resolver Out of Lifecycle (done)

**Objectives:**

- Keep lifecycle pure for policy/state/timers only.
- Ensure staff natural-language logic and staff-facing outbound behaviors live in dedicated resolver/front modules (not in `LIFECYCLE_ENGINE.gs`).

**Actions (aligned to current state):**

- **Resolver interface (already implemented):**

  Example:

  ```js
  // To replace direct routeStaffInbound_ call:
  staffHandleLifecycleCommand_(phone, rawText) =>
    { kind: "RESOLVED", lifecycleSignal, ackIntent } |
    { kind: "CLARIFY", clarifyIntent } |
    { kind: "UNHANDLED" }
  ```

- **Extraction (already completed in current codebase):**
  - Staff resolver helpers moved out of `LIFECYCLE_ENGINE.gs` into `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`:
    - `lifecycleResolveTargetWiForStaff_`
    - `lifecycleParsePartsEta_`
    - `lifecycleNormalizeStaffOutcome_`
    - `lifecycleListOpenWisForOwner_`
    - `lifecycleExtractUnitFromBody_`
    - `lifecycleKnownPropertyCodes_`
    - `lifecycleExtractPropertyHintFromBody_`
    - `lifecycleExtractWorkItemIdHintFromBody_`
    - `routeStaffInbound_`-equivalent logic, now exposed as `staffHandleLifecycleCommand_`.
  - Shared directory responsibilities moved out of lifecycle:
    - `isStaffSender_`
    - `lifecycleResolveStaffIdByPhone_`
  - `PROPERA MAIN.gs` now calls `staffHandleLifecycleCommand_(phone, bodyTrim)` directly for non-`#` staff messages.

- **Phase 2 cleanup (done):**
  - `LIFECYCLE_ENGINE.gs` contains only: gateway, policy evaluation, state transitions/timers, lifecycle-driven tenant verify and timer-based staff pings. Staff ACK/clarification from raw text is in the resolver only.

#### Phase 3 — Upgrade Staff Resolution Behavior (build on current resolver, not on lifecycle)

**Status:** Implemented. Summary below.

**Objectives (met):**

- Property scope first; robust unit parsing; issue-hint extraction and scoring; bounded candidates; deterministic scoring + thresholds/margins; clarification with suggested prompts.

**Actions (implemented):**

- **Property scope:** Explicit property-from-text (including “403 penn done”); clarify at property level when multiple properties for same unit (`CLARIFICATION_MULTI_PROPERTY` with `suggestedPrompts`). Staff assignment scope is implicit via `lifecycleListOpenWisForOwner_` (staff’s open WIs only).

- **Unit parsing:** Supports “403 done”, “apt 403”, “unit 403”, “403 penn done”, “penn 403 done”, “403 main bathroom sink fixed” (unit + fixture in body). Alphanumeric units (e.g. 403a) supported.

- **Issue-hint extraction and scoring:** `extractIssueHintsForStaff_` (fixture/synonym-style tokens) + `staffGetIssueLabelForWi_` (from WI `metadataJson`) + `scoreCandidatesByIssueHints_` with `STAFF_RESOLVER_SCORE_THRESHOLD_` (0.3) and `STAFF_RESOLVER_SCORE_MARGIN_` (0.2). Clear winner → auto-pick (`ISSUE_HINT_MATCH`); else clarification.

- **Bounded candidate retrieval:** Unchanged; already respects staff ownership, then property hint, then unit.

- **Clarification logic:** Resolver returns `suggestedPrompts` (e.g. “403 sink done”, “403 refrigerator done”); `staffHandleLifecycleCommand_` passes `vars.options` and `vars.suggestedPrompts` into `STAFF_CLARIFICATION`. Outgate rendering of options is Phase 4.

#### Phase 4 — Outgate Clarification / ACK Alignment

**Status:** Clarification rendering implemented. Resolver already provides `ackIntent`/`clarifyIntent` via `dispatchOutboundIntent_`; lifecycle does not generate clarification from raw text.

**Objectives:**

- Make Outgate the single expression layer for staff ACK/clarification.
- Ensure lifecycle only receives canonical signals.

**Actions (implemented):**

- **Extend Outgate intents:**
  - `STAFF_CLARIFICATION` and `STAFF_UPDATE_ACK` added to `OG_INTENT_TEMPLATE_MAP_` (OUTGATE.gs).
  - When `STAFF_CLARIFICATION` has `vars.options` or `vars.suggestedPrompts`, Outgate builds the message via `ogBuildStaffClarificationMessage_(options, lang)` (e.g. “Which one? Reply with: '403 sink done' or '403 refrigerator done'.”). Otherwise falls back to `renderTenantKey_("STAFF_CLARIFICATION", ...)`.
  - `STAFF_UPDATE_ACK` continues to use template/vars from resolver; richer vars (e.g. unit, issueTitle) can be added later if the resolver passes them.

- **Align resolver outputs with Outgate:**
  - Resolver already passes `vars.options` and `vars.suggestedPrompts` for CLARIFY; Outgate now renders them.
  - RESOLVED path already sends `STAFF_UPDATE_ACK` with outcome.

- **Lifecycle:** Staff clarifications originate from resolver + Outgate only; lifecycle only does policy-driven tenant verify and timer-based staff pings.

#### Phase 5 — Test Plan and Regression Scenarios

**Objectives:**

- Validate architecture changes and behavioral upgrades safely.
- Exercise success, ambiguity, and edge cases.

**Actions:**

- **Test harness:**
  - Build a test entrypoint that:
    - Accepts (staffId, phone, list of open WIs, rawText).
    - Runs new resolver, then optionally calls a **test-mode** `handleLifecycleSignal_`.
  - Logs:
    - Candidate set, scores.
    - Resolver decision (RESOLVED/CLARIFY).
    - Lifecycle decision, if invoked.
    - Outgate intent summary.

- **Regression strategy:**
  - Capture a sample of existing staff messages + outcomes before refactor.
  - Re-run through new resolver:
    - Confirm behavior is equivalent or improved.
    - Investigate divergences with logs.

---

### 6. Test Matrix

#### 6.1 Scenario Table

| ID | Context / Open WIs | Staff Text | Expected Resolver Behavior | Expected Lifecycle Behavior | Expected Outgate Behavior |
|----|--------------------|-----------|----------------------------|-----------------------------|---------------------------|
| S1 | One open WI for staff at PENN, unit 403, issue “sink clogged” | `403 done` | Property from staff scope, unit 403, only candidate → RESOLVED with outcome COMPLETED | `STAFF_UPDATE` to DONE/VERIFYING_RESOLUTION per policy | `STAFF_UPDATE_ACK` confirming 403 sink ticket completed |
| S2 | Two open WIs at PENN 403: (A) sink clogged, (B) refrigerator not cooling | `403 sink clogged done` | Bounded set (PENN 403), issue-hint “sink/clogged” matches A → RESOLVED for A | `STAFF_UPDATE` for WI A | ACK referencing sink ticket |
| S3 | Same as S2 | `403 refrigerator done` | Bounded set, issue-hint “refrigerator” matches B → RESOLVED for B | `STAFF_UPDATE` for WI B | ACK referencing refrigerator ticket |
| S4 | Same as S2 | `403 done` | Property+unit bound, no strong issue-hint → multiple equal candidates → CLARIFY | No lifecycle call yet | Clarification listing “403 sink” vs “403 refrigerator” with suggested reply forms |
| S5 | Staff has 403 tickets at PENN and MORRIS | `403 fridge fixed` | Detect unit 403 and issue “fridge/refrigerator”; if property not explicit and both properties have 403, require property-level CLARIFY | None | Clarification asking “403 at Penn or 403 at Morris?” with short reply options |
| S6 | Staff has 403 at PENN and MORRIS | `penn 403 refrigerator done` | Explicit property “PENN” + unit 403 + issue-hint “refrigerator” → RESOLVED for PENN 403 refrigerator WI | `STAFF_UPDATE` for correct WI | ACK for that WI |
| S7 | Staff has single WI at PENN 403 | `403 penn done` | Mixed property+unit parsing recognized as PENN 403; RESOLVED with outcome COMPLETED | `STAFF_UPDATE` | ACK |
| S8 | Single WI at PENN 403 “sink clogged” | `403 main bathroom sink fixed` | Property from staff scope, unit 403, issue-hint “sink”, extra location info; RESOLVED | `STAFF_UPDATE` outcome COMPLETED | ACK confirming sink ticket completion |
| S9 | Single WI at PENN 403 “refrigerator not cooling” | `403 fridge fixed` | Synonym fridge→refrigerator; RESOLVED for that WI | `STAFF_UPDATE` outcome COMPLETED | ACK referencing refrigerator ticket |
| S10 | Multiple units for staff at PENN; no unit in text | `done` | No unit; candidate set too large → CLARIFY asking for unit | None | Clarification: “For which unit? Reply '403 done' or '405 done'...” |
| S11 | No open tickets for referenced unit | `999 done` | Property from scope, unit 999 yields empty bounded set; context cannot override → CLARIFY “no open tickets for 999” | None | Clarification / informative response about no open tickets |
| S12 | WAITING_PARTS scenario | `403 waiting on parts, eta next week` | Property+unit bound; outcome WAITING_PARTS; ETA parsed from phrase “next week” → RESOLVED | `STAFF_UPDATE` with `outcome="WAITING_PARTS"` + `partsEtaAt` | ACK summarizing waiting on parts with ETA |
| S13 | Stale context | Prior context points to old WI; new WI exists for same unit | `403 done` | Resolver respects bounded text-based candidate set first; context used only as secondary assist inside the same property+unit; RESOLVED or CLARIFY without blindly trusting stale context | `STAFF_UPDATE` for correct WI or none if CLARIFY | ACK or clarification accordingly |

---

### 7. Risks / Migration Notes

**Risk 1 — Cross-module entanglement during extraction**

- Extracting resolver helpers from `LIFECYCLE_ENGINE.gs` can accidentally:
  - Introduce new dependencies.
  - Break invariants if touched alongside lifecycle core.
- **Mitigation:**
  - Phase 2 is a strict move-only refactor:
    - Same function bodies, new homes.
    - Only update imports/call sites.
  - Use test harness to validate behavior is unchanged.

**Risk 2 — Staff experience changes with clarifications**

- More clarifications might:
  - Increase message volume.
  - Temporarily slow staff flow if not tuned well.
- **Mitigation:**
  - Start with conservative thresholds (auto-resolve when clearly safe).
  - Log resolver decisions for tuning.
  - Possibly gate new behaviors behind property-level flags.

**Risk 3 — Wrong candidate pruning with stricter bounds**

- Tighter bounding (property+unit) might:
  - Miss cases where historical behavior was more forgiving.
- **Mitigation:**
  - Start with:
    - Transparent clarifications instead of silent errors.
  - Use logs to refine heuristics:
    - E.g. allow limited fallback to broader staff-scope with explicit messaging.

**Risk 4 — Lifecycle regressions**

- Any accidental change in:
  - `STAFF_UPDATE` signal shape.
  - Timer/write behavior.
- Could affect auto-close, pings, etc.
- **Mitigation:**
  - Keep `handleLifecycleSignal_`, `evaluateLifecyclePolicy_`, and `executeLifecycleDecision_` untouched until after resolver extraction.
  - Use regression tests to compare lifecycle logs before/after.

**Risk 5 — Outgate template churn**

- New intents or vars may need template updates.
- **Mitigation:**
  - Design new intent+vars schema in Phase 3.
  - Keep message content minimal and operational for initial rollout.
  - Reuse existing `STAFF_CLARIFICATION` / `STAFF_UPDATE_ACK` where possible with additive vars.

This markdown document defines the current-state map, target end-form, staff cycle end-form, phased execution plan, test matrix, and risks/migration notes for aligning staff lifecycle command handling with the Propera compass.

