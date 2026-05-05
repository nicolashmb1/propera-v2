# Brain port map — GAS → V2 (Node)

**New agent / “continue V2”:** read **[../AGENTS.md](../AGENTS.md)** first (mandatory doc list + freeze + commands).
**Adding a channel:** follow **[ADAPTER_ONBOARDING.md](./ADAPTER_ONBOARDING.md)** (adapter-only boundary, canonical contracts, media bridge).

**Direction:** Port the real Propera brain incrementally. No parallel “preview” logic. Node/Postgres is the destination; GAS/Sheets remains backup/reference until cutover.

**Authoritative rule:** behavioral logic is **ported from GAS**, not rewritten — see **[PORTING_FROM_GAS.md](./PORTING_FROM_GAS.md)** (unit, address-vs-unit, schedule when wired, stages, etc.).

**Parity truth (flow vs semantics, gaps, risk):** **[PARITY_LEDGER.md](./PARITY_LEDGER.md)** — must be updated when V2 behavior changes; do not claim “complete” without checking this ledger.

## Handoff status (for the next agent)

**Latest session notes:** **[HANDOFF_LOG.md](./HANDOFF_LOG.md)** (dated blocks — ops dashboard, `event_log` expansion, `.env` path, intake flags).

| Phase | Status |
|-------|--------|
| **PHASE 1–2** Map + canonical `RouterParameter` contract | **Done** — see builder + `InboundSignal` |
| **PHASE 3** First real slice (precursors only) | **Done** — `src/brain/router/*`, `src/contracts/buildRouterParameterFromTelegram.js` |
| **PHASE 4** Tests | **Done** — `npm test` (router, parse draft, staff brain, `ticketDefaults`) |
| **PHASE 5** Next slices | **In progress** — maintenance + staff slices are live; **orchestrator** explicit in **`src/inbound/routeInboundDecision.js`** + **`docs/ORCHESTRATOR_ROUTING.md`** (core guards, vendor/system **lane stubs**). **Outgate:** `src/outgate/` — `dispatchOutbound` only place for user-facing sends; compliance **MessageSpecs** + maintenance template keys on **`coreRun.outgate`**. Staff lifecycle partial; schedule commit runs **`parsePreferredWindowShared`**, **`inferStageDayFromText_`**, **`validateSchedPolicy_`** (`ticketPreferredWindow.js`). **Remaining:** full GAS canonical intake, full lifecycle graph, template map — **PARITY_LEDGER.md** §7. |

**Migration plan (canonical in repo):** [PROPERA_V2_GAS_EXIT_PLAN.md](./PROPERA_V2_GAS_EXIT_PLAN.md) (YAML todos + phases).

**Keep docs current:** When you change behavior, update **this file**, **[PROPERA_V2_GAS_EXIT_PLAN.md](./PROPERA_V2_GAS_EXIT_PLAN.md)** (todos + narrative), and **[OUTSIDE_CURSOR.md](./OUTSIDE_CURSOR.md)** if operators must run new SQL or env steps. See *Documentation discipline* at the bottom.

### Portal: preventive / program runs (separate from inbound brain)

**Not** part of `runInboundPipeline` / `handleInboundCore`. Owner-portal HTTP on the same Express app:

| Piece | Location |
|-------|----------|
| Expansion (pure) | `src/pm/expandProgramLines.js` |
| DAL (create, list, detail, preview, delete, line PATCH) | `src/dal/programRuns.js` |
| Routes | `src/portal/registerPortalRoutes.js` — `GET/POST /api/portal/program-templates`, `GET/POST /api/portal/program-runs`, `POST /api/portal/program-runs/preview`, `GET/DELETE /api/portal/program-runs/:id`, `PATCH .../program-lines/:id/complete` & `reopen` |

**Canonical spec + UI contract:** **[PM_PROGRAM_ENGINE_V1.md](./PM_PROGRAM_ENGINE_V1.md)**. **Per-property building data:** `properties.program_expansion_profile` (migration **019**). **Roadmap** (tenant/staff/ops reuse of that structure): same doc, **Strategic reuse — building structure beyond preventive**.

---

## PHASE 1 — Current vs target flow

### V2 inbound — Telegram **and** Twilio (same pipeline)

1. **HTTP** — `src/index.js`: `POST /webhooks/telegram` **or** `POST /webhooks/twilio` / `/webhooks/sms`
2. **Adapter** — Telegram: `verifyTelegramWebhookSecret`, `normalizeTelegramUpdate`, optional `enrichTelegramMediaWithOcr` → `buildRouterParameterFromTelegram`. Twilio: `buildRouterParameterFromTwilio` (form body).
3. **`runInboundPipeline`** — `src/inbound/runInboundPipeline.js` (shared):
   - `upsertTelegramChatLink` (Telegram only)
   - `resolveStaffContextFromRouterParameter` — staff roster match on real phone **or** `telegram_chat_link` bridge from `TG:…` (channel-agnostic identity; no duplicate `TG:` `contacts` row required when link row carries `phone_e164`)
   - `evaluateRouterPrecursor` → `normalizeInboundEventFromRouterParameter`
   - **`buildLaneDecision`** — `src/inbound/routeInboundDecision.js` (staff capture / staff gate **or** `decideLane`)
   - Staff lifecycle / SMS compliance / opt-out suppress / **non-maintenance lane stub** (vendor/system) / **`handleInboundCore`**
   - **Outgate:** `renderOutboundIntent` → **`dispatchOutbound`** → `telegramSendMessage` **or** `twilioSendMessage` (transport only; **no** direct sends from core)
4. **Ops:** `GET /dashboard`, `GET /api/ops/event-log` — `src/dashboard/` (not GAS)

**Routing truth:** **[ORCHESTRATOR_ROUTING.md](./ORCHESTRATOR_ROUTING.md)**.

### Current V2 core slice (honest scope)

- **Flow (partial):** **`recomputeDraftExpected`** — pre-ticket slice (see ledger). **`intake_sessions`** + merge (includes **`issue_buf_json`** persistence + deterministic **attach classify** gates). **Unit:** GAS **`extractUnit_`** port — `extractUnitGas.js`. **`handleInboundCore`**: prompts + fast path via **`parseMaintenanceDraft`** / async compile when enabled. **Deterministic issue clauses:** GAS **`parseIssueDeterministic_`** port — `src/brain/gas/issueParseDeterministic.js`, wired through **`properaBuildIntakePackage`** (fallback signal shape matches GAS `properaFallbackStructuredSignalFromDeterministicParse_`). Events: **`EXPECT_RECOMPUTED`**, **`TURN_SUMMARY`**, **`TICKET_CREATED_ASK_SCHEDULE`**, **`ATTACH_CLARIFY_REQUIRED`**, **`INTAKE_START_NEW`**, etc.
- **Semantics (gaps):** full GAS **`compileTurn_`** graph + vision/CIG/media queue, full property directory variants vs **`detectPropertyFromBody_`**, full **`handleInboundRouter_`** graph (incl. full **`ATTACH_CLARIFY`** lifecycle) — see **[PARITY_LEDGER.md](./PARITY_LEDGER.md)**. Schedule parse + **`validateSchedPolicy_`** + `inferStageDayFromText_` are ported on the ticket schedule commit path; **`property_policy`** must match GAS PropertyPolicy for identical decisions.

### GAS Telegram → brain (reference)

1. `telegramWebhook_` — `02_TELEGRAM_ADAPTER.gs` (enqueue; optional drain)
2. `processTelegramQueue_` — `02_TELEGRAM_ADAPTER.gs` (~300+)
3. Builds `syntheticE` with `parameter` matching Twilio-shaped router input — lines **462–476**
4. `handleInboundRouter_(syntheticE)` — `16_ROUTER_ENGINE.gs` from **215**

### Target: same `parameter` contract → same precursor decisions

V2 must build **`e.parameter` equivalent** before any router logic. Source of truth for Telegram: **`02_TELEGRAM_ADAPTER.gs`** `syntheticE.parameter`.

---

## PHASE 2 — Canonical inbound contract (`RouterParameter`)

Shape matches the object under `e.parameter` that `handleInboundRouter_` reads (`16_ROUTER_ENGINE.gs` ~216).

| Field | Role | Telegram source (GAS) |
|--------|------|------------------------|
| `From` | Actor id | `TG:` + Telegram user id |
| `Body` | Message text | `msg.text` / `caption` |
| `_channel` | `TELEGRAM` / `SMS` / `WA` | `"TELEGRAM"` |
| `_phoneE164` | Router “actor key” | Same as GAS: `TG:` + user id (not always E.164) |
| `_telegramChatId` | Reply target | `msg.chat.id` |
| `_telegramUpdateId` | Dedupe | `update_id` |
| `_mediaJson` | Media bridge payload | JSON string array (`[]` when absent); parsed channel-agnostically in router/core; adapters may enrich `ocr_text` before core |

**Builder:** `src/contracts/buildRouterParameterFromTelegram.js`  
**Canonical signal (cross-channel):** `src/signal/inboundSignal.js` — adapters normalize; contracts map to `RouterParameter`.

---

## PHASE 3 — First real slice (implemented)

| GAS module | Function | V2 file |
|------------|----------|---------|
| `15_GATEWAY_WEBHOOK.gs` | `normMsg_` (1014–1016) | `src/brain/router/normMsg.js` |
| `15_GATEWAY_WEBHOOK.gs` | `complianceIntent_` (1027–1077) | `src/brain/router/complianceIntent.js` |
| `16_ROUTER_ENGINE.gs` | `detectTenantCommand_` (47–73) | `src/brain/router/detectTenantCommand.js` |
| `16_ROUTER_ENGINE.gs` | `handleInboundRouter_` precursor chain (ordering only) | `src/brain/router/evaluateRouterPrecursor.js` |

**Partially ported:** `decideLane` / `normalizeInboundEvent` — see `src/brain/router/`. **Orchestrator:** `routeInboundDecision.js` encodes core entry guards + vendor/system lane stubs (**20-B/C**). **Core path:** `handleInboundCore` performs real DB writes when configured. **SMS opt-out:** migration **011** + `smsOptOut.js` + pipeline (SMS **only**). **Still missing vs GAS:** full lifecycle state machine, full canonical intake/vision, full `handleInboundRouter_` depth — see **PARITY_LEDGER.md**.

**Staff:** DB-backed staff resolution + `STAFF_LIFECYCLE_GATE`; `handleStaffLifecycleCommand` — full GAS `handleLifecycleSignal_` parity ongoing (**PARITY_LEDGER** §6).

**Outgate:** Phase 1 — `src/outgate/` (intent → render → `dispatchOutbound`); not full **19_OUTGATE.gs** template map.

---

## PHASE 4 — Testing

- `tests/routerPrecursor.test.js` — precursors + related router tests.
- `tests/ticketDefaults.test.js` — `localCategoryFromText`, `inferEmergency`, ticket id shape.
- Run: `npm test` (includes `recomputeDraftExpected`, `mergeMaintenanceDraft`, **`extractUnitGas`** tests)

---

## PHASE 5 — Next slices (order)

1. **Router / orchestrator:** ~~precursor chain~~ done; ~~explicit route graph~~ **`routeInboundDecision.js`** + **ORCHESTRATOR_ROUTING.md**. **Remainder:** deeper `handleInboundRouter_` parity (vendor/amenity engines, weak-issue branches — **PARITY_LEDGER** §5).
2. **Core:** `compileTurn` / `properaBuildIntakePackage` (**INTAKE_COMPILE_TURN=1**) + canonical merge gaps; **attach** — see ledger.
3. **Lifecycle / policy:** explicit transition graph vs GAS **12_LIFECYCLE_ENGINE**; `property_policy` already feeds **`validateSchedPolicy_`**.
4. **Outgate:** expand **MessageSpec** / template map vs **19_OUTGATE.gs**; optional Agent-2 refinement (flag — not implemented).

---

## Rules (recap)

- No Telegram-only fake state machines.
- No bridging the **new** bot to GAS as the primary brain.
- Stubs only at **I/O seams** (e.g. “SMS storage not ported”), not as business rules.
- **No substitute rules** for brain behavior: if the product should ask for a schedule window, that must flow from **compileTurn / lifecycle / policy** (same as GAS), not a new `if` in the adapter.

---

## Documentation discipline

After meaningful changes to V2 behavior — or when **conversation direction / scope / freeze stance** changes — update in the same PR or follow-up commit. Details: **[../AGENTS.md](../AGENTS.md)** (“You must update these docs”).

| Doc | When |
|-----|------|
| **AGENTS.md** | Freeze lifted, priority shift, or any change to **mandatory agent instructions** / “current stance.” |
| **PARITY_LEDGER.md** | **Always** when porting, stubbing, or changing brain semantics vs GAS (flow vs semantic parity). |
| **BRAIN_PORT_MAP.md** (this file) | Router, core, DAL, or test layout changes; handoff table. |
| **PROPERA_V2_GAS_EXIT_PLAN.md** | Phase/todo status, scope, or migration strategy shifts. |
| **OUTSIDE_CURSOR.md** | New SQL migrations operators must run, or new env vars for hosted setup. |
| **STRUCTURED_LOGS.md** | New `log_kind` / `event` vocabulary, `event_log` shape, or observability parity vs GAS log sheet. |
| **ORCHESTRATOR_ROUTING.md** | Inbound order, core blockers, or lane-stub behavior changes. |
| **PORTING_FROM_GAS.md** | Which GAS file owns each behavior; **no parallel rewrites** of stage/parse/policy rules. |
| **ADAPTER_ONBOARDING.md** | New channel implementation checklist (adapter/contract/tests/docs) with channel-agnostic core constraints. |
| **TESTING_STRATEGY.md** | Scenario / integration tests; **staged implementation** (tests when the corresponding brain slice has a stable boundary). |
| **README.md** (propera-v2) | New scripts (`npm run dev`), ports, first-run steps, or **portal surfaces** (e.g. program-run API). |
| **PM_PROGRAM_ENGINE_V1.md** | Portal **preventive / program runs** behavior, expansion rules, **`program_expansion_profile`**, strategic reuse of building structure. |
