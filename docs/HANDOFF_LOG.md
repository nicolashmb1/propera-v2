# Handoff log — propera-v2

**Purpose:** Short, dated notes so the **next agent** knows what landed recently and where to continue.  
**Not** a substitute for **[PARITY_LEDGER.md](./PARITY_LEDGER.md)** (GAS ↔ V2 truth) or **[AGENTS.md](../AGENTS.md)** (rules).

**How to use:** Read the **latest dated section** first, then **`PARITY_LEDGER.md`**, **`BRAIN_PORT_MAP.md`**, and **`AGENTS.md`** as usual.

---

## 2026-05-09 — `handleInboundCore` refactor plan **complete** (Phases 2–5 closure)

### Done

| Area | Notes |
|------|--------|
| **`coreMaintenanceLoadContext.js`** | **`buildMaintenanceCoreDispatchContext`** — everything through gates + `fastDraft` + clarify-media tweak (formerly inline in `handleInboundCore`). |
| **`coreMaintenanceBoundaryLog.js`** | **`CORE_EXIT`** (after **`CORE_ENTER`**, includes gate early returns) + **`CORE_ERROR`** + rethrow. |
| **`handleInboundCore.js`** | ~**107** lines: load → fast \| multi → boundary log. |
| **Tests** | **`staffCaptureBrainSourceGuard.test.js`** — draft-owner regex moved to **`coreMaintenanceLoadContext.js`**. **`npm test`** green. |
| **Docs** | **`HANDLE_INBOUND_CORE_REFACTOR_PLAN.md`** marked complete; **`STRUCTURED_LOGS.md`**, **`BRAIN_PORT_MAP.md`** updated. |

### Continue

Normal product work; no remaining items from that stabilization plan unless you open a **new** polish ticket.

---

## 2026-05-09 — `handleInboundCore` Phase 4 (third slice): staff finalize receipt dedupe

### Done

| Area | Notes |
|------|--------|
| **`coreMaintenanceStaffFinalizeReceipt.js`** | **`finalizeReceiptStaffCaptureScheduleBranch`** — one implementation for inline schedule vs no-schedule-prompt after finalize (`fast` / `multi_turn`). |
| **Fast / multi runners** | Delegate staff branch to helper; **`npm test`** green. |

### Continue

**`loadCoreContext`** (Phase 2 deferral) or Phase 5 **`withCoreLogging`** when touching core entry again.

---

## 2026-05-09 — `handleInboundCore` Phase 4 (second slice): staff session + portal draft builders

### Done

| Area | Notes |
|------|--------|
| **`coreMaintenanceStaffCapture.js`** | **`resolveStaffCaptureBodyAndSession`** — replaces inline canonical checks + **`resolveStaffCaptureDraftTurn`** vs tenant **`getIntakeSession`**. |
| **`coreMaintenancePortalDraft.js`** | **`buildFastDraftForMaintenanceCore`** — portal structured create validation + parse fallback in one async helper. |
| **`handleInboundCore.js`** | Thinner: delegates session + initial **`fastDraft`** build; **`npm test`** green. |

### Continue

Dedupe staff **post-finalize** receipt branches shared by **`coreMaintenanceFastPath`** / **`coreMaintenanceMultiTurn`**; or **`loadCoreContext`** when touching dispatcher again.

---

## 2026-05-09 — `handleInboundCore` Phase 4 (first slice): fast vs multi-turn dispatch

### Done

| Area | Notes |
|------|--------|
| **`coreMaintenanceShared.js`** | **`resolveManagerTenantIfNeeded`**, **`loadPropertyCodesUpper`**, **`hasClarifyingStaffMediaSignal`** (moved from monolith). |
| **`coreMaintenanceFastPath.js`** | **`runCoreMaintenanceFastPath`** — verbatim former “fast path” body (`path: "fast"`). |
| **`coreMaintenanceMultiTurn.js`** | **`runCoreMaintenanceMultiTurn`** — verbatim former multi-turn body; **`setDraftSeqActive`** callback preserves staff **`start_new`** draft seq mutation + **`staffMeta()`** closure semantics. |
| **`handleInboundCore.js`** | Setup, gates, portal validation + **`parseMaintenanceDraftAsync`**, then **`dispatch`** = fast runner vs multi-turn runner. **No intentional behavior change**; **`npm test`** green. |

### Continue

Optional: extract **`coreStaffCapture.js`** / **`corePortalCreate.js`** as separate top-level policies (plan’s original four-file split); **`loadCoreContext`** still deferred per Phase 2 notes.

---

## 2026-05-06 — `handleInboundCore` Phase 2: mechanical extractions

### Done

| Area | Notes |
|------|--------|
| **`handleInboundCoreMechanics.js`** | Shared **`outgateMeta`**, **`coreInboundResult`**, **`finalizeTicketRowGroups`** (reconcile rows → `finalizeMaintenanceDraft` + same error shape), **`appendCoreFinalizedFlightRecorder`**, **`enterScheduleWaitAndLogTicketCreatedAskSchedule`** (schedule wait + pending expected + WI substate + `TICKET_CREATED_ASK_SCHEDULE` logs). |
| **`handleInboundCore.js`** | Fast + multi-turn finalize loops and duplicate schedule-wait blocks replaced; two returns use **`coreInboundResult`**. Removed direct **`finalizeMaintenanceDraft`** / **`setPendingExpectedSchedule`** / **`setWorkItemSubstate`** imports where inlined only. |
| **`loadCoreContext`** | Not extracted in this step (closure / `staffMeta` timing); see **`HANDLE_INBOUND_CORE_REFACTOR_PLAN.md`** Phase 2 status. |

### Continue

Phase 3 (gates before dispatch) or finish Phase 2 with context load when touching dispatcher shape.

---

## 2026-05-06 — `handleInboundCore` Phase 1: scenario regression net

### Done

| Area | Notes |
|------|--------|
| **Scenarios** | New files under **`tests/scenarios/`**: tenant fast path, common area, emergency, schedule-after-receipt, attach clarify + resolve, start-new mid draft, multi-issue split, staff capture (fast / multi-turn / no schedule prompt), portal structured **`create_ticket`**. All use **`PROPERA_TEST_INJECT_SB`** + **`createScenarioMemorySupabase`** + **`runInboundPipeline`** (portal scenario same). |
| **Helpers** | **`memorySupabaseScenario.js`**: **`SCENARIO_STAFF_E164`**, **`scenarioMaintenanceSeedPennWithStaffPhone`**. |
| **Router** | **`computeCanEnterCore`**: allow **`transportChannel === "portal"`** + **`_portalAction === "create_ticket"`** + staff **`managerLane`** so structured PM create can reach core without relying on `#` precursor only; **`runInboundPipeline`** passes **`portalAction`**. **`routeInboundDecision.test.js`** + **`ORCHESTRATOR_ROUTING.md`** updated. |

### Continue

Phase 2 of **`docs/HANDLE_INBOUND_CORE_REFACTOR_PLAN.md`** — mechanical extractions behind this net.

---

## 2026-05-02 — Preventive / program runs: preview, scope subset, FLOOR_BASED + commons, app UX

### Done

| Area | Notes |
|------|--------|
| **`expandProgramLines.js`** | **`FLOOR_BASED`** now appends **`common_paint_scopes`** as **`COMMON_AREA`** lines after floor lines (same profile as Properties → building structure). |
| **`programRuns.js`** | **`createProgramRun`**: optional **`includedScopeLabels`** filters expanded lines by trimmed **`scope_label`**; **`no_matching_scopes`** if empty after filter; **`previewProgramRunExpansion`** dry-run; **`deleteProgramRun`**. |
| **`registerPortalRoutes.js`** | **`POST .../program-runs/preview`**; create passes **`includedScopeLabels`**; **`DELETE .../program-runs/:id`**. |
| **Tests** | **`expandProgramLines.test.js`** — floors + commons case. |
| **propera-app** | **`/preventive`**: preview + **Areas in this run** checkboxes + **`includedScopeLabels`** on create; **`body-row` / `table-pane` / single `page-scroll`** so the page scrolls; property detail **building structure** + PATCH profile; friendly error for **`no_matching_scopes`**. |
| **Docs** | **`docs/PM_PROGRAM_ENGINE_V1.md`** — status, preview, create body, DELETE, app UI, implementation checklist, **Strategic reuse** (building structure → future tenant/staff/ops flows). **`docs/BRAIN_PORT_MAP.md`** — portal PM table; **`docs/PARITY_LEDGER.md`** snapshot line; **`AGENTS.md`** — stance + “update these docs” row + **Where everything lives**; **`README.md`** — runtime bullet for portal program API. |

### Ops

Restart **propera-v2** after pulling so portal expansion matches app preview.

---

## 2026-05-02 — WI_CREATED_UNSCHEDULED without default owner (`PING_UNSCHEDULED`)

### Done

| Area | Notes |
|------|--------|
| **`finalizeMaintenance.js`** | After WI insert, **`handleLifecycleSignal(WI_CREATED_UNSCHEDULED)`** runs for **`wiState === "UNSCHEDULED"`** (non-emergency). Removed incorrect gate on **`ownerId`** / `ASSIGN_DEFAULT_OWNER` — unscheduled open-service WIs now arm **`PING_UNSCHEDULED`** the same as assigned ones. |
| **Tests** | **`tests/lifecycleWiCreatedUnscheduled.test.js`** — mock Supabase: one **`PING_UNSCHEDULED`**, duplicate create cancels prior, **`ACTIVE_WORK_ENTERED`** leaves only **`PING_STAFF_UPDATE`**, emergency **`STAFF_TRIAGE`** holds with no timer. |

---

## 2026-05-02 — V2-first portal PM + propera-app route reconciliation

### Done

| Area | Notes |
|------|--------|
| **propera-app** | New **`/api/pm/{update-ticket,complete-ticket,delete-ticket,add-attachment,upload-attachment,create-property}`** routes; V2 via **`pmRouteHelpers`** + **`pmGasForward`** for GAS legacy; **`pmV2Proxy`** infers logical failure from `staff.resolution.error` and HTTP **422** from V2 on failed portal mutations |
| **propera-v2** | Portal **`attachments` / `attachmentUrls`** in JSON → **`portalTicketMutations`** merges into `tickets.attachments`; **`buildRouterParameterFromPortal`** treats attachments as PM-save hint; **`runInboundPipeline`** sets **`json.ok`** false when **`staffRun.ok === false`**; structured **`emit`** on **`/webhooks/portal`** (received / complete / failed) |
| **Tests** | **`tests/portalWebhookContract.test.js`** — noop body + parse for attachment append |

### Docs

**`AGENTS.md`**, **`README.md`** (v2 + app): operator stance **V2-first**, GAS legacy backup.

---

## 2026-05-02 — `portal_auth_allowlist` migration (021)

### Done

| Area | Notes |
|------|--------|
| **`021_portal_auth_allowlist.sql`** | Pre-approved emails, `portal_role`, optional `staff_id` → `staff(staff_id)`, RLS enabled (service role used by app) |

### Ops

Run after **`003_identity.sql`**. Seed rows for each allowed signup email. **`propera-app`** register/login unchanged — already targeted this table.

---

## 2026-05-02 — `program_lines` scope_type: drop SITE (020)

### Done

| Area | Notes |
|------|--------|
| **`020_program_lines_scope_type_common_area_only.sql`** | `SITE` → `COMMON_AREA`; check constraint `UNIT` / `COMMON_AREA` / `FLOOR` only |
| **`expandProgramLines.js`** | `COMMON_AREA_ONLY` emits `scope_type: COMMON_AREA` (not `SITE`) |

### Ops

Apply **`020_program_lines_scope_type_common_area_only.sql`** after **018** on any DB that still allows `SITE`.

---

## 2026-05-02 — `properties.program_expansion_profile` + migration 019

### Done

| Area | Notes |
|------|--------|
| **`019_properties_program_expansion_profile.sql`** | `properties.program_expansion_profile` jsonb default `{}` + comment |
| **`expandProgramLines.js`** | Optional third arg: `floor_paint_scopes` / `common_paint_scopes` override template defaults for `FLOOR_BASED` / `COMMON_AREA_ONLY` |
| **`programRuns.js`** | Loads profile on create; passes into `expandProgramLines` |
| **Docs / tests** | **`PM_PROGRAM_ENGINE_V1.md`**, **`supabase/migrations/README.md`**; **`expandProgramLines.test.js`** |

### Ops

Apply **`019_properties_program_expansion_profile.sql`** in Supabase if the column is missing (recovery DBs that only had 018).

---

## 2026-04-29 — PM / Tasks V1 spec + backend slice

### Done

| Area | Notes |
|------|--------|
| **`docs/PM_PROGRAM_ENGINE_V1.md`** | Locked **V1** definition (program runs + lines, templates, boundary vs reactive intake). |
| **`018_program_engine_v1.sql`** | `program_templates`, `program_runs`, `program_lines` + seed (`HVAC_PM`, `WATER_HEATER_PM`, `COMMON_AREA_PAINT`), RLS enabled. |
| **`src/pm/expandProgramLines.js`** | Pure expansion by `expansion_type`. |
| **`src/dal/programRuns.js`** | `createProgramRun`, list/detail, complete/reopen line + `event_log` (`PROGRAM_RUN_CREATED`, etc.). |
| **`registerPortalRoutes.js`** | `GET /api/portal/program-templates`, `GET/POST /api/portal/program-runs`, `GET .../program-runs/:id`, `PATCH .../program-lines/:id/complete`, `PATCH .../program-lines/:id/reopen`. |
| **`tests/expandProgramLines.test.js`** | Unit tests for expansion helpers. |

### Ops

Apply **`018_program_engine_v1.sql`** in Supabase (see **`docs/OUTSIDE_CURSOR.md`**) before using portal PM routes.

### Next

**propera-app:** `/preventive` page + `/api/program-*` proxy routes (see repo `propera-app/`).

---

## 2026-04-28 — Tenant roster portal API + propera-app `/tenants`

### Done

| Area | Notes |
|------|--------|
| **`014_tenant_roster_email.sql`** | Optional `email` on `tenant_roster`; index on `phone_e164`. |
| **`portalTenants.js`** | List/create/update/deactivate (`tenant_roster`); property resolved from display/short/code. |
| **`registerPortalRoutes.js`** | `GET/POST/PATCH/DELETE /api/portal/tenants`, `gas-compat?path=tenants`. |
| **propera-app** | `/tenants` owner-only UI + `/api/tenants` proxy to V2; Contact Picker button when supported; staff redirected off `/tenants`. |

### Commands

```bash
cd propera-v2 && npm test
cd ../propera-app && npm run build
```

---

## 2026-04-19 — Staff #capture: tenant roster phone (GAS Tenants sheet)

### Done

| Area | Notes |
|------|--------|
| **Migration `012_tenant_roster.sql`** | `tenant_roster` — `property_code`, `unit_label`, `phone_e164`, `resident_name`, `active` (GAS sheet parity). |
| **`tenantRoster.js`** | `findTenantCandidates`, `resolveStaffCaptureTenantPhone`, `pickResolvedTenantPhone` — same match rules as GAS (`score >= 85` when name hint, single row, etc.). |
| **`extractStaffTenantNameHintFromText.js`** | GAS tail hint + **leading** hint (`Maria report from…`). |
| **`finalizeMaintenance.js`** | MANAGER: `tenant_phone_e164` / `work_items.phone_e164` from resolved tenant only; **`conversation_ctx`** upserts tenant phone when matched (not staff). |
| **`handleInboundCore.js`** | Before finalize (fast + multi-turn): `resolveManagerTenantIfNeeded` + merged body/OCR for hints. |
| **Docs / tests** | **`PARITY_LEDGER.md`** §6, **`PORTING_FROM_GAS.md`**, **`OUTSIDE_CURSOR.md`**, **`supabase/migrations/README.md`**; **`tests/staffCaptureTenantLookup.test.js`**. |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-19 — `normalizeUnit_` in canonize (GAS `17` ~2247–2258)

### Done

| Area | Notes |
|------|--------|
| **`extractUnitGas.js`** | Exported **`normalizeUnit_`** — same logic as GAS (strip apt/suite prefixes, trailing punct, uppercase). |
| **`canonizeStructuredSignal.js`** | Applies **`normalizeUnit_`** to structured `unit` after copy from raw (matches **`properaCanonizeStructuredSignal_`** ~1299–1301). |
| **Tests** | `canonizeStructuredSignal.test.js` — `apt 402b` → `402B`. |
| **Docs** | **`PARITY_LEDGER.md`** §1 / §7; **`PORTING_FROM_GAS.md`** unit row. |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-19 — Intake: GAS `properaCanonizeStructuredSignal_` property grounding + `compileTurn` propertiesList

### Done

| Area | Notes |
|------|--------|
| **`lifecycleExtract.js`** | **`phraseInNormalizedText`**, **`resolvePropertyFromTextStrict`** — GAS `phraseInText_` + strict branch of `resolvePropertyFromText_` (`17_PROPERTY_SCHEDULE_ENGINE.gs`). |
| **`canonizeStructuredSignal.js`** | When **`propertiesList`** is non-empty, property fields follow GAS `07` ~1399–1426 (explicit-only then strict phrase); **`queryType`**, **`ambiguity`**, **`access_notes` → `schedule.raw`** aligned with GAS. |
| **`compileTurn.js`** | Forwards **`propertiesList`** into **`properaBuildIntakePackage`** (was dropped before — LLM canonize could not ground). |
| **`properaBuildIntakePackage.js`** | Passes **`propertiesList`** into **`properaCanonizeStructuredSignal`** on LLM path. |
| **Tests** | `tests/canonizeStructuredSignal.test.js`. |
| **Docs** | **`PARITY_LEDGER.md`** §1 + §7; **`PORTING_FROM_GAS.md`** compile row. |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-19 — PARITY_LEDGER GAS inventory completeness

### Done

| Area | Notes |
|------|--------|
| **`docs/PARITY_LEDGER.md`** | **§ GAS V1 engine file → V2 coverage map** now lists **`27_DEV_TOOLS_HARNESS.gs`** and **`apps-script/ProperaPortalAPI.gs`**, plus an explicit **inventory** paragraph: every numbered `01`–`27` root engine is accounted for; “accounted for” ≠ “fully PORTED”. **§7** scope note points agents at closing PARTIAL rows, not hunting orphan files. |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-18 — Documentation sync (orchestrator + outgate + README reality)

### Done

| Area | Notes |
|------|--------|
| **README / AGENTS / BRAIN_PORT_MAP** | Current scope: Twilio + Telegram, `runInboundPipeline`, `routeInboundDecision`, Outgate `dispatchOutbound`, migrations **011** — no “Phase 0 / no DB” drift. |
| **PORTING_FROM_GAS** | Rows for orchestrator + outgate partial port. |
| **ORCHESTRATOR_ROUTING** | Linked from README, AGENTS, BRAIN_PORT_MAP, PROPERTY_POLICY_PARITY, PARITY_LEDGER §9. |
| **STRUCTURED_LOGS** | Documents `log_kind: outgate`, `LANE_STUB`. |
| **PROPERA_V2_GAS_EXIT_PLAN** | `gateway-router-telegram-first` todo set **in_progress** with accurate remainder. |
| **TESTING_STRATEGY** | `routeInboundDecision` in unit-test row. |
| **ADAPTER_ONBOARDING** | Outbound-only-via-outgate rule. |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-18 — `recomputeDraftExpected` expiry parity + tests

### Done

| Area | Notes |
|------|--------|
| **`expiryMinutesForExpectedStage`** | GAS `11_TICKET_FINALIZE_ENGINE.gs` ~174: 30 min for `SCHEDULE` / `SCHEDULE_PRETICKET`, else 10; `null` when `next` is empty. |
| **`recomputeDraftExpected` return** | Adds **`expiryMinutes`** for callers / logs. |
| **`handleInboundCore`** | `computePendingExpiresAtIso` uses **`expiryMinutesForExpectedStage`** (single source with recompute). |
| **Tests** | Post-ticket + `hasSchedule` → empty `next`; `skipScheduling` → `EMERGENCY_DONE` on post-ticket schedule branch; expiry minutes assertions. |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-18 — ATTACH_CLARIFY resolution path (conversation_ctx + core)

### Done

| Area | Notes |
|------|--------|
| **`parseAttachClarifyReply.js`** | GAS `16_ROUTER_ENGINE.gs` ~470–482: digits `1`/`2`, NL `same request` / `new one` / etc., with stripped remainder. |
| **`conversationCtxAttach.js`** | `getConversationCtxAttach`, `clearAttachClarifyLatch` — clear `pending_expected` after resolution. |
| **`handleInboundCore.js`** | If `conversation_ctx.pending_expected === ATTACH_CLARIFY`, resolve before multi-turn merge; **`start_new`** clears session + restarts like existing latch; **`attach`** sets `attachClarifyOutcome` + `effectiveBody`. |
| **`intakeAttachClassify.js`** | `attachClarifyOutcome: 'attach'` skips unit-mismatch **`clarify_attach_vs_new`** and handles digit/phrase attach class (`PROPERA_MAIN_BACKUP` class). |
| **`mergeMaintenanceDraft.js`** | Passes `attachClarifyOutcome` through. |
| **Tests** | `parseAttachClarifyReply.test.js`, merge bypass test. |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-18 — GAS `parseIssueDeterministic_` port + intake fallback alignment

### Done

| Area | Notes |
|------|--------|
| **`issueParseDeterministic.js`** | Full port of GAS `issueParseDeterministic_` (`09_ISSUE_CLASSIFICATION_ENGINE.gs`) with bundled helpers from `14_DIRECTORY_SESSION_DAL.gs` / `16_ROUTER_ENGINE.gs` (`looksActionableIssue_`, `isScheduleWindowLike_`, `looksLikeAckOnly_`, etc.). Category via `localCategoryFromText` (`ticketDefaults.js`). |
| **`properaBuildIntakePackage.js`** | Deterministic path now matches GAS `properaFallbackStructuredSignalFromDeterministicParse_` (`07_PROPERA_INTAKE_PACKAGE.gs`): multi-clause **issues** array, confidence **0.35**, `issueMeta` from parsed output (`issue_parse_deterministic`). Removed ad-hoc `parseIssueDeterministicV2` strip-only helper. |
| **Tests** | `tests/issueParseDeterministic.test.js` |
| **Docs** | **`PARITY_LEDGER.md`** §1 + §7, **`PORTING_FROM_GAS.md`** table |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-17 — AGENTS.md bootstrap roadmap (execution order)

### Done

- Added **Bootstrap roadmap** section to **`AGENTS.md`**: numbered priorities (maintenance parity → router front door → compile/intake truth → tests → staff lifecycle → media/OCR → docs), aligned with **`PARITY_LEDGER.md` §7** and the “continue V2” workflow.

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-17 — Session wrap (docs sync + maintenance intake parity)

### Shipped this session (high level)

| Area | Notes |
|------|--------|
| **Intake merge / session** | `issue_buf_json` read/write + accumulation; deterministic **attach classify** port (`intakeAttachClassify.js`) wired into `mergeMaintenanceDraftTurn`; `handleInboundCore` handles **`ATTACH_CLARIFY`** (`conversation_ctx.pending_expected`) and **`start_new_intake`** restart path. |
| **Property grounding** | DB-backed menu rows now include `ticket_prefix`, `short_name`, `address`; variant expansion closer to GAS `buildPropertyVariants_` (still **PARTIAL** — see ledger). |
| **Multi-ticket finalize** | Split finalize with regression guard so split mode never also emits the full combined string as its own ticket. |
| **Regression net** | `npm test` — **85** passing at session end. |

### Docs updated (same session)

| File | Why |
|------|-----|
| **`PARITY_LEDGER.md`** | Merge + session rows reflect attach classify + issue buffer progress. |
| **`PORTING_FROM_GAS.md`** | Maps `properaIntakeAttachClassify_` → V2 partial port. |
| **`BRAIN_PORT_MAP.md`**, **`PROPERA_V2_GAS_EXIT_PLAN.md`**, **`AGENTS.md`**, **`README.md`**, **`OUTSIDE_CURSOR.md`**, **`STRUCTURED_LOGS.md`** | Handoff truth + ops notes aligned with code (session-end sync). |

### Next session (recommended order)

1. **`ATTACH_CLARIFY` resolution path** in V2 core (digits `1/2`, same-request / new-issue phrases) — still partial vs GAS router latch.  
2. **`PARITY_LEDGER.md` §7** remaining rows: full compile/intake + full router graph (out of scope for this session).  

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-17 — Channel-agnostic media bridge (adapter-neutral core)

### Done

| Area | Change |
|------|--------|
| **Core contract** | Added shared media helpers in `src/brain/shared/mediaPayload.js` to parse `_mediaJson` and compose inbound text with media text hints (`ocr_text` / `text` / `transcript` / `caption`) in a channel-agnostic way. |
| **Router/core wiring** | `normalizeInboundEventFromRouterParameter` now parses `_mediaJson` into `event.media` and sets `meta.numMedia`. Core entry (`src/index.js`) merges body text + media text hints before `handleInboundCore` (same path for any adapter using `_mediaJson`). |
| **Telegram adapter (producer only)** | `normalizeTelegramUpdate` now emits media metadata for photo/document; `buildRouterParameterFromTelegram` serializes this to `_mediaJson`. This is adapter output only — core logic remains transport-neutral. |
| **Tests** | Added `tests/mediaPayload.test.js` and `tests/telegramMediaBridge.test.js` (media parse/merge and adapter-to-contract bridge coverage). |
| **OCR hook (optional)** | Added channel-agnostic OCR orchestrator `src/brain/shared/mediaOcr.js` and Telegram producer hook `src/adapters/telegram/enrichTelegramMediaWithOcr.js`. Enabled only with `INTAKE_MEDIA_OCR_ENABLED=1`; writes `ocr_text` into `_mediaJson` contract before core intake. |
| **Ticket evidence persistence** | `finalizeMaintenanceDraft` now maps `_mediaJson` to `tickets.attachments` (URL preferred, fallback provider token like `telegram:<file_id>`), and logs media summary in `work_items.metadata_json`. |
| **Agent onboarding docs** | Added `docs/ADAPTER_ONBOARDING.md` and linked it from `AGENTS.md`, `README.md`, `BRAIN_PORT_MAP.md` so a new agent can start from `AGENTS.md` and execute channel additions without re-explaining architecture. |
| **Slot parity (recompute opener branch)** | `recomputeDraftExpected` now ports opener-driven pre-ticket schedule branch (`SCHEDULE_PRETICKET`) and emergency override for both `SCHEDULE` and `SCHEDULE_PRETICKET`. Compile parse now carries `scheduleRaw`/`openerNext` hints into merge/recompute. |
| **Explicit-only property grounding** | Added `resolvePropertyExplicitOnly` parity slice and wired it into deterministic compile intake + property-reply resolution; avoids broad contains false-positives (`morning` no longer maps to `MORRIS` in compile path unless explicit property mention). |
| **Session/recompute parity slice** | Ported active-ticket recompute guard (continuation whitelist) and session expiry sync (`expires_at_iso` 10/30 min by expected stage) in V2 core/session upsert path. |
| **Multi-ticket creation slice** | Added deterministic issue grouping (`buildIssueTicketGroups`) and finalize loop so distinct issue families create multiple tickets, while same-system sub-issues stay bundled (e.g. AC filter + AC drain => one ticket group). |
| **Maintenance parity hardening (property + merge)** | Ported more GAS-like property variants into V2 grounding (`ticket_prefix`, `short_name`, `address` tokens + stripped name variants from DB-backed `properties`) and added slot-stage issue capture in merge so actionable issue text is not dropped during PROPERTY/UNIT/SCHEDULE collection turns. |
| **Issue buffer parity slice** | Wired `issue_buf_json` through V2 intake session/core merge path: read from session, accumulate distinct issue snippets during slot collection, persist on upsert, and include buffered issue text in finalize split/e-mergency evaluation input. |
| **Attach classifier parity slice** | Ported deterministic GAS `properaIntakeAttachClassify_` rules into V2 merge (`intakeAttachClassify.js`): schedule-only turns no longer append as issues, pure property/unit slot replies stay slot-only, continuation split can append residual symptom, unit mismatch without explicit new markers surfaces `clarify_attach_vs_new` and sets `conversation_ctx.pending_expected=ATTACH_CLARIFY` via `conversationCtxAttach.js`. |

### Next / open

| Item | Notes |
|------|--------|
| **OCR/vision parity** | Optional OCR works for Telegram producer path, but full GAS media queue/vision semantics are still partial. |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-17 — DB-managed property aliases (no hardcoded property names)

### Done

| Area | Change |
|------|--------|
| **Schema** | Added migration `supabase/migrations/009_property_aliases.sql` (`property_code`, `alias`, `active`) for config-driven aliases per property. |
| **DAL** | `listPropertiesForMenu` now reads aliases from DB table `property_aliases` when present and attaches `aliases` per property; safe fallback to `properties` only when table is absent. |
| **Detection path** | `detectPropertyFromBody` variant set now includes DB aliases (`propertiesList[].aliases`) in addition to code/display-name tokens. |
| **Tests** | Added alias token assertions in draft parse/merge tests; fixtures are generic (non-tenant-branded). |
| **Ops helper** | Added optional migration `010_property_aliases_seed_from_properties.sql` to backfill aliases from existing `properties` rows (idempotent convenience seed). |

### Next / open

| Item | Notes |
|------|--------|
| **Full GAS parity** | Still partial vs GAS `buildPropertyVariants_` + ticketPrefix semantics and explicit-only grounding chain. |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-17 — Property detect slice + merge uses async parsed draft

### Done

| Area | Change |
|------|--------|
| **Property detection (tenant maintenance)** | Added `detectPropertyFromBody` in `src/brain/staff/lifecycleExtract.js` (GAS slice): standalone menu digit, code/compact token, strong display-name token with stopwords. Wired into `parseMaintenanceDraft` and deterministic intake package path (`properaBuildIntakePackage`). |
| **Merge path intake** | `mergeMaintenanceDraftTurn` now accepts `parsedDraft` (from `parseMaintenanceDraftAsync`) and uses it as slot source when provided; `handleInboundCore` passes async parse output into merge for multi-turn maintenance path. |
| **Tests** | Added coverage in `tests/mergeMaintenanceDraft.test.js` and `tests/parseMaintenanceDraft.test.js` for strong name detection + parsedDraft merge usage. |

### Next / open

| Item | Notes |
|------|--------|
| **Full GAS property grounding** | Still missing `_variants` / ticketPrefix directory semantics and broader intake grounding (`resolvePropertyExplicitOnly_` class). |
| **Compile-driven merge semantics** | Merge accepts async parsed data, but full GAS compile/intake slot semantics are still partial (see `PARITY_LEDGER.md` §1–2). |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-14 — Intake logs on post-finalize schedule turns

### Done

| Area | Change |
|------|--------|
| **Schedule capture branch** | When `expected === "SCHEDULE"` and there is an `active_artifact_key` (post-finalize window ask), **`handleInboundCore`** now **`await`s `parseMaintenanceDraftAsync`** before `mergeMaintenanceDraftTurn`. Discards parse result for apply — merge + `applyPreferredWindowByTicketKey` unchanged. **`INTAKE_PARSE_BRANCH`** / **`INTAKE_BRAIN_PATH`** (and compile path when `INTAKE_COMPILE_TURN=1`) now match other core turns. |
| **Docs** | **`PARITY_LEDGER.md`** §1 row, **`STRUCTURED_LOGS.md`** gap note updated. |

### Next / open (unchanged priorities)

| Item | Notes |
|------|--------|
| **Merge slot fill vs compile** | `mergeMaintenanceDraftTurn` still uses sync `parseMaintenanceDraft` internally; driving merge slots from `compileTurn` output is a larger port (see **PARITY_LEDGER.md** §7). |
| **`detectPropertyFromBody_`** | Still heuristic `extractPropertyHintFromBody` — ledger #1 recommended port. |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-04-11 — Ops dashboard, flight recorder, intake env, tenant UX

### Done (this session / thread)

| Area | Change |
|------|--------|
| **Ops dashboard** | Tenant sidebar + filters aggregate by **Telegram user id** (`telegram_user_id` / `payload.ctx.tg_user_id`), not only `actor_key`. API: `fetchEventLogForDashboard` in `src/dashboard/eventLogApi.js`. |
| **Dashboard UI** | Request cards are **outcome-first**: prominent hero (Tenant, Message, Result, Ticket, LLM, Duration). Raw `event_log` rows are in **`<details>`** — **collapsed by default**; expand for timestamps/payloads. Summary lines derived client-side from events (`summarizeRequest` in `dashboardPage.html`). |
| **Tenant receipt** | Finalize SMS/TG copy no longer includes **WI id** or **ticket_key UUID** — human ticket id + property/unit only (`handleInboundCore.js`). |
| **Flight recorder (Supabase `event_log`)** | **Schedule policy:** `SCHEDULE_PARSED`, `SCHEDULE_POLICY_CHECK`, `SCHEDULE_POLICY_OK` / `SCHEDULE_POLICY_REJECT` / `SCHEDULE_POLICY_ERROR` from `ticketPreferredWindow.js` (mirrors stdout). Duplicate `SCHEDULE_POLICY_REJECT` only in core removed. |
| **Flight recorder** | **Intake:** `INTAKE_PARSE_BRANCH`, `INTAKE_BRAIN_PATH` (incl. `llm_structured_used`, `summary`). **Regex-only** path logs when `INTAKE_COMPILE_TURN` is off. |
| **Flight recorder** | **Staff:** `STAFF_TARGET_RESOLVED` / `STAFF_TARGET_UNRESOLVED` enriched with `property_id`, `unit_id`, `open_wi_count`, `summary` where applicable. |
| **`.env` loading** | `dotenv` now loads **`propera-v2/.env`** via path from `src/config/env.js` (`path.join(__dirname, '..', '..', '.env')`) so **`npm start` from a parent directory** still picks up `INTAKE_COMPILE_TURN`, Supabase keys, etc. |
| **Flags** | `INTAKE_COMPILE_TURN` and `INTAKE_LLM_ENABLED` accept **`1`, `true`, `yes`, `on`** (trimmed, case-insensitive). Pre-set shell env vars still override `.env` (dotenv default). |
| **Structured logs doc** | See updated **[STRUCTURED_LOGS.md](./STRUCTURED_LOGS.md)** for stdout vs DB coverage. |

### Known gaps / next session candidates

| Item | Notes |
|------|--------|
| **Merge path intake** | Multi-turn draft still uses **sync** `mergeMaintenanceDraft` + `parseMaintenanceDraft` — **no** `INTAKE_PARSE_BRANCH` / `INTAKE_BRAIN_PATH` on those turns unless wired to `parseMaintenanceDraftAsync` / compile. See `PARITY_LEDGER.md` §1–2. |
| **GAS parity** | No change to “semantic parity” claims — dashboard + logging are **operational**; ledger rows for STUB/PARTIAL brain remain. |
| **Dashboard auth** | Optional `DASHBOARD_TOKEN`; use **http** locally if server is http (see README). |

### Commands unchanged

```bash
cd propera-v2
npm test
npm start
```

---

## Template for future entries

```markdown
## YYYY-MM-DD — short title

### Done
- ...

### Next / open
- ...
```
