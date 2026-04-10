# Testing strategy — Propera brain / intake / routing (baseline)

This doc is the **end-goal map** for automated confidence in V2, aligned with **PROPERA_GUARDRAILS.md** and **BRAIN_PORT_MAP.md**. It extends the original “discussion baseline” with Propera-specific structure: **stage authority**, **layer boundaries**, **channel neutrality**, and **anti–mini-brain drift**.

---

## Goal

Stop relying on **manual Telegram** for every change.

Tests should answer: **given this inbound signal or message sequence, what should Propera do?**

Assert the right:

- **Canonical signal / package facts** (when the intake package exists)
- **Stage / expected-next** (single authority)
- **Draft fields** and **finalize vs prompt** decision
- **Ticket / work_item** creation when that layer runs
- **Lifecycle / policy** effects (when ported)
- **Outbound intent** (template / intent key), not ad-hoc copy
- **No duplicate handling** of the same inbound idempotency key

**Purpose beyond correctness:** tests protect **architecture** — no unofficial mini-brains, duplicated interpreters, conflicting stage sources, or channel logic leaking into the wrong layer.

---

## Core testing principles

1. **Test the real stack where it matters** — Prefer exercising **control boundaries** (router precursors, core draft merge + recompute, future lifecycle gateway) over only isolated helpers. Helpers stay unit-tested, but confidence comes from **scenarios** that touch the same order of operations as production.

2. **Deterministic first** — Telegram / Twilio / WhatsApp are **smoke/E2E**. Main regression safety is **replayable, channel-agnostic** tests (`npm test`).

3. **One source of truth per decision** — Guard against multiple stage authorities, duplicate route decisions, shadow parsing, or parallel interpretations of one turn.

4. **Product stories → fixtures** — One fixture = one operational story (readable by humans and agents).

5. **Default suite stays fast** — `npm test`: mostly pure + scenario, **no** real DB unless you add a separate job.

6. **Tests follow the brain, not the calendar** — Do **not** build the full future matrix before the code exists. When a slice of the real stack lands, **add the tests that slice can support** in the **same milestone** (same PR or immediate follow-up). Premature tests (no stable boundary to assert) are as harmful as permanent gaps.

---

## Staged test implementation — “right stage, right tests”

**Rule:** Implement automated coverage **when** the product/architecture is at the point where a **stable contract** exists for that layer. Until then, document the **intended** fixture in **this file** or **BRAIN_PORT_MAP.md** and move on.

| Brain / code milestone | Tests to add (same milestone) |
|--------------------------|-------------------------------|
| Pure helper exists (`recompute`, `merge`, `parse`, precursors) | **Unit tests** — no DB |
| Multi-turn draft + `intake_sessions` behavior stable | **Scenario fixtures** + in-memory runner (optional stub DAL) |
| `handleInboundCore` (or core entry) semantics frozen | **Scenario** or thin **integration** with mocked Supabase |
| DAL + DB constraints matter | **`integration/`** against dev Supabase (separate job) |
| Intake package / LLM contract stable | **Contract + golden** fixtures with **mocked** provider |
| Lifecycle / policy engine ported | **Lifecycle/policy** unit + scenario replay |
| Outgate intent map stable | **Outgate** template / intent key assertions |
| Channel adapter shape stable | **Adapter** normalization tests only (no brain logic) |

**Definition of done for a brain slice:** merging the feature without a **proportionate** test addition at the applicable row above is incomplete — unless explicitly waived in the PR with a tracked follow-up issue.

### Can this be done “automatically”?

- **Fully automatic** detection of “the right stage” is **not** reliable: tools don’t know architectural readiness without human/architect judgment.
- **What works in practice:**
  - **Milestone binding** — tie **PROPERA_V2_GAS_EXIT_PLAN.md** / **BRAIN_PORT_MAP.md** phases to the test row above; when a phase flips to done, the corresponding tests are **expected** in the same release train.
  - **PR discipline** — reviewers ask: *which row in the table did this change satisfy, and where are the tests?*
  - **Optional CI (later)** — e.g. `npm test` in every PR; optional path filters that warn if `src/brain/**` changes with zero `tests/**` changes (noisy — use sparingly).

**Summary:** “Automatic” means **process + checklist + milestone alignment**, not a bot that guesses when to write tests. The **table** is the contract for when to implement which layer.

---

## Layers (recommended)

| Layer | What it proves | Speed | Default `npm test` |
|-------|----------------|-------|---------------------|
| **Pure unit** | Pure functions: `recomputeDraftExpected`, `mergeMaintenanceDraftTurn`, `parseMaintenanceDraft`, `resolvePropertyFromReply`, router precursors, `normMsg`, etc. | Fastest | Yes |
| **Scenario / golden** | Multi-turn stories **in memory**: fixture → merge → recompute → assert stage + draft; optional stubbed finalize | Fast | Yes (grow over time) |
| **Replay / parity** | Normalized transcripts or golden inbounds replayed through the **same stack** as prod; lane + expected-next + no duplicate handling | Medium | Yes or separate `npm run test:replay` when heavy |
| **Integration** | Real Supabase dev DB: `intake_sessions`, tickets, `event_log`, dedupe, idempotency | Slower | Separate CI job |
| **E2E** | Telegram sandbox + tunnel + webhook | Slowest | Smoke only |

**Rule of thumb:** Table- or JSON-driven scenarios (“issue only”, “property + unit + issue one message”, …). Keep **DB out of default** until a dedicated integration target exists.

---

## Coverage by architecture layer (target map)

Use this as a **checklist**; V2 today only fills part of it — mark tests as **implemented** / **partial** / **future** in PRs.

### A. Signal / adapter

- Normalize to canonical inbound shape; **channel + actor ids preserved**; media normalized.
- **Invariant:** adapters do **not** implement brain rules (see guardrails).

### B. Intake package / compiler (GAS `properaBuildIntakePackage_` / `compileTurn_` class)

When ported: language, semantic text, issue/property/unit/schedule hints, location, multi-issue — with **LLM mocked** in default suite; optional live-provider suite non-default.

### C. Router

- Precursors, lane, compliance, staff gate, continuation boundaries.
- **Invariants:** route-once, no conflicting prompts, disabled lanes don’t steal traffic.

### D. Core / draft / ticket (V2 maintenance slice today)

- Draft merge, `recomputeDraftExpected`, finalize decision, ticket/work_item creation path.
- **Invariants:** no finalize without required facts; no duplicate ticket for same idempotency key; weaker text doesn’t silently overwrite stronger committed facts.

### E. Lifecycle / policy

- State transitions, timers, policy keys, verify-resolution, contact windows — **deterministic** once ported.

### F. Outgate

- Canonical intent → template; channel-specific **expression** only; no bypass around outgate for operational messages.

---

## Fixture shape (evolving)

Recommended **one scenario** = **seed** + **turns** + **assertions** per turn.

```json
{
  "id": "issue_only_then_property_menu",
  "description": "Tenant reports issue only; next expected is PROPERTY; reply by menu number.",
  "seed": {
    "properties": [
      { "code": "PENN", "display_name": "The Grand at Penn" }
    ],
    "actor": {
      "channel": "TELEGRAM",
      "actor_key": "TG:999"
    },
    "session": null
  },
  "turns": [
    {
      "body": "my kitchen sink is leaking",
      "assert": {
        "expected": "PROPERTY",
        "draft": { "issue_contains": "leak" },
        "route_once": true
      }
    },
    {
      "body": "1",
      "assert": {
        "expected": "UNIT",
        "draft": { "property_code": "PENN" },
        "route_once": true
      }
    }
  ]
}
```

**Future fields** (when behavior exists):

```json
{
  "schedule_hint": "tomorrow 9-11am",
  "language": "en",
  "media": [],
  "assert_finalize": {
    "should_finalize": true,
    "preferred_window_present": true
  },
  "assert_outbound": {
    "intent_type": "ASK_FOR_MISSING_UNIT"
  }
}
```

`schedule_hint` / `assert_finalize.preferred_window` apply when **schedule parsing + policy** are ported — reserve fields in fixtures without blocking current work.

---

## Suggested fixture families (organize by behavior)

Not all directories need to exist on day one — introduce as suites grow.

| Family | Examples |
|--------|----------|
| **intake/** | Issue only; issue + property; issue + property + unit; one-shot full message; emergency; multi-issue (future); media + text (future) |
| **continuations/** | Reply to PROPERTY / UNIT / SCHEDULE prompt; interruption; expired session (future) |
| **router/** | Short-reply boundaries; compliance; staff gate; precursor ordering |
| **lifecycle/** | Unscheduled ping; verify-resolution; wait-parts (future — needs engine) |
| **staff/** | Done / scheduled / could not access (future — staff brain parity) |
| **outgate/** | Same intent, SMS vs Telegram vs WhatsApp **meaning** preserved (future) |

**Naming:** Prefer `issue_only_then_property_menu` over `mergeDraftCase4`.

---

## Replay / parity (high value for GAS → V2)

Maintain a small library of:

- Normalized **historical** sequences
- **Must never break again** bugs
- Golden **EXPECT_RECOMPUTED** / **TURN_SUMMARY**-class outcomes where applicable

**Assert:** same lane / expected-next / finalize behavior; **one** handling path per inbound key; no stage drift between router and core.

---

## Global invariants (reusable helpers)

These should become shared assertion helpers over time.

**Routing**

- One inbound idempotency key → one primary route decision on the hot path.
- No duplicate outbound “same prompt” from the same turn.

**Draft**

- Required slots actually present before FINALIZE_DRAFT.
- Issue / property / unit merge rules stay consistent with `recomputeDraftExpected`.

**Ticket**

- No duplicate creation for the same operational key.
- Finalize only when draft completeness matches engine rules.

**Lifecycle / policy** (when present)

- Valid transitions only; timers not double-armed without reason.

**Outgate**

- Operational replies go through canonical intent + template path; adapters don’t improvise business copy.

---

## What exists in V2 now (concrete)

- Unit: `recomputeDraftExpected`, `mergeMaintenanceDraft`, `parseMaintenanceDraft`, `ticketDefaults`, router precursors (see `npm test`).
- **Not yet:** scenario runner over shared fixtures, replay library, integration job, outgate golden matrix.

---

## What to prioritize next (short list)

**Immediate**

- Scenario runner + `tests/scenarios/` maintenance intake JSON/JS fixtures.
- Orchestrated test with **stubbed** `finalizeMaintenanceDraft` / `getSupabase` for full `handleInboundCore` paths (optional).
- Golden: **issue only → PROPERTY → UNIT → finalize** (multi-turn) **in memory**.

**Soon**

- Schedule / preferred window (when engine exists).
- Router replay cases (compliance + staff gate).
- Integration: Supabase round-trip for `intake_sessions` + ticket insert.

**Stay manual / non-default**

- Live OpenAI; OCR/media live; ngrok smoke; production webhook.

---

## First milestone (five golden stories — stretch goal)

| # | Story | V2 readiness |
|---|--------|----------------|
| 1 | Issue only → property prompt | In reach with scenario runner |
| 2 | Issue + property → unit prompt | Same |
| 3 | Issue + property + unit in **one** message → ticket created | Fast path exists; assert with stub |
| 4 | Schedule reply on active expectation → stored | **Future** — needs post-finalize schedule + WI |
| 5 | Staff marks done → verify-resolution | **Future** — lifecycle |

Treat (1)–(3) as the **first shield**; (4)–(5) track the real brain port.

---

## Suggested repo layout (gradual)

```
tests/
  unit/              # optional split from flat tests/
  scenarios/         # fixture data + shared loader
  replay/            # parity transcripts (optional)
  integration/       # Supabase — separate runner
  e2e/               # Telegram smoke — rare
```

Use **`node:test`** and **`assert`** today; if you add stubs, use small manual mocks or **dependency injection** — not Vitest-specific APIs unless the project adopts Vitest.

Optional: **`LOG_FIXTURE=1`** in one test to dump `EXPECT_RECOMPUTED`-shaped objects for docs.

---

## Documentation rule

Update **this file** when any of these change materially:

- Canonical **RouterParameter** / inbound signal contract
- Intake package or **compileTurn** contract
- **Stage authority** (who sets `expected`)
- Lifecycle / policy semantics
- Outgate intent / template contract
- Scenario coverage map

Cross-link from **BRAIN_PORT_MAP.md** when milestone coverage shifts.

---

## Guiding rule

The suite is not only for bug prevention. It is how **V2 stays the real Propera brain** — without mini-brain drift, channel hacks, silent regressions, or loss of **single architectural authority** over the next action.
