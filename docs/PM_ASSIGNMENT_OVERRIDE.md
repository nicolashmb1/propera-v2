# PM Assignment Override — Phase Roadmap

**Feature:** Property manager (PM) can explicitly reassign any V2 ticket to any active staff member
from the `propera-app` cockpit. The assignment is tagged `PM_OVERRIDE` so the automated resolver
never silently overwrites it.

**North Compass alignment:** V2 (the brain) is the only writer. The app cockpit is a signal sender.
No direct Supabase writes from `propera-app`. All writes pass through V2 portal routes, which
validate, audit, and persist deterministically.

---

## Phase status

| Phase | Title | Status |
|-------|-------|--------|
| 1 | Database + V2 DAL foundation | ✅ Complete |
| 2 | Portal routes + app cockpit UI | ✅ Complete |
| 3 | Policy / automation respect for PM_OVERRIDE | ✅ Complete (see Phase 3 section) |
| 4 | Assignment history in Activity tab | ⬜ Not started |
| 5 | Vendor / team / PM targets beyond staff | ⬜ Not started |

---

## Phase 1 — Database + V2 DAL foundation ✅

**Goal:** Store assignment provenance on every ticket and expose a deterministic write path.

### Deliverables

| Item | Location | Notes |
|------|----------|-------|
| Migration 043 | `supabase/migrations/043_ticket_assignment_responsibility_v1.sql` | Adds `assignment_source`, `assignment_note`, `assignment_updated_at`, `assignment_updated_by` to `tickets`; backfills `POLICY` on existing assigned rows; creates `portal_tickets_v1` view (all assignment cols + `ticket_row_id` + `timeline_json`). |
| `applyPortalTicketAssignment` | `src/dal/portalTicketAssignment.js` | Deterministic write: validates staff, stamps `PM_OVERRIDE` source, updates `tickets` + syncs `work_items.owner_id` via `updateWorkItemsByTicketKey`, appends `PORTAL_PM_TICKET_ASSIGNMENT` event log. |
| `listStaffAssignableToProperty` | `src/dal/portalTicketAssignment.js` | Returns all `active = true` staff org-wide (no `staff_assignments` row required). |
| `assertStaffAssignable` | `src/dal/portalTicketAssignment.js` | Validates staff exists and is active. |
| `finalizeMaintenance` | `src/dal/finalizeMaintenance.js` | **INSERT-only** for new tickets — always seeds policy assignment from `ASSIGN_DEFAULT_OWNER`. No update path today; PM_OVERRIDE applies only after the row exists (PM portal or future writers). |

### Acceptance criteria met
- [x] PM assignment writes `assignment_source = 'PM_OVERRIDE'` on the ticket row
- [x] Every change is logged in `event_log` with actor, staff id, ticket key, trace id
- [x] `work_items.owner_id` is kept in sync
- [x] Policy automation does not overwrite ticket assignment columns while `assignment_source = PM_OVERRIDE` (see Phase 3 — `ticketAssignmentGuard` + call sites)

---

## Phase 2 — Portal routes + app cockpit UI ✅

**Goal:** Expose the DAL over authenticated REST; render a clean assignment block in the PM cockpit.

### Deliverables

| Item | Location | Notes |
|------|----------|-------|
| V2 route — write | `src/portal/registerPortalRoutes.js` `POST /api/portal/tickets/:ticketId/assignment` | Portal-token gated. Accepts UUID or human ticket id as path segment; falls back to `ticket_key` lookup. |
| V2 route — staff list | `src/portal/registerPortalRoutes.js` `GET /api/portal/properties/:code/staff-for-assignment` | Returns org-wide active staff. Property code kept in URL for compatibility; query is now global. |
| Next.js proxy — write | `propera-app/src/app/api/pm/ticket-assignment/route.ts` | Forwards to V2. Resolves path segment: UUID → human id → `ticketKey` fallback. UUID regex accepts any standard UUID (any version/variant). |
| Next.js proxy — staff | `propera-app/src/app/api/pm/property-staff/route.ts` | Forwards to V2 staff list. |
| App types + maps | `propera-app/src/lib/types.ts`, `mapRemoteTicket.ts`, `portalSupabaseRead.ts` | `PortalStaffOption`, `PmTicketAssignmentPayload`; `ticketRowId`, `ticketKey`, `assignedStaffId`, `assignmentNote`, `assignmentSourceLabel` mapped from `portal_tickets_v1`. |
| `api.ts` helpers | `propera-app/src/lib/api.ts` | `fetchPmStaffForPropertyAssignment`, `postPmTicketAssignment`. |
| `TicketDetailPanel` | `propera-app/src/components/TicketDetailPanel.tsx` | Compact assignment block: "Assigned to · Name" + pencil edit icon. Click → modal with reassign select (current assignee excluded), reason textarea (optional), dark Save + Cancel. Resets on open. |
| CSS | `propera-app/src/components/AppLayout.tsx` | `.assign-display-row`, `.assign-edit-btn`, `.assign-modal-*`, `.assignment-save-btn`, `.assignment-reassign-note`. |

### Acceptance criteria met
- [x] PM can open the modal, pick a new staff member, optionally add a reason, and save
- [x] Current assignee is excluded from the dropdown
- [x] Reason text appears as a hint below the assignee name (only when set)
- [x] All other staff metadata (source, timestamps, updated-by) hidden from panel; stored in DB only
- [x] Modal closes on success; ticket list refreshes
- [x] Errors surface inside the modal
- [x] All active staff appear (not filtered by `staff_assignments` rows)

---

## Phase 3 — Policy / automation respects PM_OVERRIDE ✅

**Goal:** Any V2 code path that builds a `tickets.update()` patch must not overwrite policy-owned
assignment columns when `assignment_source = PM_OVERRIDE`. Status, schedule, turnover links,
and other non-assignment fields continue to update normally.

### Central module

| Item | File | Notes |
|------|------|--------|
| `mergeTicketUpdateRespectingPmOverride` | `src/dal/ticketAssignmentGuard.js` | Strips `assign_to`, `assigned_*`, `assignment_*` keys from a patch when the existing row has `PM_OVERRIDE`. **Not** used by `applyPortalTicketAssignment` (that route is the authoritative PM writer). |

### Call sites (all `tickets.update` paths audited)

| Item | File | Status |
|------|------|--------|
| Portal PM ticket mutation + soft delete | `src/dal/portalTicketMutations.js` | ✅ Merged patch before update; fetch includes `assignment_source`. Logs `PORTAL_PM_TICKET_MUTATION_ASSIGNMENT_STRIPPED` if a future parser ever injects assignment keys under PM lock. |
| Lifecycle schedule → ticket Scheduled | `src/brain/lifecycle/executeLifecycleDecision.js` (`APPLY_SCHEDULE_SET`) | ✅ Fetch `assignment_source` by `ticket_key`, merge before update. |
| Tenant schedule applied | `src/brain/lifecycle/afterTenantScheduleApplied.js` | ✅ Same pattern. |
| WI done → ticket Completed | `src/dal/ticketLifecycleSync.js` | ✅ Same pattern. |
| Turnover link / post-create turnover columns | `src/dal/turnovers.js` | ✅ Same pattern. |
| `finalizeMaintenanceDraft` | `src/dal/finalizeMaintenance.js` | N/A — INSERT only; cannot hit PM_OVERRIDE on same operation. |
| `handleStaffLifecycleCommand` | `src/brain/core/handleStaffLifecycleCommand.js` | N/A today — no `tickets` assignment writes (only schedule path reads ticket). |
| Lifecycle cron / `lifecycleTimers.js` | `src/dal/lifecycleTimers.js` | N/A — no `tickets` row assignment updates. |
| `ticketPreferredWindow.js` | `src/dal/ticketPreferredWindow.js` | N/A — updates `preferred_window` / `scheduled_end_at` only. |

### Product policy — staff vs PM lock

- **Today:** No staff SMS/Telegram path updates `tickets.assigned_*`. `work_items.owner_id` is only set at WI create (`finalizeMaintenanceDraft`) and on PM portal assign (`applyPortalTicketAssignment` → `updateWorkItemsByTicketKey`).
- **Future:** If staff commands gain ticket reassignment, they must either (a) **reject** with a clear reply when `assignment_source = PM_OVERRIDE`, or (b) **explicitly** replace override with `STAFF_REASSIGN` and a new assignee — never silent policy merge.

### Acceptance criteria
- [x] Shared guard module + unit tests (`tests/ticketAssignmentGuard.test.js`)
- [x] Every audited `tickets.update` path uses `mergeTicketUpdateRespectingPmOverride` or is documented N/A
- [x] `PARITY GAP` pointer on guard module for future `work_items.owner_id` policy writers

---

## Phase 4 — Assignment history in Activity tab ⬜

**Goal:** PM reassignments appear in the ticket's Activity timeline so the full ownership chain
is visible without leaving the cockpit.

### Deliverables needed

| Item | File | Notes |
|------|------|-------|
| `ticket_timeline_events` row on PM assign | `src/dal/portalTicketAssignment.js` `applyPortalTicketAssignment` | Append kind `assigned`, actor = PM label, detail = new staff name, `occurred_at = now()`. |
| Timeline kind registration | `supabase/migrations/` (or existing `034`–`037` kind list) | Ensure `assigned` kind is registered and has a color in `portal_tickets_v1` timeline CASE. |
| App timeline mapping | `propera-app/src/lib/timelineMapping.ts` | Verify `assigned` kind renders correctly (color, label). |
| "Unassigned" event | Same | If PM clears assignment, log `unassigned` kind or `assigned` with detail "Unassigned". |

### Acceptance criteria (not yet met)
- [ ] Every PM reassign (including clearing) produces a `ticket_timeline_events` row
- [ ] Activity tab shows "Assigned to Geff · by Nick · 5 min ago" style entry
- [ ] Duplicate-event guard respected (see `TICKET_TIMELINE.md` duplicate rule)

---

## Phase 5 — Vendor / team / PM targets beyond staff ⬜

**Goal:** The PM can assign a ticket to a vendor, a team, or another PM — not only to a
`staff` table row.

### Deliverables needed

| Item | Notes |
|------|-------|
| `assigned_type` expansion | Currently only `STAFF` and empty. Needs `VENDOR`, `TEAM`, `PM`. |
| Vendor/team lookup endpoint | New V2 route or extend staff-for-assignment to return typed options. |
| App dropdown grouping | Reassign modal groups options: Staff · Vendors · Teams. |
| `assertStaffAssignable` → `assertAssignableTarget` | Validate by type; vendor rows live in a different table. |
| `work_items` sync for non-staff targets | `updateWorkItemsByTicketKey` currently writes `owner_id` (staff UUID). Non-staff targets need a different field or a nullable owner with a vendor/team reference. |

### Acceptance criteria (not yet met)
- [ ] PM can assign a ticket to a vendor from the cockpit
- [ ] `assigned_type` correctly reflects the target type
- [ ] Activity tab shows the vendor/team name

---

## Key files (all phases)

| Layer | File |
|-------|------|
| Migration | `propera-v2/supabase/migrations/043_ticket_assignment_responsibility_v1.sql` |
| V2 DAL — PM write | `propera-v2/src/dal/portalTicketAssignment.js` |
| V2 DAL — PM lock (Phase 3) | `propera-v2/src/dal/ticketAssignmentGuard.js` |
| V2 DAL — guarded updates | `propera-v2/src/dal/portalTicketMutations.js`, `ticketLifecycleSync.js`, `turnovers.js` |
| V2 lifecycle — guarded updates | `propera-v2/src/brain/lifecycle/executeLifecycleDecision.js`, `afterTenantScheduleApplied.js` |
| V2 ticket create (policy seed, INSERT-only) | `propera-v2/src/dal/finalizeMaintenance.js` |
| V2 routes | `propera-v2/src/portal/registerPortalRoutes.js` |
| Tests (Phase 3) | `propera-v2/tests/ticketAssignmentGuard.test.js` |
| App proxy — write | `propera-app/src/app/api/pm/ticket-assignment/route.ts` |
| App proxy — staff | `propera-app/src/app/api/pm/property-staff/route.ts` |
| App types | `propera-app/src/lib/types.ts` |
| App maps | `propera-app/src/lib/mapRemoteTicket.ts` |
| App API helpers | `propera-app/src/lib/api.ts` |
| App panel | `propera-app/src/components/TicketDetailPanel.tsx` |
| App styles | `propera-app/src/components/AppLayout.tsx` |
| Timeline contract | `propera-v2/docs/TICKET_TIMELINE.md` |

---

## Related docs

- `docs/PARITY_LEDGER.md` §11 — status table (summary)
- `docs/HANDOFF_LOG.md` 2026-05-14 — session details
- `docs/TICKET_TIMELINE.md` — Activity tab contract (Phase 4)
- `PROPERA_NORTH_COMPASS.md` — architecture doctrine (V2 as authoritative brain)
