# Parity ledger — GAS ↔ V2 (single source of truth)

**Purpose:** Track **flow parity** vs **semantic parity** for every brain-relevant behavior.  
**Rule:** GAS is the **source implementation** for core intake logic until explicitly superseded.

| Term | Meaning |
|------|---------|
| **Flow parity** | The conversation/engine **steps** exist (e.g. schedule prompt after ticket). |
| **Semantic parity** | **Same decisions and structured outputs** as GAS (parsed windows, policy, sheet-shaped fields). |

**Do not** treat flow parity as full product parity. If this row says `STUB` or `PARTIAL`, semantics differ from production GAS.

---

## Maintenance: update this file when you change V2 behavior

1. Add or update the row for that behavior.  
2. Set **Status** and **What is missing**.  
3. Add a **PARITY GAP** pointer comment in code (see template at bottom).  
4. Cross-link major ports in [PORTING_FROM_GAS.md](./PORTING_FROM_GAS.md) if you add a new GAS ↔ V2 mapping.

---

## 1. Intake, extraction, address guards

| Behavior | GAS source (file + symbol) | V2 implementation (file + symbol) | Status | What is missing (semantic) | Risk | Notes |
|----------|----------------------------|-------------------------------------|--------|----------------------------|------|-------|
| Unit extraction from free text | `extractUnit_` — `17_PROPERTY_SCHEDULE_ENGINE.gs` (~2260+) | `extractUnit` — `src/brain/shared/extractUnitGas.js` | **PORTED** | None known for the ported slice; verify against latest GAS if GAS changed | **Low** | Delegates `isBlockedAsAddress_` from same module chain. |
| Street vs unit (block “618” as unit) | `isBlockedAsAddress_` — `16_ROUTER_ENGINE.gs` (~2449); address list | `isBlockedAsAddress_`, `isAddressInContext_` — `src/brain/gas/addressContext.js` | **PORTED** | Config must match GAS: `PROPERTY_ADDRESSES` → `PROPERTY_ADDRESSES_JSON` / `src/config/propertyAddresses.js` | **Medium** | Wrong JSON = wrong blocking. |
| Address list global | GAS global `PROPERTY_ADDRESSES` | `getPropertyAddresses` — `src/config/propertyAddresses.js` (env JSON) | **PARTIAL** | Operator must deploy same semantic list as GAS prod | **Medium** | Not code drift — **config parity**. |
| Property hint from body (single-turn parse) | `detectPropertyFromBody_` and related — `PROPERA_MAIN_BACKUP.gs` / canonical intake | `detectPropertyFromBody`, `resolvePropertyExplicitOnly`, `extractPropertyHintFromBody` — `src/brain/staff/lifecycleExtract.js`; aliases via `listPropertiesForMenu` — `src/dal/intakeSession.js` (`property_aliases`) | **PARTIAL** | V2 now ports explicit-only grounding (`resolvePropertyExplicitOnly_` class) for compile/intake path and property-reply stage. Still missing full GAS variant builder (`buildPropertyVariants_`) / ticketPrefix-specific semantics and broader canonical intake grounding chain. | **Medium** | DB-first config: aliases come from `property_aliases` when migration `009` is applied; fallback keeps working from `properties` only. |
| Single-message draft parse | `compileTurn_` / intake package — `08_INTAKE_RUNTIME.gs` | **`compileTurn`** — `src/brain/intake/compileTurn.js`; **`properaBuildIntakePackage`** — `src/brain/intake/properaBuildIntakePackage.js`; fast path **`parseMaintenanceDraftAsync`** — `src/brain/core/parseMaintenanceDraft.js` | **PARTIAL** | No GAS `parseIssueDeterministic_` / full `properaCanonizeStructuredSignal_` / vision / CIG slot rules. `_mediaJson` text hints are merged into intake text via channel-agnostic bridge and Telegram adapter can enrich `ocr_text` when `INTAKE_MEDIA_OCR_ENABLED=1`, but full GAS media queue/vision flow is still not ported. Merge now accepts async `parsedDraft`, but full slot semantics are still not driven by complete GAS compile chain. | **Medium** | Enable compile path with **`INTAKE_COMPILE_TURN=1`** (also `true`/`yes`/`on`); optional OCR requires **`INTAKE_MEDIA_OCR_ENABLED=1`**, `TELEGRAM_BOT_TOKEN`, and `OPENAI_API_KEY`. **`.env`** is loaded from **`propera-v2/.env`** via `src/config/env.js` (package root), not only `cwd` — see **[HANDOFF_LOG.md](./HANDOFF_LOG.md)** 2026-04-11. |

---

## 2. Stage / expected / merge (maintenance lane)

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| Pre-ticket slot order (issue → property → unit → finalize/schedule) | `recomputeDraftExpected_` — `11_TICKET_FINALIZE_ENGINE.gs` (~147–171) | `recomputeDraftExpected` — `src/brain/core/recomputeDraftExpected.js` | **PARTIAL** | V2 now ports opener-driven `SCHEDULE_PRETICKET` + emergency override for pre-ticket schedule branch; still missing active-ticket continuation whitelist/session-expiry write semantics from full GAS recompute. | **Medium** | `openerNext="SCHEDULE"` now yields `SCHEDULE_PRETICKET` when pre-ticket slots are complete. |
| Merge one turn into draft | `draftUpsertFromTurn_` class / canonical merge — GAS intake | `mergeMaintenanceDraftTurn` — `src/brain/core/mergeMaintenanceDraft.js` | **PARTIAL** | Menu index + property resolution; not full GAS merge / compile | **Medium** | `resolvePropertyFromReply` is V2 helper, not full `detectPropertyFromBody_`. |
| Multi-issue split on finalize | Canonical split preview + commit (`issueAtom*`, `groupIssueAtomsIntoTicketGroups_`, finalize split commit) — `PROPERA_MAIN_BACKUP.gs` / `17_PROPERTY_SCHEDULE_ENGINE.gs` | `buildIssueTicketGroups` + finalize loop — `src/brain/core/splitIssueGroups.js`, `src/brain/core/handleInboundCore.js` | **PARTIAL** | V2 now splits distinct issue families into multiple tickets and keeps same-system sub-issues bundled; full GAS atom taxonomy, split preview memory, and stable bundle scheduling semantics are not yet ported. | **Medium** | Initial parity slice for multi-ticket creation behavior. |
| Tenant prompts | Outgate / templates — GAS | `buildMaintenancePrompt` — `src/brain/core/buildMaintenancePrompt.js` | **PARTIAL** | Simplified copy; not full template map | **Low** | UX copy may differ from SMS templates. |
| Intake session persistence | GAS `Sessions` sheet | `intake_sessions` — `src/dal/intakeSession.js` | **PARTIAL** | `expires_at_iso` sync now mirrors recompute timeout class (10/30 min) and active-ticket whitelist guard is ported in core recompute path; `issue_buf_json` and broader session overlays remain partial vs GAS canonical merge/session model. | **Low** | Postgres shape, not Sheets. |
| Ticket + work_item rows (finalize path) | GAS `workItemCreate_` / Sheet writers | `finalizeMaintenanceDraft` — `src/dal/finalizeMaintenance.js` | **PARTIAL** | Migration **006** Sheet1-shaped columns; many fields defaulted empty; not full GAS create/transition graph | **Medium** | Sets `conversation_ctx` on finalize; `scheduled_end_at` null until schedule message. `attachments` now derives from channel-agnostic `_mediaJson` contract (URL or provider token fallback). |

---

## 3. Schedule (post-finalize)

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| Post-create “ask schedule” flow | Lifecycle / finalize + `TICKET_CREATED_ASK_SCHEDULE` — `11_TICKET_FINALIZE_ENGINE.gs` / orchestrator | `handleInboundCore` + `setScheduleWaitAfterFinalize` — `src/brain/core/handleInboundCore.js`, `src/dal/intakeSession.js` | **PARTIAL** | **Flow:** yes. **Semantics:** not full GAS lifecycle engine (`routeToCoreSafe_` graph) | **Medium** | After finalize (non–skip-scheduling): `setPendingExpectedSchedule` + `setWorkItemSubstate(_, "SCHEDULE")` — `src/dal/conversationCtxSchedule.js`, `src/dal/workItemSubstate.js`. |
| Parse natural language window (“tomorrow morning”) | `parsePreferredWindowShared_` — `08_INTAKE_RUNTIME.gs` (~1859+) | `parsePreferredWindowShared` — `src/brain/gas/parsePreferredWindowShared.js` | **PORTED** | Commit path uses `inferStageDayFromText_` before parse — `src/brain/gas/inferStageDayFromText.js`. **`PROPERA_TZ`** / **`TZ`**, **`PROPERA_SCHED_LATEST_HOUR`** — `src/config/env.js` | **Low** | Tests: `tests/parsePreferredWindowShared.test.js` (`TZ=UTC`). |
| Wrapper `parsePreferredWindow_` in schedule engine | `parsePreferredWindow_` — `17_PROPERTY_SCHEDULE_ENGINE.gs` (delegates to shared) | Same shared module (not a separate file) | **PORTED** | — | **Low** | One implementation. |
| Policy validation of window | `validateSchedPolicy_` — `17_PROPERTY_SCHEDULE_ENGINE.gs` (~501–556) | `validateSchedPolicy_` — `src/brain/gas/validateSchedPolicy.js`; policy rows via `getSchedPolicySnapshot` — `src/dal/propertyPolicy.js` (GAS `ppGet_` merge GLOBAL + property) | **PORTED** | Operator must keep `property_policy` aligned with GAS PropertyPolicy sheet | **Medium** | Run **after** parse in `applyPreferredWindowByTicketKey`; rejects with `SCHED_REJECT_*` + tenant copy via `schedulePolicyRejectMessage`. **Observability:** same steps also **`appendEventLog`** (`SCHEDULE_POLICY_*`, `SCHEDULE_PARSED`) for ops dashboard — not required for GAS parity. |
| Canonical `preferred_window` + parse fallback | Sheet `PREF_WINDOW` / sync — GAS may keep raw; V2 stores **label** when parse succeeds | `applyPreferredWindowByTicketKey` — `src/dal/ticketPreferredWindow.js` | **PARTIAL** | Unparseable text → **raw** in `preferred_window` if no label; policy still evaluated on built `sched` | **Low** | GAS `syncScheduledEndAtFromRawWindow_` — V2 sets label + `scheduled_end_at` in one step when parse + policy pass. |
| `scheduled_end_at` on ticket | GAS COL; `syncScheduledEndAtFromRawWindow_` | `applyPreferredWindowByTicketKey` sets `scheduled_end_at` when `parsed.end` is a finite `Date`; `finalizeMaintenanceDraft` still inserts `null` | **PARTIAL** | **Create** path leaves null until tenant sends schedule; **no** re-sync from sheet-only edits | **Medium** | Matches “end from parse” behavior. |
| `inferStageDayFromText_` for `stageDay` | `17_PROPERTY_SCHEDULE_ENGINE.gs` (~2387–2398) | `inferStageDayFromText_` — `src/brain/gas/inferStageDayFromText.js` | **PORTED** | — | **Low** | Used in schedule commit path before `parsePreferredWindowShared` (+ fallback parse with `null` like GAS `schedPolicyRecheckWindowFromText_`). |
| Work item substate while awaiting window | GAS WI / sheet columns | `setWorkItemSubstate` — `src/dal/workItemSubstate.js` | **PARTIAL** | V2 uses string `"SCHEDULE"`; not full GAS substate machine | **Low** | Cleared when `applyPreferredWindowByTicketKey` succeeds (`substate: ""`). |

---

## 4. Ticket defaults & classification

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| Category label | `localCategoryFromText_` — `18_MESSAGING_ENGINE.gs` (~644–702) | `localCategoryFromText` — `src/dal/ticketDefaults.js` | **PORTED** | — | **Low** | Same rule order; no match → `""` like GAS line 702. |
| Emergency flag | `hardEmergency_` + `evaluateEmergencySignal_` — `18_MESSAGING_ENGINE.gs` (~373–603) | `inferEmergency` — `src/dal/ticketDefaults.js` (uses `hardEmergency_`, `detectEmergencyKind_`, `evaluateEmergencySignal_`) | **PORTED** | Does not include LLM `classify_` or `urgentSignals_` (non-emergency urgency) | **Low** | Sheet shape `emergency` Yes/No + `emergency_type`; drives `skipScheduling` in core. |
| Human ticket id shape | `makeTicketId_` — `14_DIRECTORY_SESSION_DAL.gs` (~845–867) | `formatHumanTicketId` — `src/dal/ticketDefaults.js` | **PARTIAL** | GAS suffix = sheet row padded; V2 uses random 4 digits (no row at insert) | **Low** | PREFIX + MMDDYY + 4-digit suffix shape aligned. |
| Thread id | GAS thread builders | `buildThreadIdV2` — `src/dal/ticketDefaults.js` | **PARTIAL** | V2-specific prefix scheme | **Low** | Intentional shell difference. |

---

## 5. Router / precursors / lane (non-intake-complete)

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| Normalize body | `normMsg_` — `15_GATEWAY_WEBHOOK.gs` | `normMsg` — `src/brain/router/normMsg.js` | **PORTED** | — | **Low** | Covered by tests. |
| Compliance (STOP/HELP/START) | `complianceIntent_` | `complianceIntent.js` | **PORTED** | — | **Low** | |
| Tenant commands | `detectTenantCommand_` | `detectTenantCommand.js` | **PORTED** | — | **Low** | |
| Precursor ordering | `handleInboundRouter_` chain | `evaluateRouterPrecursor.js` | **PARTIAL** | Explicitly does not invoke full router / core / Sheets | **Medium** | By design in V2 slice. |
| Lane classification | `classifyLane_` / `decideLane_` — `15_GATEWAY_WEBHOOK.gs` | `decideLane` — `src/brain/router/decideLane.js` | **PARTIAL** | Simplified policy hooks (`lanePolicy.js`) | **Medium** | |
| Inbound event normalization | `normalizeInboundEvent_` — `15_GATEWAY_WEBHOOK.gs` | `normalizeInboundEventFromRouterParameter` — `src/brain/router/normalizeInboundEvent.js` | **PORTED** | Edge-case parity with GAS (channel hints) if mismatches appear | **Low** | Used when building normalized event from `RouterParameter`. |
| Full router | `handleInboundRouter_` — `16_ROUTER_ENGINE.gs` | *Partial* — `src/index.js` wiring | **NOT STARTED** | Opt-out, SMS storage, full route graph | **High** | |

---

## 5b. Identity & Telegram shell (not full brain, but wired today)

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| Actor resolution (tenant/staff) | GAS directory + router identity | `resolveActor` — `src/identity/resolveActor.js` | **PARTIAL** | Postgres `contacts` / staff tables; not full GAS identity + router graph | **Medium** | Optional dev route when `IDENTITY_API_ENABLED`; not a substitute for full router. |
| Telegram → `RouterParameter` | `02_TELEGRAM_ADAPTER.gs` `syntheticE.parameter` | `buildRouterParameterFromTelegram` — `src/contracts/buildRouterParameterFromTelegram.js` | **PARTIAL** | Keep field-level parity with GAS `parameter` — see **BRAIN_PORT_MAP** PHASE 2 | **Medium** | |
| `update_id` dedupe | GAS queue / replay rules | `tryConsumeUpdateId` — `src/adapters/telegram/dedupeUpdateId.js` | **PARTIAL** | In-process TTL map vs durable queue | **Low** | Transport replay guard; not semantic parity. |
| Telegram chat ↔ phone link | GAS linkage | `upsertTelegramChatLink` — `src/identity/upsertTelegramChatLink.js` | **PARTIAL** | DB-backed; compare to GAS if divergences reported | **Low** | |

---

## 6. Staff / lifecycle

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| WI hint / resolution | `25_STAFF_RESOLVER.gs` | `resolveTargetWorkItemForStaff.js`, `normalizeStaffOutcome.js`, `handleStaffLifecycleCommand.js` | **PARTIAL** | Full `staffHandleLifecycleCommand_` parity ongoing | **Medium** | See staff tests. |
| Staff extraction helpers | GAS resolver | `lifecycleExtract.js` (property hint **not** full GAS) | **PARTIAL** | Same as property row above | **Medium** | |

---

## 7. Highest-risk semantic gaps to port next (recommended order)

1. **`detectPropertyFromBody_` full parity** — complete GAS variant builder + ticketPrefix semantics and explicit-only grounding in intake pipeline.  
2. **Full GAS intake** — `parseIssueDeterministic_`, property grounding (`resolvePropertyExplicitOnly_`), media/vision, `mergeMaintenanceDraft` on async compile.  
3. **Full `recomputeDraftExpected_`** — align `SCHEDULE_PRETICKET` / opener branches with GAS.  
4. **Full `handleInboundRouter_`** — opt-out, SMS storage, complete route graph (`/router` parity).  
5. **PropertyPolicy / `property_policy`** — keep DB rows aligned with GAS PropertyPolicy when operators change hours (operational parity, not code).

---

## 8. Pointer comment template (required for STUB / PARTIAL brain code)

```text
// PARITY GAP: <one line what is reduced> — see docs/PARITY_LEDGER.md §<section or behavior name>
```

---

## 9. Related docs

- [PORTING_FROM_GAS.md](./PORTING_FROM_GAS.md) — porting rules + table (keep in sync with this ledger).  
- [BRAIN_PORT_MAP.md](./BRAIN_PORT_MAP.md) — handoff and file map.  
- [PROPERA_V2_GAS_EXIT_PLAN.md](./PROPERA_V2_GAS_EXIT_PLAN.md) — migration phases.  
- [HANDOFF_LOG.md](./HANDOFF_LOG.md) — dated session notes (ops, env, dashboard); **not** parity truth.

---

## 10. Ops / observability (V2-only — not GAS parity)

These items **do not** change GAS behavioral parity; they help operators and agents debug V2.

| Item | Status | Notes |
|------|--------|--------|
| **`event_log` flight recorder** | **Expanded (2026-04)** | Policy schedule chain, intake brain path (`INTAKE_BRAIN_PATH`, `INTAKE_PARSE_BRANCH`), staff resolution summaries — see `appendEventLog` in `ticketPreferredWindow.js`, `properaBuildIntakePackage.js`, `parseMaintenanceDraft.js`, `handleStaffLifecycleCommand.js`. |
| **Ops dashboard** | **Shipped** | `GET /dashboard`, `GET /api/ops/event-log` — `src/dashboard/`; tenant index by **Telegram user id**; UI: outcome-first card, raw events collapsed by default. Requires DB + `DASHBOARD_ENABLED` (see README). |
| **Structured stdout** | **Unchanged** | `emitTimed` / `STRUCTURED_LOGS.md`; `STRUCTURED_LOG=0` disables. |

**Tenant-facing copy:** finalize receipt hides internal WI id / ticket UUID — see `handleInboundCore.js` (UX, not engine parity).
