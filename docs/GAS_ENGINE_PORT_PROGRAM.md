# GAS engine port program (10 / 12 / 14 / 20)

**Purpose:** Executable phases to move from **partial** → **maintainance-lane semantic parity** for the four engines called out in `PARITY_LEDGER.md` (snapshot table + §§1–6).

**Reality check — do not use old gap lists without re-reading the ledger.** Items like “`parseMaintenanceDraft` STUB”, “`validateSchedPolicy_` NOT STARTED”, “`inferStageDayFromText_` not wired” were **superseded** in-repo by:

- `compileTurn` + `properaBuildIntakePackage` + `parseMaintenanceDraft` async path (`INTAKE_COMPILE_TURN=1`)
- `validateSchedPolicy_` + `applyPreferredWindowByTicketKey` (`src/dal/ticketPreferredWindow.js`)
- `inferStageDayFromText_` in the schedule commit path (`ticketPreferredWindow.js`)

Always treat **`docs/PARITY_LEDGER.md`** as current truth.

---

## What “ported” means here

Not “every GAS line exists in Node.” It means:

- **Same decisions** on the maintenance + staff slice (who acts next, draft slots, finalize, schedule policy, staff WI updates).
- **Explicit, testable seams** (orchestrator table, lifecycle transitions) instead of ad hoc scattered updates.
- **Documented** remaining gaps vs full GAS (other lanes, Alexa, vendor, etc.).

---

## Engine `10_CANONICAL_INTAKE_ENGINE.gs`

### Current V2 anchors
`mergeMaintenanceDraft.js`, `intakeAttachClassify.js`, `canonizeStructuredSignal.js`, `properaBuildIntakePackage.js`, `compileTurn.js`, `parseMaintenanceDraft.js`

### Port program
| Phase | Deliverable | Acceptance |
|-------|-------------|------------|
| **10-A** | Close **canonize** gaps vs GAS `properaCanonizeStructuredSignal_` for maintenance | Golden tests from GAS edge cases; PARITY_LEDGER §1 row updated |
| **10-B** | **Split preview + commit** parity (where GAS has preview memory) | Session fields + merge behavior match documented GAS rules; tests |
| **10-C** | **Media / vision queue** parity with `05_AI_MEDIA_TRANSPORT.gs` (or explicit “V2 queue contract”) | No silent divergence: either port queue semantics or document V2-only contract in ledger |
| **10-D** | **Property grounding** at all resolver callsites (`_variants` / alias behavior) | `lifecycleExtract` + merge paths share one grounding helper; tests |

---

## Engine `12_LIFECYCLE_ENGINE.gs`

### Current V2 anchors
DAL: `ticketPreferredWindow.js`, `workItemSubstate.js`, `conversationCtxSchedule.js`, `finalizeMaintenance.js`; staff: `handleStaffLifecycleCommand.js`

### Port program
| Phase | Deliverable | Acceptance |
|-------|-------------|------------|
| **12-A** | **Lifecycle intent catalog** — named signals (tenant schedule set, staff outcome, staff schedule, suppressions) | Single module lists allowed signals + target rows |
| **12-B** | **Transition table (or state machine)** — Postgres-backed or code table with tests | No handler updates WI/ticket without going through the table |
| **12-C** | **Wire tenant + staff paths** through 12-B | `handleInboundCore` / staff command handlers call lifecycle API, not one-off DAL soup |
| **12-D** | **Event log + dashboard** hooks for transition audit | `event_log` rows prove transitions |

---

## Engine `14_DIRECTORY_SESSION_DAL.gs`

### Current V2 anchors
`resolveActor.js`, `intakeSession.js`, `property_aliases` / `properties`, `ticketDefaults.js` (ids)

### Port program
| Phase | Deliverable | Acceptance |
|-------|-------------|------------|
| **14-A** | **Identity parity matrix** — staff vs tenant vs unknown, documented vs GAS | Doc + tests for `resolveActor` / router precursors |
| **14-B** | **Session overlay fields** needed for canonical intake (attach/split) | `intake_sessions` (or adjunct table) holds what GAS Sessions held for those decisions |
| **14-C** | **Ticket id / thread id** — decide: match GAS numerics or document intentional V2 scheme | PARITY_LEDGER §4 aligned |

---

## Engine `20_CORE_ORCHESTRATOR.gs`

### Current V2 anchors
`runInboundPipeline.js`, `handleInboundCore.js`, `evaluateRouterPrecursor.js`, `decideLane.js`

### Port program
| Phase | Deliverable | Acceptance |
|-------|-------------|------------|
| **20-A** | **Explicit route graph** — `normalized signal → { compliance?, staff?, core lane, suppressed? }` | **`src/inbound/routeInboundDecision.js`** — pure helpers (`buildLaneDecision`, `computeCanEnterCore`, SMS suppress / compliance gates, `resolveDefaultBrain`); `runInboundPipeline.js` delegates to them (no behavior change; tests green). |
| **20-B** | **routeToCoreSafe_-class guards** — document which precursors block core | **`docs/ORCHESTRATOR_ROUTING.md`** — execution order, core blockers, precursor × core table; **`tests/routeInboundDecision.test.js`** exercises gate helpers. |
| **20-C** | **Lane stubs** — vendor/system do not enter maintenance core | **`laneAllowsMaintenanceCore`**, **`buildNonMaintenanceLaneStub`**, event **`LANE_STUB`**; JSON field **`stub`** on pipeline response. |

---

## Recommended order (dependencies)

1. **20-A** — clarifies all other work (where intake vs staff vs compliance runs).
2. **12-B / 12-C** — lifecycle authority before more DAL sprawl.
3. **10-A / 10-D** — canonical intake + property grounding (feeds merge quality).
4. **14-B** — session overlays once 10-B/12 need them.
5. **10-C** — media queue when product requires GAS-class vision semantics.

---

## How to use this doc with Cursor

- One phase per PR (e.g. “20-A explicit route graph only”).
- Update **`PARITY_LEDGER.md`** when a phase completes (status + “what is missing”).
- Add **`// PARITY GAP:`** comments only where behavior is still reduced vs GAS (`PROPERA_GUARDRAILS.md`).

---

## Related

- `PARITY_LEDGER.md` — live parity rows  
- `ORCHESTRATOR_ROUTING.md` — engine **20** inbound order + core guards (shipped)  
- `PORTING_FROM_GAS.md` — porting rules  
- `PROPERA_V2_GAS_EXIT_PLAN.md` — migration phases (product-level)
