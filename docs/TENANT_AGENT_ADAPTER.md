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
Router must not branch on “came from agent” for policy. Optional `_portalChannel: tenant_agent` is metadata only.

**Outbound:** only **`src/outgate/dispatchOutbound.js`** sends user-facing messages. The agent module calls it; it must not import Twilio/Telegram senders directly.

**Do not modify** for agent-specific behavior:

- `src/brain/core/handleInboundCore.js` (except allowlisting `tenant_agent` as structured portal channel — see §5)
- lifecycle / policy modules
- finalize or ticket DAL semantics

---

## 3) `tenant_conversations` table schema

**Migration:** `supabase/migrations/062_tenant_conversations.sql` (planned — not applied until implementation PR).

One active conversation per **tenant actor + channel** (or per `conversation_id` if you prefer explicit UUID primary key).

```sql
-- tenant_conversations — AI Staff conversation state (adapter-owned)
create table if not exists public.tenant_conversations (
  id uuid primary key default gen_random_uuid(),

  -- Canonical tenant identity (E.164 for SMS/WA; TG:… or linked phone for Telegram)
  tenant_actor_key text not null,

  -- sms | whatsapp | telegram
  transport_channel text not null default 'sms',

  -- gathering | handoff_pending | handoff_done | closed | escalated
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

---

## 5) Handoff `RouterParameter` shape (portal JSON)

Handoff reuses **structured portal create** so core skips NL slot machine (`buildStructuredPortalCreateDraft`).

Build via `buildHandoffRouterParameterFromAgent()` in `src/adapters/tenantAgent/` (planned), mirroring `buildRouterParameterFromPortal` output but preserving **real transport channel** (`sms` / `telegram` / `whatsapp`), not `_channel: PORTAL`.

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
  "preferredWindow": "Friday 9am–12pm",
  "tenant_locale": "en",
  "conversation_id": "uuid-from-tenant_conversations.id"
}
```

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

**Env (planned):** add to `.env.example` when implemented.

```bash
# Master switch — default off
TENANT_AGENT_ENABLED=0

# LLM for conversation turns (requires OPENAI_API_KEY)
TENANT_AGENT_LLM_ENABLED=0

# Optional: comma-separated property codes pilot (empty = all properties when master on)
TENANT_AGENT_PROPERTY_ALLOWLIST=

# Max conversation turns before escalation (override table default)
TENANT_AGENT_MAX_TURNS=12
```

Read flags in `src/config/env.js`; do not read `process.env` in adapter ad hoc.

| Flag | `0` / unset | `1` |
|------|-------------|-----|
| `TENANT_AGENT_ENABLED` | **Legacy path only** — current slot machine + Phase 1 outgate receipts | Tenant maintenance on SMS/TG/WA routes through agent adapter when eligible |
| `TENANT_AGENT_LLM_ENABLED` | Deterministic scripted prompts (Sprint 1 skeleton) | LLM conversation turns |
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
   - Stop agent loop until staff clears conversation or TTL expires (e.g. 24h → `closed`)

Reset `turn_count` when `status` transitions to `handoff_done` and tenant starts a **new** issue (“anything else?” flow) — implementation may create a new conversation row or reset row on explicit new-issue intent.

---

## 9) Post-handoff reply shaping

After brain success:

1. Read `coreRun.finalize`, `coreRun.replyText`, `coreRun.outgate.templateKey`
2. Prefer **`buildMaintenanceReceipt`** facts for English canonical body (see `OUTGATE_VOICE_SPEC.md`)
3. Agent LLM may rephrase **only** from a JSON fact bundle `{ ticketId, issuePhrase, unit, propertyDisplayName, preferredWindow, tier }`
4. Send via `dispatchOutbound` (channel render / localize per outgate phases)

While `gathering`, agent replies do **not** go through maintenance receipt templates — conversational prompts only.

---

## 10) Adapter implementation checklist

Create files under **`src/adapters/tenantAgent/`** only:

| File | Role |
|------|------|
| `runTenantAgentTurn.js` | Entry: load conversation, route gather vs handoff |
| `conversationStore.js` | CRUD `tenant_conversations` |
| `completeness.js` | Rule-based ready-for-brain |
| `buildHandoffRouterParameter.js` | §5 shape |
| `shapeBrainReply.js` | Facts → tenant message |
| `systemPrompt.js` | Voice + “never decide” constraints |
| `deterministicPrompts.js` | Fallback questions when LLM off |

Wire in **`src/inbound/runInboundPipeline.js`** (or `routeInboundDecision.js`):

- After precursors, before `handleInboundCore`
- Feature flag + eligibility check
- Pass `traceId`, `transportChannel`, `routerParameter`, `staffContext`

Add migration **`062_tenant_conversations.sql`**.

Extend **`isTenantPortalStructuredCreate`** for `tenant_agent` channel.

Do **not** add Twilio/Telegram imports outside `dispatchOutbound`.

---

## 11) Parity gates before merge

### New tests (agent on)

- `tests/tenantAgent/completeness.test.js`
- `tests/tenantAgent/buildHandoffRouterParameter.test.js`
- `tests/scenarios/tenantAgentHandoff.test.js` — mock LLM / scripted turns → one ticket

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

**CI rule:** `TENANT_AGENT_ENABLED` is unset or `0` in all existing scenario files (same pattern as `INTAKE_LLM_ENABLED=0`). Agent scenarios set `TENANT_AGENT_ENABLED=1` in-file only.

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

- [ ] `tenant_conversations` migration applied
- [ ] `TENANT_AGENT_ENABLED=0` → byte-identical behavior to pre-agent tenant path (regression tests green)
- [ ] `TENANT_AGENT_ENABLED=1` → multi-turn gather → one structured handoff → one ticket
- [ ] Agent never sends ticket id not returned by brain
- [ ] LLM failure → deterministic fallback (no crash, no silent drop)
- [ ] Max-turn escalation message sent; no infinite loop
- [ ] All sends via `dispatchOutbound`
- [ ] Ledger + handoff docs reflect truth

---

## 14) Sprint map (implementation order)

| Sprint | Deliverable |
|--------|-------------|
| **1** | Table + flag + deterministic gather script + handoff + Phase 1 receipt reply |
| **2** | LLM conversation + completeness + voice prompt |
| **3** | Brain-aware shape reply + channel render hooks + pilot allowlist |

See `./OUTGATE_VOICE_SPEC.md` for expression phases (footer, localize) — agent consumes those seams, does not fork them.
