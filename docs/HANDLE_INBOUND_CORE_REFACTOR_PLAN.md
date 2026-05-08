# `handleInboundCore` refactor plan (living doc)

This document **reflects the consensus from the recovery-branch / refactor thread** (early 2026), **merged with the safer ordering** (cross-cutting gates before policy splits). It is the **stabilization** track for maintenance brain code—not a blocker for GAS cutover, portal, or other product work.

---

## Ground truth (repo snapshot)

| Item | Value |
|------|--------|
| File | `src/brain/core/handleInboundCore.js` |
| Total lines | **1,477** |
| `async function handleInboundCore` | starts **~line 217**; body is **~1,260 lines** in one function |
| `return {` (rough) | **~36** exit shapes in this file |
| `await` (rough) | **~71** |
| `appendEventLog` / `emitTimed` (rough) | **~38** combined |

Older thread estimates (e.g. 48 `if/else if` branches, 31 returns, 49 awaits) were from a **point-in-time audit**; re-count after edits. The **qualitative** point stands: **one function encodes many policies** with **high cyclomatic complexity** and **I/O interleaved with control flow**.

---

## What went wrong (why it grew)

- **Not “bad code” in the sense of useless code** — it accumulated **real GAS parity**: tenant intake, staff `#` capture, portal structured create, attach clarify, common area, emergency, schedule wait, verification, lifecycle hooks, logging.
- **Local additions felt small** (`if (isStaffCapture) { … }` per feature); **the aggregate** became hard to reason about and risky to change.
- **Root issue:** **policy identity is implicit.** The code repeatedly asks `isStaffCapture`, `isPortalCreateTicketRouter(p)`, `commonAreaFast`, `pendingTicketRow`, artifact/expected stage, etc., instead of a single **named mode** (“this turn is staff capture”, “this is portal create”, …).

That conflicts with **Propera Compass**: deterministic core, readable “who owns the next action.”

---

## What is already good (do not undo)

These are **intentional extractions** and **test seams**—keep them and build on them.

| Asset | Location / notes |
|--------|------------------|
| Draft helpers (pure) | `handleInboundCoreDraftHelpers.js` — `draftFlagsFromSlots`, `computePendingExpiresAtIso`, `issueTextForFinalize` |
| Schedule hints (pure) | `handleInboundCoreScheduleHints.js` — portal create detection + `Preferred:` / JSON schedule extraction |
| Unit tests for helpers | `tests/handleInboundCoreDraftHelpers.test.js`, `tests/handleInboundCoreScheduleHints.test.js` |
| In-memory scenario | `tests/scenarios/tenantMaintenanceInMemory.test.js` (multi-turn tenant maintenance) |
| In-memory Supabase seam | `setSupabaseClientForTests` in `src/db/supabase.js` — requires `PROPERA_TEST_INJECT_SB=1` |
| Other tests using seam | e.g. `staffCaptureImageSignal.test.js`, `finalizeCommonArea.test.js`, `tests/integration/staffCaptureCrossChannel.test.js`, `lifecycleWiCreatedUnscheduled.test.js` |
| Pipeline contract | Inbound: adapters → lane → compliance → … → **`handleInboundCore`** → outgate (see `README.md` / `runInboundPipeline.js`) |

**Hardest infra (test without real DB) is already in place.** Next work is **characterization coverage + disciplined extraction**, not reinventing the harness.

---

## What not to do

- **No big-bang rewrite** of the whole function.
- **No policy file split** until **more scenarios** lock behavior.
- **Do not** assume an earlier branch’s line counts are still exact—re-verify after churn.

---

## Phased plan (shippable increments)

### Phase 1 — Expand the safety net (highest priority)

**Goal:** Before structural changes, **pin external behavior** (brain, reply, key DB side effects).

**Add scenario files under `tests/scenarios/`** (names are targets; adjust to match repo conventions):

- `tenantFastPath.test.js` — single-message complete
- `tenantAttachClarify.test.js` — photo / attach clarify paths
- `tenantCommonArea.test.js` — lobby / laundry / hallway
- `tenantEmergency.test.js` — emergency / skip-schedule behavior
- `tenantScheduleReplyAfterReceipt.test.js` — post-finalize `SCHEDULE` expected
- `staffCaptureFastPath.test.js` — e.g. `#…` + issue + unit in few turns
- `staffCaptureMultiTurn.test.js` — property reply then unit reply
- `staffCaptureNoSchedulePrompt.test.js` — staff must not get tenant schedule ask
- `portalCreateTicketStructured.test.js` — manager structured `create_ticket`
- `startNewMidDraft.test.js` — attach_clarify `start_new` (or equivalent)
- `multiIssueSplit.test.js` — multiple issues in one message, if applicable

Each scenario should assert **at least:** `brain`, `replyText` / template / outgate hints where stable, and **critical writes** (ticket/work_item rows, schedule wait flags, draft seq when relevant).

**Exit criterion:** “We changed `handleInboundCore` and CI told us before merge” — not production surprise.

**Status (2026-05):** Scenario files listed above are implemented under `tests/scenarios/` (names aligned with this section); `npm test` includes them. Staff/portal seeds live in `tests/helpers/memorySupabaseScenario.js`.

---

### Phase 2 — Low-risk mechanical extractions (~200 lines out, behavior unchanged)

Do in **small commits**, each green on Phase 1 + existing tests.

1. **`coreResult(ctx, { ok, brain, replyText, templateKey, extraOutgate, extra })`**  
   Centralize `{ ok, brain, replyText, …staffMeta(), …outgateMeta() }` duplication.

2. **`enterScheduleWait(ctx, fin, path)`** (or equivalent)  
   Deduplicate the repeated “set schedule wait + pending expected + work item substate” block wherever it appears **identically**.

3. **`runFinalizeGroups(ctx, groups)`** (name TBD)  
   Wrap the loop over `reconcileFinalizeTicketRows` → `finalizeMaintenanceDraft` + failure handling.

4. **`loadCoreContext(o)`** (async)  
   First chunk of the function: trace, mode, routerParameter, canonical keys, body/media, `sb`, property lists, session, staff draft resolution, `staffMeta`, shared validation early returns → **`ctx`** with `{ ok, result? }` or always-ok `ctx` + small gates.

**Exit criterion:** `handleInboundCore` is shorter; **zero** intentional behavior change.

**Status (2026-05):** Items **1–3** implemented in `handleInboundCoreMechanics.js` (`coreInboundResult`, `finalizeTicketRowGroups`, `appendCoreFinalizedFlightRecorder`, `enterScheduleWaitAndLogTicketCreatedAskSchedule`, shared `outgateMeta`). **`loadCoreContext`** deferred: staff draft resolution + `staffMeta` / `clearIntakeLike` closures make a clean early-load extraction better paired with Phase 3 dispatcher prep.

---

### Phase 3 — Cross-cutting gates **before** policy dispatch (safer than splitting four files immediately)

Extract **interrupt handlers** that are not “tenant fast” vs “staff” vs “portal”:

- Tenant verification reply if pending  
- Attach clarify resolution if pending  
- Schedule reply if `pending_expected` / artifact says `SCHEDULE` (exact conditions stay 1:1 with today’s code)

Target shape (conceptual):

```text
ctx = await loadCoreContext(o)
if (!ctx.ok) return ctx.result

verify = await resolveTenantVerificationIfPending(ctx)
if (verify.handled) return verify.result

attach = await resolveAttachClarifyIfPending(ctx)
if (attach.handled) return attach.result

schedule = await handleScheduleReplyIfExpected(ctx)
if (schedule.handled) return schedule.result

return dispatchMaintenanceTurn(ctx)
```

**Exit criterion:** Main file reads as **setup → gates → dispatch**; tests still green.

**Status (2026-05):** Implemented in `handleInboundCoreGates.js` — `resolveTenantVerificationIfPending`, `resolveAttachClarifyIfPending`, `handleScheduleReplyIfExpected` — wired from `handleInboundCore.js` immediately after `staffMeta` / `clearIntakeLike` / `saveIntakeLike` / `setScheduleWaitLike` setup. **`loadCoreContext`** still not a single function; **`dispatchMaintenanceTurn`** remains inline (Phase 4). Staff `start_new` after attach clarify returns **`staffDraftSeq`** from the newly allocated draft (same as post-assignment `staffMeta()` in the old inline code).

---

### Phase 4 — Dispatch by policy (the real win)

Only after Phases 1–3:

- `handleStaffCapture(ctx)` → e.g. `coreStaffCapture.js`
- `handlePortalCreate(ctx)` → e.g. `corePortalCreate.js`
- `handleTenantFastPath(ctx)` → e.g. `coreTenantFastPath.js`
- `handleTenantMultiTurn(ctx)` → e.g. `coreTenantMultiTurn.js`

**Recommended split order** (highest Propera-specific risk first):

1. **Staff capture** (canonical actor, draft seq, OCR/media, **no tenant schedule prompt**)  
2. **Portal create**  
3. **Tenant fast path**  
4. **Tenant multi-turn** (largest, leave last)

`handleInboundCore.js` becomes a **thin dispatcher** (~80–120 lines) + re-exports if needed.

---

### Phase 5 — Logging at the boundary (optional cleanup)

- Wrapper e.g. `withCoreLogging(inner)` for **CORE_ENTER / CORE_EXIT / CORE_ERROR** (duration + `brain`).
- Inner code keeps **domain-specific** logs only.
- Removes a chunk of repetitive `appendEventLog` / `emitTimed` noise.

---

## Time rough order of magnitude

| Phase | Effort (rough) |
|-------|------------------|
| 1 Scenarios | 1–2 focused days (most writing) |
| 2 Mechanical | ~1 day |
| 3 Gates | 1–2 days |
| 4 Policy split | 3–4 days |
| 5 Logging wrapper | ~0.5 day |

**Total:** on the order of **~2 weeks focused**, not calendar-blocked on other tracks.

---

## Relation to other work

- **GAS cutover / portal / Supabase reads** can continue in parallel.
- **Rule:** Before adding another **large** feature **inside** `handleInboundCore`, **prefer** landing Phase 1 (or Phase 1 + 2) so the next change has a net.

---

## Verdict (plain English)

The function is **overloaded but not junk**: it is the **working engine**. Treat the refactor as a **transmission rebuild**: **characterization tests first**, then **extract helpers → gates → policies**, not a replacement engine overnight.

---

*Last updated: aligns thread proposal + repo snapshot; update line counts/metrics when `handleInboundCore.js` changes materially.*

**See also:** [TESTING_STRATEGY.md](./TESTING_STRATEGY.md) — overall test layers, in-memory seams, and milestone table.
