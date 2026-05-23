# Outgate Voice Spec — propera-v2

**Status:** Approved decisions (2026-05-23). Block D (property branding) + language architecture locked.  
**Scope:** Tenant-facing maintenance SMS, WhatsApp, Telegram. Portal chat unchanged for now.  
**Not in scope:** GAS parity, broadcast comms engine. LLM outgate refinement is a **later phase** (see Language).

**North compass:** Brain owns facts; outgate owns expression. Adapters stay thin. All operational tenant sends go through `src/outgate/dispatchOutbound.js`.

---

## Architecture (v2)

```text
Inbound (any language)
  → Intake package (LLM when enabled): detect lang, semanticTextEnglish, issueHint EN
  → Brain (deterministic): tickets, urgency, slots — works in English facts
  → Outgate render: English canonical body from template + facts
  → localizeOutbound (target = tenant locale)   ← product; Phase 5
  → renderForChannel (SMS footer, TG markdown)  ← Phase 4
  → dispatchOutbound
```

**Language rule (product):**

| Layer | Language | Why |
|-------|----------|-----|
| **Intake / brain** | English facts | One resolver, one policy graph, one ticket model |
| **Outgate** | Tenant’s language | What the tenant reads on SMS / WA / TG |

Intake already surfaces `lang`, `langConfidence`, `semanticTextEnglish`, and `issueHint` via `compileTurn` / `properaBuildIntakePackage`. Outgate must receive **`tenantLocale`** (BCP-47 short, e.g. `en`, `es`, `pt`) on the outbound intent and persist it on the actor/session when confidence is high enough.

**Phase 1 ships English templates only** but threads `tenantLocale` through `facts` so localization is not a rewrite later.

**Test hook (today):** `runInboundPipeline()` → `r.coreRun.replyText`  
**Test hook (after channel render):** `{ channel, body, meta }` from render layer.  
**Test hook (after localization):** assert Spanish body when `tenantLocale: "es"` and `OUTGATE_LOCALIZE=1`.

**Replace:** Hardcoded `Ticket logged: {id} …` in `coreMaintenanceFastPath.js` and `coreMaintenanceMultiTurn.js`.

---

## Voice register

Professional but human — property staff who cares, not a corporate bot and not a friend texting.

| Tier | When | Register |
|------|------|----------|
| **Routine** | Default finalize | Warm opener allowed; confirm facts; set expectation |
| **Urgent** | Ticket urgency = urgent (non-emergency) | Drop casual opener; “prioritizing”; no fluff |
| **Emergency** | Ticket emergency = Yes | Formal; present tense; safety close; no casual opener |

Always echo **short cleaned issue phrase** (not raw tenant paste). Always show **ref/ticket id** on finalize receipts.

---

## Block A — Finalize receipt

### A1 — Lead line (ticket reference)

**Decision:** Ref-style lead.

```
Ref #{ticketId} — we're on it.
```

- `{ticketId}` = finalized ticket id (e.g. `PENN-052326-2930`).
- Do **not** use “Ticket logged” wording.

### A2 — Issue echo

**Decision:** Short cleaned phrase from classifier/intake, not full tenant message.

Examples: `heat not working`, `kitchen sink leak`, `door lock stuck`.

Source (v2): derive from draft `issueText` / issue atom / category label — trim, lowercase phrase for mid-sentence use, capitalize first letter when sentence-initial.

### A3 — Structure

**Decision:** Three lines for single-ticket routine/urgent finalize (before optional schedule block).

```text
Ref #PENN-052326-2930 — we're on it.
Heat not working confirmed for unit 410.
We'll be in touch shortly.
```

Line 2 pattern:

- **Unit:** `{Issue phrase} confirmed for unit {unit}.`
- **Common area (G2):** `{Issue phrase} confirmed for the {location_label}.` — see Common area below.

Line 3 expectation (routine): `We'll be in touch shortly.`

### A4 — Urgency tiers

**Decision:** Three tiers — routine / urgent / emergency — driven by ticket fields at finalize.

### A5 — Emergency

**Decision:** Open with emergency acknowledgment; differentiated copy, not routine minus schedule.

```text
We're treating this as an emergency.
Ref #PENN-052326-2930 — heat not working reported for unit 410. Someone is being contacted now.
Please stay safe.
```

Rules:

- Line 1: exactly `We're treating this as an emergency.`
- No “Got it”, no schedule ask in same turn.
- Shorter than routine; target one SMS segment when possible (F3).

### Urgent (non-emergency)

```text
Ref #PENN-052326-2930 — we're on it.
Noted — we're prioritizing the heat not working for unit 410.
Someone will be there as soon as possible.
```

---

## Block B — Multi-turn slot prompts

Used when draft incomplete or post-receipt schedule needed. Keys stay aligned with `buildMaintenancePrompt` / `maintenanceTemplateKeyForNext`.

### B1 — Missing unit (ladder)

**Decision:** Three attempts; track `askAttempt` on intake session or draft meta.

| Attempt | Copy |
|---------|------|
| 1 | Thanks for reaching out — what's your apartment number so we can get this sorted? |
| 2 | I still need your unit number to place this request. |
| 3 | Reply with just the unit number, for example: 410. |

If property known on attempt 1+, prefer contextual variant:

| Attempt | With property |
|---------|----------------|
| 1 | {display_name} — what unit are you in? |
| 2 | I still need your unit number for {display_name}. |
| 3 | Reply with just the unit number, for example: 410. |

Template key: `MAINTENANCE_UNIT`.

### B2 — Missing issue

**Decision:** Contextual when property + unit known.

```
{display_name}, unit {unit} — what issue are you having?
```

Fallback (no unit/property): `What issue are you having?`

Template key: `MAINTENANCE_ISSUE`.

### B3 — Schedule ask

**Decision:** Keep current copy.

```
When would be a good time for us to come by? Share a day and time window (example: tomorrow 9–11am).
```

Template key: `MAINTENANCE_SCHEDULE_ASK`.

### B4 — Receipt + schedule composition

**Decision:** One outbound send. Append schedule block **only if** the inbound message did not already contain a schedulable time hint.

- If time hint parsed on same turn → receipt only (or receipt + “Preferred time noted: …” when policy accepts).
- If no hint → receipt + `\n\n` + schedule ask (B3).
- Never two separate sends for receipt then schedule.

---

## Block C — Trivial / conversational

**Decision:** Router/core branch **before** draft slot prompts. Requires v2 precursor or core gate (not built today).

Detect using existing helpers in `issueParseDeterministic.js`: `looksLikeGreetingOnly_`, `looksLikeAckOnly_`, plus emoji-only heuristic.

| Situation | Intent | Copy |
|-----------|--------|------|
| Pure ack, no open ticket/draft | `TENANT_ACK_IDLE` | Anytime. Let us know if you need anything. |
| Pure ack, open ticket, no pending slot | `TENANT_ACK_OPEN_TICKET` | Got it — your request is still open. We'll keep you updated. |
| Pure greeting, no issue | `TENANT_GREETING` | Hi — how can we help? Describe the issue and your unit. |
| Emoji-only / `k` / `?` | `TENANT_TRIVIAL_CLARIFY` | Did you need something, or just checking in? |

Rules:

- No ticket created.
- No property menu on `thanks` / `ok` / `👍`.
- No “ticket” or internal ops language in trivial replies.
- Brief: target &lt; 80 chars where possible.

---

## Block D — Property / company branding

“Brand” = the **property or management company the tenant knows** (Vermela, The Grand at Penn, etc.) — **not** Propera product attribution.

| ID | Decision |
|----|----------|
| **D1** | Property name on **first contact only** (first outbound in a session/day to that tenant actor, same window as SMS compliance footer). |
| **D2** | Use **`properties.display_name`** from DB. |
| **D3** | See **Language architecture** below — not “English only”; brain English, outgate tenant locale. |

### First-contact property line

Prepended or appended once per session/day (same trigger as E2 footer), **before** compliance footer on SMS:

```text
The Grand at Penn — maintenance
```

Or inline opener on first receipt only:

```text
The Grand at Penn
Ref #PENN-052326-2930 — we're on it.
…
```

**Pick at implement time:** prefer **short header line** + blank line + body (keeps receipt template stable). Localize header via outgate locale (Phase 5).

**Rules:**

- Never “Powered by Propera” on tenant maintenance SMS/TG/WA.
- Repeat property name in slot prompts (B1/B2) when contextual — not only first contact.
- If `display_name` missing, fall back to `properties.code` or omit header.

---

## Language architecture (product)

### Inbound — any language → English for brain

When `INTAKE_LLM_ENABLED=1`, the intake package should:

1. Detect tenant language (`lang`, `langConfidence`).
2. Normalize operational meaning to **English** (`semanticTextEnglish`, English `issueHint` for receipts).
3. Pass English facts into merge/finalize/policy.

Deterministic-only path (`INTAKE_LLM_ENABLED=0`) stays English-centric; language detection may be weak — default `tenantLocale` to `en`.

### Outbound — English template → tenant language

1. **Render** canonical English body from facts + template key (`buildMaintenanceReceipt`, slot prompts, trivial intents).
2. **Localize** if `tenantLocale !== "en"` and confidence ≥ threshold (e.g. 0.7):
   - Input: English body + structured facts (ticket id, unit, issue phrase, tier).
   - Output: tenant-language SMS/TG text; preserve ticket id and unit numbers verbatim.
3. **Compliance footer** (SMS): localize STOP line per locale where campaign allows; legal text may stay English until counsel approves translations.

### Implementation phases

| Phase | Behavior |
|-------|----------|
| **1–4** | English render; pass `tenantLocale` on `OutboundIntent.facts` from compile turn / session |
| **5** | `localizeOutbound.js` — LLM or translation API behind `OUTGATE_LOCALIZE=1`; tests with `es` fixture |
| **Later** | `OUTBOUND_AGENT_REFINE` — tone polish *after* localize or on English only (TBD) |

### Facts contract (add to outbound intent)

```js
{
  tenantLocale: "es",           // BCP-47 short
  tenantLocaleConfidence: 0.92,
  issuePhraseEn: "heat not working",  // for localize + tests
  propertyDisplayName: "The Grand at Penn",
  isFirstContactToday: true,    // drives D1 header + E2 footer
}
```

### Tests

- **Phase 1:** English intent keys (unit, issue, Ref #, no “Ticket logged”).
- **Phase 5:** Same facts, `tenantLocale: "es"` → reply contains Spanish function words / no English “We'll be in touch” OR golden snapshot per locale file.

---

## Block E — SMS compliance

### E1 — Footer text (SMS maintenance number only)

```
Reply STOP to opt out. Msg & data rates may apply.
```

(Campaign wording — confirm against live A2P registration before send.)

### E2 — When to append

**Decision:** First outbound **per session/day** per tenant actor on SMS.

- Track last footer date (or session) in DB or conversation ctx — implementation TBD.
- Append after body, separated by blank line.
- Counts toward segment budget (F3).

### E3 — WhatsApp & Telegram

**Decision:** No TCPA-style compliance footer on WA or TG.

---

## Block F — Channel expression

Same **meaning** on all channels; **format** may differ at render.

| Channel | Decision |
|---------|----------|
| **SMS** | Plain text; compliance footer per E; **prefer 1 segment (~160 chars)**; allow 2+ only when content requires (emergency, multi-ticket, receipt + schedule) |
| **WhatsApp** | Same copy as SMS body (no footer); slightly longer OK if clarity needs it (F2) |
| **Telegram** | Markdown: bold ticket ref and emergency line where applicable (F1). Example: `Ref #PENN-052326-2930 — we're on it.` → `*Ref #PENN-052326-2930* — we're on it.` Emergency line 1 bold. |

Implementation: `renderForChannel({ channel, body, meta })` called from pipeline after `renderOutboundIntent`, before `dispatchOutbound`.

Portal: **unchanged** — HTTP JSON `core.reply` as today (G3).

---

## Block G — Edge cases

### G1 — Multi-ticket (one inbound, multiple finalize groups)

```text
Ref #PENN-001 — Heat not working, unit 410.
Ref #PENN-002 — Kitchen sink leak, unit 410.
Both are being handled. We'll be in touch shortly.
```

- One line per ticket: ref + cleaned issue phrase + unit/location.
- Closing line once.
- Urgency/emergency: apply tier rules to closing + emergency header if **any** ticket is emergency.

### G2 — Common area

Use ticket `location_type` when `COMMON_AREA` (or equivalent):

```text
… confirmed for the common area.
```

If a parsed location label exists (lobby, laundry, etc.), prefer:

```text
… confirmed for the lobby.
```

Fallback: `the common area`.

### G3 — Portal chat

No change in this phase. Same brain strings may appear in JSON; rich UI is app-layer.

---

## Intent → template key map (v2)

| Intent / situation | templateKey | Render owner |
|--------------------|-------------|--------------|
| Finalize receipt (routine) | `MAINTENANCE_RECEIPT_ROUTINE` | outgate render |
| Finalize receipt (urgent) | `MAINTENANCE_RECEIPT_URGENT` | outgate render |
| Finalize receipt (emergency) | `MAINTENANCE_RECEIPT_EMERGENCY` | outgate render |
| Finalize multi | `MAINTENANCE_RECEIPT_MULTI` | outgate render |
| Missing unit | `MAINTENANCE_UNIT` | slot ladder B1 |
| Missing issue | `MAINTENANCE_ISSUE` | slot B2 |
| Schedule ask | `MAINTENANCE_SCHEDULE_ASK` | slot B3 |
| Trivial ack idle | `TENANT_ACK_IDLE` | router/outgate |
| Trivial ack open ticket | `TENANT_ACK_OPEN_TICKET` | router/outgate |
| Greeting | `TENANT_GREETING` | router/outgate |
| Trivial clarify | `TENANT_TRIVIAL_CLARIFY` | router/outgate |

Legacy key `MAINTENANCE_RECEIPT_ONLY` → map to tier-specific keys above.

---

## Test contract (scenario assertions)

Assert on **intent keys**, not exact strings (except fixed emergency line 1).

### Routine fast path (`sink leaking 303 penn`)

```js
const reply = String(r.coreRun?.replyText || "");
assert.match(reply, /Ref #/i);
assert.match(reply, /303/);
assert.match(reply, /leak/i);
assert.match(reply, /We'll be in touch/i);
assert.doesNotMatch(reply, /Ticket logged/i);
assert.doesNotMatch(reply, /emergency/i);
```

### Emergency

```js
assert.match(reply, /We're treating this as an emergency/i);
assert.match(reply, /303/);
assert.doesNotMatch(reply, /When would be a good time/i);
assert.doesNotMatch(reply, /Got it/i);
```

### Trivial (`thanks!`) — after Block C implemented

```js
assert.equal(mem._state.tickets.length, 0);
assert.match(reply, /Anytime|still open/i);
assert.doesNotMatch(reply, /confirm your property/i);
assert.doesNotMatch(reply, /ticket|logged|Ref #/i);
```

### SMS footer — after Block E implemented

```js
// First message of day
assert.match(reply, /Reply STOP to opt out/i);
// Second message same day — no duplicate footer
```

### Segment budget (F3)

- Routine receipt **without** schedule: prefer `reply.length <= 160` when issue phrase is short.
- Document exceptions in test name when receipt + schedule or multi-ticket exceeds one segment.

File: `tests/scenarios/tenantOutgateVoice.test.js` (to add).

---

## Build phases

### Phase 1 — Receipt + issue echo (priority)

1. `src/outgate/buildMaintenanceReceipt.js` — facts in, body out (tiers, multi, common area).
2. Wire fast path + multi-turn finalize to call it instead of inline strings.
3. `tests/scenarios/tenantOutgateVoice.test.js` — routine + emergency + common area.
4. B4: schedule append only when no time hint on inbound.

**Files:** `coreMaintenanceFastPath.js`, `coreMaintenanceMultiTurn.js`, new outgate module, tests.

### Phase 2 — Slot ladders

1. `askAttempt` persistence on intake session.
2. B1 ladder + B2 contextual issue prompt in `buildMaintenancePrompt.js` or outgate slot renderer.

### Phase 3 — Trivial router

1. Precursor or core gate for C1–C4 before property menu.
2. Scenario tests for thanks / hi / emoji.

### Phase 4 — Channel render + SMS footer + property header

1. `renderForChannel.js` — TG markdown, SMS footer (E2), **property header (D1)** on first contact.
2. Wire in `runInboundPipeline.js` before `dispatchOutbound`.
3. Track `isFirstContactToday` per actor (same store as footer).
4. Footer + header tests.

### Phase 5 — Outbound localization (real product)

1. Persist `tenantLocale` from intake on `intake_sessions` or `conversation_ctx`.
2. `localizeOutbound({ bodyEn, facts, tenantLocale })` after English render.
3. Spanish (and next locales) golden tests; `OUTGATE_LOCALIZE=1` env gate.
4. Slot prompts + trivial intents included in localize map.

### Deferred

- Portal-specific copy / rich UI strings.
- `OUTBOUND_AGENT_REFINE` (tone polish — separate from translate).

---

## Decision log

| ID | Choice |
|----|--------|
| A1 | C — `Ref #{id} — we're on it.` |
| A2 | B — short cleaned issue phrase |
| A3 | A — three-line structure |
| A4 | A — routine / urgent / emergency |
| A5 | B — `We're treating this as an emergency.` |
| B1 | D — unit ask ladder |
| B2 | A — `{Property}, unit {unit} — what issue…` |
| B3 | A — keep current schedule ask |
| B4 | C — one send; schedule only if no time hint on inbound |
| C1 | A — `Anytime. Let us know if you need anything.` |
| C2 | A — open-ticket context ack |
| C3 | A — hi + describe issue and unit |
| C4 | C — clarify once for emoji/ambiguous short |
| D1 | First contact only — property header from `display_name` |
| D2 | `properties.display_name` |
| D3 | Brain English; outgate tenant locale (Phase 5 localize) |
| E1 | A — full STOP + rates footer |
| E2 | B — first outbound per session/day (SMS) |
| E3 | A — no footer on WA/TG |
| F1 | B — TG markdown bold ref + emergency |
| F2 | B — WA same meaning, length OK when needed |
| F3 | Prefer 1 SMS segment; exceed only when necessary |
| G1 | A — multi-line multi-ref format |
| G2 | C — common area / location_type label |
| G3 | Portal unchanged |

---

## Related docs

- `docs/TESTING_STRATEGY.md` — outgate golden tests (section F).
- `docs/BRAIN_PORT_MAP.md` — inbound → outgate path.
- `src/outgate/renderOutboundIntent.js` — current passthrough render.
