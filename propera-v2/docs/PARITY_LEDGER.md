# Parity ledger — GAS ↔ V2 (single source of truth)

**Purpose:** Track **flow parity** vs **semantic parity** for every brain-relevant behavior.  
**Rule:** GAS is the **source implementation** for core intake logic until explicitly superseded.

| Term | Meaning |
|------|---------|
| **Flow parity** | The conversation/engine **steps** exist (e.g. schedule prompt after ticket). |
| **Semantic parity** | **Same decisions and structured outputs** as GAS (parsed windows, policy, sheet-shaped fields). |

**Do not** treat flow parity as full product parity. If this row says `STUB` or `PARTIAL`, semantics differ from production GAS.

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
| Property hint from body (single-turn parse) | `detectPropertyFromBody_` and related — `PROPERA_MAIN_BACKUP.gs` / canonical intake | `extractPropertyHintFromBody` — `src/brain/staff/lifecycleExtract.js` | **PARTIAL** | Not a full port of `detectPropertyFromBody_`; heuristic regex over known codes | **High** | V2 menu + regex ≠ full GAS property detection. |
| Single-message draft parse | `compileTurn_` / intake package — `08_INTAKE_RUNTIME.gs` | `parseMaintenanceDraft` — `src/brain/core/parseMaintenanceDraft.js` | **STUB** | No `compileTurn_`, no `properaBuildIntakePackage_`, no LLM package merge | **High** | **Flow-only** slice for maintenance fast path; strips hints from issue text locally. |

---

## 2. Stage / expected / merge (maintenance lane)

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| Pre-ticket slot order (issue → property → unit → finalize) | `recomputeDraftExpected_` — `11_TICKET_FINALIZE_ENGINE.gs` (~147–171) | `recomputeDraftExpected` — `src/brain/core/recomputeDraftExpected.js` | **PARTIAL** | GAS has more branches (e.g. `SCHEDULE_PRETICKET`, opener); V2 is a **slice** | **Medium** | Comment in V2 file marks pre-ticket slice. |
| Merge one turn into draft | `draftUpsertFromTurn_` class / canonical merge — GAS intake | `mergeMaintenanceDraftTurn` — `src/brain/core/mergeMaintenanceDraft.js` | **PARTIAL** | Menu index + property resolution; not full GAS merge / compile | **Medium** | `resolvePropertyFromReply` is V2 helper, not full `detectPropertyFromBody_`. |
| Tenant prompts | Outgate / templates — GAS | `buildMaintenancePrompt` — `src/brain/core/buildMaintenancePrompt.js` | **PARTIAL** | Simplified copy; not full template map | **Low** | UX copy may differ from SMS templates. |
| Intake session persistence | GAS `Sessions` sheet | `intake_sessions` — `src/dal/intakeSession.js` | **PARTIAL** | Column subset; `issue_buf_json` unused | **Low** | Postgres shape, not Sheets. |

---

## 3. Schedule (post-finalize)

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| Post-create “ask schedule” flow | Lifecycle / finalize + `TICKET_CREATED_ASK_SCHEDULE` — `11_TICKET_FINALIZE_ENGINE.gs` / orchestrator | `handleInboundCore` + `setScheduleWaitAfterFinalize` — `src/brain/core/handleInboundCore.js`, `src/dal/intakeSession.js` | **PARTIAL** | **Flow:** yes. **Semantics:** not full GAS lifecycle engine (`routeToCoreSafe_` graph) | **Medium** | |
| Parse natural language window (“tomorrow morning”) | `parsePreferredWindowShared_` — `08_INTAKE_RUNTIME.gs` (~1859+) | `parsePreferredWindowShared` — `src/brain/gas/parsePreferredWindowShared.js` | **PORTED** | `stageDay` often `null` in V2 (GAS sometimes passes `inferStageDayFromText_`); set **`TZ` / `PROPERA_TZ`** to match GAS script TZ for local `Date` parity | **Medium** | Tests: `tests/parsePreferredWindowShared.test.js` (`TZ=UTC`). |
| Wrapper `parsePreferredWindow_` in schedule engine | `parsePreferredWindow_` — `17_PROPERTY_SCHEDULE_ENGINE.gs` (delegates to shared) | Same shared module (not a separate file) | **PORTED** | — | **Low** | One implementation. |
| Policy validation of window | `validateSchedPolicy_` — `17_PROPERTY_SCHEDULE_ENGINE.gs` | *None* | **NOT STARTED** | Must run **after** parse for prod parity | **High** | |
| Canonical `preferred_window` + parse fallback | Sheet `PREF_WINDOW` / sync — GAS may keep raw; V2 stores **label** when parse succeeds | `applyPreferredWindowByTicketKey` — `src/dal/ticketPreferredWindow.js` | **PARTIAL** | Unparseable text → **raw** stored; no policy recheck | **Medium** | GAS `syncScheduledEndAtFromRawWindow_` aligns end from raw — V2 aligns label + end in one step. |
| `scheduled_end_at` on ticket | GAS COL; `syncScheduledEndAtFromRawWindow_` | `applyPreferredWindowByTicketKey` sets `scheduled_end_at` when `parsed.end` is a finite `Date`; `finalizeMaintenanceDraft` still inserts `null` | **PARTIAL** | **Create** path leaves null until tenant sends schedule; **no** re-sync from sheet-only edits | **Medium** | Matches “end from parse” behavior. |
| `inferStageDayFromText_` for `stageDay` | `17_PROPERTY_SCHEDULE_ENGINE.gs` | *Not wired* — parser called with `stageDay: null` | **NOT STARTED** | Pass inferred stage day when GAS would | **Medium** | |

---

## 4. Ticket defaults & classification

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| Category label | `localCategoryFromText_` — `18_MESSAGING_ENGINE.gs` | `localCategoryFromText` — `src/dal/ticketDefaults.js` | **PARTIAL** | V2 defaults to `"General"` when GAS returns `""` (see comment in file) | **Low–Medium** | Documented deviation. |
| Emergency flag | GAS `inferEmergency` / sheet columns | `inferEmergency` — `src/dal/ticketDefaults.js` | **PARTIAL** | Short regex list; may not match full GAS keyword set | **Medium** | Affects `skipScheduling` in core. |
| Human ticket id shape | GAS / Sheet conventions | `formatHumanTicketId` — `src/dal/ticketDefaults.js` | **PARTIAL** | V2 format may differ from GAS `formatHumanTicketId_` if GAS uses different rules | **Low** | Verify against GAS if mismatches reported. |
| Thread id | GAS thread builders | `buildThreadIdV2` — `src/dal/ticketDefaults.js` | **PARTIAL** | V2-specific prefix scheme | **Low** | Intentional shell difference. |

---

## 5. Router / precursors / lane (non-intake-complete)

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| Normalize body | `normMsg_` — `15_GATEWAY_WEBHOOK.gs` | `normMsg` — `src/brain/router/normMsg.js` | **PORTED** | — | **Low** | Covered by tests. |
| Compliance (STOP/HELP/START) | `complianceIntent_` | `complianceIntent.js` | **PORTED** | — | **Low** | |
| Tenant commands | `detectTenantCommand_` | `detectTenantCommand.js` | **PORTED** | — | **Low** | |
| Precursor ordering | `handleInboundRouter_` chain | `evaluateRouterPrecursor.js` | **PARTIAL** | Explicitly does not invoke full router / core / Sheets | **Medium** | By design in V2 slice. |
| Lane classification | `classifyLane_` / `decideLane_` — `15_GATEWAY_WEBHOOK.gs` | `decideLane` — `src/brain/router/decideLane.js` | **PARTIAL** | Simplified policy hooks (`lanePolicy.js`) | **Medium** | |
| Full router | `handleInboundRouter_` — `16_ROUTER_ENGINE.gs` | *Partial* — `src/index.js` wiring | **NOT STARTED** | Opt-out, SMS storage, full route graph | **High** | |

---

## 6. Staff / lifecycle

| Behavior | GAS source | V2 implementation | Status | What is missing | Risk | Notes |
|----------|------------|-------------------|--------|-----------------|------|-------|
| WI hint / resolution | `25_STAFF_RESOLVER.gs` | `resolveTargetWorkItemForStaff.js`, `normalizeStaffOutcome.js`, `handleStaffLifecycleCommand.js` | **PARTIAL** | Full `staffHandleLifecycleCommand_` parity ongoing | **Medium** | See staff tests. |
| Staff extraction helpers | GAS resolver | `lifecycleExtract.js` (property hint **not** full GAS) | **PARTIAL** | Same as property row above | **Medium** | |

---

## 7. Highest-risk semantic gaps to port next (recommended order)

1. **`validateSchedPolicy_`** — run after `parsePreferredWindowShared` (property hours, blackouts).  
2. **`inferStageDayFromText_`** — feed `stageDay` into parser where GAS does.  
3. **`detectPropertyFromBody_`** (or canonical intake property resolution) — replace heuristic `extractPropertyHintFromBody` for tenant maintenance.  
4. **`compileTurn_` + `properaBuildIntakePackage_`** — replace `parseMaintenanceDraft` as the authoritative merge.  
5. **Full `recomputeDraftExpected_`** — align `SCHEDULE_PRETICKET` / opener branches with GAS.

---

## 8. Pointer comment template (required for STUB / PARTIAL brain code)

```text
// PARITY GAP: <one line what is reduced> — see docs/PARITY_LEDGER.md §<section or behavior name>
```

---

## 9. Related docs

- [PORTING_FROM_GAS.md](./PORTING_FROM_GAS.md) — porting rules + table (keep in sync with this ledger).  
- [BRAIN_PORT_MAP.md](./BRAIN_PORT_MAP.md) — handoff and file map.  
- [PROPERA_V2_GAS_EXIT_PLAN.md](./PROPERA_V2_GAS_EXIT_PLAN.md) — migration phases.
