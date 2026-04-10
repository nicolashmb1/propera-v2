# Propera V2 — agent handoff (read this first)

If the user says **“keep working on V2”** or **“continue Propera V2”**, **do not improvise**. Follow this file and the linked docs in order. **No re-explanation of repo purpose** — the links below are the explanation.

---

## Mandatory read order (do not skip)

1. **Repo root** `PROPERA_GUARDRAILS.md` — patch law, module boundaries, safety.  
2. **Repo root** `PROPERA_NORTH_COMPASS.md` — mission / architecture doctrine.  
3. **`docs/PARITY_LEDGER.md`** — **single source of truth** for what is PORTED vs PARTIAL vs STUB vs NOT STARTED (GAS ↔ V2). **Flow parity ≠ semantic parity.**  
4. **`docs/PORTING_FROM_GAS.md`** — rule: port GAS behavior; no parallel brain rules.  
5. **`docs/BRAIN_PORT_MAP.md`** — what files exist, Telegram → router → core path, handoff table.  
6. **`docs/PROPERA_V2_GAS_EXIT_PLAN.md`** — phases / cutover narrative (when relevant).  
7. **`docs/OUTSIDE_CURSOR.md`** — SQL/env steps operators run outside the editor.

Optional: **`docs/TESTING_STRATEGY.md`**, **`docs/STRUCTURED_LOGS.md`**.

---

## Current stance (explicit)

- **GAS + Sheets = production brain** until a deliberate cutover. V2 is the parallel Node runtime under `propera-v2/`.  
- **Do not add new product paths or new brain surfaces** unless the user explicitly un-freezes that. Prior work item: **what is already wired must behave like GAS** (regression / parity), not scope expansion.  
- **Any behavior change** → update **`docs/PARITY_LEDGER.md`** and pointer comments in code (`PARITY GAP:` where reduced vs GAS).

---

## You must update these docs when reality changes (non-optional)

Conversations **drift**: freeze lifts, scope shifts, priorities change, a port lands, env/ops steps change. **The next agent only reads the repo** — not this chat. If **direction, scope, stance, or “what’s true”** changes during the thread (or you establish a new norm), **edit the files** so they stay true.

| If this changed… | Update (same PR / follow-up commit) |
|------------------|-------------------------------------|
| What’s PORTED / PARTIAL / STUB, or semantic gaps | **`docs/PARITY_LEDGER.md`** |
| Files, flows, handoff status, “what’s wired” | **`docs/BRAIN_PORT_MAP.md`** |
| New GAS ↔ V2 mapping or porting rule | **`docs/PORTING_FROM_GAS.md`** |
| Phases, cutover, migration strategy | **`docs/PROPERA_V2_GAS_EXIT_PLAN.md`** |
| Operators must run SQL, new env vars, webhook steps | **`docs/OUTSIDE_CURSOR.md`**, **`README.md`**, **`.env.example`** |
| Freeze lifted, new priority (e.g. parity-only → new paths), or agent instructions | **`AGENTS.md`** (this file) — **especially “Current stance”** |
| Test strategy / what to run for regression | **`docs/TESTING_STRATEGY.md`** (if testing expectations changed) |

**Rule:** Stale docs are a bug. **Do not** end a meaningful direction change with only chat context updated.

---

## Where everything lives

| Need | Location |
|------|----------|
| Parity status (what matches GAS, what’s missing) | `docs/PARITY_LEDGER.md` |
| File / flow map | `docs/BRAIN_PORT_MAP.md` |
| Porting rules + GAS source table | `docs/PORTING_FROM_GAS.md` |
| Runnable code | `propera-v2/src/` |
| Unit tests | `propera-v2/tests/` |
| Supabase SQL | `propera-v2/supabase/migrations/` |
| Env template | `propera-v2/.env.example` |

**Entry server:** `src/index.js`. **Tenant maintenance core:** `src/brain/core/handleInboundCore.js`. **Router precursors:** `src/brain/router/`. **DAL:** `src/dal/`. **GAS ports (parsers, address):** `src/brain/gas/`, `src/brain/shared/`.

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

1. Open **`docs/PARITY_LEDGER.md`** — identify rows relevant to the task (**PARTIAL** / **STUB** = risk).  
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
