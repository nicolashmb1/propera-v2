# Parity ledger — GAS ↔ V2 (single source of truth)

**Purpose:** Track **flow parity** vs **semantic parity** for every brain-relevant behavior.  
**Rule:** GAS is the **source implementation** for core intake logic until explicitly superseded.

| Term | Meaning |
|------|---------|
| **Flow parity** | The conversation/engine **steps** exist (e.g. schedule prompt after ticket). |
| **Semantic parity** | **Same decisions and structured outputs** as GAS (parsed windows, policy, sheet-shaped fields). |

**Do not** treat flow parity as full product parity. If this row says `STUB` or `PARTIAL`, semantics differ from production GAS.

---

## Snapshot — where you stand (V1 GAS vs V2 Node)

**V1 (production reference):** Google Apps Script (`*.gs` in repo root) + Google Sheets — full surface area: **router** (`16_ROUTER_ENGINE.gs`), **lifecycle** (`12_LIFECYCLE_ENGINE.gs`), **orchestrator** (`20_CORE_ORCHESTRATOR.gs`), **finalize/intake** (`11`, `08`, `07`, `10`), **staff** (`25`), **outgate/templates** (`19`), plus **amenity / leasing / water / vendor / comm** engines (`21`–`24`, `26`), **Alexa / sensor** adapters (`03`, `04`), **AI media transport** (`05`), etc.

**V2 (this repo):** Node + Supabase — **intentional slice**, not a line-for-line port. **HTTP entry:** `src/index.js` (`/webhooks/telegram`, `/webhooks/twilio`, `/webhooks/sms`). **Shared router:** `src/inbound/runInboundPipeline.js`. Strongest parity today: **maintenance tenant lane** (`handleInboundCore` → merge → `recomputeDraftExpected` → finalize → schedule ask → `applyPreferredWindowByTicketKey` + `validateSchedPolicy_`), **staff lifecycle** (`handleStaffLifecycleCommand` — WI resolution, outcomes, **ETA/parts**, **staff-originated schedule** on linked `ticket_key`), **router precursors + lane**, **identity** for staff/tenant, **Telegram + Twilio (SMS + WhatsApp)** ingress.

**Compliance / opt-in / opt-out:** **SMS only** — `src/inbound/transportCompliance.js` + `sms_opt_out` table. **Telegram and WhatsApp do not** persist TCPA compliance or opt-out state (messages like `STOP` may flow to core as normal text).

**Biggest intentional gaps vs full GAS:** full **`handleInboundRouter_`** graph (vendor/system lanes, complete Twilio parity), full **`handleLifecycleSignal_`** / sheet-style lifecycle, **Outgate template map**, **amenity/leasing/water/vendor** engines, **canonical intake vision/CIG** queue, **Alexa/sensors**.

### GAS V1 engine file → V2 coverage map

Use this to see **what exists in GAS** and whether **V2 has a row** in §§1–6 below. “**Not in V2**” = no meaningful port yet.

| GAS file | Role | Ledger / V2 notes |
|----------|------|---------------------|
| `01_PROPERA MAIN.gs` | Triggers / entry | Orchestration — see exit plan, not a single V2 file |
| `02_TELEGRAM_ADAPTER.gs` | TG → `e.parameter` | §5b — `buildRouterParameterFromTelegram.js` |
| `15_GATEWAY_WEBHOOK.gs` | SMS/WA webhook shell | §5 — `normMsg`; Twilio → `buildRouterParameterFromTwilio.js`, `index.js` |
| `16_ROUTER_ENGINE.gs` | Router, lanes, SMS opt-out, weak issue | §5 — `evaluateRouterPrecursor`, `runInboundPipeline`, `decideLane`; address helpers §1 |
| `17_PROPERTY_SCHEDULE_ENGINE.gs` | Schedule engine, `extractUnit_` | §1, §3 — `extractUnitGas`, `parsePreferredWindowShared` |
| `18_MESSAGING_ENGINE.gs` | Ticket defaults, emergency | §4 — `ticketDefaults.js` |
| `11_TICKET_FINALIZE_ENGINE.gs` | Finalize, `recomputeDraftExpected_` | §2, §3 — `recomputeDraftExpected`, `finalizeMaintenance.js` |
| `08_INTAKE_RUNTIME.gs` | `compileTurn_`, shared schedule parse | §1, §3 — `compileTurn`, `parsePreferredWindowShared` |
| `07_PROPERA_INTAKE_PACKAGE.gs` | Intake package | §1 — `properaBuildIntakePackage`, `canonizeStructuredSignal` subset |
| `09_ISSUE_CLASSIFICATION_ENGINE.gs` | Issue classification | §1 — `issueParseDeterministic.js` |
| `10_CANONICAL_INTAKE_ENGINE.gs` | Canonical merge stack | Partial — `mergeMaintenanceDraft`, `intakeAttachClassify` |
| `12_LIFECYCLE_ENGINE.gs` | Lifecycle signals, transitions | Partial — staff schedule/outcome via DAL; **not** full GAS signal graph |
| `14_DIRECTORY_SESSION_DAL.gs` | Directory / session | Partial — `resolveActor`, `intakeSession`, properties |
| `20_CORE_ORCHESTRATOR.gs` | Core routing | Partial — embodied in `handleInboundCore` only |
| `25_STAFF_RESOLVER.gs` | Staff WI resolution + lifecycle cmd | §6 — `resolveTargetWorkItemForStaff`, `handleStaffLifecycleCommand`, `lifecycleExtract` |
| `19_OUTGATE.gs` | Templates, outbound copy | **Not in V2** — `buildMaintenancePrompt` etc. are simplified |
| `13_POLICY_ENGINE.gs` | Broader policy | **Not ported** — schedule hours via `property_policy` DAL only |
| `21_AMENITY_ENGINE.gs` | Amenity lane | **Not in V2** |
| `22_WATER_ENGINE.gs` | Water lane | **Not in V2** |
| `23_LEASING_ENGINE.gs` | Leasing lane | **Not in V2** |
| `24_COMM_ENGINE.gs` | Communications | **Not in V2** |
| `26_VENDOR_ENGINE.gs` | Vendor lane | **Not in V2** |
| `06_STAFF_CAPTURE_ENGINE.gs` | `#` staff capture | Precursor — `STAFF_CAPTURE_HASH` in `evaluateRouterPrecursor` |
| `05_AI_MEDIA_TRANSPORT.gs` | Media / vision queue | Partial — Telegram `enrichTelegramMediaWithOcr`, not full GAS queue |
| `03_ALEXA_ADAPTER.gs` | Alexa | **Not in V2** |
| `04_SENSOR_GATEWAY.gs` | IoT | **Not in V2** |
| `PROPERA_MAIN_BACKUP.gs` | Monolith backup / `detectPropertyFromBody_` | §1 — property detect ported in `lifecycleExtract.js` |
| `sms-consent-handler.gs` (if present) | SMS consent | Superseded by V2 **`sms_opt_out`** + SMS-only compliance in `runInboundPipeline` |

### V2 HTTP ingress (compliance scope)

| Route | Transport | `transportChannel` | Compliance / `sms_opt_out` |
|-------|-----------|--------------------|----------------------------|
| `POST /webhooks/telegram` | Telegram Bot API | `telegram` | **No** |
| `POST /webhooks/twilio`, `POST /webhooks/sms` | Twilio `application/x-www-form-urlencoded` | `sms` if `From` is not `whatsapp:`; **`whatsapp`** if `From` starts with `whatsapp:` | **Yes, SMS only** — `sms` runs TCPA compliance + DB opt-out; **`whatsapp` does not** |

Requires migration **`011_sms_opt_out.sql`** for opt-out persistence. See [PROPERTY_POLICY_PARITY.md](./PROPERTY_POLICY_PARITY.md) for policy rows.

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
| Property hint from body (single-turn parse) | `detectPropertyFromBody_` and related — `PROPERA_MAIN_BACKUP.gs` / canonical intake | `detectPropertyFromBody`, `resolvePropertyExplicitOnly`, `extractPropertyHintFromBody` — `src/brain/staff/lifecycleExtract.js`; variants sourced from DB fields via `listPropertiesForMenu` — `src/dal/intakeSession.js` (`property_aliases`, `ticket_prefix`, `short_name`, `address`) | **PARTIAL** | V2 now includes GAS-like variant components (code, display, alias, ticket prefix, short name, address tokens) and explicit-only grounding. Remaining gap is broader canonical intake grounding chain and full `_variants` behavior in all resolver callsites. | **Medium** | DB-first config: aliases come from `property_aliases` when migration `009` is applied; fallback keeps working from `properties` only. |
| Single-message draft parse | `compileTurn_` / intake package — `08_INTAKE_RUNTIME.gs` | **`compileTurn`** — `src/brain/intake/compileTurn.js`; **`properaBuildIntakePackage`** — `src/brain/intake/properaBuildIntakePackage.js` (deterministic path uses GAS-shaped **`properaFallbackStructuredSignalFromDeterministicParse_`**); **`parseIssueDeterministic`** — `src/brain/gas/issueParseDeterministic.js` (GAS `issueParseDeterministic_` / `parseIssueDeterministic_`); fast path **`parseMaintenanceDraftAsync`** — `src/brain/core/parseMaintenanceDraft.js` | **PARTIAL** | **`parseIssueDeterministic_` is ported** (clause taxonomy, scoring, title/details, `localCategoryFromText`); **`properaCanonizeStructuredSignal_`** remains a V2 subset vs full GAS. Still missing: GAS vision / CIG slot rules, full GAS media queue/vision flow; `_mediaJson` + optional OCR bridge is not full GAS queue semantics. Merge accepts async `parsedDraft`; end-to-end compile chain parity with GAS `08`/`07` edge cases still tracked case-by-case. | **Medium** | Enable compile path with **`INTAKE_COMPILE_TURN=1`** (also `true`/`yes`/`on`); optional OCR requires **`INTAKE_MEDIA_OCR_ENABLED=1`**, `TELEGRAM_BOT_TOKEN`, and `OPENAI_API_KEY`. **`.env`** is loaded from **`propera-v2/.env`** via `src/config/env.js` (package root), not only `cwd` — see **[HANDOFF_LOG.md](./HANDOFF_LOG.md)** 2026-04-11. |

---

## 2. Stage / expected / merge (maintenance lane)

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| Pre-ticket slot order (issue → property → unit → finalize/schedule) | `recomputeDraftExpected_` — `11_TICKET_FINALIZE_ENGINE.gs` (~147–171) | `recomputeDraftExpected` — `src/brain/core/recomputeDraftExpected.js` | **PARTIAL** | Emergency / `skipScheduling` forces **`EMERGENCY_DONE` only when `next === "SCHEDULE"`** (GAS ~161–171), not `SCHEDULE_PRETICKET`. Active-ticket whitelist enforced in `handleInboundCore`. Full GAS session-expiry write parity optional. | **Medium** | `openerNext="SCHEDULE"` → `SCHEDULE_PRETICKET` when pre-ticket slots complete. |
| Merge one turn into draft | `draftUpsertFromTurn_` class / canonical merge — GAS intake | `mergeMaintenanceDraftTurn` + deterministic `intakeAttachClassifyDeterministic` — `src/brain/core/mergeMaintenanceDraft.js`, `src/brain/core/intakeAttachClassify.js` | **PARTIAL** | Ports deterministic slice of GAS `properaIntakeAttachClassify_` (schedule-only vs symptom, pure property/unit slot answers, continuation split append, unit mismatch clarify) + `issue_buf_json` accumulation; still not full canonical merge / AI assist / split preview merge. | **Medium** | `resolvePropertyFromReply` is V2 helper, not full canonical merge stack. |
| Multi-issue split on finalize | Canonical split preview + commit (`issueAtom*`, `groupIssueAtomsIntoTicketGroups_`, finalize split commit) — `PROPERA_MAIN_BACKUP.gs` / `17_PROPERTY_SCHEDULE_ENGINE.gs` | `buildIssueTicketGroups` + finalize loop — `src/brain/core/splitIssueGroups.js`, `src/brain/core/handleInboundCore.js` | **PARTIAL** | V2 now splits distinct issue families into multiple tickets and keeps same-system sub-issues bundled; full GAS atom taxonomy, split preview memory, and stable bundle scheduling semantics are not yet ported. | **Medium** | Initial parity slice for multi-ticket creation behavior. |
| Tenant prompts | Outgate / templates — GAS | `buildMaintenancePrompt` — `src/brain/core/buildMaintenancePrompt.js` | **PARTIAL** | Simplified copy; not full template map | **Low** | UX copy may differ from SMS templates. |
| Intake session persistence | GAS `Sessions` sheet | `intake_sessions` — `src/dal/intakeSession.js` | **PARTIAL** | `expires_at_iso` sync now mirrors recompute timeout class (10/30 min), active-ticket whitelist guard is ported, and `issue_buf_json` is now read/write in merge/core/finalize path. Remaining gap: broader canonical session overlays/attachment decisions/split preview semantics from GAS canonical intake. | **Low** | Postgres shape, not Sheets. |
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
| Compliance (STOP/HELP/START) | `complianceIntent_` | `complianceIntent.js` | **PORTED** | **Side effects SMS-only** — see §12; TG/WA/SMS non-compliance paths use `transportCompliance.js` | **Low** | Parser ported; DB writes not on TG/WA |
| Tenant commands | `detectTenantCommand_` | `detectTenantCommand.js` | **PORTED** | — | **Low** | |
| Precursor ordering | `handleInboundRouter_` chain | `evaluateRouterPrecursor.js` | **PARTIAL** | Explicitly does not invoke full router / core / Sheets | **Medium** | By design in V2 slice. |
| Lane classification | `classifyLane_` / `decideLane_` — `15_GATEWAY_WEBHOOK.gs` | `decideLane` — `src/brain/router/decideLane.js` | **PARTIAL** | Simplified policy hooks (`lanePolicy.js`) | **Medium** | |
| Inbound event normalization | `normalizeInboundEvent_` — `15_GATEWAY_WEBHOOK.gs` | `normalizeInboundEventFromRouterParameter` — `src/brain/router/normalizeInboundEvent.js` | **PORTED** | Edge-case parity with GAS (channel hints) if mismatches appear | **Low** | Used when building normalized event from `RouterParameter`. |
| Full router | `handleInboundRouter_` — `16_ROUTER_ENGINE.gs` | `runInboundPipeline.js` + `src/index.js` (Telegram + Twilio SMS/WA) | **PARTIAL** | Twilio **SMS** = compliance + `sms_opt_out`; **WhatsApp/Telegram** = no TCPA compliance writes. **Orchestrator order + core guards + vendor/system lane stubs:** [ORCHESTRATOR_ROUTING.md](./ORCHESTRATOR_ROUTING.md). Deeper vendor/amenity engines still not in V2 | **Medium** | See `transportCompliance.js`, `routeInboundDecision.js` |

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
| WI hint / resolution | `lifecycleResolveTargetWiForStaff_` — `25_STAFF_RESOLVER.gs` | `resolveTargetWorkItemForStaff.js` — issue-hint scoring, CTX + `getWorkItemByWorkItemId` owner check | **PARTIAL** | Full GAS `handleLifecycleSignal_` after staff update (sheet transitions) | **Medium** | Tests: `staffBrain.test.js` |
| Staff outcomes + parts ETA | `lifecycleNormalizeStaffOutcome_`, `lifecycleParsePartsEta_` | `normalizeStaffOutcome.js` — includes slash + month-name ETA | **PORTED** | — | **Low** | |
| Staff-originated schedule | `staffHandleLifecycleCommand_` + `parsePreferredWindowShared_` | `handleStaffLifecycleCommand.js` — remainder strip, `applyPreferredWindowByTicketKey`, duplicate window | **PARTIAL** | Requires `work_items.ticket_key` linked to `tickets` | **Medium** | Not full GAS `handleLifecycleSignal_` for schedule |
| Staff extraction helpers | `detectPropertyFromBody_` etc. | `lifecycleExtract.js` — menu 1–5, `ticket_prefix`, variants | **PARTIAL** | Optional `_variants` cache like GAS `buildPropertyVariants_` | **Low** | `extractPropertyHintFromBody` uses detect + regex fallbacks |

---

## 7. Remaining high-value gaps (prioritized)

1. **Canonical intake / merge** — Full GAS `10_CANONICAL_INTAKE_ENGINE` + vision/CIG/`properaCanonizeStructuredSignal_` edge cases; media queue semantics (`05_AI_MEDIA_TRANSPORT.gs`). V2: `mergeMaintenanceDraft`, `intakeAttachClassify`, `canonizeStructuredSignal` subset, Telegram OCR bridge only.  
2. **Router depth** — `16_ROUTER_ENGINE.gs` vendor/system lanes, weak-issue / media-only branches, full `routeToCoreSafe_` parity. V2: `runInboundPipeline` + Twilio SMS/WA + Telegram; compliance **SMS-only** (§12).  
3. **Lifecycle engine** — `12_LIFECYCLE_ENGINE.gs` signal graph (STAFF_UPDATE / SCHEDULE_SET transitions, hold/reject). V2: DAL updates + staff path; not full transition table.  
4. **Outgate** — `19_OUTGATE.gs` template map. V2: simplified prompts (`buildMaintenancePrompt`).  
5. **Other lanes** — Amenity / leasing / water / vendor / comm (`21`–`24`, `26`): **not in V2** — see §11.  
6. **PropertyPolicy + config** — [PROPERTY_POLICY_PARITY.md](./PROPERTY_POLICY_PARITY.md); `PROPERTY_ADDRESSES_JSON` vs GAS `PROPERTY_ADDRESSES`.  
7. **Done or strong partial (do not re-prioritize as greenfield):** `detectPropertyFromBody` menu 1–5 + `ticket_prefix` (`lifecycleExtract.js`); `recomputeDraftExpected` emergency guard on `SCHEDULE` only; `parseIssueDeterministic`; staff schedule + resolver slices (§6).

---

## 8. Pointer comment template (required for STUB / PARTIAL brain code)

```text
// PARITY GAP: <one line what is reduced> — see docs/PARITY_LEDGER.md §<section or behavior name>
```

---

## 9. Related docs

**Orientation:** read **Snapshot** (top of this file) + **§7** (remaining gaps) before deep rows in §§1–6.

- [ORCHESTRATOR_ROUTING.md](./ORCHESTRATOR_ROUTING.md) — **inbound order**, **core guards**, **lane stubs** (engine 20 review).  
- [GAS_ENGINE_PORT_PROGRAM.md](./GAS_ENGINE_PORT_PROGRAM.md) — **phased port** for engines **10 / 12 / 14 / 20** (canonical intake, lifecycle, directory/session, orchestrator); use when you want “ported” beyond this ledger’s row-level notes.
- [PORTING_FROM_GAS.md](./PORTING_FROM_GAS.md) — porting rules + table (keep in sync with this ledger).  
- [BRAIN_PORT_MAP.md](./BRAIN_PORT_MAP.md) — handoff and file map.  
- [PROPERA_V2_GAS_EXIT_PLAN.md](./PROPERA_V2_GAS_EXIT_PLAN.md) — migration phases.  
- [HANDOFF_LOG.md](./HANDOFF_LOG.md) — dated session notes (ops, env, dashboard); **not** parity truth.

---

## 10. Ops / observability (V2-only — not GAS parity)

These items **do not** change GAS behavioral parity; they help operators and agents debug V2.

| Item | Status | Notes |
|------|--------|--------|
| **`event_log` flight recorder** | **Expanded (2026-04)** | Policy schedule chain, intake brain path (`INTAKE_BRAIN_PATH`, `INTAKE_PARSE_BRANCH`), staff resolution summaries, **Outgate** (`log_kind: outgate`, `OUTBOUND_*`), router **`LANE_STUB`** — see `appendEventLog` / `dispatchOutbound.js`; brain path files as before. |
| **Ops dashboard** | **Shipped** | `GET /dashboard`, `GET /api/ops/event-log` — `src/dashboard/`; tenant index by **Telegram user id**; UI: outcome-first card, raw events collapsed by default. Requires DB + `DASHBOARD_ENABLED` (see README). |
| **Structured stdout** | **Unchanged** | `emitTimed` / `STRUCTURED_LOGS.md`; `STRUCTURED_LOG=0` disables. |

**Tenant-facing copy:** finalize receipt hides internal WI id / ticket UUID — see `handleInboundCore.js` (UX, not engine parity).
