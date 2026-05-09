# `handleInboundCore` refactor plan (living doc)

This document **reflects the consensus from the recovery-branch / refactor thread** (early 2026), **merged with the safer ordering** (cross-cutting gates before policy splits). It described the **stabilization** track for maintenance brain code.

**Track status (2026-05-09):** Phases **1–5** described below are **implemented** in-repo (scenario net + extractions + gates + policy modules + load context + boundary logs). Treat this file as **historical / rationale**; current layout lives under `src/brain/core/` (see **Ground truth**).

---

## Ground truth (repo snapshot)

| Item | Value (2026-05-09) |
|------|--------|
| Entry | `src/brain/core/handleInboundCore.js` — **~107 lines** (`try`/`catch`, dispatch only) |
| Load + gates + draft | `src/brain/core/coreMaintenanceLoadContext.js` — **`buildMaintenanceCoreDispatchContext`** (~349 lines) |
| Fast / multi policy | `coreMaintenanceFastPath.js`, `coreMaintenanceMultiTurn.js` |
| Portal / staff session / shared / finalize receipt | `coreMaintenancePortalDraft.js`, `coreMaintenanceStaffCapture.js`, `coreMaintenanceShared.js`, `coreMaintenanceStaffFinalizeReceipt.js` |
| Mechanics / gates | `handleInboundCoreMechanics.js`, `handleInboundCoreGates.js` |
| Boundary logs | `coreMaintenanceBoundaryLog.js` — **`CORE_EXIT`**, **`CORE_ERROR`** (after **`CORE_ENTER`** in load context) |
| Baseline (pre-track) | Monolith **~1,477** lines — see Phase 1–4 narrative below |

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

**Status (2026-05):** Items **1–3** implemented in `handleInboundCoreMechanics.js` (`coreInboundResult`, `finalizeTicketRowGroups`, `appendCoreFinalizedFlightRecorder`, `enterScheduleWaitAndLogTicketCreatedAskSchedule`, shared `outgateMeta`).

**Status (2026-05-09, complete):** Item **4** — **`buildMaintenanceCoreDispatchContext`** in **`coreMaintenanceLoadContext.js`** (async load through gates + `fastDraft`; closures **`clearIntakeLike` / `saveIntakeLike` / `setScheduleWaitLike`** + mutable **`draftSeqActive`** preserved).

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

**Status (2026-05):** Implemented in `handleInboundCoreGates.js` — `resolveTenantVerificationIfPending`, `resolveAttachClarifyIfPending`, `handleScheduleReplyIfExpected` — invoked from **`buildMaintenanceCoreDispatchContext`** after intake helpers exist. Staff `start_new` after attach clarify returns **`staffDraftSeq`** from the newly allocated draft (unchanged).

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

**Status (2026-05-09):** First **safe slice** landed without changing behavior: after Phase 3 gates + `fastDraft` build, **`runCoreMaintenanceFastPath`** lives in **`coreMaintenanceFastPath.js`** (single-turn complete / `path: "fast"`) and **`runCoreMaintenanceMultiTurn`** in **`coreMaintenanceMultiTurn.js`** (`path: "multi_turn"` + pending prompts). Shared **`resolveManagerTenantIfNeeded`**, property load, and staff media clarify helpers → **`coreMaintenanceShared.js`**.

**Status (2026-05-09, second slice):** **`coreMaintenanceStaffCapture.js`** — **`resolveStaffCaptureBodyAndSession`** (canonical invariant + `STAFF_CAPTURE_CANONICAL_*` logs + draft turn resolve vs **`getIntakeSession`**). **`coreMaintenancePortalDraft.js`** — **`buildFastDraftForMaintenanceCore`** (portal structured **`create_ticket`** validation failure logging + **`buildStructuredPortalCreateDraft`**, else **`parseMaintenanceDraftAsync`**). **`handleInboundCore.js`** wires these before clarify-media tweak and fast vs multi dispatch.

**Status (2026-05-09, third slice):** **`coreMaintenanceStaffFinalizeReceipt.js`** — **`finalizeReceiptStaffCaptureScheduleBranch`** (shared **`STAFF_CAPTURE_INLINE_SCHEDULE`** / **`STAFF_CAPTURE_NO_SCHEDULE_PROMPT`** + receipt shapes). **`coreMaintenanceFastPath`** / **`coreMaintenanceMultiTurn`** call it with path-specific `staffSchedHint` / `draft` payloads.

**Completion:** Thin **`handleInboundCore`** delegates load → fast vs multi; original four **named policy files** from the sketch map to **staff session**, **portal draft**, **fast path**, **multi-turn** modules above (staff finalize receipt shared).

---

### Phase 5 — Logging at the boundary

- **`CORE_ENTER`** remains in **`buildMaintenanceCoreDispatchContext`** (same payload as before).
- **`emitMaintenanceCoreExit`** / **`emitMaintenanceCoreError`** in **`coreMaintenanceBoundaryLog.js`** — **`CORE_EXIT`** fires for every return **after** **`CORE_ENTER`** (early gate returns + successful dispatch); **`CORE_ERROR`** on thrown errors before rethrow.
- Domain-specific logs stay in policy modules (`CORE_FAST_PATH_COMPLETE`, `EXPECT_RECOMPUTED`, etc.).

**Status (2026-05-09):** Implemented and **`npm test`** green.

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

The function was **overloaded but not junk**: it was the **working engine**. The stabilization track delivered **characterization tests**, **mechanical helpers**, **gates**, **policy modules**, **explicit load context**, and **boundary exit/error logs** without changing intake semantics (locked by CI). Further splits are **optional polish**, not required for this plan.

---

*Last updated: 2026-05-09 — plan phases 1–5 marked complete; metrics reflect modular layout.*

**See also:** [TESTING_STRATEGY.md](./TESTING_STRATEGY.md) — overall test layers, in-memory seams, and milestone table.
