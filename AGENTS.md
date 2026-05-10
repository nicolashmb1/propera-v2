# Propera V2 — agent handoff (read this first)

If the user says **“keep working on V2”** or **“continue Propera V2”**, **do not improvise**. Follow this file and the linked docs in order. **No re-explanation of repo purpose** — the links below are the explanation.

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

Optional: **`docs/GAS_ENGINE_PORT_PROGRAM.md`** (phased port for engines 10/12/14/20), **`docs/TESTING_STRATEGY.md`**, **`docs/STRUCTURED_LOGS.md`**, **`docs/HANDOFF_LOG.md`** (what changed recently — read **latest dated section** before deep-diving).

---

## Current stance (explicit)

- **Operator default: V2-first** for the **staff portal stack** (`propera-app` → `/webhooks/portal`, Supabase reads). **GAS + Sheets** is **legacy backup** for slices not retired (escape hatch / old ticket rows), not the default target for new portal PM features.  
- **Semantic reference:** **`docs/PARITY_LEDGER.md`** still tracks **GAS-class behavior** where it matters for maintenance intake and regressions — that is **correctness reference**, not “ship every change to GAS first.”  
- **Do not add new product paths or new brain surfaces** unless the user explicitly un-freezes that. Prior work item: **what is already wired must behave like GAS** (regression / parity), not scope expansion.  
- **Exception (explicit):** **PM/Task V1** — template-driven `program_runs` / `program_lines` + `/api/portal/program-*` routes (**`docs/PM_PROGRAM_ENGINE_V1.md`**). **Not** tenant reactive intake; keep **`handleInboundCore`** out of program creation. **`properties.program_expansion_profile`** is the per-property **building structure** for expansion today; **planned reuse** for tenant/staff/ops assistance (same labels across tickets and programs) is documented under **Strategic reuse** in that file — still **read-side / resolver** until explicitly owned elsewhere (**`docs/BRAIN_PORT_MAP.md`** portal PM table).  
- **Any behavior change** → update **`docs/PARITY_LEDGER.md`** and pointer comments in code (`PARITY GAP:` where reduced vs GAS).

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
| Portal PM / preventive (program runs, expansion) | `docs/PM_PROGRAM_ENGINE_V1.md`; code: `src/dal/programRuns.js`, `src/pm/expandProgramLines.js`, `src/portal/registerPortalRoutes.js` |
| Unit tests | `propera-v2/tests/` |
| Supabase SQL | `propera-v2/supabase/migrations/` |
| Portal ticket Activity / timeline V1+V2 contract | **`docs/TICKET_TIMELINE.md`**; SQL: `034`–`037` ticket timeline migrations; app: `propera-app/src/lib/timelineMapping.ts` |
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
