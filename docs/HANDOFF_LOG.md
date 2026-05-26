# Handoff log — propera-v2

**Purpose:** Short, dated notes so the **next agent** knows what landed recently and where to continue.  
**Not** a substitute for **[PARITY_LEDGER.md](./PARITY_LEDGER.md)** (GAS ↔ V2 truth) or **[AGENTS.md](../AGENTS.md)** (rules).

**How to use:** Read the **latest dated section** first, then **`PARITY_LEDGER.md`**, **`BRAIN_PORT_MAP.md`**, and **`AGENTS.md`** as usual.

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
