# Handoff log — propera-v2

**Purpose:** Short, dated notes so the **next agent** knows what landed recently and where to continue.  
**Not** a substitute for **[PARITY_LEDGER.md](./PARITY_LEDGER.md)** (GAS ↔ V2 truth) or **[AGENTS.md](../AGENTS.md)** (rules).

**How to use:** Read the **latest dated section** first, then **`PARITY_LEDGER.md`**, **`BRAIN_PORT_MAP.md`**, and **`AGENTS.md`** as usual.

---

---

---

---

---

## 2026-06-15 (g) — Step 2 ledger mimic pilot (WESTFIELD unit 101)

**Why:** Close Phase 1.6 loop for tenant ledger — LH `posted_transactions` → idempotent `tenant_ledger_entries` without staff re-keying. One-unit pilot before full building.

### Done

| Area | Change |
|------|--------|
| **Migration 108** | `108_accounting_import_ledger.sql` — `accounting_import` source + `import_idempotency_key` unique index |
| **V2 brain** | `ledgerEventSignal.js`, `postLedgerEventSignal.js`; `handleAccountingImportSignals.js` processes lease + ledger signals |
| **Bridge** | `buildLedgerEventSignals.js`, `ledger-mimic-pilot.json` — **WESTFIELD unit 101** only |
| **App** | `enrichAccountingImportSignals.ts` — all signal kinds → `unit_catalog_id`; import returns `ledger_created` / `ledger_skipped_existing` |
| **Tests** | `propera-v2/tests/ledgerEventSignal.test.js`; `leasehold-bridge/tests/buildLedgerEventSignals.test.js` |
| **Verify SQL** | `supabase/queries/verify_ledger_mimic_westfield_101.sql` |

### Deploy

1. Apply migration **108** on Supabase  
2. Deploy **propera-v2**, **propera-app**, **leasehold-bridge**  
3. Run WESTFIELD sync (`sync-changed` or manual import)  
4. Compare unit 101 — SQL above + LH screen spot-check  

### Next agent

1. Validate unit **101** ledger vs snapshot  
2. Expand `ledger-mimic-pilot.json` → full **WESTFIELD** building  
3. **Step 4** policy hooks  
4. **Phase 5b** tenant ledger report for WESTFIELD  
5. Per-building cutover doc (cutoff date, balance source, stop double-post)  

---

## 2026-06-15 (f) — Bridge emits `lease_terms_sync` signals[]

**Why:** LH adapter at source; app forwards structured intent, not raw matched facts.

### Done

| Area | Change |
|------|--------|
| **Bridge** | `src/signals/buildLeaseTermsSyncSignals.js` — `signals[]` on every import payload |
| **App** | `enrichLeaseTermsSignals.ts` — resolve `unit_label` → `unit_catalog_id`; prefer signals over matched facts |
| **V2 brain** | Staff charge-line mode merge at post time (`postLeaseTermsSync.js`) |
| **Tests** | `leasehold-bridge/tests/buildLeaseTermsSyncSignals.test.js` |

### Deploy

Requires **leasehold-bridge** (office syncher), **propera-app**, and **propera-v2** — all three for signal path.

---

## 2026-06-15 (e) — `lease_terms_sync` signal contract + thin brain handler

**Why:** Channel-agnostic architecture — LH today, cockpit tomorrow, Jarvis/agents later. Brain validates intent signals; adapters normalize transport.

### Done

| Area | Change |
|------|--------|
| **Contract** | `ACCOUNTING_SIGNAL_SCHEMA.md` — locked `lease_terms_sync` envelope + validation rules |
| **Brain** | `leaseTermsSyncSignal.js`, `postLeaseTermsSync.js`, `handleAccountingImportSignals.js` |
| **LH adapter** | `adapters/leasehold/normalizeLeaseholdFactToLeaseTermsSync.js` — fact → signal (pet fee, deposits, charge_lines) |
| **Route** | `POST /api/portal/financial/accounting-import-signals` (primary); legacy `materialize-leases-from-import` aliases |
| **App** | Proxies to `accounting-import-signals` with `matched` facts (adapter on V2) |
| **Tests** | `tests/leaseTermsSyncSignal.test.js` + existing `leaseImportFacts.test.js` |

### Producers (same spine)

- `leasehold_import` — adapter normalizes LH snapshot
- `portal_lease_edit` — future cockpit form
- `jarvis_confirm` — future staff confirm
- `agent_proposal` — future multi-agent

---

## 2026-06-15 (d) — Lease materializer moved to V2 brain (Step 1 clean path)

**Why:** Owner chose channel-agnostic architecture from the start — `unit_leases` posting belongs in **propera-v2** brain, not propera-app.

### Done

| Area | Change |
|------|--------|
| **V2 brain** | `src/brain/financial/leaseImportFacts.js`, `materializeLeaseShellFromFacts.js`, `handleAccountingImportLeases.js` |
| **Route** | `POST /api/portal/financial/materialize-leases-from-import` (portal token) |
| **App** | Snapshots still upsert in app; lease post via `materializeLeasesViaV2.ts` → V2 proxy only |
| **Tests** | `propera-v2/tests/leaseImportFacts.test.js` (7 tests); run `npm test` in propera-v2 |

### Deploy note

**V2 Cloud Run restart required** after this lands — app-only deploy is insufficient for lease materialization.

---

## 2026-06-15 (c) — Lease materializer Step 1 (Phase 1.6)

**Why:** Every occupied LH unit needs a full `unit_leases` row (rent, dates, deposits, charge_lines) — not just net-rent/deposit enrichment. Required before renewals/actions; roster reconcile not blocking.

### Done

| Area | Change |
|------|--------|
| **Logic** | `propera-app/src/lib/server/leaseImportFacts.ts` — occupied gate, LH patch builder, change detection, invalid date guard |
| **Import** | `leaseMaterializeImport.ts` — upsert on `importAccountingSnapshots`; preserves `renewal_status`, `renewal_notes`, `notes` |
| **Charge lines** | `hasStaffChargeTemplate`, `refreshChargeLineAmountsFromAncillary` in `unitChargePrefill.ts` |
| **Tests** | `npm run test:lease-materialize` (7 tests) |
| **UI** | `/financial/imports` shows leases created/updated count |

### Field ownership (locked)

- **LH overwrites:** rent, dates, deposits, charge_lines (amounts; staff modes preserved when template saved)
- **Never touched:** `renewal_status`, `renewal_notes`, `notes`
- **Vacant LH units:** skip (no insert/update)

### Verify after import

Re-import one property → check `unit_leases` has rows matching snapshot rent/dates for occupied units.

---

## 2026-06-15 (b) — Owner cutover intent + staff-minimal finance

**Why:** Owner wants to **switch to Propera** after finance is complete — not run Leasehold forever. Emphasis: easy payment recording, bank reconciliation, automation (captures, deposits), minimal staff system time, **complete report section for accountant**.

### Done

| Area | Change |
|------|--------|
| **PROPERA_FINANCE_ROADMAP.md** | Owner cutover intent; §Staff-minimal finance; Phase **5b** reports; Phase **6** reframed as cutover target + gate |
| **ACCOUNTING_SIGNAL_SCHEMA.md** | §End state — financially complete |
| **PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md** | Finance end state in north star; non-goals → phased cutover goals |
| **AGENTS.md** | Finance guardrail — owner cutover intent |

---

## 2026-06-15 — Accounting signal schema doc (Leasehold mimic)

**Why:** Phase 1.5 ingest is display-only. Product direction (from prior sessions): Leasehold-bridge should mimic staff actions into Propera via structured signals — not stay read-only forever. Spec was discussed but never written.

### Done

| Area | Change |
|------|--------|
| **Spec SSOT** | **`docs/ACCOUNTING_SIGNAL_SCHEMA.md`** — adapter pattern, signal kinds, idempotency, field ownership, build Steps 0–4, cutover/strangler, implementation status |
| **Finance roadmap** | Phase **1.6** row added; intelligence item 7 points to mimic doc |
| **AGENTS.md** | Finance mandatory read #2; Phase 1.6 in roadmap table; doc update table row |
| **FINANCIAL_LEASEHOLD_SYNC.md** | Target-state pointer to schema doc |

### Not built (next work per schema)

1. **Step 0** — finish tenant roster ↔ LH reconcile (SQL workflow exists; WESTFIELD/PENN in progress)
2. **Step 1** — lease materializer on import (`unit_leases` from snapshot)
3. **Step 2** — ledger materializer + migration **108+** (`accounting_import`)
4. **Step 3** — bridge `signals[]` + `handleAccountingImportSignals`

---

## 2026-06-12 — Documentation sync (codebase reality audit)

### Done

| Area | Change |
|------|--------|
| **`AGENTS.md`** | Finance phase migration numbers corrected (**103+** for Phase 2–5; **053–057 consumed**); vendor lane V0–V2 shipped; CME-2 shipped; ticket split **`061`** correction; balance reminder row; red test count **~13 flaky** |
| **`PARITY_LEDGER.md`** | GAS engine map rows **21–26** split GAS-brain vs V2-native (comm, access, leasing portal, vendor partial); §7 “other lanes” updated |
| **`PROPERA_FINANCE_ROADMAP.md`** | Migration table: **094–097 applied**; Phase 2–5 renumbered **103+**; **053** financial intake marked applied |
| **`BRAIN_PORT_MAP.md`** | Vendor lane live (`handleVendorInbound`); balance reminder automation block (**098–101**) |
| **`ORCHESTRATOR_ROUTING.md`** | Identified vendor → handler; unidentified → stub |
| **`VENDOR_LANE.md`**, **`BALANCE_REMINDER_AUTOMATION.md`**, **`OPEN_DECK_DAY_CHART_V1.md`** | Stale stub/planned/migration references fixed |
| **`supabase/migrations/README.md`** | Added **053**, **061**, **069**, **073**, **098–102** |
| **`TESTING_STRATEGY.md`** | §Known flaky failures (**~13** reds, do-not-fix rule) |
| **`propera-app/AGENTS.md` + `README.md`** | Leasing, access, conflicts, balance reminders, tenant portal feature rows |
| **`PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md`** | Layer 1.5/1d shipped, comm/balance-reminder/vendor surfaces, §2.6–2.9, migration footer |
| **`PROPERA_FINANCIAL_LAYER_MAP.md`** | **053**, **082**, **098–101** tables; balance reminder section |
| **`TICKET_SPLIT_V1.md`**, **`PORTING_FROM_GAS.md`**, **`BRAIN_PORT_MAP.md`** | **061** collision; vendor orchestrator routing |

### Test baseline

```bash
cd propera-v2 && npm test
# ~1195 pass / ~13 fail (tenant-agent gather/handoff drift + cancel layer unimplemented)
```

### Still open (docs only — not code)

| Item | Notes |
|------|--------|
| **Migration 100 collision** | Two files share prefix `100` — apply both; consider renumber in cleanup |
| **Phase 2 finance schema** | Pick **103+** when implementing `rent_postings` |
| **Tenant-agent red tests** | Fix only with explicit user approval |

---

## 2026-06-08 (b) — Westfield deposit reconciliation + migration 097

### Done

| Area | Change |
|------|--------|
| **leasehold-bridge (M1)** | `deriveUnitDeposits.js` — key label expansion, signed key lines, same-day security cluster turnover, stale Other after key opening, S.Dat `ADJ` in security, pet/key net sums; `parseDepositLedgerDat.js` R.Dat labels; OXPS regression tests; `scripts/reconcileOxpsWestfield.js` |
| **Westfield** | **29/30** units match LH OXPS print (`westifield2.oxps`); **unit 314** Other $700 still null — **mirror gap** (no 314 rows in `RA0003S.Dat` / `R.Dat`), not parser bug |
| **Migration 097** | `unit_leases.other_deposit_cents`, `pet_deposit_cents` — apply on office Supabase with **094–096** |
| **Docs** | Deposit invariant + manual override SQL (`units` join, not `unit_catalog`) in `FINANCIAL_LEASEHOLD_SYNC.md` |

### Ops (office)

1. Apply **097** if `other_deposit_cents` column missing.
2. Re-import **WESTFIELD** (and other properties) after bridge fixes — **Financial → Imports**.
3. Unit **314:** refresh mirror from `\\lhdata` **or** interim SQL `other_deposit_cents = 70000` (cleared on next import until mirror fixed).
4. Spot-check unit hub vs LH screen: **LH Sec + Other = Propera Sec + Key + Pet + Other**.

```powershell
cd leasehold-bridge
npm test
npm run validate:deposits
```

---

## 2026-06-08 — Leasehold financial snapshot ingest + office syncher spec

### Done

| Area | Change |
|------|--------|
| **Migrations** | **094** `tenant_account_snapshots`; **095** net rent enrichment; **096** key + `deposits_derived_at`; **097** other + pet deposits |
| **propera-app import** | `accounting-snapshots`, `run-leasehold`, `run-leasehold-all`; batched `leaseEnrichmentImport`; typed `leaseholdBridgeExport.ts` |
| **Portfolio math** | `financialSnapshot.ts` — tenant obligation from enriched net or billed; credits = billed − net per unit; simplified subtitles |
| **UI** | Overview financial KPIs (Billed, Collected, Collection rate, Balance due); Financial nav under All Tickets; deposits on unit hub + property financial |
| **leasehold-bridge** | Deposit parsers (S.Dat/R.Dat), pet fee naming, strict net-rent ADJ rules, batched import support |
| **Vercel build** | TypeScript fixes `leaseholdBridgeExport`, `tenantLedgerMath` (commit `e409cfa`) |
| **Cloud Run prod** | `npm run cloud-run:deploy-prod` — revision **00015** healthy; deploy skips missing optional Secret Manager bindings |
| **Docs** | `propera-app/docs/FINANCIAL_LEASEHOLD_SYNC.md`; finance roadmap Phase 1.5 updated |

### Architecture locked (office syncher)

```text
\\lhdata → office mirror (not Propera) → robocopy → Propera staging → bridge → import API
```

- Never touch `\\lhdata` or office mirror writes.
- Incremental: fingerprint `RA####.DAT` / `H.Dat` / `S.Dat` / `R.Dat` per property; import only changed.
- Schedule: **Mon–Sat every 5 min**, **Sunday every 6 h**.

### Next / open

| Item | Notes |
|------|--------|
| **Office PC** | Copy `leasehold-bridge` to office; set mirror source + staging paths; `npm install` |
| **`sync-changed` script** | robocopy + cursor + POST import — not in repo yet |
| **M2M import secret** | `PROPERA_FINANCIAL_IMPORT_SECRET` for unattended office POST |
| **Task Scheduler** | Two tasks (weekday 5 min, Sunday 6 h) |
| **Apply 094–097** | Supabase SQL Editor if not already applied |
| **Re-import all 5** | After enrichment changes |

### Commands

```bash
# Local dev import (machine with bridge + mirror)
cd propera-app
# Financial → Imports → Import all properties

# Cloud Run prod deploy
cd propera-v2
npm run cloud-run:deploy-prod
```

---

## 2026-06-06 — Jarvis reasoning read agent (slice 1): tool-driven, not intent-parsed

**Why:** The Jarvis *write* spine is mature, but the *read* side was a fixed intent parser (`classifyJarvisIntent` + `parseServiceHistoryQuestion` → pre-fetch a fixed fact pack → phrase). Product direction: Jarvis should **understand the question and go look for the answer**, fetching different data per question, not match phrasings to canned reports.

| Area | Change |
|------|--------|
| **New module** | `src/agent/jarvisReason/` — `ticketLookupTool.js` (flexible read-only `lookup_tickets`: filters property/status/category/priority/text/assignee/scheduled/date-range, plus `groupBy` + `countOnly`; reads `portal_tickets_v1`, recent-window capped at 300 with a `capped` floor flag) and `runJarvisReasoning.js` (bounded OpenAI **tool-calling loop**: model chooses lookups, may call several times, then answers; facts-only/read-only system prompt; forced no-tool summary on step/budget exhaustion; test seam `setReasonChatForTests`). |
| **Wiring** | `handleJarvisAskTurn.js` — when `JARVIS_REASON_ENABLED` and a question is present, run the reasoning loop **first**; on disabled/no-key/failure it falls back to the existing `gatherJarvisFacts` deterministic path. Logs `JARVIS_REASON_ANSWERED` with the lookup trace. |
| **Env** | `src/config/env.js` + `.env.example`: `JARVIS_REASON_ENABLED` (default off), `JARVIS_REASON_MODEL` (defaults to `JARVIS_ASK_LLM_MODEL`), `JARVIS_REASON_MAX_STEPS` (1–8, default 4), `JARVIS_REASON_TIMEOUT_MS` (3–60s, default 25s). |
| **Tests** | `tests/agent/jarvisReason/ticketLookupTool.test.js` + `runJarvisReasoning.test.js` (11 tests, all green); added `tests/agent/jarvisReason/*.test.js` to the `npm test` glob. |

**Scope:** Read-only (Tier 0) — no writes, no new brain mutation paths, safe under the freeze. This is the start of JARVIS_SPINE Layer 4; it does **not** yet remove the legacy intent parser (kept as fallback).

**Same-day follow-on — two more read tools (same loop):**

| Tool | File | What it answers |
|------|------|-----------------|
| `lookup_costs` | `src/agent/jarvisReason/costLookupTool.js` | Spend aggregation over `ticket_cost_entries` — "how much did we spend this year", "what did plumbing cost at Penn". Filters property/entryType/vendor/date; `groupBy` entry_type\|property\|vendor; company + tenant-charge totals (cents + USD). **Finance-flag gated** → returns `finance_not_enabled` (model says cost tracking is off, never $0). Voided rows JS-filtered so it works whether or not migration **053** is applied. |
| `get_ticket_detail` | `src/agent/jarvisReason/ticketDetailTool.js` | One-ticket story — "what's the deal with 301": status/category/priority/assignee/window/tenant/notes/timeline + cost summary. Reuses `loadFocusTicketDetail` + `loadTicketCostSummary`. |

Staff-activity questions ("why did Nick only do 4 today") are already covered by `lookup_tickets` (assignee + closed + date). **Next:** a ticket-joined cost drill-down. Tests: `tests/agent/jarvisReason/costAndDetailTools.test.js` (7 more; 18 jarvisReason tests total, all green). Full suite unchanged at 15 pre-existing reds.

**Asset / parts arc — Phase 1: `get_unit_assets` (equipment → model).**

Goal of the arc (staff voice): *"I'm working on unit 410's dishwasher, needs a heating element — find the cheapest part"* and *"fridge at Penn 502, what could be causing this?"* — Jarvis resolves the real make/model from the unit's asset registry, then does parts lookup / diagnosis. Phases: **(1) assets in the loop ← this**, (2) diagnosis synthesis (assets + service history), (3) external parts-search **tool gateway** (Layer 5; read-only links, **never auto-purchase** — buying is a future Tier-3 step; needs a data-source decision: search API vs appliance-parts specialist vs Amazon PA-API), (4) photo→asset capture (vision extract make/model/serial → confirm → `addUnitAsset`).

| Area | Change |
|------|--------|
| **New tool** | `src/agent/jarvisReason/unitAssetsTool.js` — `get_unit_assets(propertyCode, unit, assetType?)`. Reuses `resolveUnitCatalogId` + `listUnitAssets` (no new schema; registry already has make/model/serial/nameplate_photo). Synonyms (fridge→refrigerator, ac→hvac). Read-only, gated by `unitLifecycleEnabled()` (`PROPERA_UNIT_LIFECYCLE_ENABLED`) → `assets_not_enabled`; `unit_not_found` when property+unit can't match. |
| **Loop** | Registered in `runJarvisReasoning` TOOLS/TOOL_IMPL + system-prompt rule (resolve equipment → model via `get_unit_assets` before parts/diagnosis); exported from `jarvisReason/index.js`. |
| **Tests** | `tests/agent/jarvisReason/unitAssetsTool.test.js` (6; resolve, filter, synonym, unit_not_found, assets_not_enabled, loop registration). Full suite **1169 pass / 15 pre-existing reds** — zero new. |

**Enable assets in Jarvis:** `PROPERA_UNIT_LIFECYCLE_ENABLED=1` (plus the Jarvis reason flags).

**Phase 2 — diagnosis ("fridge at 502, what's causing it?").** Diagnosis is a *synthesis* over existing data, not a new data source — but the missing piece was "what was already tried," which `lookup_tickets` omits.

| Area | Change |
|------|--------|
| **New tool** | `src/agent/jarvisReason/unitServiceHistoryTool.js` — `get_unit_service_history(propertyCode, unit, assetType?)`: chronological unit work (open+closed) **including `service_notes`**, equipment text filter with synonym groups. Reads `portal_tickets_v1`. Distinct from `lookup_tickets` (no notes). Read-only, ungated (ticket reads). |
| **Prompt** | `runJarvisReasoning` system prompt gained a **diagnosis discipline**: resolve model via `get_unit_assets` → pull prior work via `get_unit_service_history` → offer **possible** causes clearly labeled as possibilities, prioritized by history, recommend next diagnostic step. Facts (model, prior tickets, what was done) from tools only; **never a confirmed diagnosis or a promise a part/fix will work** (matches the north-star "allowed to say" boundary). |
| **Tests** | `tests/agent/jarvisReason/unitServiceHistoryTool.test.js` (4; tool scope/filter/notes + a loop test proving diagnosis composes `get_unit_assets` → `get_unit_service_history` → answer). |

**Test-suite note (correction):** the pre-existing red set is **flaky 13–15**, not a fixed 15 — several tenant-agent LLM-gather/TTL tests flip between runs. jarvisReason tests (now 28) are deterministic and green; zero new regressions from any slice here.

**Phase 3a — parts search (deep links, the Layer 5 tool gateway begins).** Source decision (operator): buy via **Amazon** (cheapest/fastest for common parts) **and specialists PartSelect/RepairClinic** (pricier, find almost anything). Reality: neither has a free open "search by model" API, so v1 generates **deep links, not fetched prices**.

| Area | Change |
|------|--------|
| **New tool** | `src/agent/jarvisReason/partsSearchTool.js` — `search_parts(make, model, part, applianceType)`. Builds links: **Amazon** `/s?k=`, **PartSelect** model page `/Models/<MODEL>/` (canonical OEM-catalog deep link; site-scoped Google fallback when no model), **RepairClinic** site-scoped Google. Pure (no fetch, no key, no DB), `pricesFetched:false`, `missing_part_query` when no model+part. |
| **Prompt** | Parts rule: resolve model via `get_unit_assets` → `search_parts` → present Amazon (cheap/fast common) vs specialist (finds anything, pricier). **Links only — model must NOT state prices or claim "cheapest" as fact; never auto-purchase** (Layer 5 doctrine). |
| **Tests** | `tests/agent/jarvisReason/partsSearchTool.test.js` (4; link construction, model-page vs fallback, missing_part_query, loop composition assets→search_parts). **jarvisReason suite now 32 tests, all green.** |

**Test-suite note:** full `npm test` ~1181 pass / **flaky 13–15** pre-existing reds (tenant-agent/comms). jarvisReason 32/32 deterministic; zero new regressions.

**Parts arc status:** Phase 1 (equipment→model) ✅, Phase 2 (diagnosis) ✅, **Phase 3a (parts deep links) ✅**. **Next:** Phase 3b = paid search API (SerpAPI/Bing/Google Shopping) for real **cheapest-price ranking** — `search_parts` is structured to add fetched results behind a key without changing the contract. Phase 4 = photo→asset capture (vision extract make/model/serial → confirm → `addUnitAsset`). Buying/payment remains a future **Tier-3** step, never automatic.

**Voice wiring (important):** the reasoning loop is wired into `handleJarvisAskTurn`, which **both** the portal-chat `jarvis_ask` path **and** the staff **voice** `ask_propera` tool call (`src/voice/jarvisVoiceTools.js`). So all six reasoning tools (tickets/costs/detail/assets/service-history/parts) are reachable on voice for free when the model calls `ask_propera`. Discoverability pass done (2026-06-07): broadened the `ask_propera` description + `jarvisSystemPrompt.js` "Your job" so voice routes **equipment / diagnosis / parts** questions to `ask_propera` (with the voice guards: diagnosis = possibilities not a fix; parts = links, no price/"cheapest" claims, never purchase). Test: `tests/voice/jarvisSystemPrompt.test.js`. Note voice also has older dedicated read tools (`query_service_history`, `list_open_service_tickets`, `resolve_open_ticket`) that bypass the loop — kept as-is.

**Asset capture in the Jarvis moment (scoping note, not built):** asset *photo* capture already exists on the unit page; the gap is capturing/registering **inside a Jarvis turn**. That is a WRITE → belongs in the proposal spine as a new op `register_unit_asset` (validator → existing `addUnitAsset`), not the read loop. Decompose: (i) in-conversation **registration** (spoken/typed model → propose → confirm → write) is buildable now on chat + voice, no camera; (ii) **photo-assisted** extraction in the moment works on chat (image attach → OCR → prefill) but the voice/glasses "snap while speaking" is blocked by the same camera-input limit (web-app glasses have no camera; needs native toolkit). Reading long model/serial codes aloud is unreliable — treat as low-confidence fallback; the plate photo/OCR is the real capture path.

**Enable:** `JARVIS_ASK_ENABLED=1` + `JARVIS_REASON_ENABLED=1` + `OPENAI_API_KEY`, restart V2. The "answers vary by question, not a canned list" behavior is an LLM property — verify on a real key against live tickets.

**Test suite note:** full `npm test` shows **15 pre-existing reds** (4 tenant-agent ones documented in AGENTS.md, plus communication helpers `normalizeAudienceFilter` / `buildAutoResponse` and several tenant-agent gather/golden tests). Confirmed pre-existing/unrelated — they reproduce standalone and this slice is additive + flag-gated. Not touched.

---

## 2026-06-04 — GAS cutover: tenant-roster authz ported off GAS (propera-app)

**Context:** GAS is already disconnected in production (Vercel app has no `PROPERA_API_BASE_URL`; V2 never called GAS). The one path with a real behavior consequence was the **tenant-roster staff check**, which called GAS `?path=me` and silently became a no-op once those env vars were unset — i.e. staff were no longer blocked from editing the roster.

| Area | Change |
|------|--------|
| **Authz restored** | `propera-app/src/lib/tenantMutationGuard.ts` `blockIfStaff()` now resolves role from Supabase **`portal_auth_allowlist.portal_role`** (new `resolvePortalRoleForEmail` in `portalMeFromSupabase.ts`, same source as `/api/me`) instead of the GAS `path=me` call. Rule restored: **staff/maintenance/field = read-only on the roster; owners/ops may edit** (`isStaffRoleLabel`). |
| **Fail mode** | Fail-open on infra error (no service client / Supabase blip) — a known "is staff" answer blocks; an unknown one allows. Matches prior resilience; avoids locking owners out. |
| **GAS coupling removed** | `tenantMutationGuard.ts` no longer reads `PROPERA_API_BASE_URL` / `PROPERA_PM_TOKEN`. |

**Dead-code sweep (merged 2026-06-04):** removed dormant GAS paths from `propera-app` — `gas-only` read rollback, GAS create-ticket branch, `fetchGas*` helpers, `PROPERA_API_BASE_URL` from `loadV2EnvFallback.ts`.

**Operator:** apply migrations **092** + **093** on Supabase when ready (code degrades gracefully until then).

---

## 2026-06-04 — Jarvis reliability/speed pass (#4–#7)

| # | Area | Change |
|---|------|--------|
| **#5** | **Boundary — generic confirm spine** | Campaign existence check moved to `preCommitValidators.js` + `preCommitValidateSendCommunicationCampaign` in `sendCommunicationCampaign.js`. |
| **#4** | **Speed — scope compile gate** | `logOperationalScopeForInbound.js` compiles scope only for `jarvis_ask` / `jarvis_plan`. |
| **#6** | **Reliability — open-ticket scope** | Migration **`093_portal_open_tickets_v1.sql`**; scope reads use open-only view with fallback. |
| **#7 (partial)** | **Voice WS drop** | Heartbeat + idempotent `teardown()` in `jarvisVoiceWebSocketBridge.js`. Client auto-reconnect still open. |

---

## 2026-06-04 — Jarvis Ask read path: parallelized + bounded LLM timeout

| Area | Change |
|------|--------|
| **Parallel reads** | `gatherJarvisFacts.js` — service-history eager; cost + spend via `Promise.all`. |
| **Bounded LLM** | `JARVIS_ASK_LLM_TIMEOUT_MS` (default 10s) via `jarvisAskLlmTimeoutMs()`. |
| **Bug fix** | Missing `parseServiceHistoryAnalysis` import fixed. |

---

## 2026-06-04 — Jarvis thread DAL: atomic confirm claim + fewer round trips

| Area | Change |
|------|--------|
| **Atomic claim** | Migration **`092_jarvis_proposal_transition.sql`** — `jarvis_transition_proposal` RPC. |
| **Round trips** | `rowToThread()`, upsert returns row, `findThreadWithProposalForActor` single query. |
| **Tests** | `tests/dal/jarvisClaimProposal.test.js`; `tests/dal/*.test.js` wired in `npm test`. |

---

## 2026-06-02 — Jarvis confirm loop hardening

| Area | Change |
|------|--------|
| **Shared confirm spine** | `executeJarvisConfirm.js` — portal Plan + voice: token verify, thread claim (`executing`), in-process lock, idempotent replay, failure-safe (no false committed) |
| **Dedupe** | `guardPendingProposal.js` blocks new propose while confirm pending; recent duplicate for schedule (ticket+window) and service note (ticket+text) |
| **Receipts** | `jarvisConfirmReceipt.js`; create+schedule partial failure copy + `schedule_partial` on resolution |
| **Tests** | `tests/agent/proposals/jarvisConfirmSpine.test.js` |

**Continue:** WS reconnect (#12); access PIN regen / edit time on voice (#14).

---

## 2026-06-02 — Jarvis staff voice: multi-ticket, access ops, analytics reads

| Area | Change |
|------|--------|
| **Spec** | **`docs/JARVIS_SPINE.md`** — code map, op registry, multi-intent rules, amenity ops, backlog refreshed |
| **Multi-ticket** | Same unit, different issues → **one `propose_create_service_request` per issue** (sequential confirm). Issue-aware dedupe (`createIssueDedupe.js`, `findRecentDuplicateCreate`); reuse property/unit/`preferred_window` via thread receipt + session context |
| **Access (voice + Plan)** | Ops: `book_amenity_reservation`, `set_amenity_schedule`, `cancel_amenity_reservation`, `update_amenity_policy`. Reads: `list_amenity_locations`, `lookup_amenity_booking` (PIN), `get_amenity_booking_rules`. Requires **`PROPERA_ACCESS_ENGINE_ENABLED=1`** + `JARVIS_PLAN_ENABLED=1` |
| **Analytics read** | `src/agent/jarvisQuery/` — `query_service_history` (counts, distinct/repeat units). Voice + portal Ask |
| **Open list** | Voice `list_open_service_tickets` — portfolio-wide open services (not just assigned work) |
| **Confirm hardening** | Idempotent confirm, recent-duplicate block on create, portal/voice proposal field parity (`proposalPortalFields.js`, `jarvisProposalView.ts`) |
| **Tests** | `tests/agent/proposals/amenityProposals.test.js`, `createIssueDedupe.test.js`, `jarvisOperatorThreads.test.js`, `serviceHistory.test.js` |

**Enable (staff Jarvis voice):** `JARVIS_VOICE_ENABLED=1`, `JARVIS_PLAN_ENABLED=1`, `JARVIS_ASK_ENABLED=1`, `JARVIS_THREAD_ENABLED=1`, `PROPERA_ACCESS_ENGINE_ENABLED=1` (amenity), `NEXT_PUBLIC_PROPERA_JARVIS_VOICE_ENABLED=1` (app). Restart V2 after changes.

**Continue:** WS reconnect; access PIN regen / edit time on voice; optional batch-create op.

---

## 2026-06-02 — Leasing Engine V1 (portal) + org-scoped preventive list

| Area | Change |
|------|--------|
| **Migration** | **`085_leasing_engine_v1.sql`** — `unit_leases.renewal_status` / `renewal_notes`; `leasing_prospects` table (`org_id` text FK). |
| **V2** | `src/dal/leasingProspects.js`; `/api/portal/leasing/*` behind **`PROPERA_LEASING_ENGINE_ENABLED=1`**. Fail-closed org scope via `resolveOrgPropertyScopeForQuery`. |
| **App** | `/leasing` UI + `/api/leasing/*` proxy; **`NEXT_PUBLIC_PROPERA_LEASING_ENABLED=1`**. `fetchV2Portal` now forwards portal JWT + `x-propera-org-id`. |
| **Org fix** | **`GET /api/portal/program-runs`** now filters by org property scope (preventive list was cross-org when no property filter). |
| **Tests** | `tests/portalOrgScopeFailClosed.test.js`. |

**Enable:** apply **085**, set both leasing flags, restart V2 + app.

**Continue:** GAS leasing engine (`23_LEASING_ENGINE.gs`) remains **not ported** — tours/SMS pipeline is separate future work.

---

## 2026-06-02 — Tenant portal bilingual (en / es) Phases 1–3 + push prompt

| Area | Change |
|------|--------|
| **Spec** | **`docs/TENANT_PORTAL_I18N.md`** — locked decisions: display translate, English operational brain, `en`+`es`, profile + detect. |
| **V2** | `tenant_roster.preferred_language` PATCH; `detectTextLanguage`, `translateToEnglish` (maintenance POST), `translateForDisplay` (maintenance + notices GET). Modules: `tenantI18nLocale.js`, `translateTenantText.js`, `tenantMaintenanceI18n.js`, `tenantDisplayI18n.js`. |
| **App** | `src/lib/tenant/i18n/` catalogs + `TenantLocaleProvider`; profile language row (edit button like email); avatar → `/tenant/profile`. |
| **Env** | `PROPERA_TENANT_I18N_ENABLED=1` + `OPENAI_API_KEY` for translate layers; optional `PROPERA_TENANT_TRANSLATE_MODEL`. Static UI works from profile without flag. |
| **Tests** | `tests/tenantI18nLocale.test.js`, `tests/detectTextLanguage.test.js`, `tests/tenantMaintenanceI18n.test.js`, `tests/tenantDisplayI18n.test.js`. |
| **Phase 4 (partial)** | Push permission banner localized (`TenantPushPrompt` + `tenantPushErrors.ts`). Login + amenity description display translate **not** done. |

**Continue:** Phase 4 remainder (login strings, amenity `descriptionDisplay`) or next tenant portal slice per **`docs/TENANT_PORTAL_BUILD_PLAN.md`**.

---

## 2026-06-01 — Max voice agent (V2, brain-routed)

| Area | Change |
|------|--------|
| **Voice module** | `src/voice/` — Max Realtime agent: Twilio Media Stream ↔ OpenAI Realtime (`voiceWebSocketBridge.js`). |
| **Routes** | `POST /webhooks/twilio/voice` (TwiML), `WS /voice/stream` — wired in `index.js` when `PROPERA_VOICE_ENABLED=1`. |
| **Brain rule** | Tools **never** insert tickets/work_items directly. `maxTools.js` → `tenantMaintenanceService` → `runInboundPipeline` (`createVoiceMaintenanceTicket`, `listTenantTickets`, `getTenantTicket`). |
| **Roster / brand** | `lookupCallerRoster.js` (no tenant-agent pilot filter); `voiceBrandResolve.js` (brand from roster property → org). |
| **Env** | `PROPERA_VOICE_ENABLED`, `PROPERA_VOICE_MODEL`, `PROPERA_VOICE_AGENT_VOICE` + existing `OPENAI_API_KEY`, `PROPERA_PUBLIC_BASE_URL`. |
| **Tests** | `tests/voice/maxTools.test.js` |

**Turn on:** set env vars, `npm install`, restart V2, point Twilio **voice** number webhook to `https://<PUBLIC_BASE>/webhooks/twilio/voice`.

---

| Area | Change |
|------|--------|
| **SQL** | **`078_org_onboarding.sql`** — `organizations.onboarding_completed_at`, `created_via`. |
| **V2** | `portalOrgOnboarding.js` + `registerOnboardingRoutes.js` — bootstrap org + owner + first property; gated by `PROPERA_ORG_SIGNUP_*`. |
| **App** | `/signup/company` 4-step wizard; `/api/onboarding/*` proxies + Supabase auth link. |

**Enable:** set `PROPERA_ORG_SIGNUP_ENABLED=1` and same `PROPERA_ORG_SIGNUP_SECRET` on **both** propera-v2 and propera-app. Run migration **078**.

**Not in v1:** public signup without secret; multi-property wizard; DNS for custom domains; org-scoped GLOBAL policy.

---

## 2026-05-30 — MO-2c Policies (operational policy admin PC-2)

| Area | Change |
|------|--------|
| **SQL** | **`077_policy_change_log.sql`** — append-only audit for Settings policy edits. |
| **V2** | `portalOrgPolicies.js` — curated `property_policy` keys (sched, conflict, lifecycle/contact); `GET/PATCH/DELETE /api/portal/settings/policies*` + audit route. |
| **App** | `/settings/policies` — scope selector (GLOBAL + properties), grouped table, revert override, recent changes. |

**Not in v1:** effective dating; finance keys; org-scoped GLOBAL (shared `GLOBAL` row until org_id on policy); full PropertyPolicy sheet parity.

---

## 2026-05-30 — MO-3 Channels (org channel metadata + guided setup)

| Area | Change |
|------|--------|
| **SQL** | **`076_org_channel_config.sql`** — `org_channel_configs` (per-org phone/Telegram metadata + setup status); seeds five channel keys per org. |
| **V2** | `portalOrgChannels.js` + `GET/PATCH /api/portal/settings/channels`; merges catalog with platform env hints (masked); webhook URLs when `PROPERA_PUBLIC_BASE_URL` set. |
| **App** | `/settings/channels` — checklist UI, edit modal; proxy `/api/settings/channels`. |

**Not in v1:** inbound org routing by `To` number (brain paths unchanged); Twilio secrets in DB; auto webhook registration.

---

## 2026-05-30 — MO-2 Settings UI (org self-admin v1)

| Area | Change |
|------|--------|
| **V2** | `portalOrgSettings.js` + `/api/portal/settings/*` routes (org, staff, portal-users, vendors); `gateSettings` requires JWT + Owner/Ops/PM. |
| **App** | `/settings` — Organization, Staff, Portal access, Vendors; sidebar link for elevated roles; proxies under `/api/settings/*`. |

**Not in v1:** property edit/aliases, staff property assignments, policies, audit log.

---

## 2026-05-30 — Multi-org spine MO-1 (portal isolation foundation)

| Area | Change |
|------|--------|
| **SQL** | **`074_org_spine_core.sql`** — `org_id` on `portal_auth_allowlist`, `staff`, `vendors`, `tenant_roster`, `property_aliases`; allowlist unique `(org_id, email_lower)`. |
| **Docs** | **`docs/MULTI_ORG_ARCHITECTURE.md`** — shared-DB multi-tenant doctrine + phases. |
| **V2** | `resolvePortalOrgContext.js`, `portalOrgScope.js`, `defaultOrgId()`; portal list routes scoped (tickets, properties, tenants, vendors). |
| **App** | `/api/me` org payload; `portalOrgScope.ts`; supabase + v2-http reads forward JWT / filter by org. |
| **Ops** | Run **`074`** after **`073`** in Supabase SQL Editor. Set **`PROPERA_DEFAULT_ORG_ID=grand`** (or client org slug) on V2 + app. |

**Next (MO-2):** Settings UI — staff, allowlist, vendors, property admin (no wizard yet).

---

## 2026-05-27 — Jarvis thread state v0 (foundation layer 2)

| Area | Change |
|------|--------|
| **SQL** | **`070_jarvis_operator_threads.sql`** — `jarvis_operator_threads` (actor + channel + anchor fingerprint, `pending_proposals` jsonb, `last_receipt`). |
| **Code** | `src/agent/thread/` — anchor fingerprint, `recordThreadForStaffRun`; wired on Plan propose/commit + portal cost capture. |
| **Flag** | `JARVIS_THREAD_ENABLED=1` |
| **Tests** | `tests/jarvisThread.test.js` |

Apply migration **070** on Supabase before enabling thread flag in prod.

---

## 2026-05-27 — Jarvis Plan slice 1 (proposal spine + portal Plan tab)

| Area | Change |
|------|--------|
| **Spine** | `src/agent/proposals/` — `attach_ticket_cost` op, signed confirm token, `commitProposal`, `enrichStaffRunWithProposal`. |
| **Portal Plan** | `jarvis_plan` mode → `handleJarvisPlanTurn`; flags `JARVIS_PLAN_ENABLED=1`, app `NEXT_PUBLIC_PROPERA_JARVIS_PLAN_ENABLED=1` (requires finance cost capture). |
| **Cost mode** | Medium-confidence confirms now include `resolution.proposal`; same **Plan** card in app. |
| **App** | `PlanProposalCard.tsx`, command bar **Plan** tab, `portal_proposal_context` on confirm. |
| **Tests** | `tests/jarvisProposals.test.js` |

---

## 2026-05-27 — Jarvis spine foundation doc

| Area | Change |
|------|--------|
| **Doctrine** | **`docs/JARVIS_SPINE.md`** — seven foundation layers (scope, thread state, operation contract, query layer, tool gateway, coordination loops, receipts); proposal sketch; op registry seed table; anti-patterns; build order 1–7; PR review checklist. |
| **Cross-links** | **`docs/PROPERA_JARVIS_NORTH_STAR.md`** — Related docs + immediate product direction point at spine doc. |

---

## 2026-05-27 — Jarvis Operational Scope (doctrine + compiler v0)

| Area | Change |
|------|--------|
| **Doctrine** | **`docs/PROPERA_JARVIS_NORTH_STAR.md`** — new § **Operational Scope** (open-project model, one operator / all channels, Ask/Plan/Execute, readiness gates). Phase 1/2 deliverables updated. |
| **Code** | **`src/agent/operationalScope/`** — `compileOperationalScope()` v0 (read-only): actor, anchor from `portal_page_context`, staff open WIs, property open tickets, focus candidates, `story` line. |
| **Tests** | **`tests/operationalScope.test.js`** — story + anchor filter unit tests. |
| **Portal observe** | `runInboundPipeline` calls `logOperationalScopeForPortalChat` on `portal_chat` → `OPERATIONAL_SCOPE_COMPILED` in `event_log`; `_operationalScopeJson` on router parameter for downstream. |
| **Jarvis Ask (portal)** | `portal_chat_mode: jarvis_ask` → `handleJarvisAskTurn` (read-only). Flags: `JARVIS_ASK_ENABLED=1`, optional `JARVIS_ASK_LLM_ENABLED=1`. App: `NEXT_PUBLIC_PROPERA_JARVIS_ASK_ENABLED=1`, command bar **Ask** tab. |

---

## 2026-05-26 — Access Engine completion slice landed (lifecycle + outgate + inbound + tenant-agent seam)

| Area | Change |
|------|--------|
| **Lifecycle automation** | Added **`066_access_lifecycle_jobs.sql`** plus access-owned job helpers/worker (`src/access/accessLifecycleJobs.js`, `src/access/processAccessLifecycleJobs.js`). The existing cron endpoint **`POST /internal/cron/lifecycle-timers`** now processes both maintenance lifecycle timers and access lifecycle jobs. Access now schedules approval timeout, reminder, start-window activation, and end-window completion beside maintenance core. |
| **Access DAL / state progression** | `src/dal/accessEngine.js` now schedules/cancels lifecycle jobs on create/approve/cancel/reschedule, promotes **`CONFIRMED → ACTIVE`**, completes reservations at window end, and expires/revokes passes from the Access domain instead of trying to reuse maintenance `work_items`. |
| **Canonical outgate seam** | Added deterministic access copy + send path via `src/outgate/accessMessageSpecs.js` and `src/access/accessNotifications.js`. Tenant/staff access notifications now go through the shared outgate seam / channel render, including reminder and lifecycle messages, instead of a parallel send path. |
| **Shared inbound ACCESS_* path** | Added `src/access/handleAccessInbound.js` and routed access turns beside maintenance in `runInboundPipeline` / `routeInboundDecision`. SMS / WhatsApp / Telegram can now handle deterministic **reserve / cancel / status / list** style access requests without entering `handleInboundCore`. |
| **Tenant Agent seam** | Added `src/adapters/tenantAgent/maybeHandleAccessTurn.js`. Access/amenity asks are no longer forced into the maintenance-only deflect path first; the agent can gather amenity + window and hand off `_accessPayloadJson` to the canonical access handler. Fallback remains safe prompts / tenant portal deep-link style guidance when identity or slots are ambiguous. |
| **Focused tests** | Added `tests/accessIntentParser.test.js`, `tests/accessMessageSpecs.test.js`, and `tests/accessRouteDecision.test.js`. Focused access test run: `node --test tests/accessIntentParser.test.js tests/accessMessageSpecs.test.js tests/accessRouteDecision.test.js tests/accessReservationRules.test.js` |
| **Still pending / explicitly out of this slice** | Real smart-lock providers beyond `noop`, deposit/payment hooks, and richer NL slot discovery / deeper multi-turn access memory. Do not treat the current text-channel handler as permission to move reservation truth into the agent. |

---

## 2026-05-26 — Communication portal deep link, recipient/reply tabs, and draft delete

| Area | Change |
|------|--------|
| **propera-app cockpit** | Added dedicated **`/communications/[id]`** deep-link support while keeping the existing list/detail page behavior. Campaign selection now syncs to the URL so operators can bookmark or return to a specific campaign. |
| **Detail drill-down** | Campaign detail now shows **recipient** and **reply** tabs backed by the V2 detail payload, so operators can inspect prepared recipients, delivery/error context, inbound reply classes, and auto-response/handoff metadata from the app. |
| **Safe delete seam** | Added thin delete support from app → V2 via **`DELETE /api/communications/campaigns/:id`**. V2 only allows delete while the campaign is still **`DRAFT`** to preserve prepared/sent operational history. |
| **Next follow-ups** | Hybrid `/communications/new` setup route, richer campaign editing (title/body metadata beyond current seam), fuller delivery drill-down / pagination for large campaigns, and the still-stubbed maintenance handoff from communication replies. |

---

## 2026-05-26 — Communication hybrid route shape landed

| Area | Change |
|------|--------|
| **Hybrid UX** | Shifted the portal from an inline-create home page to a hybrid route shape: **`/communications`** is now the monitoring/list home, **`/communications/new`** is the dedicated setup route, and **`/communications/[id]`** remains the campaign operations/detail route. |
| **Operator flow** | New campaigns are created from **`/communications/new`**, then redirected into the created campaign detail page for draft generation, footer preview, audience preview, replies/recipients, and send. |
| **Architecture boundary** | No new business logic moved into the app. The change stays in the thin portal layer only; V2 contracts for create/draft/preview/resolve/send/delete remain canonical. |
| **Next follow-ups** | If the setup flow keeps growing, turn `/communications/new` into a fuller step-by-step wizard; otherwise keep polishing delivery drill-down and reply-to-maintenance handoff. |

---

## 2026-05-25 — Communication portal UI slice landed in propera-app

| Area | Change |
|------|--------|
| **propera-app cockpit** | Added **`/communications`** behind **`NEXT_PUBLIC_PROPERA_COMMUNICATIONS_ENABLED=1`**. First slice is live: campaign list, inline draft creation, detail panel, AI/deterministic draft generation from brief, manual draft save/edit, final SMS footer preview + segment estimate, audience preview, send, and exact unit / resident targeting controls. |
| **Thin app proxies** | Added **`src/app/api/communications/*`** routes that forward to V2 **`/api/communications/*`**. No audience resolution / compose / manual draft save / footer preview / send business logic was duplicated in Next. |
| **Portal shell / gating** | Sidebar nav wired in **`AppLayout.tsx`** and route/api gating added in **`proxy.ts`** so the module stays opt-in like Preventive / Access. |
| **Docs / env** | Updated `propera-app/README.md`, `propera-app/.env.example`, and `COMMUNICATION_ENGINE.md` so the portal slice is now part of repo truth. |
| **Next follow-ups** | Dedicated `/communications/[id]` deep link, recipient / reply tabs, footer preview / segment estimate, and richer campaign editing (for example title/body metadata beyond the current draft-save seam). |

---

## 2026-05-25 — Communication backend landed; preserve tenant-agent behavior, move to app UI

| Area | Change |
|------|--------|
| **Communication Engine backend** | `src/communication/` + `src/webhooks/communicationsSms.js` now cover campaign draft/preview/compose/send plus broadcast reply/delivery tracking. Current next work item is **`propera-app` Communication UI** over the live V2 endpoints. |
| **Approved tenant-agent rule** | **Unit** maintenance requests may **finalize without schedule**; schedule ask is **post-create optional**. **Common area** and **emergency / skipScheduling** must **not** ask for schedule. This behavior was restored intentionally; do not “fix” it away for tests. |
| **Test cleanup done** | Fixed the hermetic audio test and the shared one-line tenant-agent handoff regression. Full suite dropped from **26 fails** to **4 fails**. |
| **Known remaining red tests (do not auto-fix without approval)** | **`tests/scenarios/tenantAgentConversationTtl.test.js`** — test expects expired conversation fresh partial `{}` but runtime now preserves metadata (`_last_inbound_*`, `_roster_lookup_done`). **`tests/scenarios/tenantAgentPostCompletePhase4.test.js`** — expects brain label **`tenant_agent_gather`** but runtime returns **`intake_start_new`** for explicit new-issue branch. **`tests/tenantAgent/detectGatherSafety.test.js`** — expects `payload.emergency = "Yes"` for handoff safety payload, runtime leaves it undefined unless `receiptTier === "emergency"`. **`tests/tenantMessagesCancelLayer.test.js`** — known red / unimplemented: tenant cancel does not yet suspend linked ticket (`OPEN` vs expected `SUSPENDED`). |
| **Agent instruction** | Unless the user explicitly asks to work on those tenant-agent tests/behaviors, **do not** change tenant-agent behavior just to make the suite fully green. Preserve the current accepted agent behavior and move forward with the requested product slice. |

### Commands

```bash
cd propera-v2
npm test
```

---

## 2026-05-25 — Finance Phase 1 read-side polish

| Area | Change |
|------|--------|
| **propera-app snapshot read model** | `financialSnapshot.ts` now includes per-unit deposit, selected-month posted payments, last payment, and 6-month payment history from `unit_leases` + `tenant_ledger_entries` |
| **`/financial/properties/[property]`** | Units tab now shows live lease/ledger values instead of placeholders for payments, last payment, deposit, and payment history; vacancy loss now uses canonical unit status history (migration 064) for selected-month days/loss. Maintenance tab now includes a 12-month spend trend, current-month category breakdown, receipt preview/open affordances, and shared ticket detail drill-down |
| **`/properties/.../units/[unitId]`** | Payment history panel now renders from posted ledger payments instead of placeholder bars |
| **Docs** | `PROPERA_FINANCE_ROADMAP.md`, `AGENTS.md`, and `PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md` updated to reflect 052 repo status and current `/financial` behavior |

---

## 2026-05-24 — Tenant Agent maintenance-only lane (Phase 8a)

| Area | Change |
|------|--------|
| **Adapter** | Non-maintenance requests → deflect + property SUPER/PM phone (fallback `COMM_MAIN_NUMBER_DISPLAY`) |
| **Events** | `TENANT_AGENT_NON_MAINTENANCE_DEFLECT` |
| **Tests** | `maintenanceOnlyLane.test.js`, `tenantAgentMaintenanceOnlyLane.test.js` |

---

## 2026-05-24 — Tenant Agent Phase 6 (find_related_ticket after 48h)

| Area | Change |
|------|--------|
| **Brain/DAL** | `findRelatedTenantTickets.js` — open tickets by tenant phone + hint scoring |
| **Brain** | `handleTenantFindRelatedTicket.js` — read-only lookup operation |
| **Adapter** | After TTL expiry + problem signal → lookup before gather; strong match → same/new clarify with status |
| **Tests** | `tenantAgentFindRelatedPhase6.test.js`, `findRelatedTenantTickets.test.js` |

---

## 2026-05-24 — Docs sync: Tenant Agent code reality

| Doc | Update |
|-----|--------|
| **`TENANT_AGENT_ADAPTER.md`** | Implementation snapshot; file map; §13 pilot checklist; Phases 4–5 done / Phase 6 not started |
| **`PARITY_LEDGER.md`** | Tenant Agent row expanded |
| **`BRAIN_PORT_MAP.md`**, **`ORCHESTRATOR_ROUTING.md`** | Post-complete + append operations |
| **`OUTSIDE_CURSOR.md`** | Migration **063** apply step |
| **`AGENTS.md`** | Tenant Agent pointer in “Where everything lives” |

---

## 2026-05-24 — Append confirm: brain gets substance, not "yep same"

| Area | Change |
|------|--------|
| **`resolveAppendHandoffContent.js`** | Pending follow-up body/media → brain note; confirmation phrases stripped |
| **LLM** | Same/new classify runs **first** when enabled; receives `pending_follow_up`; returns `append_note` |
| **Flow** | Tenant "yep same" after "still leaking" → brain `append_to_ticket` message = **still leaking**, not confirm text |
| **Photo-only** | "yep same" after photo → append attachment only; note = "Tenant sent a photo." (existing outgate default) |

---

| Area | Change |
|------|--------|
| **Prompts** | `sameOrNewClarify.js` — conversational ask/re-ask; no "Reply 1 or 2" |
| **Parse** | Expanded natural-language heuristics (`yes same`, `still leaking`, `different problem`, …); numeric 1/2 still accepted silently |
| **LLM** | `sameOrNewLlmClassify.js` — optional fallback when `TENANT_AGENT_LLM_ENABLED=1` and rules inconclusive |
| **Bugfix** | `postCompleteTurn.js` — ambiguous reply re-prompt no longer throws on undefined `replyText` |
| **Tests** | Phase 4 scenarios use natural replies; ambiguous re-ask test added |

---

| Area | Change |
|------|--------|
| **Adapter** | `postCompleteTurn.js`, `classifyPostCompleteFollowUp.js`, `sameOrNewClarify.js` — no media-only auto-attach; `same_or_new_pending`; natural-language confirm |
| **Brain** | `append_to_ticket` via `tenantTicketAppend.js` + `handleTenantAppendToTicket.js` |
| **Status** | `complete` after finalize (alias `handoff_done`) |
| **Tests** | `tenantAgentPostCompletePhase4.test.js`, unit tests under `tests/tenantAgent/` |

---

## 2026-05-24 — Tenant Agent §15 plan (post-handoff clarify + lookup)

| Area | Change |
|------|--------|
| **`TENANT_AGENT_ADAPTER.md` §15** | Phased plan: clarification authority, no media-only auto-attach, `same_or_new_pending`, `append_to_ticket`, `find_related_ticket` after 48h, Phase 7 staff-ETA extension point |
| **Doctrine** | 48h = conversation memory only; operational tickets queried via brain |

**Next implementation slice:** Phase 4 (clarification routing + tests) — no brain append handler required to start clarify UX.

---

## 2026-05-24 — postCreate contract (category + optional schedule)

| Area | Change |
|------|--------|
| **`postCreateContract.js`** | `scheduleMode`: `NONE` (portal default) vs `ASK_OPTIONAL` (tenant agent); brain skips schedule ask only when `NONE` |
| **Handoff** | `category` from `resolveHandoffCategory()`; agent sends `postCreate: { scheduleMode: "ASK_OPTIONAL" }` |
| **Pipeline** | `deferToCoreSchedule.js` — when intake expects SCHEDULE, skip agent turn |
| **Tests** | `postCreateContract.test.js`, handoff scenario asserts schedule ask + HVAC category |

---

## 2026-05-24 — Tenant Agent conversation TTL (48h)

| Area | Change |
|------|--------|
| **`conversationExpiry.js`** | Lazy expiry on inbound; `TENANT_AGENT_CONVERSATION_EXPIRED` → `event_log` then **delete** row |
| **Env** | `TENANT_AGENT_CONVERSATION_TTL_HOURS=48` (default 48; `0` = off) |
| **Accountability** | Tickets/work_items untouched; expiry logs `partial_summary`, `active_ticket_key`, `message_count` |

---

## 2026-05-23 — Tenant Agent Sprint 3 (shape reply + channel + allowlist)

### Done

| Area | Change |
|------|--------|
| **`shapeBrainReply.js`** | Rebuild finalize receipt from brain facts (`buildMaintenanceReceipt`); failure copy; multi-ticket passthrough |
| **`extractBrainReceiptFacts.js`** | Ticket id / tier from `coreRun.finalize` + `outgate` only |
| **`tenantAgentChannelRender.js`** | Gather/escalated: no Telegram receipt markdown; handoff: full channel extras |
| **`propertyAllowlist.js`** | `TENANT_AGENT_PROPERTY_ALLOWLIST`; non-pilot → close conv + legacy core same turn |
| **Pipeline** | `facts.tenantLocale`; `renderForChannel({ applyTelegramReceiptMarkdown })` |
| **Tests** | `tenantAgentSprint3.test.js`, `shapeBrainReply.test.js`, `propertyAllowlist.test.js` |

### Ops

Pilot one property: `TENANT_AGENT_PROPERTY_ALLOWLIST=PENN` (comma-separated). Empty = all properties.

---

## 2026-05-23 — Tenant Agent Sprint 2 (LLM gather)

### Done

| Area | Change |
|------|--------|
| **`systemPrompt.js`** | Gather voice + JSON contract (never decide urgency/tickets) |
| **`tenantAgentLlmTurn.js`** | OpenAI gather turn + test mock hook |
| **`mergePartialFromLlm.js`** | Strict slot merge; rules confirm `handoff_ready` |
| **Env** | `TENANT_AGENT_LLM_MODEL`, `TENANT_AGENT_FALLBACK_TO_LEGACY` |
| **Tests** | `tenantAgentLlmGather.test.js`, unit tests for merge/prompt |

### Ops

Pilot: `TENANT_AGENT_ENABLED=1` + `TENANT_AGENT_LLM_ENABLED=1` + valid `OPENAI_API_KEY`.

---

## 2026-05-23 — Tenant Agent Sprint 1 (deterministic gather + handoff)

### Done

| Area | Change |
|------|--------|
| **Migration 063** | `tenant_conversations` — adapter conversation state |
| **`src/adapters/tenantAgent/`** | Deterministic gather, completeness, handoff `RouterParameter`, pipeline hook |
| **Pipeline** | `TENANT_AGENT_ENABLED=1` → agent before core; handoff uses structured `create_ticket` (`channel: tenant_agent`) |
| **Tests** | `tests/tenantAgent/*`, `tests/scenarios/tenantAgentHandoff.test.js` |

### Ops

Apply **`063_tenant_conversations.sql`** after **062**. Set **`TENANT_AGENT_ENABLED=1`** only for pilot tenants; default **off** preserves legacy slot machine.

---

## 2026-05-21 — Preventive P2: program line → maintenance ticket bridge

### Done

| Area | Change |
|------|--------|
| **Migration 060** | `program_lines.linked_ticket_*`; `tickets.program_run_id` / `program_line_id` |
| **V2** | `createTicketFromProgramLine.js` → `finalizeMaintenanceDraft` (turnover pattern) |
| **Portal** | `POST /api/portal/program-lines/:id/create-ticket` |
| **propera-app** | Report issue modal + Ticket link (`/tickets?ticket=…`) |
| **Timeline** | `ticket_linked` event kind |

### Ops

Apply **`060_program_line_ticket_bridge.sql`** after **059**. Restart V2.

---

## 2026-05-21 — Preventive P1: mutable lines + Activity timeline + run filters

### Done

| Area | Change |
|------|--------|
| **Migration 059** | `program_timeline_events` — append-only Activity |
| **V2 DAL** | `addProgramLine`, `deleteProgramLine`, `reorderProgramLines`; timeline on all run/line mutations; `listProgramRuns` filters |
| **Portal routes** | `POST …/lines`, `DELETE program-lines/:id`, `PATCH …/reorder`; `GET program-runs?propertyCode&status&inProgress` |
| **propera-app** | `/preventive` — add/remove/reorder lines, Activity panel, status filter chips |
| **Tests** | `programLineFlex.test.js` |

### Ops

Apply **`059_program_timeline_v1.sql`** in Supabase. Restart V2. Timeline is empty for old runs until new actions occur.

---

## 2026-05-21 — Preventive: completion notes UI + canonical common-area expansion

### Done

| Area | Change |
|------|--------|
| **propera-app `/preventive`** | Optional **completion notes** per open line (sent on Complete); shown on completed lines |
| **V2 expansion** | `expandProgramLines` merges **`common_paint_scopes`** with active **`property_locations`** (`common_area`); `buildProgramLineSpecs` loads canonical labels |
| **Tests** | `expandProgramLines.test.js` — merge + fallback cases |
| **Docs** | `PM_PROGRAM_ENGINE_V1.md` — expansion merge + notes UI |

### Ops

No new migration. Restart V2 after pull if running. Refresh preventive checklist to see notes on newly completed lines.

---

## 2026-05-21 — Access Engine V1 slice (schema + staff cockpit)

### Done

| Area | Change |
|------|--------|
| **Migration 057** | `057_access_engine_v1.sql` — `access_*` tables + PENN Gameroom seed |
| **propera-v2** | `src/access/*`, `src/dal/accessEngine.js`, `registerAccessRoutes.js` — policy, `canReserve`, noop PIN adapter, portal CRUD |
| **propera-app** | `/access` command center, `/api/access/*` proxies, feature flags |
| **Tests** | `tests/accessReservationRules.test.js` |

### Ops before smoke test

1. Apply **057** in Supabase (after **056**).
2. Set **`PROPERA_ACCESS_ENGINE_ENABLED=1`** in `propera-v2/.env`.
3. Set **`NEXT_PUBLIC_PROPERA_ACCESS_ENABLED=1`** in `propera-app/.env.local`.
4. Restart V2 + app; open `/access` — should list Gameroom (PENN).

### Next

Inbound ACCESS_* router + outgate; tenant `/tenant/access`; scheduler ACTIVE→COMPLETED.

---

## 2026-05-21 — Access staff override + config UI + command center design

### Done

| Area | Change |
|------|--------|
| **propera-app** | **Book for tenant** modal (`AccessOverrideModal`) — roster pick, date/time, staff_override |
| **propera-app** | **`/access/locations/[id]/config`** — tabs: Hours, Booking rules, Approval & pricing, Notifications |
| **propera-app** | Command center layout refresh — page header, location sidebar, stats, legend, now-line, Config link |
| **API proxies** | `policy`, `schedules`, `locations/[id]`, `regenerate-pin`; `proxyV2PortalRequest` supports **PUT** |

---

## 2026-05-20 — Tenant portal Phase A (auth + domain shell)

### Done

| Area | Change |
|------|--------|
| **Migration 056** | `056_tenant_portal.sql` — OTP, documents, roster/ticket/org domain columns |
| **propera-v2** | `src/tenant/*`, `registerTenantRoutes` — `GET /api/tenant/brand`, auth OTP, `GET /api/tenant/me` |
| **propera-app** | `/tenant/login`, `(portal)/dashboard` shell, `/api/tenant/*` proxies, `proxy.ts` org + cookie guard |
| **Tests** | `tests/tenantJwt.test.js` |

### Ops before smoke test

1. Apply **056** in Supabase (after **055**).
2. Set **`TENANT_JWT_SECRET`** in `propera-v2/.env` (long random).
3. Set **`DEV_ORG_SUBDOMAIN=thegrand`** in `propera-app/.env.local`.
4. Restart V2 + app; open `http://localhost:3000/tenant/login` — OTP logs to stderr in dev if Twilio off.

### Next

Phase B–F per **`docs/TENANT_PORTAL_BUILD_PLAN.md`** (maintenance, notices, documents, lease/balance).

---

## 2026-05-19 — Phase 1.5 Leasehold import reverted (blocked on export samples)

> **Superseded 2026-06-08** — Phase 1.5 re-shipped via `leasehold-bridge` + migrations 094–097. See latest HANDOFF section above.

### Done

| Area | Change |
|------|--------|
| **Decision** | Speculative Phase 1.5 code removed — unknown Leasehold export shape. |
| **Removed** | Migration **058**, `leaseholdCsv`, import API, snapshot wiring in `financialSnapshot.ts`. |
| **UI** | `/financial` rent collected / delinquent back to placeholders; **Imports** page explains blocked state. |
| **Docs** | `PROPERA_FINANCE_ROADMAP.md` §1.5 gated; `AGENTS.md` Phase 1.5 = **Blocked**. |

### Resume when

Accounting shares **real** rent roll + ledger CSV for one property → write import spec → implement **058** + import from spec (not guessed columns).

---

## 2026-05-19 — Finance P0 slice (YTD + receipts + preventive line on create)

### Done

| Area | Change |
|------|--------|
| **Migration 048** | `048_portal_properties_maintenance_ytd.sql` — `portal_properties_v1` adds UTC **YTD** maintenance spend/charge/entry count (sum of monthly rollup from Jan 1 UTC). |
| **V2** | `portalTicketsRead.js` maps YTD fields; fallback property rows include YTD zeros. |
| **propera-app** | Properties KPI + cards (month + YTD); financial property header; **`CostEntryReceiptsField`** + PDF support on **`/api/pm/upload-attachment`**; ticket + preventive cost forms attach up to 6 URLs; preventive **optional checklist line** on new cost; CSV export columns for month/YTD cents. |

### Ops

Apply **048** after **042** (and **047** if program costs in use).

---

## 2026-05-19 — Preventive / program-run cost entries (finance)

### Done

| Area | Change |
|------|--------|
| **Migration 047** | `047_program_run_cost_entries.sql` — `ticket_id` nullable; `program_run_id` / `program_line_id`; XOR parent check; **`material`** `entry_type`. |
| **DAL** | `ticketCostEntries.js` — `listProgramRunCostEntriesForPortal`, `createProgramRunCostEntryForPortal`; `updateTicketCostEntryForPortal` supports rows with `program_run_id` (no ticket timeline / no ticket-scoped ledger V1); `mapRowToApi` includes `programRunId` / `programLineId`. |
| **Portal** | `GET|POST /api/portal/program-runs/:programRunId/ticket-cost-entries` (`gateFinance`). |
| **propera-app** | `GET|POST /api/program-runs/[id]/cost-entries` (same `[id]` segment as run detail); **`ProgramRunCostsSection`** on `/preventive` detail; ticket costs add **Material** type; `TicketCostEntry.ticketId` nullable + program ids. |

### Ops

Apply **047** in Supabase after **042** (and **046** if vendors are in use).

---

## 2026-05-19 — V2 + app capabilities & finance-depth roadmap (doc)

### Done

| Area | Change |
|------|--------|
| **Docs** | **`PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md`** — what V2 does today, how **propera-app** connects (portal REST / webhooks / reads), market comparison, Layer 0–5 finance gaps. |
| **Cross-links** | **`PROPERA_FINANCIAL_LAYER_MAP.md`**, **`BRAIN_PORT_MAP.md`** point to the new doc. |

---

## 2026-05-18 — Vendor assignment + preventive vendor + mobile proof uploads

### Done

| Area | Change |
|------|--------|
| **Migration 046** | `046_vendors_and_program_line_vendor.sql` — `vendors` table; `program_lines.assigned_vendor_id` / `assigned_vendor_display`. |
| **Tickets** | `applyPortalTicketAssignment` accepts **`assigned_vendor_id`** (mutually exclusive with non-empty staff); `tickets.assigned_type = VENDOR`; `work_items.owner_type` + `owner_id`; **`listVendorsForAssignment`**; **`GET /api/portal/vendors-for-assignment`**. |
| **Preventive** | **`setProgramLineVendor`** in `programRuns.js`; **`PATCH /api/portal/program-lines/:id/vendor`**; JWT optional (falls back to system actor for event log). |
| **propera-app** | Ticket modal staff/vendor tabs; `/api/pm/vendors-for-assignment`; `/api/program-lines/[id]/vendor`; **`/preventive`**: vendor dropdown per line; proof file input **visually hidden** (not `display:none`) + **`isLikelyImageFileForUpload`** for iOS empty MIME types. |
| **Docs** | `PM_ASSIGNMENT_OVERRIDE.md` Phase 5 partial; `PARITY_LEDGER.md` §11; `migrations/README.md` row for **046**. |

### Ops

Insert active rows into **`public.vendors`** (`vendor_id`, `display_name`) after applying **046** — no seed in migration.

---

## 2026-05-15 — Ticket mutation audit + Activity actor (P0)

### Done (this session)

| Area | Change |
|------|--------|
| **Migration 045** | `045_ticket_mutation_audit.sql` — `tickets.changed_by_actor_type|id|label|source`; `ticket_timeline_events.actor_type|id|source`; `tickets_log_timeline()` reads **`changed_by_*`** (legacy fallbacks); status headline **Status changed to …**; **`portal_tickets_v1.timeline_json`** exposes structured actor fields; index on **`portal_auth_allowlist(auth_user_id)`**. |
| **Portal actor resolution** | `src/portal/resolvePortalStaffActor.js` — JWT → allowlist → staff; `PROPERA_PORTAL_ACTOR_JWT_REQUIRED` in `.env.example`. |
| **Inbound / webhook** | Bearer token from `POST /webhooks/portal` into pipeline; portal PM ticket mutations gated before `tryPortalPmTicketMutation`; `_portalMutationActorJson` for DALs. |
| **DALs** | `portalTicketMutations`, `portalTicketAssignment`, `finalizeMaintenance`, `ticketPreferredWindow`, `afterTenantScheduleApplied`, lifecycle paths, `ticketCostEntries`, `turnovers` (create + **link-ticket** ticket patch) merge **`changed_by_*`**. |
| **REST** | `registerPortalRoutes` — turnover **create-ticket** + **link-ticket** require Bearer + resolved actor. |
| **propera-app** | Session bearer on webhook mutations (`pmV2Proxy`, `pmRouteHelpers`); turnover **link-ticket** route forwards **`Authorization`**. |
| **UI / docs** | `timelineMapping.ts` maps legacy **`PM_PORTAL`** display; **`TICKET_TIMELINE.md`** §1–3 + migration table; **`PARITY_LEDGER.md`** assignment timeline row set to **SHIPPED**. |

### Notes

- **Turnover link-ticket** now mutates `tickets` with the same actor contract as other portal ticket writes (was a gap).

---

## 2026-05-14 — PM Assignment Override V1 (portal cockpit)

### Done (this session)

| Area | Change |
|------|--------|
| **Migration 043** | `043_ticket_assignment_responsibility_v1.sql` — adds `assignment_source`, `assignment_note`, `assignment_updated_at`, `assignment_updated_by` columns to `tickets`; backfills `POLICY` source on existing assigned rows; creates `portal_tickets_v1` view (all assignment columns + `timeline_json` + `ticket_row_id` alias). |
| **V2 DAL** | `src/dal/portalTicketAssignment.js` — `applyPortalTicketAssignment` (writes `PM_OVERRIDE` source tag, syncs `work_items` via `updateWorkItemsByTicketKey`, appends `PORTAL_PM_TICKET_ASSIGNMENT` event log); `listStaffAssignableToProperty` (org-wide active staff, no `staff_assignments` dependency); `assertStaffAssignable` (active-only check, property-agnostic). |
| **V2 portal routes** | `registerPortalRoutes.js`: `POST /api/portal/tickets/:ticketId/assignment` (PM override write); `GET /api/portal/properties/:code/staff-for-assignment` (staff list). Both guarded by portal token (`gate`). |
| **Phase 3 — `ticketAssignmentGuard`** | `src/dal/ticketAssignmentGuard.js` — `mergeTicketUpdateRespectingPmOverride` strips policy assignment columns from patches when `assignment_source = PM_OVERRIDE`. Wired into `portalTicketMutations.js` (incl. soft delete), `executeLifecycleDecision.js` (`APPLY_SCHEDULE_SET`), `afterTenantScheduleApplied.js`, `ticketLifecycleSync.js`, `turnovers.js`. Event `PORTAL_PM_TICKET_MUTATION_ASSIGNMENT_STRIPPED` when a portal mutation patch contained stripped keys. Tests: `tests/ticketAssignmentGuard.test.js`. |
| **Docs** | `docs/PM_ASSIGNMENT_OVERRIDE.md` Phase 3 marked complete; `PARITY_LEDGER.md` §11 corrected (finalize is INSERT-only; guard is `ticketAssignmentGuard` + call sites). |
| **propera-app types + maps** | `types.ts` (`PortalStaffOption`, `PmTicketAssignmentPayload` incl. `ticketKey`); `mapRemoteTicket.ts` (`ticketRowId`, `ticketKey`, `assignedStaffId`, `assignmentNote`, `assignmentSourceLabel`); `portalSupabaseRead.ts` fallback column read. |
| **propera-app API routes** | `/api/pm/ticket-assignment` (proxy → V2 POST); `/api/pm/property-staff` (proxy → V2 GET staff list). UUID regex loosened to accept any standard UUID (any version/variant). `ticketKey` forwarded as last-resort path segment. |
| **propera-app `api.ts`** | `fetchPmStaffForPropertyAssignment`, `postPmTicketAssignment` helpers. |
| **TicketDetailPanel UX** | Assignment block redesigned: compact display row (Assigned to · Name + pencil edit icon). Clicking edit opens a **modal popup** with "Reassign to" select (current assignee excluded), "Reason (optional)" textarea, dark Save + Cancel. Current assignee excluded from dropdown. Modal resets on open. Save closes modal on success. |
| **AppLayout.tsx** | CSS for `.assign-display-row`, `.assign-edit-btn`, `.assign-modal-backdrop`, `.assign-modal`, `.assign-modal-*`, `.assignment-save-btn`, `.assignment-reassign-note` — all scoped, no global style changes. |
| **Staff list fix** | Old code queried `staff_assignments` for property/GLOBAL — excluded staff without property rows (Geff). New code queries `staff` where `active = true` directly. V2 server restart required after code change. |
| **UUID/lookup robustness** | UUID regex: loosened from `[1-8]...[89ab]` to any standard 8-4-4-4-12 UUID. `fetchTicketRowForAssignment`: UUID path → `tickets.id`; human id path → `tickets.ticket_id` with `tickets.ticket_key` fallback; final last-resort by `ticket_key` for unrecognised hint formats. |

### Architecture alignment

- **V2 is authoritative** — app sends a PM signal; V2 validates, writes, audits. No direct Supabase writes from app.
- **PM lock vs automation** — `ticketAssignmentGuard` ensures `tickets.update` from portal mutations, lifecycle schedule paths, WI-done sync, and turnover links cannot overwrite assignment columns while `assignment_source = PM_OVERRIDE`. PM portal `applyPortalTicketAssignment` remains the authoritative assignment writer (no stripper).
- **Audit trail** — every assignment change appended to `event_log` with actor, staff id, ticket key, trace id.
- **Phases 4–5** — Phase 4 (Activity): DB trigger **`assigned`** rows on assignee column changes with resolved **`changed_by_*`** (see 2026-05-15 handoff). Phase 5 (vendor/team targets) not started.

### Known gaps / next session candidates

| Item | Notes |
|------|-------|
| **Rich assignment history UI** | Single **`assigned`** timeline row per assignee change; no separate “history list” UI beyond Activity stream. |
| **Staff `staff_id` null guard** | If a `staff` row has `staff_id = null`, `listStaffAssignableToProperty` filters it out via `.filter(r => r.staffId)` — correct but silent. |
| **`HANDOFF_LOG` + `PARITY_LEDGER` update** | Done in this entry. |

### Commands

```bash
cd propera-v2
npm test
npm start   # restart required after portalTicketAssignment.js changes
```

---

## 2026-05-12 — Preventive checklist proof-of-work photos

### Done

| Area | Notes |
|------|--------|
| **SQL** | **`040_program_lines_proof_photos.sql`** — `program_lines.proof_photo_urls` (jsonb array of public URLs). |
| **V2** | **`programRuns.js`** — `PATCH` complete accepts **`proofPhotoUrls`** (bounded, http(s) only); reopen clears; **`PROGRAM_LINE_COMPLETED`** payload includes **`proof_photo_count`**. |
| **Portal** | **`registerPortalRoutes.js`** forwards **`proofPhotoUrls`**. |
| **propera-app** | **`/preventive`** checklist: upload via existing **`/api/pm/upload-attachment`** (`pm-attachments`), optional thumbnails before complete, saved proofs on completed lines. |
| **Docs** | **`PM_PROGRAM_ENGINE_V1.md`**, **`PARITY_LEDGER.md`**, **`supabase/migrations/README.md`**. |

### Continue

Apply migration **`040`** on Supabase; requires **`026`** bucket for uploads (same as ticket photos).

---

## 2026-05-11 — Portal command bar (`portal_chat`)

### Done

| Area | Notes |
|------|--------|
| **`buildRouterParameterFromPortal.js`** | **`action: portal_chat`** — `body` / `message`, optional **`media`** → **`_mediaJson`**; rejects media-only without body `#`. |
| **`enrichInboundMediaWithOcr.js`** | OCR for **`data:image…` dataUrl** items (portal uploads) via existing vision transport when OCR enabled. |
| **Tests** | **`buildRouterParameterFromPortal.test.js`** — portal_chat cases; **`tests/scenarios/portalPortalChatStaffCapture.test.js`** — `#` body → core. |
| **propera-app** | **`POST /api/portal/command`**, **`portalCommandChat.ts`** (actor phone from session contact + env fallback), **`PortalCommandChat.tsx`** (New ticket vs Normal), wired in **`AppLayout`**. |

### Continue

Operator docs: roster **`contacts.phone_e164`** for signed-in staff (else **`PROPERA_PM_ACTOR_PHONE_E164`**); parity row **`PARITY_LEDGER.md`** (portal ingress).

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

## 2026-05-25 — Communication Engine portal-first backend slice

### Done
| Area | Change |
|------|--------|
| **Schema / audit** | Communication Engine base migration already existed (`055`). Added follow-up migration **`065_communication_agent_initiated.sql`** for agent-vs-portal draft audit. |
| **Backend routes** | Added **`src/communication/`** module + route registrar. Live routes: **`POST /api/communications/campaigns`**, **`GET /api/communications/campaigns`**, **`GET /api/communications/campaigns/:id`**, **`POST /api/communications/draft`**, **`POST /api/communications/campaigns/:id/resolve`**, **`POST /api/communications/campaigns/:id/send`**. Wired from **`src/index.js`** behind **`PROPERA_COMMUNICATION_ENGINE_ENABLED=1`** + portal token gate. |
| **Audience + brand** | `brandContextService.js` reads `organizations` + property display/short/sender-label columns. `audienceResolver.js` resolves from **`tenant_roster`** + **`units`**, produces preview counts + skip reasons (`NO_PHONE`, `OPT_OUT`). |
| **Compose + send** | `messageComposer.js` adds AI draft with deterministic fallback; `commOutgate.js` appends footer only at send time and sends from **`TWILIO_BROADCAST_FROM`** via transport-level `from` override in **`src/outbound/twilioSendMessage.js`**. `campaignService.js` now handles draft update, prepare snapshot, and send orchestration. |
| **Reply / delivery webhooks** | Added **`src/webhooks/communicationsSms.js`** with **`POST /webhooks/communications/sms`** and **`POST /webhooks/communications/status`**. `replyClassifier.js` is deterministic, `replyHandler.js` records replies + opt-out + auto-response redirect, `deliveryTracker.js` rolls up recipient/campaign delivery status. Explicit seam **`src/brain/createMaintenanceTicketFromCommReply.js`** exists but is still stubbed (`not_implemented`). |
| **Tests** | Added **`tests/communicationAudienceResolver.test.js`**, **`tests/communicationMessageComposer.test.js`**, and **`tests/communicationReplyClassifier.test.js`**. All pass. |
| **Docs / env** | Updated **`COMMUNICATION_ENGINE.md`**, **`AGENTS.md`**, **`BRAIN_PORT_MAP.md`**, **`OUTSIDE_CURSOR.md`**, **`supabase/migrations/README.md`**, and **`.env.example`** for the live slice. |

### Next / open
| Item | Notes |
|------|--------|
| **Portal UI** | No `propera-app` communications proxy/routes/screens yet. Backend is ready for the first wizard slice. |
| **Maintenance handoff** | Broadcast reply classification can identify maintenance/emergency signals, but **`createMaintenanceTicketFromCommReply`** is still a stub seam until the ticket-seed contract is defined. |
| **Delivery detail / replies detail / cancel** | Planned routes are still partial: recipients/replies list and cancel path not implemented yet. |
| **Full-suite status** | `npm test` still has the same unrelated tenant-agent failures as before this slice (**26 failures total**). New communication tests pass; module smoke checks pass. |

### Commands

```bash
cd propera-v2
npm test
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
