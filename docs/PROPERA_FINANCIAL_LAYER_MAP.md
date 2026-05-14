# Propera operational finance — integration map (V1)

**Purpose:** Where ticket costs and ledger data live, how the portal and app reach them, and how this stays behind feature flags.

## Canonical store (Supabase)

| Concept | Table / view | Notes |
|--------|----------------|-------|
| Operational ticket | `public.tickets` | Parent for Phase 1 costs (`ticket_cost_entries.ticket_id` → `tickets.id`). |
| Human ticket id | `tickets.ticket_id` | Portal display id (e.g. `PENN-050826-5683`). |
| Stable row id | `tickets.id` | Exposed as `ticket_row_id` on `portal_tickets_v1` for finance APIs. |
| Location targets | `tickets.unit_catalog_id`, `tickets.location_id`, snapshots | Cost rows mirror **financial** target independently (prefilled from ticket, overridable). |
| Building locations | `public.property_locations` | Non–unit scope (common area, property-wide, floor zone, system). |
| Ticket costs | `public.ticket_cost_entries` | Property-scoped, target-based; see migration `042_operational_finance_v1.sql`. |
| Tenant ledger (opt-in) | `public.tenant_ledger_entries` | Posted from approved ticket charges when `PROPERA_FINANCE_LEDGER_ENABLED=1`. |
| Rollups | `portal_ticket_financial_summary_v1`, `portal_property_maintenance_spend_month_v1` | Read models for badges / property spend. |
| Activity timeline | `public.ticket_timeline_events` | Trigger-owned kinds unchanged; V2 appends `cost_added`, `cost_updated`, `tenant_charge_decision`. |

## Attachments

Receipts reuse the same URL pattern as tickets (`pm-attachments` flow in propera-app: `uploadPmAttachment` + URLs stored on cost row `attachment_urls` jsonb). No separate bucket required for V1.

## V2 HTTP (portal token)

- **Flags (all must be `1` for ticket costs):** `PROPERA_FINANCE_ENABLED=1`, `PROPERA_FINANCE_TICKET_COSTS_ENABLED=1`. Ledger posting additionally requires `PROPERA_FINANCE_LEDGER_ENABLED=1`.
- **Routes:** `GET|POST /api/portal/tickets/:ticketRowId/ticket-cost-entries`, `PATCH /api/portal/ticket-cost-entries/:entryId` (see `registerPortalRoutes.js`).

## propera-app

- **Env:** `NEXT_PUBLIC_PROPERA_FINANCE_ENABLED=1` — hides Costs UI when unset/false.
- **Proxy:** `GET|POST /api/tickets/[ticketRowId]/cost-entries`, `PATCH /api/ticket-cost-entries/[entryId]` → V2 portal (see `src/lib/v2PortalApi.ts`).
- **Reads:** When finance is on and read backend is Supabase, `portal_tickets_v1` includes `ticket_row_id`; ticket list merges `portal_ticket_financial_summary_v1` for badges.

## Guardrails

- Browser never writes finance tables directly; only V2 portal with `X-Propera-Portal-Token`.
- Imported GAS tickets (`is_imported_history`): cost mutations blocked (same rule as PM ticket edits).
