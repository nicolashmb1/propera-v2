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
| **PHASE 5** Next slices | **In progress** — see **Current V2 core slice** below. Staff lifecycle partial; **post-finalize schedule** turns run **`parseMaintenanceDraftAsync`** before merge, and merge now accepts async `parsedDraft` from compile/intake path. `_mediaJson` channel-agnostic bridge is wired (adapter → router → core text merge), but OCR/vision extraction itself is still pending. **Next:** deepen compile-driven slot semantics and finish full GAS property grounding (`_variants` / explicit-only resolution) per **PARITY_LEDGER.md** §7; full lifecycle/policy vs GAS; schedule/outgate follow **engine truth**. |

**Migration plan (canonical in repo):** [PROPERA_V2_GAS_EXIT_PLAN.md](./PROPERA_V2_GAS_EXIT_PLAN.md) (YAML todos + phases).

**Keep docs current:** When you change behavior, update **this file**, **[PROPERA_V2_GAS_EXIT_PLAN.md](./PROPERA_V2_GAS_EXIT_PLAN.md)** (todos + narrative), and **[OUTSIDE_CURSOR.md](./OUTSIDE_CURSOR.md)** if operators must run new SQL or env steps. See *Documentation discipline* at the bottom.

---

## PHASE 1 — Current vs target flow

### V2 Telegram inbound (today)

1. `POST /webhooks/telegram` — `src/index.js`
2. `verifyTelegramWebhookSecret` — `src/adapters/telegram/verifyWebhookSecret.js`
3. `normalizeTelegramUpdate` — `src/adapters/telegram/normalizeTelegramUpdate.js` → `InboundSignal`
4. `upsertTelegramChatLink` — `src/identity/upsertTelegramChatLink.js`
5. `resolveStaffContextFromRouterParameter` — `src/identity/resolveStaffContext.js` (GAS `isStaffSender_` + Telegram `staffActorKey` / chat fallback)
6. ~~`processInboundSignalStub`~~ → **precursor evaluation** + logging
7. **Lane + core (when enabled):** `decideLane` → **`handleInboundCore`** — maintenance draft parse (`parseMaintenanceDraft`) → if complete, **`finalizeMaintenanceDraft`** → `tickets` + `work_items` + `conversation_ctx` (requires DB: migration **006** for `tickets` columns; **008** or **004** for `properties.legacy_property_id`; see `src/dal/finalizeMaintenance.js`, **`supabase/migrations/README.md`**).
8. Optional `sendTelegramMessage` — `src/outbound/telegramSendMessage.js` (transport only)
9. **Ops:** `GET /dashboard`, `GET /api/ops/event-log` — `src/dashboard/registerDashboard.js` + `dashboardPage.html` + `eventLogApi.js` (not GAS; flight recorder UI)

### Current V2 core slice (honest scope)

- **Flow (partial):** **`recomputeDraftExpected`** — pre-ticket slice (see ledger). **`intake_sessions`** + merge. **Unit:** GAS **`extractUnit_`** port — `extractUnitGas.js`. **`handleInboundCore`**: prompts + fast path via **`parseMaintenanceDraft`** (not full **`compileTurn_`**). Events: **`EXPECT_RECOMPUTED`**, **`TURN_SUMMARY`**, **`TICKET_CREATED_ASK_SCHEDULE`**, etc.
- **Semantics (gaps):** full **`compileTurn_`** / intake package, full GAS property detection, full **`handleInboundRouter_`** graph — see **[PARITY_LEDGER.md](./PARITY_LEDGER.md)**. Schedule parse + **`validateSchedPolicy_`** + `inferStageDayFromText_` are ported on the ticket schedule commit path; **`property_policy`** must match GAS PropertyPolicy for identical decisions.

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

**Partially ported:** `decideLane_` / `normalizeInboundEvent_` shapes — see `src/brain/router/`. **Core path:** `handleInboundCore` performs real DB writes when configured (not a stub). **Still missing vs GAS:** full `routeToCoreSafe_` session graph, `compileTurn_`, SMS opt-out writes, Sheets, full outgate templates.

**Staff:** DB-backed staff resolution + `STAFF_LIFECYCLE_GATE`; lifecycle command handler exists but full parity is ongoing.

**Seam:** Precursors are real; core finalize is real for the maintenance slice above — **full** behavior parity requires intake compile + lifecycle + outgate next.

---

## PHASE 4 — Testing

- `tests/routerPrecursor.test.js` — precursors + related router tests.
- `tests/ticketDefaults.test.js` — `localCategoryFromText`, `inferEmergency`, ticket id shape.
- Run: `npm test` (includes `recomputeDraftExpected`, `mergeMaintenanceDraft`, **`extractUnitGas`** tests)

---

## PHASE 5 — Next slices (order)

1. **Router:** ~~`isStaffSender_` / staff keys~~ → `resolveStaffContext.js` + `STAFF_LIFECYCLE_GATE` in `evaluateRouterPrecursor`. **Remainder:** `staffHandleLifecycleCommand_` (real handler).
2. **Router:** `decideLane_` + `normalizeInboundEvent_` / media parse.
3. **Core:** `compileTurn_` + intake package + canonical merge + Postgres draft store (replaces single-message-only finalize when authoritative).
4. **Lifecycle / policy:** lifecycle engine + `property_policy` reads — **next questions** (e.g. scheduling) emerge here, not from hardcoded “ask window first” rules.
5. **Outgate:** canonical intents → `sendTelegramMessage` / template rendering.

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
| **PORTING_FROM_GAS.md** | Which GAS file owns each behavior; **no parallel rewrites** of stage/parse/policy rules. |
| **ADAPTER_ONBOARDING.md** | New channel implementation checklist (adapter/contract/tests/docs) with channel-agnostic core constraints. |
| **TESTING_STRATEGY.md** | Scenario / integration tests; **staged implementation** (tests when the corresponding brain slice has a stable boundary). |
| **README.md** (propera-v2) | New scripts (`npm run dev`), ports, or first-run steps. |
