# PROPERA — Channel Neutrality Audit
**Architecture Audit · Gap Map · Execution Plan**
March 2026 · Confidential

---

## EXECUTIVE SUMMARY

The central question: **If the same operational message arrives on SMS, WhatsApp, Telegram, or any future channel, does Propera produce the same internal decision and domain behavior?**

**Short answer:** Partially today. The foundations are structurally sound — `normalizeInboundEvent_()`, `decideLane_()`, `dispatchOutboundIntent_()`, and the lifecycle engine are all channel-agnostic by design. But three critical leaks in the current runtime prevent true channel neutrality.

| Layer | What's Already Right | The Gap |
|---|---|---|
| Signal Normalization | `normalizeInboundEvent_()` exists and is called correctly | Does NOT include `media[]` or `channel` as first-class fields — meta is freeform |
| Identity / Context Key | `phoneKey_()` normalizes phone consistently | `ConversationContext` keyed by `PhoneE164` only — Telegram user ID has no mapping path |
| Channel Detection | `isWa` / `channel` derived early and passed to inbound | `globalThis.__inboundChannel` set from raw Twilio `From` field — any non-Twilio adapter defaults to SMS |
| Lane Routing | `classifyLane_()` / `decideLane_()` reads from inbound object — channel-neutral | After `decideLane_()`, `routeToCoreSafe_(e)` passes raw `e` — downstream reads Twilio fields directly |
| Media Extraction | `imageSignalAdapter_()` exists for synthesis | Media loop reads `p['MediaUrl'+i]` — Twilio field names hardcoded in 3+ places in core |
| Outgate / Delivery | `dispatchOutboundIntent_()` is fully channel-aware; `ogDeliver_()` branches WA vs SMS | Falls back to `globalThis.__inboundChannel` when `intent.channel` missing |
| Lifecycle Engine | `handleLifecycleSignal_()` has zero channel references — fully neutral | `lifecycleOutboundIntent_()` emits no `channel` field — relies on global |
| Compliance / OptOut | `isSmsOptedOut_()` checks by phone | STOP/START/HELP compliance block runs for all channels — should be SMS-only |

---

## SECTION 1 — ARCHITECTURE AS-BUILT

### 1.1 The Inbound Signal Path (Current State)

Tracing a message from Twilio webhook to domain action:

---

#### `doPost(e)` — Transport Entry — 🔴 Twilio-shaped
Reads `e.parameter.From` (Twilio field). Sets `globalThis.__inboundChannel` from `'whatsapp:'` prefix (`"WA"` vs `"SMS"`). Sets `globalThis.__bodyOverride` for media-only messages. Routes: Portal → AppSheet → Alexa → Twilio path.

> 🔎 Code-Verified: `doPost(e)` sets `globalThis.__inboundChannel` based on raw Twilio `From` and never on a canonical channel field. See `doPost` in `PROPERA MAIN.gs` around lines 5995–6122.

---

#### `handleSmsSafe_(e)` — Pre-Router — 🔴 Twilio-shaped
Reads `From`, `Body`, and `MessageSid`/`SmsMessageSid` directly from Twilio-shaped params via `safeParam_`. Delegates immediately to `handleSmsCore_()` but participates in fallback error replies using `dispatchOutboundIntent_()` with `channel` derived from `globalThis.__inboundChannel`.

> 🔎 Code-Verified: `handleSmsSafe_` logs inbound and calls `handleSmsCore_(e)` directly, and on crash uses `dispatchOutboundIntent_({ channel: globalThis.__inboundChannel || "SMS", ... })`. See `PROPERA MAIN.gs` around lines 13600–13623.

---

#### `normalizeInboundEvent_(channel, opts)` — Signal Boundary — 🟡 Partial
**GOOD:** produces `{ v, source, actorType, actorId, body, bodyTrim, bodyLower, eventId, timestamp, meta }`.
**GAP:** `media[]` and `channel` are buried in `meta{}` as freeform — not first-class fields in the contract.
**GAP:** called correctly but its output is not the only thing downstream reads.

> 🔎 Code-Verified: `normalizeInboundEvent_` currently returns only `source`, `actorType`, `actorId`, body fields, `eventId`, `timestamp`, and `meta` with no `channel` or `media` top-level fields. See `PROPERA MAIN.gs` lines 6373–6402.

---

#### `decideLane_(inbound)` — Lane Decision — ✅ Channel-neutral
`classifyLane_()` reads only `inbound.actorId` (the phone). Returns lane + mode struct. Does not touch transport. Correct.

> 🔎 Code-Verified: `classifyLane_` inspects `inbound.actorId` and (optionally) `inbound.source` for `"aiq"` only, then `decideLane_` wraps this into a decision object with no channel checks. See `PROPERA MAIN.gs` lines 6408–6444.

---

#### `routeToCoreSafe_(e, opts)` — Core Dispatch — 🔴 Twilio-shaped
Passes raw `e` to `handleSmsCore_()`. Does NOT pass the inbound canonical object. Brain re-reads Twilio fields from scratch.

> 🔎 Code-Verified: `routeToCoreSafe_(e, opts)` only injects `_mode` / `_internal` into `e.parameter` and then calls `handleSmsCore_(e)`; it does not attach a canonical inbound object or channel. See `PROPERA MAIN.gs` lines 6540–6553.

---

#### `handleSmsCore_(e)` — Brain Entry — 🔴 Twilio-shaped
Reads `safeParam_(e, 'From')`, `safeParam_(e, 'Body')`, `safeParam_(e, 'NumMedia')`, `safeParam_(e, 'MediaUrl'+i)`. Re-derives phone, mode, media from raw Twilio params. Channel is re-read from `globalThis.__inboundChannel`.

> 🔎 Code-Verified: `handleSmsCore_` uses `safeParam_(e, "From"/"Body"/"NumMedia"/"MediaUrl"+i)` and `e.parameter._phoneE164` for identity, and pulls `bodyRaw` from `globalThis.__bodyOverride` plus Twilio `Body`. All channel awareness comes from `globalThis.__inboundChannel`, not from a canonical inbound or explicit parameter. See `PROPERA MAIN.gs` around lines 13711–13728 and 13842–13851.

---

#### `compileTurn_()` / domain logic — 🟡 Mostly neutral
Operates on text + structured facts. Phone-keyed. Largely channel-agnostic. Small leak: `turnFacts.meta.channel` set from Twilio `From` prefix again.

> 🔎 Code-Verified: domain and lifecycle helpers consume `turnFacts` and `ctx*` keyed by phone/actor, and where channel appears in `meta` it is derived from Twilio-originated hints (e.g. `meta.mediaUrls`, source, or inferred channel) rather than from a normalized `channel` field.

---

#### `dispatchOutboundIntent_(intent)` — Outbound — ✅ Channel-aware
Resolves channel from `intent.channel` → `globalThis.__inboundChannel` → default SMS. Renders template correctly per channel. Delivers via `sendRouterSms_()` which branches WA/SMS.

> 🔎 Code-Verified: `dispatchOutboundIntent_` in `OUTGATE.gs` resolves `channel` as `String(intent.channel || "").trim().toUpperCase()`, falls back to `globalThis.__inboundChannel` when empty, normalizes anything non-`"WA"` to `"SMS"`, writes `intent.channel = channel`, and passes this into `ogDeliver_()`. See `OUTGATE.gs` lines 186–197.

---

## SECTION 2 — THE THREE CRITICAL LEAKS

> These are the exact locations that would cause a Telegram adapter to behave differently from SMS today.

---

### LEAK-1 — `globalThis.__inboundChannel` — Transport-Coupled Channel Propagation
**Severity: CRITICAL**

**Location:** `doPost()` channel snapshot (`globalThis.__inboundChannel` set from Twilio `From`) and every `dispatchOutboundIntent_()` call site that omits `intent.channel` (e.g. error fallbacks in `handleSmsSafe_()`, maintenance replies in `handleSmsCore_()`, and emergency flows).

**Problem:** `globalThis.__inboundChannel` is set at the top of `doPost()` by reading the raw Twilio `From` field prefix (`'whatsapp:+1...'`). It is then read as the fallback channel in `ogDeliver_()` and in every `dispatchOutboundIntent_()` call site in the brain that omits `intent.channel`. A Telegram adapter has no `'whatsapp:'` prefix. The global would default to `'SMS'` for every outbound reply from a Telegram message.

**Fix:** Move channel into the inbound canonical object as a first-class field. Pass it explicitly through `routeToCoreSafe_()` → `handleSmsCore_()` → into every `dispatchOutboundIntent_()` call. `globalThis.__inboundChannel` becomes a deprecated fallback only, then is removed.

**Test:** Send WA message. Send SMS. Both should produce correct channel on outbound without reading `globalThis`.

> 🔎 Code-Verified: 
> - `doPost` sets `globalThis.__inboundChannel` based solely on `From` (`"WA"` for `whatsapp:` prefix, otherwise `"SMS"`).
> - `dispatchOutboundIntent_` and `ogDeliver_` both use `intent.channel` with a fallback to `globalThis.__inboundChannel`.
> - Many `dispatchOutboundIntent_` call sites in `PROPERA MAIN.gs` (maintenance intake, emergency, help, etc.) do not pass `channel`, implicitly binding outbound behavior to that global.

---

### LEAK-2 — `ConversationContext` Keyed by `PhoneE164` Only
**Severity: CRITICAL**

**Location:** `ctxGet_()` / `ctxUpsert_()` — ConversationContext sheet, `PhoneE164` column and all callers in tenant/staff flows.

**Problem:** All context threading (pending state, active work items, expected stage, language) is keyed by `phoneKey_(phone)`. Telegram user IDs are not E.164 phone numbers. A Telegram user texting 'yes' to confirm a schedule cannot be linked to their pending context because the key doesn't exist. The entire pending/continuation flow breaks.

**Fix:** Two paths:
- **(A) Synthetic phone key** — prefix Telegram user IDs as `'TG:12345678'` and treat as opaque actor keys throughout. Consistent with the `SCAP:` pattern already used for staff capture. Fast, low risk.
- **(B) Abstract actorKey** — replace `PhoneE164` column with `ActorKey` that accepts any channel-prefixed identifier. Correct long term.

Phase 1 should use path A.

**Test:** Telegram user sends multi-turn conversation. `pendingExpected` state survives between messages.

> 🔎 Code-Verified:
> - `ctxGet_(phoneAny)` normalizes via `phoneKey_` and looks up rows strictly by `"PhoneE164"`; it returns default context when no row exists. See `PROPERA MAIN.gs` lines 4692–4743.
> - `ctxUpsert_` likewise finds/creates rows keyed on `"PhoneE164"` and enforces safety rules based on manager/vendor status, confirming that all pending/active state is currently keyed by phone. See `PROPERA MAIN.gs` lines 4747–4811.
> - Existing synthetic keys (e.g. `"SCAP:" + draftId`) demonstrate the precedent for non-phone actor keys flowing through the same context layer.

---

### LEAK-3 — Media Extraction Hardcoded to Twilio Field Names
**Severity: HIGH**

**Location:** `handleSmsSafe_()` ~line 5421, `handleSmsCore_()` ~line 13830, STAFF_CAPTURE block ~line 13832

**Problem:** Media URLs are extracted in 3+ places using `p['MediaUrl0']`, `p['MediaUrl1']` etc. — these are Twilio multipart form field names. Telegram sends media as a JSON object with different field names (`photo[]`, `document{}`, etc.). Any non-Twilio adapter sending media would produce empty `mediaUrls[]`, causing the image signal adapter and attachment flows to silently skip.

**Fix:** Normalize media in the adapter layer into a canonical array: `[{ url, contentType }]`. Pass as `opts.media[]` into `normalizeInboundEvent_()`. The signal object then has `inbound.media[]` as a first-class field. All downstream media reading consumes `inbound.media[]`, not raw Twilio fields.

**Test:** Send image via WA. Send same image via simulated Telegram. Both should enter `imageSignalAdapter_()` with same media array.

> 🔎 Code-Verified:
> - Staff capture path in `handleSmsCore_` builds `_mediaUrlsStaff` by looping `safeParam_(e, "MediaUrl"+i)` and storing into `turnFacts.meta.mediaUrls`. See `PROPERA MAIN.gs` around lines 13842–13851.
> - Tenant maintenance paths later in `handleSmsCore_` use `turnFacts.meta.mediaUrls[0]` and related hints in multiple places, but the canonical `imageSignalAdapter_` itself pulls from `extractInboundMediaFacts_(e)`, which underneath reads Twilio-style `MediaUrl*` fields.
> - `imageSignalAdapter_` only has a single URL slot `firstUrl` and assumes Twilio media URLs; there is no adapter-independent `media[]` field on the inbound object today. See `PROPERA MAIN.gs` lines 728–785.

---

## SECTION 3 — SECONDARY GAPS (Non-Blocking, Address in Phase 2+)

| ID | Severity | Issue | Detail |
|---|---|---|---|
| S-1 | WARN | `routeToCoreSafe_()` passes raw `e` | Lane decision was made from the canonical inbound object, but the core re-parses from scratch. After LEAK-1 is fixed, the inbound object (including `channel` and `media[]`) should be passed alongside `e`. |
| S-2 | WARN | STOP/START/HELP compliance runs for all channels | The compliance block runs for any channel. WA does not require STOP/START/HELP. Should be gated behind `channel === 'sms'`. |
| S-3 | WARN | `lifecycleOutboundIntent_()` emits no channel field | Lifecycle sends outbound intents without a channel field. Timer-fired signals (cron, no live request scope) have no `__inboundChannel` global. Needs a channel parameter or separate channel resolution step. |
| S-4 | INFO | `normalizeInboundEvent_()` schema is too thin | `media[]` and `channel` should be first-class fields, not buried in `meta`. Makes the contract concrete and testable. |
| S-5 | INFO | Staff identity still phone-only | `isStaffSender_()` and `isManager_()` identify staff by phone. Telegram staff need a `TG:`-prefixed actor key and a matching Staff sheet entry. |
| S-6 | INFO | OptOut sheet column is `PhoneE164` | For channels without phone numbers, the key would be the synthetic actor ID. `isSmsOptedOut_()` should accept any actor key. |

> 🔎 Code-Verified:
> - `lifecycleOutboundIntent_` in `LIFECYCLE_ENGINE.gs` builds intents with `intentType`, `templateKey`, `recipientType`, `recipientRef`, `vars`, and `deliveryPolicy`, but no `channel` property; downstream Outgate must then infer channel from globals or context. See `LIFECYCLE_ENGINE.gs` lines 1139–1160.
> - Lifecycle timer processing (`processLifecycleTimers_` → `handleLifecycleSignal_` → `executeLifecycleDecision_`) never has access to a live request, confirming that timer-driven outbound intents cannot safely rely on `globalThis.__inboundChannel`.

---

## SECTION 3.1 — Additional Gaps Discovered (Code-Verified)

> These are channel-coupling or identity/media issues not fully spelled out in the original gap list but visible in the current code.

1. **G-1 — Alexa Adapter Forces SMS Channel**
   - **Description:** Alexa voice requests are normalized and enqueued correctly, but when `processAlexaQueue_()` hands off to `handleSmsCore_`, it sets `globalThis.__inboundChannel = "SMS"` unconditionally.
   - **Why it breaks channel neutrality:** Alexa is a distinct channel (`"alexa"`), but all outbound replies for Alexa-originated flows are forced to behave as if they were SMS. This prevents Alexa-specific channel policies and makes it impossible to reason about Alexa as a first-class channel in Outgate.
   - **Code reference:** `processAlexaQueue_` in `ALEXA_ADAPTER.gs` around lines 221–247, especially the bridge comment and assignment `globalThis.__inboundChannel = "SMS"`.
   - **Severity:** **WARN** (does not break SMS/WA, but blocks truly channel-aware Alexa behavior).

2. **G-2 — Staff Lifecycle Commands Rely on Phone-Only Context**
   - **Description:** `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs` resolves candidate work items for `#` commands and non-`#` replies using `ctxGet_(phone)` as a fallback when property/unit-based matching fails.
   - **Why it breaks channel neutrality:** All lifecycle confirmation/clarification context for staff is keyed by phone; a future staff channel without a direct E.164 mapping (e.g. app-only or Telegram staff) cannot participate without reusing phone semantics or introducing ad hoc mappings.
   - **Code reference:** `resolveLifecycleTargetWorkItem_` fallback block that uses `ctxGet_(phone)` when earlier heuristics fail. See `STAFF_LIFECYCLE_COMMAND_RESOLVER.gs` lines 464–471.
   - **Severity:** **WARN** (staff flows work but remain phone-bound; blocks non-phone staff channels).

3. **G-3 — Media Facts Contract is Twilio-Centric**
   - **Description:** `imageSignalAdapter_` and `maybeAttachMediaFactsToTurn_` define a rich media facts object (`firstUrl`, `mediaType`, issue hints, synthetic body), but the only backing implementation today (`extractInboundMediaFacts_(e)`) is Twilio form-field specific.
   - **Why it breaks channel neutrality:** New adapters must either emulate Twilio field names or fork the media path. There is no adapter-independent `inbound.media[]` handoff, so Telegram or app-uploaded images would need a parallel implementation to get equal treatment.
   - **Code reference:** `imageSignalAdapter_` and `maybeAttachMediaFactsToTurn_` in `PROPERA MAIN.gs` lines 728–785 and 841–859, plus Twilio `MediaUrl*` extraction near the staff/tenant maintenance paths.
   - **Severity:** **HIGH** (media flows are central to modern channels; Twilio-shaped assumptions leak into what is intended to be a canonical media adapter).

4. **G-4 — Outbound Channel Inference from Context Only**
   - **Description:** Lifecycle and some staff flows build intents without `channel`, relying on Outgate’s global fallback or future heuristics to pick a channel.
   - **Why it breaks channel neutrality:** Without an explicit `channel` per intent, the system cannot guarantee per-actor channel preferences or per-channel compliance routing for cron/timer-driven events. Channel selection becomes implicit instead of a first-class decision.
   - **Code reference:** `lifecycleOutboundIntent_` in `LIFECYCLE_ENGINE.gs` lines 1139–1160 and the timer execution paths that call `dispatchOutboundIntent_` without a `channel`.
   - **Severity:** **WARN** (does not break existing SMS/WA behavior today due to globals, but prevents safe expansion to more channels).

---

## SECTION 4 — WHAT IS ALREADY CORRECTLY BUILT

> These do NOT need to change. They prove the bones are sound.

| Component | Why It's Already Right |
|---|---|
| `normalizeInboundEvent_()` | Exists. Is called before `decideLane_()`. Just needs schema tightened (S-4). |
| `decideLane_()` / `classifyLane_()` | 100% channel-neutral. Reads only `inbound.actorId`. No transport leakage. |
| `dispatchOutboundIntent_()` | Channel-aware contract. Accepts explicit `intent.channel`. Contract is right — once LEAK-1 is fixed, only minimal hardening should be required, not architectural change. |
| `ogDeliver_()` / `sendRouterSms_()` | Already branches WA vs SMS delivery. Adding Telegram is additive — new branch only. |
| `LIFECYCLE_ENGINE.gs` | Zero channel references in the entire file. `handleLifecycleSignal_()` is fully transport-agnostic. This is the standard the rest of the codebase should match. |
| `imageSignalAdapter_()` | Correct abstraction point. Needs to receive canonical `media[]` from adapter rather than reading Twilio fields itself. |
| `SCAP:` synthetic key pattern | Staff capture already uses synthetic phone keys. This is the exact model for Telegram actor keys (`TG:userId`). Precedent exists. |
| `ALEXA_ADAPTER.gs` | Working example of a non-SMS adapter feeding the shared brain. This demonstrates the additive adapter routing pattern, but it is not yet a fully channel-neutral template because its bridge still forces SMS semantics downstream. |
| `doPost()` routing architecture | Already branches: Portal → AppSheet → Alexa → Twilio. Adding Telegram is purely additive. |

---

## SECTION 5 — EXECUTION PLAN

> Five phases. Each is independently shippable and testable before the next begins. No big-bang rewrites.

---

### PHASE 0 — Harden `normalizeInboundEvent_()` Contract
**Duration:** 1 session | **Risk:** LOW | **Blocks:** Everything else

**Goal:** Make the canonical signal object the authoritative source of truth. Right now it's called but its output is thin and partially ignored.

**Tasks:**
1. Add `media: []` (array of `{url, contentType}`) as first-class field to `normalizeInboundEvent_()` output
2. Add `channel: 'sms'|'whatsapp'|'telegram'|'alexa'` as first-class field
3. Update the call site in `handleSmsSafe_()` to pass `media[]` from the already-extracted `mediaUrls` array
4. Update the call site to pass `channel` explicitly
5. No downstream changes yet — schema hardening only

**Output contract:**
```js
normalizeInboundEvent_(source, opts) returns:
{
  v: 1,
  source: string,           // 'twilio_sms' | 'twilio_wa' | 'telegram' | 'alexa'
  channel: string,          // 'sms' | 'whatsapp' | 'telegram' | 'alexa'
  actorType: string,
  actorId: string,          // E.164 phone | 'TG:userId' | 'SCAP:id'
  body: string,
  bodyTrim: string,
  bodyLower: string,
  media: [{ url, contentType }],   // NEW — first-class
  eventId: string,
  timestamp: Date,
  meta: {}                  // still available for adapter-specific extras
}
```

**Test:** Log inbound object after `normalizeInboundEvent_()` call. Verify `channel` and `media[]` are present and correct for both SMS and WA messages.

---

### PHASE 1 — Fix `globalThis.__inboundChannel` (LEAK-1)
**Duration:** 1–2 sessions | **Risk:** MEDIUM | **Blocks:** All new adapters

**Goal:** Eliminate transport-coupled global state. Channel flows explicitly from the normalized inbound object through the entire call chain.

**Tasks:**
1. After `normalizeInboundEvent_()` is called in `handleSmsSafe_()`, store `inbound.channel` in scoped variable `__scopeChannel`
2. Pass `__scopeChannel` into `routeToCoreSafe_()` as `opts.channel`
3. `routeToCoreSafe_()` sets `e.parameter._channel = opts.channel` before calling `handleSmsCore_()`
4. `handleSmsCore_()` reads `_channel` from `e.parameter`, passes it into every `dispatchOutboundIntent_()` call as `intent.channel`
5. In `OUTGATE.gs`: `ogDeliver_()` uses `intent.channel` directly; `globalThis` fallback becomes dead code
6. Keep `globalThis.__inboundChannel` set during Phase 1 for backward compat, but stop reading it in new code paths
7. Audit all ~40 `dispatchOutboundIntent_()` call sites in `PROPERA_MAIN.gs` — add `channel: _channel` to each

**Contract:** Every `dispatchOutboundIntent_()` call must have `intent.channel` set explicitly. No call relies on `globalThis` fallback.

**Test:** WA message → all outbound replies arrive on WA. SMS message → all replies on SMS. Set `globalThis.__inboundChannel` to wrong value — system still behaves correctly.

---

### PHASE 2 — Abstract Actor Identity for Non-Phone Channels (LEAK-2)
**Duration:** 1 session | **Risk:** LOW–MEDIUM | **Blocks:** Telegram adapter

**Goal:** `ConversationContext` and all context threading work with any actor key, not just E.164 phones.

**Tasks:**
1. Define actor key convention: phone channels use E.164 (unchanged), Telegram uses `'TG:' + userId`, future app uses `'APP:' + userId`
2. `normalizePhone_()` gets a sibling: `normalizeActorId_(raw, channel)` — returns E.164 for phone channels, prefixed ID for others
3. `ctxGet_()` and `ctxUpsert_()` appear structurally compatible with opaque actor keys, provided normalization and caller assumptions are updated consistently.
4. `ConversationContext` sheet: treat `PhoneE164` column as opaque `ActorKey` — lowest risk path
5. `isStaffSender_()` and `isManager_()` accept actor keys — Telegram staff get a Staff sheet row with `TG:`-format key
6. `isSmsOptedOut_()` accepts any actor key, not just E.164

**Contract:** `ctxGet_('TG:12345678')` works. Pending state survives multi-turn Telegram conversations.

**Test:** Simulate Telegram user with `TG:`-prefixed key sending two-message conversation. Confirm context threads correctly on second message.

---

### PHASE 3 — Build Telegram Adapter
**Duration:** 1–2 sessions | **Risk:** LOW (after Phases 0–2) | **Blocks:** Nothing — additive only

**Goal:** Wire Telegram webhooks into the shared brain. At this point the critical inbound/outbound path should no longer depend on Twilio-specific assumptions for channel, identity, or media.

**Tasks:**
1. Create `TELEGRAM_ADAPTER.gs`
2. Register Telegram webhook URL in `doPost()` routing block — additive, new branch only
3. Adapter: verify Telegram webhook secret, extract `message.text` / `message.photo` / `message.document`, extract `message.from.id` as actor ID
4. Build canonical opts, call `normalizeInboundEvent_('telegram', opts)` with `channel='telegram'`, `actorId='TG:'+userId`, `media=[]`
5. Call `decideLane_(inbound)` — unchanged
6. Call shared brain entry with inbound + channel threaded through
7. Add Telegram delivery branch to `ogDeliver_()` — Telegram Bot API `sendMessage` call
8. Add Telegram to outgate render (no compliance footer, can support richer formatting)

**Contract:** `TELEGRAM_ADAPTER.gs` touches zero brain logic. It only: authenticates, normalizes payload, emits canonical signal, delivers via Telegram Bot API.

**Test:** Send 'my sink is leaking' on Telegram from a known tenant. Ticket created. Reply sent via Telegram. Same ticket state as if sent via SMS.

---

### PHASE 4 — Lifecycle Engine Channel Threading + Timer Signals
**Duration:** 1 session | **Risk:** LOW | **Blocks:** Lifecycle correctness on non-SMS channels

**Goal:** Cron-fired lifecycle signals have no live request scope — no `globalThis.__inboundChannel`. Staff communications from timers must know which channel to use.

**Tasks:**
1. Store preferred channel per actor in `ConversationContext` or `Contacts` sheet (channel of last inbound message)
2. `lifecycleOutboundIntent_()` accepts a `channel` parameter — uses stored preference for timer-driven sends
3. `handleLifecycleTimers_()` resolves channel from work item actor's stored preference before emitting intent
4. `WorkItems` can store `assignedChannel` field — the channel the assigned staff member prefers
5. `LIFECYCLE_ENGINE.gs` remains channel-agnostic — only passes channel as a parameter, never reads `globalThis`

**Contract:** A staff member assigned on Telegram receives lifecycle pings via Telegram, not SMS, even when triggered by a cron timer with no live request context.

**Test:** Create ticket assigned to a Telegram staff actor. Fire timer. Confirm ping arrives via Telegram.

---

## SECTION 6 — THE ADAPTER CONTRACT

Any future adapter — Telegram, WhatsApp Business API, voice, app chat — must comply with this contract. Nothing more. Nothing less.

### Adapter MUST:
- ✅ Authenticate / verify the inbound request (Twilio signature, Telegram secret, etc.)
- ✅ Extract: actor identifier, message text, media attachments
- ✅ Build canonical opts for `normalizeInboundEvent_()`
- ✅ Call `normalizeInboundEvent_(source, opts)` with `channel` set explicitly
- ✅ Pass the result to `decideLane_(inbound)` then to the shared brain entry
- ✅ Register an outbound delivery function in the outgate for its channel
- ✅ Handle its own compliance/opt-out semantics (or map to the shared OptOuts store with actor keys)

### Adapter MUST NOT:
- ❌ Implement any routing logic, lane classification, or actor resolution
- ❌ Read or write `ConversationContext`, `WorkItems`, or `Sessions` directly
- ❌ Call `compileTurn_()`, `finalizeDraft_()`, or any domain brain function
- ❌ Set `globalThis.__inboundChannel` or any other global
- ❌ Implement opt-out handling (use the shared layer)
- ❌ Hard-code channel-specific behavior into the shared brain
- ❌ Know anything about tickets, properties, units, or tenants

---

## SECTION 7 — THE CHANNEL NEUTRALITY TEST

Run these exact scenarios. If all produce the same internal state and outbound reply text (not necessarily format), the system is channel-neutral.

| ID | Scenario | Input | Expected Outcome |
|---|---|---|---|
| T-1 | Tenant maintenance intake | Send 'my sink is leaking' from SMS / WA / Telegram. Same tenant, same unit. | Ticket created. Same category, same property, same outbound reply key. No cross-channel reply. |
| T-2 | Tenant multi-turn — pending continuation | Send partial intake. Wait for `pendingExpected`. Reply 'unit 403' on same channel. | Context threads correctly. `pendingExpected` cleared. Ticket progresses. |
| T-3 | Staff # command | Send '# Penn 403 done' from SMS / WA / Telegram staff actor. | Lifecycle transition fired. `STAFF_UPDATE_ACK` sent on same channel as inbound. WorkItem state updated. |
| T-4 | Staff non-# natural reply | Staff sends 'parts arrived, fixing tomorrow' without # prefix. | `staffHandleLifecycleCommand_()` detects and handles. Response on same channel. |
| T-5 | Image / media attachment | Send image (no text) from SMS / WA / Telegram. | `imageSignalAdapter_()` receives populated `media[]`. Synthetic body generated. Ticket flow proceeds. |
| T-6 | Opt-out across channels | Tenant opts out on SMS. Then sends message on WA. | Policy choice — but must be consistent and explicit, not accidental. |
| T-7 | Lifecycle timer ping — no live request | Ticket enters `WAIT_STAFF_UPDATE`. Timer fires. No active request scope. | Staff ping sent on their registered channel preference. No `globalThis` error. |

---

## SECTION 7.1 — NON-GOALS

This plan does NOT:
- redesign lifecycle policy
- rewrite `compileTurn_()` or domain engines
- migrate storage away from Sheets
- introduce a new universal messaging framework
- move business logic into adapters

Its purpose is only to remove transport leakage from the current signal boundary and outbound channel path.

---

## SECTION 8 — PROPERA CHANNEL DOCTRINE

> **No communication channel is allowed to own business logic. Channels only transport signals. The Propera brain owns interpretation, state, policy, and action.**

**Corollaries:**

1. If two inbound events carry the same operational meaning, Propera must produce the same internal decision regardless of transport.
2. Channel differences may affect normalization and rendering only — not operational interpretation or domain behavior.
3. Adding a new channel adapter should not require channel-specific changes to the brain, lifecycle engine, resolver, or policy engine.
4. A transport approval problem (e.g. Twilio A2P) is a distribution problem, not a brain problem. The brain must survive channel failures.

---

*Propera Channel Neutrality Audit · March 2026*
