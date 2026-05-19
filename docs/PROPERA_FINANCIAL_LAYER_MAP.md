# Propera operational finance — integration map (V1)

**Purpose:** Where ticket costs and ledger data live, how the portal and app reach them, and how this stays behind feature flags.

**Broader V2 + app positioning and finance-depth roadmap (Layers 0–5):** [PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md](./PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md).  
**Phased finance build plan (Phase 1 → 6):** [PROPERA_FINANCE_ROADMAP.md](./PROPERA_FINANCE_ROADMAP.md).

## Canonical store (Supabase)

| Concept | Table / view | Notes |
|--------|----------------|-------|
| Operational ticket | `public.tickets` | Parent for ticket-scoped costs (`ticket_cost_entries.ticket_id` → `tickets.id`). |
| Program run (preventive) | `public.program_runs` | Optional parent for preventive costs (`ticket_cost_entries.program_run_id`); see migration `047_program_run_cost_entries.sql`. |
| Human ticket id | `tickets.ticket_id` | Portal display id (e.g. `PENN-050826-5683`). |
| Stable row id | `tickets.id` | Exposed as `ticket_row_id` on `portal_tickets_v1` for finance APIs. |
| Location targets | `tickets.unit_catalog_id`, `tickets.location_id`, snapshots | Cost rows mirror **financial** target independently (prefilled from ticket, overridable). |
| Building locations | `public.property_locations` | Non–unit scope (common area, property-wide, floor zone, system). |
| Ticket costs | `public.ticket_cost_entries` | Property-scoped, target-based; parent is **either** a ticket **or** a program run (`042` + `047`). |
| Tenant ledger (opt-in) | `public.tenant_ledger_entries` | Posted from approved ticket charges when `PROPERA_FINANCE_LEDGER_ENABLED=1`. |
| Rollups | `portal_ticket_financial_summary_v1`, `portal_property_maintenance_spend_month_v1`, **`portal_properties_v1`** (current UTC month + **YTD** maintenance columns after **048**) | Read models for badges / property spend. |
| Activity timeline | `public.ticket_timeline_events` | Trigger-owned kinds unchanged; V2 appends `cost_added`, `cost_updated`, `tenant_charge_decision`. |

## Attachments

Receipts reuse the same URL pattern as tickets (`pm-attachments` flow in propera-app: `uploadPmAttachment` + URLs stored on cost row `attachment_urls` jsonb). No separate bucket required for V1.

## V2 HTTP (portal token)

- **Flags (all must be `1` for ticket costs):** `PROPERA_FINANCE_ENABLED=1`, `PROPERA_FINANCE_TICKET_COSTS_ENABLED=1`. Ledger posting additionally requires `PROPERA_FINANCE_LEDGER_ENABLED=1`.
- **Routes:** `GET|POST /api/portal/tickets/:ticketRowId/ticket-cost-entries`, `GET|POST /api/portal/program-runs/:programRunId/ticket-cost-entries`, `PATCH /api/portal/ticket-cost-entries/:entryId` (see `registerPortalRoutes.js`).

## propera-app

- **Env:** `NEXT_PUBLIC_PROPERA_FINANCE_ENABLED=1` — hides ticket + preventive cost UIs when unset/false.
- **Proxy:** `GET|POST /api/tickets/[ticketRowId]/cost-entries`, `GET|POST /api/program-runs/[id]/cost-entries`, `PATCH /api/ticket-cost-entries/[entryId]` → V2 portal (see `src/lib/v2PortalApi.ts`). (`[id]` matches the existing program-run detail route segment name.)
- **Reads:** When finance is on and read backend is Supabase, `portal_tickets_v1` includes `ticket_row_id`; ticket list merges `portal_ticket_financial_summary_v1` for badges. Preventive `/preventive` run detail uses program-run cost proxy when finance is on.

## Guardrails

- Browser never writes finance tables directly; only V2 portal with `X-Propera-Portal-Token`.
- Imported GAS tickets (`is_imported_history`): cost mutations blocked (same rule as PM ticket edits).
