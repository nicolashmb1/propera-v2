# Propera V2 — agent handoff (read this first)

If the user says **“keep working on V2”** or **“continue Propera V2”**, **do not improvise**. Follow this file and the linked docs in order. **No re-explanation of repo purpose** — the links below are the explanation.

If the task also includes **`propera-app`** / portal UI, read sibling **`../propera-app/AGENTS.md`** too. `propera-app` and `propera-v2` are the same Propera ecosystem: **app = cockpit**, **V2 = operational brain**.

---

## Mandatory read order (do not skip)

1. **Repo root** `PROPERA_GUARDRAILS.md` — patch law, module boundaries, safety.  
2. **Repo root** `PROPERA_NORTH_COMPASS.md` — mission / architecture doctrine.  
3. **`docs/PARITY_LEDGER.md`** — **single source of truth** for what is PORTED vs PARTIAL vs STUB vs NOT STARTED (GAS ↔ V2). **Flow parity ≠ semantic parity.**  
4. **`docs/PORTING_FROM_GAS.md`** — rule: port GAS behavior; no parallel brain rules.  
5. **`docs/BRAIN_PORT_MAP.md`** — what files exist, inbound → router → core → outgate path, handoff table.  
6. **`docs/ORCHESTRATOR_ROUTING.md`** — **execution order**, **what blocks maintenance core**, **lane stubs** (vendor/system vs tenant/manager).  
7. **`docs/ADAPTER_ONBOARDING.md`** — when adding channels, follow adapter-only boundary + shared media contract.  
8. **`docs/PROPERA_V2_GAS_EXIT_PLAN.md`** — phases / cutover narrative (when relevant).  
9. **`docs/OUTSIDE_CURSOR.md`** — SQL/env steps operators run outside the editor.  
10. **`docs/TICKET_TIMELINE.md`** — portal **Activity** / `ticket_timeline_events`: V1 trigger contract, **`timeline_json`** shape, duplicate rule vs **Timeline V2** semantic writers, migrations **`034`–`037`**, app mapping (`propera-app` `timelineMapping.ts`).

Optional: **`docs/GAS_ENGINE_PORT_PROGRAM.md`** (phased port for engines 10/12/14/20), **`docs/TESTING_STRATEGY.md`**, **`docs/STRUCTURED_LOGS.md`**, **`docs/HANDOFF_LOG.md`** (what changed recently — read **latest dated section** before deep-diving). **Access / amenity reservations (smart locks):** **`docs/ACCESS_ENGINE_BUILD_PLAN.md`** — read before any access-engine work (**expanded partial live**: V2 engine + app/tenant portal + shared text-channel ACCESS_* + access lifecycle worker + Tenant Agent handoff are shipped; real lock adapters and deposit/payment hooks still pending). **Jarvis / multi-agent:** **`docs/PROPERA_JARVIS_NORTH_STAR.md`** (doctrine), **`docs/JARVIS_SPINE.md`** (foundation build order + proposal contract), **`docs/STAFF_AGENT_V1.md`**, **`src/agent/operationalScope/`** (scope compiler v0). **Conflict mediation:** **`docs/CONFLICT_MEDIATION_ENGINE.md`** — CME-2 live behind `PROPERA_CONFLICT_MEDIATION_ENABLED=1` (report violation + courtesy notice); CME-3+ not started. **Operational policy config (multi-tenant rules):** **`docs/OPERATIONAL_POLICY_CONFIG.md`** — `src/brain/policy/resolveOperationalPolicy.js`; do not hardcode business rules in code. **North Compass** (domain engines + Jarvis): `../propera-gas-reference/PROPERA_NORTH_COMPASS.md`.

---

## Finance work — mandatory reads when working on Propera finances

If the user says anything about **finances, ledger, rent, delinquency, owner statements, charges, lease, cost, vendor AP, budgets**, or working on the **`/financial` area** of propera-app, read these **before touching code**:

1. **`docs/PROPERA_FINANCE_ROADMAP.md`** — **start here**. Six-phase plan + **§Finance inside Propera architecture** (channel-agnostic POS, package in/out, `/financial` module spine). Shows what is done, what is next, and the migration sequence. **Check which phase we are in before building anything.**
2. **`docs/ACCOUNTING_SIGNAL_SCHEMA.md`** — **read before Leasehold mimic / materialization work**. Leasehold adapter → structured signals → brain posts Propera leases + ledger (Steps 0–4; tenant reconcile → lease materializer → ledger mimic). Phase 1.5 snapshot ingest alone is **display-only**.
3. **`docs/PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md`** — honest snapshot of what ships today (capabilities checklist, Layer 0–5 depth map, feature flags, §2.5a for propera-app finance surfaces).
4. **`docs/PROPERA_FINANCIAL_LAYER_MAP.md`** — where tables live, portal routes, guardrails, app proxy pattern for cost/ledger data.
5. **`../propera-app/docs/FINANCIAL_LEASEHOLD_SYNC.md`** — Leasehold snapshot ingest, office syncher (mirror → staging), schedule, deposit reconciliation, migrations **094–097**.

### Where the roadmap stands right now (update this when a phase item ships)

| Phase | Status | Last migration |
|-------|--------|---------------|
| **Baseline** | ✅ Complete | 051 (051 = program_lines staff — ops, not finance) |
| **Phase 1** — credible daily use (snapshot APIs, lease/rent on cards, ledger void/date/notes) | 🟡 In progress | **052** applied; Phase 1d (property expenses + record payment + bill scan) shipped **2026-05-30** — see roadmap §1d |
| **Phase 1d** — parallel-run operating expenses (`property_expenses` table, expense tab, bill scan, record payment) | ✅ Shipped | **082** `property_expenses`; record payment uses existing ledger POST; bill scan via V2 `expenseScanVision.js` |
| **Phase 1.5** — incumbent accounting **read-only snapshot** (Leasehold → `/financial`) | ✅ **Shipped** (2026-06-08) — bridge + import APIs + snapshot rollups; office syncher **planned** | migrations **094–097**; see `../propera-app/docs/FINANCIAL_LEASEHOLD_SYNC.md` |
| **Phase 1.6** — accounting mimic (LH signals → Propera lease + ledger records) | 🟡 **Steps 1–2 pilot** — `lease_terms_sync` shipped; ledger mimic **WESTFIELD unit 101** | **`handleAccountingImportSignals.js`**; migration **108** applied before import |
| **Phase 2** — rent roll + delinquency (native `rent_postings` or promoted import) | 🔲 Not started | **103+** (new number — see roadmap) |
| **Phase 3** — vendor finance / AP | 🔲 Not started | **103+** (new number — see roadmap) |
| **Phase 4** — budget vs actual | 🔲 Not started | **103+** (new number — see roadmap) |
| **Phase 5** — owner statements | 🔲 Not started | **108+** (see roadmap) |
| **Phase 5b** — accounting reports (`/financial/reports`, accountant export pack) | 🔲 Not started — **required for LH cutover** | **108+** |
| **Phase 6** — full books + bank reconciliation (**cutover target** — replace Leasehold) | 🔲 Not started | **108+** |

**Current finance migration note:** `052_tenant_ledger_effective_date_notes.sql` is applied for Phase 1 ledger hardening. **108** adds `accounting_import` + `import_idempotency_key` for LH ledger mimic. **Do not reuse 051** (already `program_lines` staff assignment). **053–057 are consumed** by other features. **094–097** = Leasehold snapshot ingest (Phase 1.5). Next **new** finance schema beyond 108 starts at **109+** — see **`docs/PROPERA_FINANCE_ROADMAP.md`** migration table.

### Finance guardrails (always apply)
- Finance is **layered on the property operation system** — channel-agnostic, package in/out. See roadmap **§Finance inside Propera architecture** and **§Staff-minimal finance**. No finance logic in adapters; no lifecycle/resolver bypass.
- **Owner intent:** Leasehold is transitional — build toward **Propera financially complete** (payments, bank rec, reports, automation). See roadmap **Owner cutover intent** and Phase **5b / 6**.
- Browser **never** writes `ticket_cost_entries` directly — only V2 portal routes with finance flags.
- **Manual ledger lines** and **unit lease** upserts go through **propera-app Next routes** with the tenant-mutation gate — not the V2 ticket-cost DAL.
- Ticket economics stay **authoritative on tickets**. Manual ledger lines are PM/owner adjustments only.
- Each phase needs **schema + API + propera-app surface** (+ financial snapshot read APIs for portfolio/property views). No orphaned half-done migrations.
- When Leasehold snapshots are absent, portfolio rent/delinquency may fall back to lease/ledger reads — show honest **as-of** / import prompts, not fake zeros.

---

## Current stance (explicit)

- **Operator default: V2-first** for the **staff portal stack** (`propera-app` → `/webhooks/portal`, Supabase reads). **GAS + Sheets** is **legacy backup** for slices not retired (escape hatch / old ticket rows), not the default target for new portal PM features.  
- **Semantic reference:** **`docs/PARITY_LEDGER.md`** still tracks **GAS-class behavior** where it matters for maintenance intake and regressions — that is **correctness reference**, not “ship every change to GAS first.”  
- **Do not add new product paths or new brain surfaces** unless the user explicitly un-freezes that. Prior work item: **what is already wired must behave like GAS** (regression / parity), not scope expansion.  
- **Exception (explicit):** **PM/Task V1** — template-driven `program_runs` / `program_lines` + `/api/portal/program-*` routes (**`docs/PM_PROGRAM_ENGINE_V1.md`**). **Not** tenant reactive intake; keep **`handleInboundCore`** out of program creation. **`properties.program_expansion_profile`** is the per-property **building structure** for expansion today; **planned reuse** for tenant/staff/ops assistance (same labels across tickets and programs) is documented under **Strategic reuse** in that file — still **read-side / resolver** until explicitly owned elsewhere (**`docs/BRAIN_PORT_MAP.md`** portal PM table).  
- **Any behavior change** → update **`docs/PARITY_LEDGER.md`** and pointer comments in code (`PARITY GAP:` where reduced vs GAS).
- **Known red tests / preserve current tenant-agent behavior (2026-06-12):** Do **not** change tenant-agent behavior just to make failing tests pass without explicit user approval. Current accepted behavior: **unit tickets may finalize without schedule**, then ask schedule **post-create**; **common area** and **emergency / skipScheduling** should **not** ask for schedule. **`npm test`** currently reports **~13 flaky failures** (count varies 13–15) — mostly tenant-agent gather/golden/handoff suites plus **`tests/tenantMessagesCancelLayer.test.js`** (known unimplemented cancel/suspend path). Core suites (router, schedule, staff brain, Jarvis reason) stay green. Do not “fix reds” unless the user explicitly requests tenant-agent work. See **`docs/TESTING_STRATEGY.md`** §Known flaky failures.

---

## Bootstrap roadmap — getting V2 “real” (execution order)

Use this order when choosing what to build next. It matches **`docs/PARITY_LEDGER.md` §7** (highest-risk gaps) and avoids stacking new modules on **PARTIAL** brain contracts. **Do not skip earlier items** to add features that depend on them.

| # | Priority | What “done” means | Primary refs |
|---|----------|---------------------|----------------|
| **1** | **Maintenance semantic parity (first)** | Property grounding, single-turn draft parse, pre-ticket slot/stage, merge/recompute aligned with GAS **where intake semantics still apply**; drift removed vs **`08_INTAKE_RUNTIME.gs` / `11_TICKET_FINALIZE_ENGINE.gs`** class behavior. Portal PM writes are **V2-canonical**; use PARITY for gaps vs old GAS, not as a GAS-first gate. | `PARITY_LEDGER.md` §§1–2; `handleInboundCore.js`, `compileTurn.js`, `properaBuildIntakePackage.js`, `parseMaintenanceDraft.js`, `mergeMaintenanceDraft.js`, `recomputeDraftExpected.js` |
| **2** | **Router + lane as the single front door** | **`runInboundPipeline.js`** + **`routeInboundDecision.js`** — precursors, lane, SMS compliance, core guards, vendor/system stubs; **`src/index.js`** wires Telegram + Twilio to the same pipeline. | `PARITY_LEDGER.md` §5; **`docs/ORCHESTRATOR_ROUTING.md`**; `evaluateRouterPrecursor.js`, `decideLane.js`, `normalizeInboundEvent.js` |
| **3** | **`compileTurn` / intake as structured truth** | Maintenance structured state comes from the primary intake path (`INTAKE_COMPILE_TURN` / package); merge/recompute consume the same truth; lighter fallbacks are not the main semantic path. | `compileTurn.js`, `properaBuildIntakePackage.js`, `mergeMaintenanceDraft.js` |
| **4** | **Test harness before more porting** | Default **`npm test`** runs every `tests/*.test.js` file (flat layout today); add **golden / replay** scenarios for maintenance intake and stage transitions per **`docs/TESTING_STRATEGY.md`** as contracts stabilize. | `package.json` `test` script; `docs/TESTING_STRATEGY.md` |
| **5** | **Staff lifecycle (enough for trustworthy execution)** | Staff operational flows match GAS class behavior; ticket/WI updates from staff are stable before new orchestration. | `PARITY_LEDGER.md` §6; `handleStaffLifecycleCommand.js` |
| **6** | **Media / OCR (after core maintenance is stable)** | Keep the **`_mediaJson`** bridge; finish OCR/vision as a bounded port; media-derived text feeds the **same** intake path as body text, not a parallel brain. | `mediaPayload.js`, `mediaOcr.js`, `ADAPTER_ONBOARDING.md` |
| **7** | **Docs reflect reality** | **README** current-state; **PARITY_LEDGER** updated when behavior changes; **HANDOFF_LOG** for session wrap; solid vs partial vs deferred is explicit. | This file, `README.md`, `PARITY_LEDGER.md`, `HANDOFF_LOG.md` |

**Why this order:** unstable maintenance semantics (1) and an ambiguous router (2) poison every layer above; intake truth (3) and tests (4) lock regressions; staff (5) and media (6) depend on those; docs (7) keep the next agent honest.

---

## You must update these docs when reality changes (non-optional)

Conversations **drift**: freeze lifts, scope shifts, priorities change, a port lands, env/ops steps change. **The next agent only reads the repo** — not this chat. If **direction, scope, stance, or “what’s true”** changes during the thread (or you establish a new norm), **edit the files** so they stay true.

| If this changed… | Update (same PR / follow-up commit) |
|------------------|-------------------------------------|
| What’s PORTED / PARTIAL / STUB, or semantic gaps | **`docs/PARITY_LEDGER.md`** |
| Files, flows, handoff status, “what’s wired” | **`docs/BRAIN_PORT_MAP.md`** |
| Adapter contract or channel onboarding rules | **`docs/ADAPTER_ONBOARDING.md`** |
| New GAS ↔ V2 mapping or porting rule | **`docs/PORTING_FROM_GAS.md`** |
| Orchestrator routing or lane-stub behavior changes | **`docs/ORCHESTRATOR_ROUTING.md`**, **`docs/PARITY_LEDGER.md`** §5 |
| Phases, cutover, migration strategy | **`docs/PROPERA_V2_GAS_EXIT_PLAN.md`** |
| Operators must run SQL, new env vars, webhook steps | **`docs/OUTSIDE_CURSOR.md`**, **`README.md`**, **`.env.example`** |
| Session wrap-up: what shipped, where to continue | **`docs/HANDOFF_LOG.md`** (append a **dated section**) |
| Freeze lifted, new priority (e.g. parity-only → new paths), or agent instructions | **`AGENTS.md`** (this file) — **especially “Current stance”** |
| Test strategy / what to run for regression | **`docs/TESTING_STRATEGY.md`** (if testing expectations changed) |
| Portal preventive / program expansion or building-profile contract | **`docs/PM_PROGRAM_ENGINE_V1.md`** (+ **`docs/BRAIN_PORT_MAP.md`** portal PM row if routes/files move) |
| Ticket Activity timeline (trigger kinds, view contract, V2 event kinds, duplicate rule) | **`docs/TICKET_TIMELINE.md`**, **`supabase/migrations/`** (new migration if SQL contract changes), **`propera-app/src/lib/timelineMapping.ts`**, **`tests/ticketTimelineV1Kinds.test.js`** (or successor) |
| PM assignment override phases, acceptance criteria, per-phase status | **`docs/PM_ASSIGNMENT_OVERRIDE.md`** — update `Status` column when a phase ships or acceptance criteria change |
| Finance phase ships, new migration lands, or roadmap priority changes | **`docs/PROPERA_FINANCE_ROADMAP.md`** (phase table + migration sequence) · **`AGENTS.md`** "Where the roadmap stands" table · **`docs/PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md`** §2.5a + §8 + Baseline row |
| Accounting mimic / signal kinds / materialization rules change | **`docs/ACCOUNTING_SIGNAL_SCHEMA.md`** · **`docs/PROPERA_FINANCE_ROADMAP.md`** Phase 1.6 row |

**Rule:** Stale docs are a bug. **Do not** end a meaningful direction change with only chat context updated.

---

## Where everything lives

| Need | Location |
|------|----------|
| Parity status (what matches GAS, what’s missing) | `docs/PARITY_LEDGER.md` |
| Recent session / ops notes (dated; not parity SSOT) | `docs/HANDOFF_LOG.md` |
| File / flow map | `docs/BRAIN_PORT_MAP.md` |
| Inbound order + core gates + lane stubs | `docs/ORCHESTRATOR_ROUTING.md` |
| Phased engine port (10/12/14/20) | `docs/GAS_ENGINE_PORT_PROGRAM.md` |
| New channel onboarding checklist | `docs/ADAPTER_ONBOARDING.md` |
| Porting rules + GAS source table | `docs/PORTING_FROM_GAS.md` |
| Runnable code | `propera-v2/src/` |
| Portal app handoff / cockpit boundary | `../propera-app/AGENTS.md`; `../propera-app/docs/PROPERA_ARCHITECTURE_BOUNDARIES.md` |
| Portal PM / preventive (program runs, expansion) | `docs/PM_PROGRAM_ENGINE_V1.md`; code: `src/dal/programRuns.js`, `src/pm/expandProgramLines.js`, `src/portal/registerPortalRoutes.js` |
| PM assignment override (phases 1–5, what's done, what's next) | `docs/PM_ASSIGNMENT_OVERRIDE.md`; code: `src/dal/portalTicketAssignment.js`, `src/portal/registerPortalRoutes.js` |
| **Finance roadmap** (phased plan, current phase, next migration) | **`docs/PROPERA_FINANCE_ROADMAP.md`** — **read before any finance work** |
| Finance depth + capability snapshot (Layer 0–5, flags, propera-app surfaces) | `docs/PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md` |
| Finance table / route / flag map | `docs/PROPERA_FINANCIAL_LAYER_MAP.md` |
| **Leasehold mimic / accounting signals** (adapter → brain → Propera records) | **`docs/ACCOUNTING_SIGNAL_SCHEMA.md`** — Steps 0–4; tenant reconcile **`supabase/queries/README_TENANT_RECONCILE.md`** |
| Unit leases (schema, API) | `supabase/migrations/049_unit_leases.sql`; propera-app `src/app/api/properties/[code]/units/[unitId]/lease/route.ts` |
| Unit tenant ledger (schema, API, manual POST) | `supabase/migrations/042_operational_finance_v1.sql` + `050_tenant_ledger_unit_property_idx.sql`; propera-app `src/app/api/properties/[code]/units/[unitId]/ledger/route.ts` |
| Unit tests | `propera-v2/tests/` |
| Supabase SQL | `propera-v2/supabase/migrations/` |
| Portal ticket Activity / timeline V1+V2 contract | **`docs/TICKET_TIMELINE.md`**; SQL: `034`–`037` ticket timeline migrations; app: `propera-app/src/lib/timelineMapping.ts` |
| **PM ticket split** (2-ticket, detail modal) | **`docs/TICKET_SPLIT_V1.md`** — spec locked; **not implemented** (needs new migration — **`061`** is open-deck day chart note only) |
| **Open deck day chart** (mobile 8a–8p, open vs completed, day pager) | **`docs/OPEN_DECK_DAY_CHART_V1.md`** — feature-flagged; `GET /api/portal/tickets/day-curve`; app `OpenDeckDayChart.tsx` |
| **Communication Engine** (broadcast SMS, dedicated Twilio number) | **`docs/COMMUNICATION_ENGINE.md`**; SQL: **`055`**, **`065`**, **`102`** (org SMS header/footer templates); code: `src/communication/` (campaign draft + compose + audience preview + send + reply/delivery tracking live), `src/webhooks/communicationsSms.js` |
| **Balance reminder automation** (rent reminders via comm engine) | **`docs/BALANCE_REMINDER_AUTOMATION.md`**; SQL: **`098`–`101`**; cron `POST /internal/cron/balance-reminders`; portal settings `/api/portal/settings/balance-reminders/*`; flag **`PROPERA_BALANCE_REMINDER_ENABLED=1`**; app **`/settings/balance-reminders`** |
| **Portal Leasing Ops V1** (expiring leases + prospect pipeline — not GAS leasing brain) | **`docs/PARITY_LEDGER.md`** §12; SQL: **`085_leasing_engine_v1.sql`**; code: `src/dal/leasingProspects.js`; flags: **`PROPERA_LEASING_ENGINE_ENABLED`** (V2) + **`NEXT_PUBLIC_PROPERA_LEASING_ENABLED`** (app) |
| **Vendor lane** (dispatch, inbound YES/NO, policy auto-route) | **`docs/VENDOR_LANE.md`**; **V0–V2 shipped:** portal assign + dispatch (`069`, `073`), **`handleVendorInbound`** YES/NO for identified vendor phones; **V3** policy auto-route not started; unidentified vendor traffic still gets lane stub |
| **Multi-org / SaaS spine** | **`docs/MULTI_ORG_ARCHITECTURE.md`**; SQL: **`074_org_spine_core.sql`**; code: `src/portal/resolvePortalOrgContext.js`, `portalOrgScope.js` |
| **Conflict Mediation Engine** (policy enforcement, complaints, notice tiers) | **`docs/CONFLICT_MEDIATION_ENGINE.md`**; **CME-2 shipped** behind `PROPERA_CONFLICT_MEDIATION_ENABLED=1` (report violation + courtesy notice); CME-3+ not started; SQL: **`067`**, **`068`**, **`071`**; code: `src/conflictMediation/` |
| **Jarvis / company operating delegate** (tenant, staff, owner agents + outgate) | **`docs/PROPERA_JARVIS_NORTH_STAR.md`**, **`docs/JARVIS_SPINE.md`** |
| **Tenant Agent** (AI Staff — conversational SMS/TG/WA front door) | **`docs/TENANT_AGENT_ADAPTER.md`**; code: `src/adapters/tenantAgent/`; brain append: `handleTenantAppendToTicket.js`; SQL: **`063_tenant_conversations.sql`**; flags: **`TENANT_AGENT_*`** in `.env.example` |
| **Tenant portal** (resident `/tenant/*` in propera-app + `/api/tenant/*` in V2) | **`docs/TENANT_PORTAL_BUILD_PLAN.md`**; SQL: **`056_tenant_portal.sql`**; **i18n en/es:** **`docs/TENANT_PORTAL_I18N.md`** (spec locked — staff portal untouched) |
| **Unit lifecycle** (occupancy history, unit assets, history tab, turnover scope — **Jarvis deferred**) | **`docs/UNIT_LIFECYCLE_BUILD_PLAN.md`**; turnover DAL: **`039`** + `src/dal/turnovers.js`; unit hub: **`propera-app`** `GET /api/properties/[code]/units/[unitId]` |
| Env template | `propera-v2/.env.example` |
| Intake attach classify (deterministic slice) | `src/brain/core/intakeAttachClassify.js` (used by `mergeMaintenanceDraft.js`) |
| Attach clarify latch (DB) | `src/dal/conversationCtxAttach.js` — sets `conversation_ctx.pending_expected = ATTACH_CLARIFY` |

**Entry server:** `src/index.js` → **`src/inbound/runInboundPipeline.js`** (Telegram + Twilio). **Orchestrator guards:** `src/inbound/routeInboundDecision.js`. **Tenant maintenance core:** `src/brain/core/handleInboundCore.js`. **Outbound send seam:** `src/outgate/dispatchOutbound.js` (only place user-facing Telegram/Twilio sends run). **Router precursors:** `src/brain/router/`. **DAL:** `src/dal/`. **GAS ports (parsers, address):** `src/brain/gas/`, `src/brain/shared/`.

---

## Commands

```bash
cd propera-v2
npm test
npm start
```

**Tests are the regression net** for wired behavior. Failing tests = wrong vs locked expectations, not “optional.”

---

## When asked to “continue V2” — do this

1. Open **`docs/PARITY_LEDGER.md`** — identify rows relevant to the task (**PARTIAL** / **STUB** = risk). When several gaps compete, prefer the **Bootstrap roadmap** order above.  
2. Open **`docs/BRAIN_PORT_MAP.md`** — confirm which files participate in the flow.  
3. Change **only** what the user asked; **update the ledger** if behavior vs GAS changes.  
4. Run **`npm test`** before finishing.  
5. Do **not** invent substitute logic when **`docs/PORTING_FROM_GAS.md`** says to port a GAS function — find the GAS source first.  
6. If the **user changes direction or scope** in-thread, apply the **“You must update these docs”** table above before wrapping up.

---

## Do not

- Treat “V2 runs” as “matches GAS” — check the **ledger**.  
- Add new routes, lanes, or intake modes without explicit user approval (freeze).  
- Duplicate GAS rules under new names — **port** the real functions.  
- Skip **`PROPERA_GUARDRAILS.md`** for any code change.  
- **Leave handoff docs stale** after a direction change — update **`AGENTS.md`** / **`docs/PARITY_LEDGER.md`** / peers per the table above.

---

*Handoff: ledger, BRAIN_PORT_MAP, and this file must reflect current truth for the next agent.*
