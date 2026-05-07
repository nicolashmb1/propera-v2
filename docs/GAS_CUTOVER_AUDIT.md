# Propera App — GAS touchpoints audit (cutover)

Inventory of `propera-app` GAS usage for Phase 1 cutover. **Reads** → Supabase views (`PROPERA_READ_BACKEND=supabase`). **Mutations** → V2 only; GAS fallback removed post-cutover except explicit unsupported/disabled routes.

## Reads (remove GAS when `supabase`)

| Route / caller | Mechanism | Cutover |
|----------------|-----------|---------|
| `src/app/api/tickets/route.ts` | `fetchMergedTicketsWithDiagnostics` / GAS GET `path=tickets` | Supabase `portal_tickets_v1` |
| `src/app/api/properties/route.ts` | GAS `path=properties` + V2 merge | Supabase `portal_properties_v1` |
| `src/app/api/dashboard/route.ts` | `fetchMergedTicketsAndPropertiesForPortal` | Supabase tickets + properties views |
| `src/app/api/analytics/route.ts` | same merge | Supabase aggregates / ticket list |
| `src/app/api/tenants/route.ts` | `fetchGasTenants` when no V2 URL | V2 tenants only (no GAS) when remote |

## Writes / PM (V2-only after cutover)

| Route | Today | Target |
|-------|-------|--------|
| `pm/create-ticket` | V2 default; optional GAS | V2 only |
| `pm/update-ticket` | V2 if `v2:` id else GAS | V2; block imported history |
| `pm/complete-ticket` | same | same |
| `pm/delete-ticket` | same | same |
| `pm/add-attachment` | same | same |
| `pm/upload-attachment` | GAS only | explicit `501` / doc until V2 storage |
| `pm/create-property` | GAS only | explicit `501` / doc until V2 admin |

## Shared

| File | Role |
|------|------|
| `src/lib/pmGasForward.ts` | Legacy POST to GAS — delete when unused |
| `src/lib/mergePortalTickets.ts` | GAS+V2 merge — keep for `PROPERA_READ_BACKEND=gas-merge` rollback |
| `src/lib/tenantMutationGuard.ts` | GAS `path=me` — evaluate separately |

## V2 (brain)

| Area | Notes |
|------|-------|
| `public.tickets` | Unified store; `is_imported_history` for GAS imports |
| `portalTicketMutations.js` | Must reject mutations on imported rows (trigger also guards) |
| `finalizeMaintenance.js` | Sets `is_imported_history = false` on create |
