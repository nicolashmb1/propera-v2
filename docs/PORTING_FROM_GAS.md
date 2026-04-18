# Porting from GAS (non-negotiable rule)

**Authoritative status by behavior (ported vs stub vs partial):** **[PARITY_LEDGER.md](./PARITY_LEDGER.md)** — single source of truth for **flow parity** vs **semantic parity**, retroactive gaps, and risk. Update it when you land or stub behavior.

**Propera V2 must not reinvent operational behavior.** Functions that encode **stage rules**, **parsing**, **property/unit/schedule** disambiguation, or **policy** must be **ported** from the existing Google Apps Script codebase — same control flow, same edge cases — with only **thin shell** differences (HTTP, Supabase, env).

You are **not** being too strict — you are preventing the migration from drifting into a **different product**. The “unit t” class of bugs is exactly what happens when Node invents a parallel rule instead of porting GAS.

### Instruction for agents / Cursor (copy as needed)

- Do **not** invent new brain logic in V2 when equivalent GAS logic already exists.
- **Port** the real GAS functions and rules first; only add **thin** adaptation where Node / Postgres / the HTTP shell requires it.
- If behavior exists in GAS and was battle-tested, **GAS is the source implementation** — not a suggestion.
- No ad-hoc rewrites for unit parsing, property resolution, stage logic, schedule parsing, address guards, or similar core intake behavior unless explicitly approved as a **post-parity** change.
- **Parity first. Improvement second.**

## What “shell only” means (allowed to be new)

- Express routes, middleware, trace ids  
- Supabase reads/writes (replacing Sheet/DAL calls)  
- Loading config from env / JSON that mirrors GAS globals (`PROPERTY_ADDRESSES`, etc.)  
- Adapters that normalize transport → `RouterParameter` / `InboundSignal`

## What must be ported (not reimagined)

| Area | GAS source (authoritative) | V2 location (today) |
|------|----------------------------|---------------------|
| Unit extraction | `extractUnit_` — `17_PROPERTY_SCHEDULE_ENGINE.gs` ~2260 | `src/brain/shared/extractUnitGas.js` |
| Street vs unit (block unit when number is an address) | `isAddressInContext_` — `14_DIRECTORY_SESSION_DAL.gs` ~2211; `isBlockedAsAddress_` — `16_ROUTER_ENGINE.gs` ~2449 | `src/brain/gas/addressContext.js` |
| Address list global | `PROPERTY_ADDRESSES` (GAS global) | `PROPERTY_ADDRESSES_JSON` env → `src/config/propertyAddresses.js` |
| Draft stage order pre-ticket | `recomputeDraftExpected_` — `11_TICKET_FINALIZE_ENGINE.gs` ~147–171; expiry ~173–176 | `src/brain/core/recomputeDraftExpected.js` — exports **`expiryMinutesForExpectedStage`** (shared with **`handleInboundCore`** session expiry) |
| Merge + attach classify (pre-canonical merge) | `properaIntakeAttachClassify_` — `10_CANONICAL_INTAKE_ENGINE.gs` | **Partial:** `src/brain/core/intakeAttachClassify.js` + `mergeMaintenanceDraft.js` (deterministic slice; no AI path) |
| Category label (deterministic) | `localCategoryFromText_` — `18_MESSAGING_ENGINE.gs` | `src/dal/ticketDefaults.js` |
| **Schedule / preferred window** | `parsePreferredWindowShared_` — `08_INTAKE_RUNTIME.gs`; `inferStageDayFromText_` + `validateSchedPolicy_` — `17_PROPERTY_SCHEDULE_ENGINE.gs` | **Parse:** `src/brain/gas/parsePreferredWindowShared.js`. **Stage day:** `src/brain/gas/inferStageDayFromText.js`. **Policy:** `src/brain/gas/validateSchedPolicy.js` + `src/dal/propertyPolicy.js` (`property_policy`); commit path `src/dal/ticketPreferredWindow.js` — [PARITY_LEDGER.md](./PARITY_LEDGER.md) §3 |
| **Property from body / menu** | `detectPropertyFromBody_` — `PROPERA_MAIN_BACKUP.gs` / MAIN ~13348+ | *Partial — `detectPropertyFromBody` in `lifecycleExtract.js`; DB-config aliases via `property_aliases` + `listPropertiesForMenu`; full parity pending GAS variant/ticketPrefix semantics* |
| **compileTurn / intake package** | `compileTurn_`, `properaBuildIntakePackage_` — `08_INTAKE_RUNTIME.gs` + `07_PROPERA_INTAKE_PACKAGE.gs` | **Partial:** `src/brain/intake/compileTurn.js`, `properaBuildIntakePackage.js`, `openaiStructuredSignal.js` — enable **`INTAKE_COMPILE_TURN=1`**; optional LLM: **`OPENAI_API_KEY`** + **`INTAKE_LLM_ENABLED=1`** — [PARITY_LEDGER.md](./PARITY_LEDGER.md) §1–2 |
| **Deterministic issue parse (clauses / title / category)** | `issueParseDeterministic_` / `parseIssueDeterministic_` — `09_ISSUE_CLASSIFICATION_ENGINE.gs`; helpers `looksActionableIssue_`, `isScheduleWindowLike_`, etc. — `14_DIRECTORY_SESSION_DAL.gs`, `16_ROUTER_ENGINE.gs` | **PORTED:** `src/brain/gas/issueParseDeterministic.js` — wired into deterministic branch of `properaBuildIntakePackage.js` (GAS `properaFallbackStructuredSignalFromDeterministicParse_` behavior) |
| **ATTACH_CLARIFY resolution** | `handleInboundRouter_` latch — `16_ROUTER_ENGINE.gs` ~460–552 | **Partial:** `parseAttachClarifyReply.js` + `handleInboundCore.js` + `conversation_ctx` clear; full GAS re-route / globals / fast-path guards not ported |
| **Orchestrator / route-to-core guards** | `handleInboundRouter_` / `routeToCoreSafe_` ordering — `16_ROUTER_ENGINE.gs`, `20_CORE_ORCHESTRATOR.gs` | **Partial:** `src/inbound/runInboundPipeline.js` + **`src/inbound/routeInboundDecision.js`** — lane, SMS compliance, core entry, vendor/system **lane stubs**; documented in **[ORCHESTRATOR_ROUTING.md](./ORCHESTRATOR_ROUTING.md)** |
| **Outbound / Outgate** | `19_OUTGATE.gs` templates | **Partial:** `src/outgate/` — `OutboundIntent` + `MessageSpec` (compliance) + `renderOutboundIntent` + **`dispatchOutbound`** (only transport sends); maintenance copy still mostly `buildMaintenancePrompt` / `handleInboundCore` — see **PARITY_LEDGER** |

When you add behavior, **find the GAS function first**, add a row to this table, then implement.

## Config: `PROPERTY_ADDRESSES_JSON`

Same idea as GAS `PROPERTY_ADDRESSES`: an array of `{ "num": "618", "hints": ["westfield"], "suffixes": ["ave", "st"] }` so **618** in “618 Westfield Ave” is **not** treated as a unit. Set in `.env` as a **single-line JSON string** (or use a secrets manager in prod).

Example (illustrative):

```json
[{"num":"618","hints":["westfield"],"suffixes":["ave"]},{"num":"702","hints":["pennsylvania"],"suffixes":["ave"]}]
```

## Documentation

Update **[PARITY_LEDGER.md](./PARITY_LEDGER.md)** for every behavior change (status, gaps, risk).  
Update this file when a new **ported** module lands. Cross-link from **BRAIN_PORT_MAP.md**.

**Non-port work** (dashboard, env plumbing, flight-recorder-only): does not change GAS parity — log in **[HANDOFF_LOG.md](./HANDOFF_LOG.md)** (dated) and **[PARITY_LEDGER.md](./PARITY_LEDGER.md)** §10 if it affects observability.
