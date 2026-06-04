-- Sync V3: ticket episode stamp (occupancy at create time).
-- Shown in unit History only — not exposed on ticket detail panel.
-- Requires unit lifecycle flag + stamp at finalizeMaintenance.

alter table public.tickets
  add column if not exists unit_occupancy_id uuid
    references public.unit_occupancies (id) on delete set null,
  add column if not exists tenant_roster_id_at_open uuid
    references public.tenant_roster (id) on delete set null;

comment on column public.tickets.unit_occupancy_id is
  'Occupancy episode active when ticket was opened (unit lifecycle Sync V3).';
comment on column public.tickets.tenant_roster_id_at_open is
  'Tenant on that episode at open — denormalized for history queries.';

create index if not exists tickets_unit_occupancy_id_idx
  on public.tickets (unit_occupancy_id)
  where unit_occupancy_id is not null;

create index if not exists tickets_tenant_roster_at_open_idx
  on public.tickets (tenant_roster_id_at_open)
  where tenant_roster_id_at_open is not null;
