# Canonical LocationTarget — locked invariants (V2)

These constraints apply to maintenance ticket **creation** via `finalizeMaintenanceDraft` and all lanes that feed it.

1. **Single write authority:** Ticket + work_item rows for maintenance intake are created only through `finalizeMaintenanceDraft` (via `finalizeTicketRowGroups`); no adapter or propera-app Supabase writes for ticket create.
2. **No portal mini-brain:** Portal and other adapters supply structured or natural-language **signals** only; deterministic resolution lives in V2 (`resolveLocationTarget` + core).
3. **No adapter business logic:** Property/location decisions are not implemented in `buildRouterParameterFromPortal` beyond shaping transport; validation and canonical mapping stay in V2.
4. **Resolver before finalize:** Maintenance finalize receives a resolved canonical location target (kind, `location_type`, snapshots, optional catalog IDs) produced by `resolveLocationTarget` where the pipeline supports it.
5. **Lifecycle unchanged:** Post-finalize lifecycle signals (`WI_CREATED_UNSCHEDULED`, etc.) remain driven by existing policy; common-area and empty-tenant rows must remain valid inputs.
6. **Backward-compatible reads:** Legacy columns (`property_code`, `unit_label`, `location_type`) remain populated during migration; new columns are additive.

Review against the workspace plan (`.cursor/plans/canonical_location_target.plan.md`) before changing behavior.
