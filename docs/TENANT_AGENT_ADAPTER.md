# Tenant Agent Adapter (AI Staff — conversational front door)

Use this when implementing the **tenant-facing conversation adapter** that gathers context through natural dialogue, then hands a **structured package** to the existing brain — same as portal structured `create_ticket`, not a new finalize path.

**Non-negotiable rule:** the Tenant Agent Adapter is **transport + expression + conversation state only**.  
It does **not** create tickets, set urgency, enforce schedule policy, or write lifecycle truth. The **brain** does that after handoff.

**Related (do not duplicate):**

- `./ADAPTER_ONBOARDING.md` — channel adapter boundary (this doc extends it for conversational ingress)
- `./OUTGATE_VOICE_SPEC.md` — tenant voice, receipts, localization (agent expression layer)
- `./ORCHESTRATOR_ROUTING.md` — pipeline order; agent sits **before** core on eligible tenant traffic
- `./BRAIN_PORT_MAP.md` — `runInboundPipeline` → `handleInboundCore`
- `../src/brain/core/portalStructuredCreateDraft.js` — structured handoff target today
- `../src/contracts/buildRouterParameterFromPortal.js` — reference for portal `RouterParameter` shape

If any of these conflict with a proposed change, stop and keep guardrails.

---

## Implementation snapshot (2026-05-24 — code reality)

**Status:** Sprints **1–3** and §15 **Phases 4–6** are **implemented in repo**. **Phase 7** (`request_staff_update`) deferred. Default CI keeps **`TENANT_AGENT_ENABLED=0`**.

| Area | Shipped | Not yet |
|------|---------|---------|
| Gather + structured `create_ticket` handoff | ✅ deterministic + LLM (`tenantAgentLlmTurn.js`) | — |
| Post-create receipt shaping | ✅ `shapeBrainReply.js`, `tenantAgentChannelRender.js` | Outgate localize (English only) |
| 48h conversation TTL | ✅ `conversationExpiry.js` + Phase 6 lookup on expiry | — |
| Post-complete clarify | ✅ `postCompleteTurn.js`, natural-language same/new (no 1/2 menu) | — |
| Append to open ticket | ✅ `append_to_ticket` → `handleTenantAppendToTicket.js` → `tenantTicketAppend.js` | Portal timeline / `changed_by_*` on append |
| Same/new LLM | ✅ **LLM first** when `TENANT_AGENT_LLM_ENABLED=1`; receives `pending_follow_up`; returns `append_note` | — |
| Append message to brain | ✅ `resolveAppendHandoffContent.js` — pending substance, **not** `"yep same"` | — |
| Schedule after receipt | ✅ `deferToCoreSchedule.js` skips agent when brain `expected === SCHEDULE` | Full post-complete schedule scenario test |
| Pilot allowlist | ✅ `propertyAllowlist.js` | — |
| `find_related_ticket` after 48h | ✅ `findRelatedTenantTickets.js`, `handleTenantFindRelatedTicket.js`, `applyFindRelatedLookupResult.js` | Phase 7 staff ETA |
| Maintenance-only lane | ✅ `classifyNonMaintenanceRequest.js`, `handleNonMaintenanceDeflect.js` | Access / lease portal links (Phase 8+) |

**Brain handlers (tenant-agent operations):**

| Operation | Code |
|-----------|------|
| `create_ticket` | Structured portal path — `buildHandoffRouterParameter.js` → `handleInboundCore` |
| `append_to_ticket` | `buildAppendHandoffRouterParameter.js` → `tryHandleTenantAppendToTicket` in `coreMaintenanceLoadContext.js` |
| `supply_schedule` | Agent defers; core `intake_sessions` SCHEDULE path (unchanged) |
| `find_related_ticket` | `findRelatedTenantTickets.js` → `tryHandleTenantFindRelatedTicket` |

**Migration:** `063_tenant_conversations.sql` is **in repo** — operators must **apply in Supabase** before pilot (`docs/OUTSIDE_CURSOR.md`).

---

## 1) Read before coding

1. `../AGENTS.md`
2. `./PARITY_LEDGER.md`
3. `./PORTING_FROM_GAS.md`
4. `./BRAIN_PORT_MAP.md`
5. `../../propera-gas-reference/PROPERA_GUARDRAILS.md`
6. `./OUTGATE_VOICE_SPEC.md`

**North compass:** Signal → Adapter → Router → Brain → Outgate.  
The Tenant Agent is **an adapter**. Brain, resolver, lifecycle, and policy stay unchanged.

---

## 2) Required contract (must match existing flow)

### What the adapter owns

| Concern | Owner |
|---------|--------|
| Multi-turn conversation history | Tenant Agent (`tenant_conversations`) |
| Questions / tone / channel formatting | Tenant Agent (LLM expression) |
| Completeness (“ready for brain?”) | Tenant Agent rules + optional LLM hint |
| Structured handoff package | Tenant Agent → `RouterParameter` |
| Ticket create, urgency, policy | **Brain** (`handleInboundCore` → finalize) |
| Post-handoff operational truth | **Brain** + DAL |
| SMS/TG/WA send | **Outgate** (`dispatchOutbound` only) |

### Pipeline when agent is active

```text
SMS / Telegram / WhatsApp webhook
  → channel normalize (existing)
  → runInboundPipeline
       → precursors / compliance / staff gates (unchanged)
       → if TENANT_AGENT_ENABLED + eligible tenant maintenance:
            Tenant Agent turn (LLM conversation OR gather)
            if not ready: dispatchOutbound(agent reply); return
            if ready: build handoff RouterParameter → same pipeline core path
       → else: existing handleInboundCore slot machine / fast path
  → core result → Tenant Agent shapes reply (facts from coreRun only)
  → dispatchOutbound
```

**Core invariant:** handoff calls the **same** `runInboundPipeline` / `handleInboundCore` entry as today.  
Router must not branch on transport (`tenant_agent` vs portal vs SMS). Optional `_portalChannel: tenant_agent` is metadata only. **Post-create behavior** is declared in payload `postCreate.scheduleMode` (see §5).

**Outbound:** only **`src/outgate/dispatchOutbound.js`** sends user-facing messages. The agent module calls it; it must not import Twilio/Telegram senders directly.

**Do not modify** for agent-specific behavior:

- `src/brain/core/handleInboundCore.js` (except allowlisting `tenant_agent` as structured portal channel — see §5)
- lifecycle / policy modules
- finalize or ticket DAL semantics

---

## 3) `tenant_conversations` table schema

**Migration:** `supabase/migrations/063_tenant_conversations.sql` — **in repo**; apply in Supabase before enabling agent in prod (see **`docs/OUTSIDE_CURSOR.md`**).

One active conversation per **tenant actor + channel** (or per `conversation_id` if you prefer explicit UUID primary key).

```sql
-- tenant_conversations — AI Staff conversation state (adapter-owned)
create table if not exists public.tenant_conversations (
  id uuid primary key default gen_random_uuid(),

  -- Canonical tenant identity (E.164 for SMS/WA; TG:… or linked phone for Telegram)
  tenant_actor_key text not null,

  -- sms | whatsapp | telegram
  transport_channel text not null default 'sms',

  -- gathering | handoff_pending | handoff_done | complete | same_or_new_pending | closed | escalated
  status text not null default 'gathering',

  -- Partial package built across turns (property, unit, issue, preferredWindow, lang, …)
  partial_package jsonb not null default '{}'::jsonb,

  -- [{ "role": "user"|"assistant", "content": "...", "at": "ISO8601" }]
  messages jsonb not null default '[]'::jsonb,

  -- Last successful brain handoff snapshot (ticketId, ticketKey, workItemId, …)
  last_brain_result jsonb,

  -- BCP-47 short (en, es, pt) — from intake detect or tenant message
  tenant_locale text not null default 'en',
  tenant_locale_confidence numeric(4,3),

  -- Turn budget / escalation
  turn_count int not null default 0,
  max_turns int not null default 12,

  -- Idempotency: one finalize per conversation handoff
  handoff_trace_id text,
  handoff_at timestamptz,

  -- Optional link after create
  active_ticket_key text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_actor_key, transport_channel)
);

create index if not exists tenant_conversations_status_idx
  on public.tenant_conversations (status, updated_at desc);

comment on table public.tenant_conversations is
  'Tenant Agent adapter: conversation history + partial package; not brain session slots (intake_sessions).';
```

### Field notes

| Column | Purpose |
|--------|---------|
| `partial_package` | Merged slots agent believes it has; rules in §6 decide completeness |
| `messages` | LLM context window; cap length in application (e.g. last 20 turns) |
| `last_brain_result` | Structured copy of `coreRun.finalize` + receipt facts for “anything else?” |
| `status` | `handoff_done` keeps thread open for follow-up; `closed` ends agent loop |
| `intake_sessions` | **Unchanged** — used when `TENANT_AGENT_ENABLED=0` (legacy slot machine) |

---

## 4) Handoff completeness (minimum package)

Before firing the brain, **rules** (not LLM alone) must pass:

| Field | Required | Rule |
|-------|----------|------|
| `property` | Yes | Resolves to known `properties.code` |
| `issue` / `message` | Yes | `length >= 2` after trim |
| `unit` | Yes* | Required when `location_kind` is `unit` (default) |
| `location_kind` | No | `unit` (default) \| `common_area` \| `property` |
| `preferredWindow` | No | Enrichment; brain may skip schedule ask if present |
| `tenant_locale` | No | For outgate Phase 5 localize |

\*Common area: `unit` empty; `location_label_snapshot` optional (lobby, mail room).

LLM may **propose** `handoff_ready: true`; adapter **confirms** with `completenessCheck(partial_package)` before brain call.

**LLM gather guard (2026-05-24):** While slots are incomplete, outbound text uses **`resolveGatherReply`** → deterministic **`promptForMissingField`**. Required before handoff: **property, unit, issue, schedule** (`preferredWindow`). **No roster auto-fill** — ask explicitly. Transport identity (`TG:…` or E.164) passes through handoff → brain → `tenant_phone_e164` on ticket.

---

## 5) Handoff `RouterParameter` shape (portal JSON)

Handoff reuses **structured portal create** so core skips NL slot machine (`buildStructuredPortalCreateDraft`).

Build via `buildHandoffRouterParameterFromAgent()` in `src/adapters/tenantAgent/buildHandoffRouterParameter.js`, mirroring `buildRouterParameterFromPortal` output but preserving **real transport channel** (`sms` / `telegram` / `whatsapp`), not `_channel: PORTAL`.

### `_portalPayloadJson` (canonical)

```json
{
  "action": "create_ticket",
  "channel": "tenant_agent",
  "actor_type": "TENANT",
  "property": "PENN",
  "property_code": "PENN",
  "unit": "410",
  "unit_label": "410",
  "location_kind": "unit",
  "message": "Heat not working since yesterday",
  "description": "Heat not working since yesterday",
  "category": "HVAC",
  "preferredWindow": null,
  "postCreate": { "scheduleMode": "ASK_OPTIONAL" },
  "tenant_locale": "en",
  "conversation_id": "uuid-from-tenant_conversations.id"
}
```

**`postCreate.scheduleMode`** — operational intent after ticket exists (not channel identity):

| Mode | Who sends | Brain behavior after finalize |
|------|-----------|-------------------------------|
| `NONE` | PM portal / tenant_portal (default when omitted) | Receipt only; no tenant schedule interview |
| `ASK_OPTIONAL` | Tenant agent handoff | Receipt + optional schedule ask when issue is schedulable and no `preferredWindow` |

Contract module: `src/contracts/postCreateContract.js`. Brain reads `postCreate` from `_portalPayloadJson`; it does **not** ask “who sent this?”.

**Category:** adapter sets `category` via `resolveHandoffCategory()` (`localCategoryFromText(issue)`) so structured create does not default to General.

When `intake_sessions.expected === 'SCHEDULE'` (post-receipt follow-up), pipeline **defers** to core (`deferToCoreSchedule.js`) so schedule policy stays in the brain.

Common area example:

```json
{
  "action": "create_ticket",
  "channel": "tenant_agent",
  "actor_type": "TENANT",
  "property": "PENN",
  "location_kind": "common_area",
  "location_label_snapshot": "lobby",
  "unit": "",
  "message": "Light broken in lobby"
}
```

### Full `RouterParameter` (handoff turn)

```javascript
{
  From: "+15551234001",              // tenant E.164 (or canonical actor)
  Body: "noop",                      // structured path — same as tenant_portal create
  _phoneE164: "+15551234001",
  _canonicalBrainActorKey: "+15551234001",
  _channel: "SMS",                   // or TELEGRAM / WHATSAPP — real transport
  _mediaJson: "",                    // or populated if tenant sent photo this turn
  _portalAction: "create_ticket",
  _portalChannel: "tenant_agent",
  _portalActorType: "TENANT",
  _portalPayloadJson: "<stringified JSON above>",
  _tenantAgentConversationId: "<uuid>",   // adapter metadata (optional, for logs)
  _tenantAgentHandoffTraceId: "<traceId>",
}
```

**Implementation note:** extend `isTenantPortalStructuredCreate()` in `handleInboundCoreScheduleHints.js` to treat `channel === "tenant_agent"` like `tenant_portal` so TENANT mode uses structured draft without `#` staff syntax.

Reference tests: `tests/portalStructuredCreateDraft.test.js`, `tests/scenarios/portalCreateTicketStructured.test.js`.

---

## 6) `TENANT_AGENT_ENABLED` flag behavior

**Env:** documented in **`propera-v2/.env.example`** (read via `src/config/env.js`).

```bash
# Master switch — default off
TENANT_AGENT_ENABLED=0

# LLM for conversation turns (requires OPENAI_API_KEY)
TENANT_AGENT_LLM_ENABLED=0

# Optional: comma-separated property codes pilot (empty = all properties when master on)
TENANT_AGENT_PROPERTY_ALLOWLIST=

# Max conversation turns before escalation (override table default)
TENANT_AGENT_MAX_TURNS=12
# Lazy delete tenant_conversations after N hours idle (default 48; 0 = off)
TENANT_AGENT_CONVERSATION_TTL_HOURS=48
```

Read flags in `src/config/env.js`; do not read `process.env` in adapter ad hoc.

| Flag | `0` / unset | `1` |
|------|-------------|-----|
| `TENANT_AGENT_ENABLED` | **Legacy path only** — current slot machine + Phase 1 outgate receipts | Tenant maintenance on SMS/TG/WA routes through agent adapter when eligible |
| `TENANT_AGENT_LLM_ENABLED` | Deterministic scripted gather prompts | LLM gather turns **and** same/new classify (**LLM first** on `same_or_new_pending` when key present) |
| `TENANT_AGENT_PROPERTY_ALLOWLIST` | N/A | If non-empty, only listed property codes use agent after property known |

### Eligibility (all must hold for agent path)

1. `TENANT_AGENT_ENABLED=1`
2. `CORE_ENABLED=1` and DB configured
3. Transport is `sms`, `whatsapp`, or `telegram`
4. Not staff (`resolveStaffContext` → not staff)
5. Not compliance-only turn (STOP/START/HELP handled first)
6. Not `#` staff capture, portal mutation, or staff lifecycle command
7. Lane is maintenance (not vendor/system stub)
8. Property allowlist passes (if set)

### What never uses the agent (flag ignored)

- Staff `#` capture and staff lifecycle
- Portal PM mutations / `portal_chat` command bar
- Vendor / system lane stubs
- Lifecycle cron / internal jobs
- Broadcast comms engine (separate number — see `COMMUNICATION_ENGINE.md`)

---

## 7) Fallback rules (LLM failure and safety)

When the agent cannot complete a turn reliably, **fall back** — never leave tenant silent.

| Condition | Behavior |
|-----------|----------|
| `TENANT_AGENT_ENABLED=0` | Skip agent entirely; existing `handleInboundCore` path |
| `TENANT_AGENT_LLM_ENABLED=0` | Use deterministic question script from `partial_package` gaps |
| OpenAI / LLM timeout or 5xx | Log `TENANT_AGENT_LLM_FAILED`; reply: short deterministic prompt for next missing field; **do not** hand off |
| LLM returns invalid JSON / empty | Same as timeout; increment `turn_count` |
| Handoff package fails `buildStructuredPortalCreateDraft` | Reply: “I need a bit more detail…” + ask failing field; stay `gathering` |
| Brain returns `core_finalize_failed` | Agent reply: apologetic + ask tenant to retry or call office; log trace; **do not** invent ticket id |
| Brain returns success | Agent reply uses **only** `coreRun.finalize`, `buildMaintenanceReceipt` facts, or LLM shape constrained to those fields |
| Duplicate handoff same conversation | Idempotent: if `handoff_trace_id` set and ticket exists, resend last receipt summary; do not second finalize |

**Hard rule:** ticket id, urgency, schedule policy outcomes, and emergency classification come **only** from brain/DAL outputs — never from LLM free text.

Optional env:

```bash
# After fallback, force legacy slot machine for this actor (session flag or short TTL)
TENANT_AGENT_FALLBACK_TO_LEGACY=1
```

When `TENANT_AGENT_FALLBACK_TO_LEGACY=1` and LLM fails twice consecutively, clear `tenant_conversations` row and process **next** message on legacy `intake_sessions` path.

---

## 8) Max-turn escalation

Default **`max_turns = 12`** (configurable via `TENANT_AGENT_MAX_TURNS`).

On each inbound message while `status = gathering`:

1. Increment `turn_count`
2. If `turn_count > max_turns`:
   - Set `status = escalated`
   - Append `event_log`: `TENANT_AGENT_ESCALATED` with `tenant_actor_key`, `conversation_id`, `turn_count`
   - Reply (deterministic):

     ```text
     I want to make sure we get this right — a team member will follow up with you shortly.
     If this is an emergency, please call 911.
     ```

   - Do **not** call brain with partial package unless emergency keywords detected → then optional **emergency fast handoff** with best-effort package + flag `emergency_forced: true` in payload metadata (implementation choice; document in PARITY_LEDGER when built)
   - Stop agent loop until staff clears conversation or TTL expires (default **48h** — `TENANT_AGENT_CONVERSATION_TTL_HOURS`; lazy delete + `TENANT_AGENT_CONVERSATION_EXPIRED` in `event_log`)

Reset `turn_count` when `status` transitions to `handoff_done` and tenant starts a **new** issue (“anything else?” flow) — implementation may create a new conversation row or reset row on explicit new-issue intent.

---

## 9) Post-handoff reply shaping

After brain success:

1. Read `coreRun.finalize`, `coreRun.replyText`, `coreRun.outgate.templateKey`
2. Prefer **`buildMaintenanceReceipt`** facts for English canonical body (see `OUTGATE_VOICE_SPEC.md`)
3. Agent LLM may rephrase **only** from a JSON fact bundle `{ ticketId, issuePhrase, unit, propertyDisplayName, preferredWindow, tier }`
4. Send via `dispatchOutbound` (channel render / localize per outgate phases)

While `gathering`, agent replies do **not** go through maintenance receipt templates — conversational prompts only.

**Follow-up after complete (photo, “still leaking”, etc.):** see **§15** — clarify before append; no media-only auto-attach; after 48h use `find_related_ticket`, not conversation memory alone.

---

## 10) Adapter implementation checklist

**Implemented** under **`src/adapters/tenantAgent/`**:

| File | Role |
|------|------|
| `runTenantAgentTurn.js` | Entry: load conversation, gather vs handoff vs post-complete |
| `conversationStore.js` | CRUD `tenant_conversations` |
| `conversationExpiry.js` | 48h lazy TTL + `TENANT_AGENT_CONVERSATION_EXPIRED` |
| `conversationStatus.js` | `complete` / `handoff_done` detection |
| `completeness.js` | Rule-based ready-for-brain |
| `buildHandoffRouterParameter.js` | §5 `create_ticket` shape |
| `buildAppendHandoffRouterParameter.js` | `append_to_ticket` handoff |
| `resolveAppendHandoffContent.js` | Pending substance → brain note (strip confirm phrases) |
| `postCompleteTurn.js` | Post-receipt clarify + append/new routing |
| `classifyPostCompleteFollowUp.js` | Pre-clarify intent (ack / new / ask same-new) |
| `sameOrNewClarify.js` | Conversational prompts + `resolveSameOrNewReply` |
| `sameOrNewLlmClassify.js` | LLM same/new + `append_note` when LLM enabled |
| `deferToCoreSchedule.js` | Skip agent when brain expects SCHEDULE |
| `shapeBrainReply.js` | Facts → tenant message after finalize/append |
| `extractBrainReceiptFacts.js` | Receipt facts from `coreRun` only |
| `tenantAgentChannelRender.js` | Channel-specific render hooks |
| `tenantAgentLlmTurn.js` | LLM gather turn |
| `mergePartialFromLlm.js` / `mergePartialFromInbound.js` | Slot merge |
| `systemPrompt.js` | Gather voice + JSON contract |
| `deterministicPrompts.js` | Fallback when LLM off |
| `postHandoffReply.js` / `gatherGreetingReply.js` | Thanks ack; greeting-only turns |
| `propertyAllowlist.js` | Pilot property gate |
| `resolveHandoffCategory.js` | Category on structured handoff |
| `eligibility.js` | Agent path eligibility |
| `extractAttachmentUrls.js` | Media URLs for append package |

**Brain (append only):** `src/brain/core/handleTenantAppendToTicket.js`, `src/dal/tenantTicketAppend.js`, `src/contracts/portalOperation.js`.

Wired in **`src/inbound/runInboundPipeline.js`** after lane stub, before `handleInboundCore`.

---

## 11) Parity gates before merge

### Agent tests (when `TENANT_AGENT_ENABLED=1` in-file)

| File | Covers |
|------|--------|
| `tests/tenantAgent/*.test.js` | Unit: completeness, handoff/append params, same/new, append content, defer schedule, shape reply, … |
| `tests/scenarios/tenantAgentHandoff.test.js` | Gather → handoff → ticket + optional schedule |
| `tests/scenarios/tenantAgentPostCompletePhase4.test.js` | Post-complete clarify, append, photo-only, natural confirm |
| `tests/scenarios/tenantAgentConversationTtl.test.js` | 48h expiry → fresh gather |
| `tests/scenarios/tenantAgentLlmGather.test.js` | LLM gather (mock) |
| `tests/scenarios/tenantAgentSprint3.test.js` | Shape reply + allowlist |
| `tests/scenarios/tenantAgentGoldenPipeline.test.js` | Golden messages (deterministic agent) |
| `tests/postCreateContract.test.js` | `postCreate.scheduleMode` |

### Existing tests that **must still pass** when `TENANT_AGENT_ENABLED=0`

Default `npm test` runs with agent **off**. These are the regression shield for legacy tenant path:

| Test file | Why |
|-----------|-----|
| `tests/scenarios/tenantOutgateVoice.test.js` | Phase 1 receipt voice |
| `tests/scenarios/tenantFastPath.test.js` | Single-message finalize |
| `tests/scenarios/tenantEmergency.test.js` | Emergency receipt + no schedule |
| `tests/scenarios/tenantCommonArea.test.js` | Common area finalize |
| `tests/scenarios/tenantMaintenanceInMemory.test.js` | Multi-turn slot machine + schedule capture |
| `tests/scenarios/tenantScheduleReplyAfterReceipt.test.js` | Post-receipt schedule |
| `tests/scenarios/tenantAttachClarify.test.js` | Attach clarify flow |
| `tests/scenarios/startNewMidDraft.test.js` | Start new mid-draft |
| `tests/scenarios/multiIssueSplit.test.js` | Multi-ticket finalize |
| `tests/buildMaintenanceReceipt.test.js` | Receipt builder unit tests |
| `tests/portalStructuredCreateDraft.test.js` | Handoff target shape |
| `tests/postCreateContract.test.js` | `postCreate.scheduleMode` contract |
| `tests/scenarios/portalCreateTicketStructured.test.js` | Structured create E2E |
| `tests/scenarios/portalCreateTicketCommonArea.test.js` | Portal common area |
| `tests/handleInboundCoreScheduleHints.test.js` | Structured create detection |
| `tests/outgatePhase1.test.js` | Outgate seam |

Staff paths (must remain unaffected):

| `tests/scenarios/staffCaptureFastPath.test.js` |
| `tests/scenarios/staffCaptureMultiTurn.test.js` |
| `tests/scenarios/staffCaptureNoSchedulePrompt.test.js` |
| `tests/scenarios/portalPortalChatStaffCapture.test.js` |
| `tests/scenarios/portalPortalChatAudioStaffCapture.test.js` |

**CI rule:** `TENANT_AGENT_ENABLED` is unset or `0` in all existing scenario files (same pattern as `INTAKE_LLM_ENABLED=0`). Agent scenarios set `TENANT_AGENT_ENABLED=1` in-file only. `npm test` includes `tests/tenantAgent/*.test.js` and `tests/postCreateContract.test.js`.

Full `npm test` pass required. Update **`docs/PARITY_LEDGER.md`** with agent row (PARTIAL until pilot proven).

---

## 12) Docs you must update in same PR

- `docs/PARITY_LEDGER.md` (agent adapter status + fallback behavior)
- `docs/BRAIN_PORT_MAP.md` (pipeline diagram with agent branch)
- `docs/ORCHESTRATOR_ROUTING.md` (eligibility + ordering)
- `docs/HANDOFF_LOG.md` (dated entry)
- `.env.example` (`TENANT_AGENT_*` vars)
- `docs/OUTSIDE_CURSOR.md` (migration 062 apply steps if any)
- `README.md` (flag mention only if operator-facing)

Rule: stale docs are a bug.

---

## 13) Definition of done (Tenant Agent pilot)

Code-complete for **pilot slice** (one property, SMS/TG/WA). Operator must still apply migration **063**.

- [x] `063_tenant_conversations.sql` **in repo** (operator applies in Supabase — see `OUTSIDE_CURSOR.md`)
- [x] `TENANT_AGENT_ENABLED=0` → legacy tenant path (default `npm test`; agent scenarios opt in)
- [x] `TENANT_AGENT_ENABLED=1` → multi-turn gather → structured handoff → one ticket (scenario tests)
- [x] Post-complete within 48h: clarify → natural confirm → `append_to_ticket` with **pending substance**, not confirm text
- [x] Agent never sends ticket id not returned by brain (`shapeBrainReply` / receipt facts)
- [x] LLM failure → deterministic fallback (`TENANT_AGENT_LLM_FAILED`, scripted prompts; optional legacy handoff via `TENANT_AGENT_FALLBACK_TO_LEGACY`)
- [x] Max-turn escalation message + `TENANT_AGENT_ESCALATED` event
- [x] All user-facing sends via `dispatchOutbound` (pipeline outgate seam)
- [x] **`find_related_ticket` after 48h** (Phase 6 — brain lookup before fresh gather)
- [ ] Append visible in portal Activity / audit (`changed_by_*`, timeline) — **not wired**
- [ ] Production pilot sign-off on one property (`TENANT_AGENT_PROPERTY_ALLOWLIST`)

---

## 14) Sprint map (implementation order)

| Sprint / Phase | Deliverable | Status |
|----------------|-------------|--------|
| **1** | Table + flag + deterministic gather + handoff + receipt reply | **Done** |
| **2** | LLM gather + completeness + voice prompt | **Done** |
| **3** | Shape reply + channel render + pilot allowlist | **Done** |
| **§15 Phase 4** | Post-complete clarify (`same_or_new_pending`, natural language) | **Done** |
| **§15 Phase 5** | `append_to_ticket` brain contract + media | **Done (minimal)** |
| **§15 Phase 6** | `find_related_ticket` after 48h TTL | **Done** |
| **§15 Phase 7** | Staff update / ETA (`request_staff_update`) | **Deferred** |

See `./OUTGATE_VOICE_SPEC.md` for expression phases (footer, localize) — agent consumes those seams, does not fork them.

---

## 15) Post-handoff follow-up — clarification authority

**Status:** **Phases 4–6 shipped in repo.** After TTL expiry, substantive messages run **`find_related_ticket`** before blind gather. **Phase 7** (`request_staff_update`) deferred.

### Doctrine (non-negotiable)

> **Tenant-agent active context is a clarification aid, not routing authority.** Within the 48-hour context window, ambiguous follow-ups must be clarified before append or new intake. **Media-only follow-ups are never auto-attached.** After 48 hours, conversation context expires and the next tenant message is treated as fresh intake **for chat memory** — but operational ticket history does not expire; the agent must query the brain for open/recent tickets before assuming a new issue.

> **48-hour memory clears the chat thread, not the ticket relationship.** The agent must not write tickets, attach media, close tickets, or escalate lifecycle. It may ask clarifying questions and send **structured operation packages** to the brain only after tenant confirmation or high-confidence rules. If confidence is low, **always ask the tenant to clarify.**

This is **agent clarification authority**, not agent routing authority.

### Two kinds of memory

| Kind | What it is | TTL | Used for |
|------|------------|-----|----------|
| **Conversation memory** | `tenant_conversations` row: `messages`, `partial_package`, adapter `status` | **48h** idle (`TENANT_AGENT_CONVERSATION_TTL_HOURS`) → row deleted + `TENANT_AGENT_CONVERSATION_EXPIRED` in `event_log` | Gather UX, same/new clarify latch, schedule_pending |
| **Operational memory** | Tickets, work items, assignment, schedule, timeline in brain/DAL | Does **not** expire with chat | Status answers, `find_related_ticket`, append validation |

After 48h the agent must **not** say “I remember we were talking about the sink.” It **may** ask the brain: “Does this tenant have an open sink ticket?”

### Normal flow (unchanged — Sprint 1–3)

```text
1. gathering        — agent collects property / unit / issue / schedule (+ media in package)
2. handoff_sent     — structured create_ticket → brain
3. brain            — ticket created; optional schedule ask (postCreate ASK_OPTIONAL)
4. schedule_pending — tenant may reply with window (core SCHEDULE; agent defers)
5. complete         — receipt + schedule done or skipped; active_ticket_key stored
```

Within 48h after `complete`, follow-ups use **§15** rules — not a blind new gather.

### Conversation states (target)

| `status` | Meaning |
|----------|---------|
| `gathering` | Building intake package |
| `handoff_pending` | Package sent; awaiting brain result |
| `handoff_done` / **`complete`** | Ticket exists; optional schedule may still be pending in **brain** `intake_sessions` |
| **`schedule_pending`** | Adapter mirror: brain waiting on SCHEDULE (agent defers to core) |
| **`same_or_new_pending`** | Asked “existing request or new issue?”; awaiting natural-language confirmation |
| **`expired`** | (logical) no row — next message is fresh adapter state |

`active_ticket_key` remains the adapter latch for “last ticket from this thread” **within 48h**. After expiry, do not trust it for attach — use **`find_related_ticket`** (brain).

### Structured operations (agent → brain)

Agent sends **operation intent** in `_portalPayloadJson` (or dedicated contract module). Core must **not** branch on `tenant_agent` channel; it branches on `operation`.

| Operation | When | Brain owns |
|-----------|------|------------|
| `create_ticket` | New intake package complete | Finalize, category, emergency, lifecycle |
| `supply_schedule` | Schedule text while brain `expected === SCHEDULE` | Policy, `preferred_window` |
| `append_to_ticket` | Tenant confirmed same request (or brain returned strong match + confirm) | Ownership, open status, `attachmentsAdd`, note append |
| `find_related_ticket` | After 48h or ambiguous follow-up without latch | Match scoring, ticket list, `allowedOperations` |
| `ack_only` | Thanks / OK | Nothing |
| *(future)* `request_staff_update` | Assigned, no schedule, tenant asks for update | Staff ping, ETA workflow — **not Phase 4–6** |

**Phase 4–6 scope:** `create_ticket` ✅ · `supply_schedule` ✅ (defer) · `append_to_ticket` ✅ · `find_related_ticket` ✅ · clarification UX ✅ (adapter).

### Post-complete decision table (within 48h)

| Situation | Agent action | Brain called? |
|-----------|--------------|---------------|
| “Thanks” / “Awesome thanks” | `ack_only` | No |
| Schedule-looking text while brain expects SCHEDULE | Defer → core schedule | Yes (schedule) |
| **Photo only** | **Ask:** same request or new issue? → `same_or_new_pending` | **No** until confirmed |
| “Here is the photo of the sink” | **Ask** same/new (low confidence) | No until confirmed |
| “Still leaking from the same sink” | **Ask** or append only if rules allow **high** confidence; default **ask** | After confirm → `append_to_ticket` |
| “New issue, bedroom door broken” | New `gathering` → `create_ticket` when complete | Yes (create) |
| “Also my bedroom door is broken” | **Ask** same/new | No until clarified |
| Tenant replies **same** / confirms existing (natural language) | `append_to_ticket` package (+ media) | Yes |
| Tenant replies **new** / different issue (natural language) | Reset gather → `create_ticket` when complete | Yes (create) |
| Context **> 48h** | No `tenant_conversations` row → **`find_related_ticket`** first | Query, then branch |

**Rule:** Media-only is **never** enough to auto-attach. Mold photo after sink ticket must not silently attach to sink.

**Append message rule:** When tenant confirms same request (`yep same`, `same one`, `yes same issue`), brain receives **`append_to_ticket`** with the **pending follow-up substance** (prior message/photo), **not** the confirmation phrase. LLM (when enabled) classifies confirm vs new and may return `append_note`; adapter merges pending + stripped detail before handoff.

### After 48h — lookup before new intake

```text
Tenant: "My sink is still leaking"
  → extract issue hints (category, symptom, unit if known)
  → find_related_ticket (brain/DAL — not raw adapter DB writes)
  → 0 matches     → fresh gathering → create_ticket
  → 1 strong match → surface status (assignee, schedule) + ask to add note if needed → append_to_ticket
  → multiple/weak  → ask tenant which request they mean
```

**Example (strong match):** Brain returns ticket assigned to Nick, tomorrow afternoon → agent: “I found your open sink request. It’s assigned to Nick and scheduled for tomorrow afternoon. I’ll add that it’s still leaking.” → `append_to_ticket`.

**Example (assigned, no schedule):** “Assigned to Jeff; I don’t see a scheduled time yet. I’ll ask for an update.” → Phase 7+ (`request_staff_update`); Phase 6 only documents extension point.

**Example (no match):** Normal gather: “What’s going on with the sink?”

### `find_related_ticket` package (sketch)

**Agent → brain (query):**

```json
{
  "operation": "find_related_ticket",
  "actor": { "type": "TENANT", "phone_e164": "+15551234001" },
  "hints": {
    "issueText": "sink is still leaking",
    "categoryHint": "Plumbing",
    "unitHint": "410",
    "property_code": "PENN"
  }
}
```

**Brain → agent (response facts for expression only):**

```json
{
  "matchStatus": "single_strong_match",
  "ticket": {
    "ticket_key": "...",
    "ticket_id": "PENN-042626-1234",
    "status": "OPEN",
    "assigned_name": "Nick",
    "preferred_window": "Tomorrow afternoon"
  },
  "allowedOperations": ["append_to_ticket", "supply_schedule"]
}
```

Agent **never** invents assignee or schedule; only speaks facts returned.

### `append_to_ticket` package (sketch)

```json
{
  "operation": "append_to_ticket",
  "ticket_key": "<uuid>",
  "message": "Tenant reports sink still leaking.",
  "attachmentUrls": ["https://..."],
  "postAppend": { "scheduleMode": "NONE" }
}
```

Brain validates: tenant ownership, ticket open, append permissions. Reuse portal `attachmentsAdd` / mutation path where possible — **no new finalize path**.

### Implementation phases

| Phase | Scope | Deliverables | Tests (minimum) |
|-------|--------|--------------|-----------------|
| **4** | **Clarification routing** (within 48h) | States `complete`, `same_or_new_pending`; conversational clarify; LLM-first same/new when enabled; `resolveAppendHandoffContent` | **done** — `postCompleteTurn.js`, `sameOrNewClarify.js`, `sameOrNewLlmClassify.js`, `resolveAppendHandoffContent.js` |
| **5** | **`append_to_ticket` brain contract** | Payload + `handleTenantAppendToTicket` + `tenantTicketAppend` DAL | **done (minimal)** — no portal timeline on append yet |
| **6** | **`find_related_ticket` after 48h** | Brain/DAL scoring + adapter branch after TTL | **done** — `findRelatedTenantTickets.js`, `handleTenantFindRelatedTicket.js`, `applyFindRelatedLookupResult.js` |
| **7** *(future)* | **Staff update / ETA** | `request_staff_update`, assignee ping, staff reply → schedule | Out of scope until 4–6 stable |
| **8a** | **Maintenance-only lane** | Non-maintenance → staff contact deflect (no ticket) | **done** — `classifyNonMaintenanceRequest.js`, `handleNonMaintenanceDeflect.js`, `resolvePropertyStaffContact.js` |
| **8b** *(future)* | **Access / amenity SMS** | Gameroom reserve via Access Engine inbound | Not started |
| **8c** *(future)* | **Lease / docs links** | Tenant portal deep link in deflect reply | Not started |

**Maintenance-only lane (8a — shipped):** Lease copies, amenity booking, building FAQ, abuse/non-ops → polite deflect + property **SUPER** / **PM** phone (fallback `COMM_MAIN_NUMBER_DISPLAY`). Conversation `status: closed`. **No ticket.** Later phases replace deflect with real routing (Access reserve, portal link) per domain.

**Stop rule for each PR:** one phase per PR; PATCH format; no channel spaghetti in `coreMaintenanceFastPath`; no lifecycle changes unless required for append validation.

### Architecture constraints (all phases)

- Agent: clarification UX + package build **after** confirm or high-confidence rule.
- Agent: **no** direct ticket writes, **no** lifecycle, **no** staff SMS from agent.
- Brain/DAL: match scoring, ownership, status, append, schedule policy.
- Reuse `intakeAttachClassify` / `ATTACH_CLARIFY` **ideas** in adapter; do not duplicate policy in LLM prompts alone.
- `deferToCoreSchedule` remains for `schedule_pending` (brain `expected === SCHEDULE`).

### Extension point (document only — Phase 7)

When brain reports open ticket, assigned, **no** `preferred_window`, and tenant asks for update:

```text
agent (expression) → brain: request_staff_update (future)
brain → staff notification → staff reply → schedule commit → tenant message
```

Do not implement in Phase 4–6.

### Phase 4–5 test checklist (implemented)

1. Photo-only after `complete` → same/new question; **no** append until confirm — ✅ `tenantAgentPostCompletePhase4.test.js`
2. “Here is the sink photo” → ask before brain — ✅
3. Confirm same (e.g. `yep same`) → `append_to_ticket` with **pending** body/media, not confirm text — ✅
4. Confirm new → `gathering`, no append — ✅
5. “New issue my bedroom door is broken” → new intake without same/new ask — ✅
6. “Also my bedroom door is broken” → same/new ask — ✅ unit `classifyPostCompleteFollowUp.test.js`
7. After 48h TTL + problem signal → `find_related_ticket` before gather — ✅ `tenantAgentFindRelatedPhase6.test.js`, `tenantAgentConversationTtl.test.js`
8. “Thanks” after `complete` → `ack_only` — ✅ `tenantAgentHandoff.test.js`
9. Schedule reply while brain expects SCHEDULE → core schedule — ✅ `deferToCoreSchedule.test.js` (unit); full pipeline scenario **TODO**

### Related code (current)

| Area | Implementation |
|------|----------------|
| `postCompleteTurn.js` | Post-complete router: ack, new intake, same/new, append handoff |
| `postHandoffReply.js` | Thanks ack; chitchat detection |
| `active_ticket_key` | Stored after finalize/append; Ref # in clarify prompt; **not** used for auto-attach |
| `conversationExpiry.js` | 48h delete row + event log |
| `deferToCoreSchedule.js` | SCHEDULE → skip agent → core |
| `resolveAppendHandoffContent.js` | Brain append message from pending + stripped reply |
| Core `ATTACH_CLARIFY` | Pre-ticket intake only (legacy path); post-complete uses adapter §15 |

### Docs to update when each phase ships

- This section (status checkboxes)
- `PARITY_LEDGER.md` — agent row + `find_related_ticket` / `append_to_ticket`
- `HANDOFF_LOG.md` — dated entry per phase
- `ORCHESTRATOR_ROUTING.md` — operations table
- `BRAIN_PORT_MAP.md` — brain handlers for new operations
