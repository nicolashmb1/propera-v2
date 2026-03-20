# Propera — Shared Schedule Parsing Map & Plan

## Goal

Create a single shared schedule parsing capability that converts free-form window text into canonical schedule data, and make all relevant signal paths use it consistently.

This first plan must accomplish three things:

1. Extract schedule parsing out of `PROPERA_MAIN.gs` into a new shared `.gs` file.
2. Hard cutover with no fallback and no duplicate logic; current `PROPERA_MAIN.gs` behavior must remain functionally the same for existing tenant paths after the cutover.
3. Make lifecycle receive parsed schedule correctly:
   - lifecycle consumes canonical schedule data
   - lifecycle does not parse raw English

## Plan Invariants (Architecture Rules)

- Must be `Signal -> Brain -> Outgate` aligned: no parsing English inside lifecycle.
- Adapters do not decide; lifecycle/policy do not do raw-text interpretation.
- Responsibility/lifecycle authority remains deterministic and auditable.
- One shared parser; no temporary duplicate parser left behind.

---

## Part 1 — Current State Map

### A. Current parser ownership

Today the schedule parser helpers are trapped inside `PROPERA_MAIN.gs` as inner-scoped functions, such as:

- `parsePreferredWindow_`
- related helpers like schedule/window detection helpers

Because they are inner-scoped:

- they are usable only inside that enclosing function/runtime block
- they are not reusable by:
  - `LIFECYCLE_ENGINE.gs`
  - `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`
  - portal-specific handlers
  - other adapters/modules that may need direct access

This is the immediate architecture blocker.

### B. Current behavior by signal form

#### 1. Twilio SMS / WhatsApp

- Likely already benefit from the current parser because they pass through the main intake pipeline in `PROPERA_MAIN.gs`.
- For these channels, schedule parsing may already happen implicitly in the existing tenant flow.

Status: likely already parsed in current pipeline  
Need: preserve behavior while moving parser out of `PROPERA_MAIN.gs`.

#### 2. Telegram

- Telegram probably also reaches the same main pipeline now, depending on how the synthetic event is built and where it lands.
- If Telegram is handed into the same intake/runtime path, it should be able to share the same parser after extraction.

Status: likely pipeline-compatible, must be mapped  
Need: verify whether Telegram passes through the same scheduling interpretation path as SMS/WA.

#### 3. Alexa

- Alexa may or may not currently pass through the same scheduling interpretation path depending on whether it lands as a canonical inbound signal or some custom adapter flow.
- Architecturally it should use the same parser whenever it contains free-form schedule text.

Status: must be mapped  
Need: verify whether Alexa reaches parser-capable pipeline or stores free text only.

#### 4. Staff natural commands

Right now staff free-form scheduling does not correctly parse schedule text into a structured schedule action.

Example inputs:

- `403 penn tomorrow morning`
- `penn 403 today 1-3pm`

Current issue:

- staff flow resolves operational command partially
- it normalizes schedule phrases like `tomorrow` / `next week` / `reschedule` into a non-schedule lifecycle outcome (`DELAYED`)
- so lifecycle receives no canonical `scheduledEndAt` and cannot schedule `PING_STAFF_UPDATE` off an actual time window
- lifecycle cannot and should not do raw-English schedule parsing itself

Status: not properly supported for `scheduledEndAt` / schedule-window setting  
Need: staff resolver must use shared parser before lifecycle, then emit canonical schedule payload (so lifecycle can write timers/state without parsing English).

#### 5. Portal

Portal create/update already parses schedule input (e.g. `preferredWindow` / `body.schedule`) using the existing `parsePreferredWindow_` logic in `PROPERA MAIN.gs`, and stores:
- `COL.PREF_WINDOW` (window label)
- `COL.SCHEDULED_END_AT` (structured end datetime, when `parsePreferredWindow_` returns an `end`)

Status: already parsed, but currently parser logic is still coupled to `PROPERA MAIN.gs`  
Need: after extraction, ensure portal uses the shared parser without behavior change.

### C. Lifecycle current/target role

Current risk:

- If solved the wrong way, lifecycle starts parsing phrases like:
  - "tomorrow morning"
  - "today 1-3pm"
  - "friday afternoon"
- That would be wrong.

Target role:

Lifecycle should receive canonical parsed schedule data, e.g.:

```json
{
  "type": "STAFF_UPDATE",
  "action": "SCHEDULE_SET",
  "target": { "...": "..." },
  "schedule": {
    "startAt": "...",
    "endAt": "...",
    "rawText": "tomorrow morning"
  }
}
```

or an equivalent canonical schedule payload from any ingress.

So lifecycle owns:

- transition validation
- schedule field writes
- timer updates
- attempt resets
- logging

Lifecycle does not own raw-text interpretation.

---

## Part 2 — Target Architecture

### The shared parser becomes infrastructure

Create a new shared file, for example:

- `SCHEDULE_PARSER.gs`

This file becomes the single place for:

- free-form schedule window parsing
- schedule-like text detection if still needed
- normalization of parsed schedule output
- emitting canonical schedule payloads suitable for lifecycle updates

### Ownership after the split

#### `SCHEDULE_PARSER.gs`

Owns:

- raw schedule text -> structured schedule window
- determining whether text contains a scheduling intent
- isolating the schedule text portion when needed
- calling the shared parser
- emitting canonical signal / canonical update payloads

#### `LIFECYCLE_ENGINE.gs`

Owns:

- canonical schedule application
- state transitions
- timers
- logging

#### `PROPERA_MAIN.gs`

Owns:

- runtime entry
- orchestration/wiring
- not the schedule parsing logic itself

---

## Part 3 — Required Deliverables for This First Plan

### Deliverable 1 — New shared file + hard cutover

Create a new shared file:

- `SCHEDULE_PARSER.gs`

Move the real parser implementation there.

Important constraints:

- this is a move, not a duplicate
- no fallback to old inner-scoped copy
- `PROPERA_MAIN.gs` must be updated to use the new outer-scoped shared parser
- current behavior must remain functionally the same for existing tenant paths

### Deliverable 2 — Lifecycle integration through canonical parsed schedule

Make lifecycle receive parsed schedule in canonical form.

That means:

- lifecycle does not call raw text parser directly for staff free-form commands
- upstream resolver parses first
- lifecycle gets structured schedule payload and applies it

For UNSCHEDULED specifically:

1. staff command resolver must resolve target + extract remainder + call shared parser
2. output canonical `SCHEDULE_SET`
3. lifecycle consumes `SCHEDULE_SET`

### Deliverable 3 — Channel map for shared parser adoption

Map every signal form into one of these categories:

Category A — Already pipeline-parsed, just repoint to shared parser  
Likely: Twilio SMS, WhatsApp, maybe Telegram, maybe Alexa depending on current wiring.

Category B — Reaches pipeline but must be confirmed  
Likely: Telegram, Alexa (confirm exact routing point).

Category C — Currently stores free text and must be upgraded  
Known: Staff natural commands, Portal.

This map should explicitly identify:

- where free-form schedule text enters
- where it is currently stored
- whether it is currently parsed
- where shared parser should be called after refactor

---

## Part 4 — Signal Form Map (Explicit Channel Upgrade Mapping)

1. Twilio SMS
   - Current: likely uses existing parser through `PROPERA_MAIN.gs` tenant path
   - Target: same behavior, but parser now comes from `SCHEDULE_PARSER.gs`
   - Action: verify no behavior change after cutover

2. WhatsApp
   - Current: likely same as Twilio if normalized into same intake path
   - Target: same shared parser
   - Action: verify same routing path and no behavior change

3. Telegram
   - Current: likely normalized into synthetic event then routed into core
   - Target: same shared parser if it hits schedule interpretation path
   - Action: map exact routing point and confirm whether parsing already occurs

4. Alexa
   - Current: unclear whether free-form schedule text is parsed or just forwarded/stored
   - Target: same shared parser for any free-form schedule phrase
   - Action: map exact Alexa ingress and determine whether it already reaches parser-capable pipeline

5. Staff natural commands
   - Current: target resolution exists or is planned, but no proper schedule parse handoff
   - Target: resolver strips target prefix, parses remainder with shared parser, emits canonical `STAFF_UPDATE` / `SCHEDULE_SET`
   - Action: explicit new integration required

6. Portal
   - Current: free text stored, not parsed
   - Target: portal intake or portal resolver calls shared parser on free-form schedule text and stores canonical schedule result or emits canonical scheduling signal
   - Action: explicit new integration required

---

## Part 5 — Phased Plan

### Phase 0 — Map the current schedule touchpoints (no behavior change yet)

Before changing behavior, build a precise map of:

- where `parsePreferredWindow_` and related helpers live now (`PROPERA MAIN.gs`)
- where tenant/SMS/WhatsApp/Telegram/Alexa free-form *schedule replies* reach the `SCHEDULE` stage and how that stage writes:
  - `COL.PREF_WINDOW`
  - `COL.SCHEDULED_END_AT`
- where portal create/update calls `parsePreferredWindow_` and writes `COL.PREF_WINDOW` + `COL.SCHEDULED_END_AT`
- where staff free-form schedule phrases enter (`STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`) and what they currently normalize into (no canonical `scheduledEndAt`)
- where staff free-form commands diverge from the tenant schedule-writing path (so we can refactor by adding parsing upstream of lifecycle, not inside it)
- where Alexa/Telegram adapters route into the same core path, and confirm they reach the tenant `SCHEDULE` stage for schedule replies

Output:

- a wiring map
- no code behavior change yet

### Phase 1 — Extract shared parser into `SCHEDULE_PARSER.gs` (hard cutover)

Move the parser and required helpers out of `PROPERA_MAIN.gs` into a new outer-scoped shared file.

Rules:

- no duplicate parser left behind
- no fallback branches
- no altered parsing behavior

`PROPERA_MAIN.gs` must call the shared parser after cutover.

Success condition:

- existing tenant scheduling behavior remains unchanged
- parser is now globally reusable

### Phase 2 — Rewire current pipeline users to the shared parser

Update all schedule-capable flows that already relied on the old parser location to use the new shared parser.

Main concern:

- preserve exact current behavior for tenant scheduling
- verify SMS/WA and any pipeline-based channels still behave the same

Success condition:

- no behavior regression in existing schedule capture flows

### Phase 3 — Add canonical staff schedule resolution

In `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs`:

1. resolve target: property/unit/work item
2. strip targeting prefix
3. isolate schedule remainder
4. call shared parser
5. if parsed, emit canonical `STAFF_UPDATE` / `SCHEDULE_SET`

In `LIFECYCLE_ENGINE.gs`:

- consume canonical schedule payload
- apply schedule via normal scheduling path
- update UNSCHEDULED state accordingly

Success condition:

- staff can send natural commands like:
  - `403 penn tomorrow morning`
  - `penn 403 today 1-3pm`
- without lifecycle parsing English

### Phase 4 — Ensure portal uses shared parser

After Phase 1 extraction, ensure the portal create/update path calls the shared schedule parser (same grammar/behavior) and continues to store:

- `COL.PREF_WINDOW`
- `COL.SCHEDULED_END_AT`

Success condition:

- portal uses the same schedule grammar as SMS/WA/staff

### Phase 5 — Confirm Alexa / Telegram compatibility

For each of Alexa and Telegram, determine whether they:

- already pass through parser-capable pipeline (then only shared extraction is needed)
- need no change beyond shared parser extraction
- or need their own explicit parse invocation before canonical signal emission

Success condition:

- map is explicit
- no ambiguity about which channels already share parsing and which still need wiring

#### Phase 5 execution result (2026-03-19)

Status: COMPLETE (mapping explicit; no additional parser wiring required for Telegram/Alexa schedule interpretation path).

1. Telegram
   - Ingress: `doPost` detects Telegram payload and routes to `telegramWebhook_` in `TELEGRAM_ADAPTER.gs`.
   - Adapter behavior: authenticate/dedupe/enqueue only; no schedule/business parsing in adapter.
   - Queue worker: `processTelegramQueue_` normalizes payload, sets `_channel: "TELEGRAM"`, and calls `handleSmsRouter_(syntheticE)`.
   - Shared parser reachability: YES. Telegram text enters the same shared brain/runtime path used by tenant scheduling logic, where shared schedule parser helpers are available.
   - Classification: Category A (pipeline-parsed through core path; shared parser-capable).
   - Action required: none for parser wiring. Keep regression checks only.

2. Alexa
   - Ingress: `doPost` JSON gate routes `data.alexaRequest === true` to `handleAlexaWebhook_` in `ALEXA_ADAPTER.gs`.
   - Adapter behavior: validate/normalize/resolve actor/enqueue package only; no schedule/business parsing in adapter.
   - Queue worker: `processAlexaQueue_` builds canonical body and calls `handleSmsCore_(e)` (same brain entry used by SMS flow).
   - Shared parser reachability: YES. Alexa free-form text is handed to the shared brain path where schedule capture uses shared parser helpers.
   - Classification: Category A (pipeline-parsed through core path; shared parser-capable).
   - Action required: none for parser wiring. Keep regression checks only.

3. Phase 5 close notes
   - No evidence that Telegram or Alexa require lifecycle-layer raw-text parsing.
   - No additional adapter-side schedule parsing should be added (keeps Signal -> Brain -> Outgate boundaries intact).
   - Remaining work after Phase 5 is verification/documentation quality: channel regression tests and final phase checklist closure.

---

## Part 6 — Rules for Implementation

### Must do

- one shared parser
- outer-scoped shared file
- no duplicated parsing logic
- lifecycle consumes canonical parsed schedule only
- preserve current tenant behavior during cutover
- explicitly map every signal form

### Must not do

- no fallback to old inner-scoped parser
- no parsing English inside lifecycle
- no "temporary" duplicate parser in another module
- no staff scheduling hack that reuses tenant flow indirectly by disguising staff input as tenant input
- no portal continuing to store only raw schedule text once upgraded

---

## Part 7 — End State

After this plan is complete:

- `PROPERA_MAIN.gs` no longer owns hidden schedule parsing logic
- schedule parsing is shared infrastructure
- existing tenant scheduling still behaves the same
- staff natural schedule commands can be parsed cleanly
- portal can parse free-form schedule text using the same functionality
- Alexa / Telegram / Twilio / WhatsApp are explicitly mapped against the same parser capability
- lifecycle remains clean and architecture-aligned

