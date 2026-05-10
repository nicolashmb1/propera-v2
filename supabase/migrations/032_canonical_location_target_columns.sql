-- Canonical location target fields (IDs + snapshots). Legacy unit_label / location_type retained.

alter table public.tickets
  add column if not exists location_id uuid null,
  add column if not exists location_label_snapshot text not null default '',
  add column if not exists unit_catalog_id uuid null references public.units (id) on delete set null;

comment on column public.tickets.location_id is 'Optional stable target id (e.g. future common-area row); nullable during transition';
comment on column public.tickets.location_label_snapshot is 'Human-readable location label at create time';
comment on column public.tickets.unit_catalog_id is 'FK to public.units when unit resolved from catalog';

create index if not exists tickets_unit_catalog_id_idx
  on public.tickets (unit_catalog_id)
  where unit_catalog_id is not null;

alter table public.work_items
  add column if not exists location_id uuid null,
  add column if not exists location_label_snapshot text not null default '',
  add column if not exists unit_catalog_id uuid null references public.units (id) on delete set null;

comment on column public.work_items.location_id is 'Mirrors ticket canonical location id for WI-level queries';
comment on column public.work_items.location_label_snapshot is 'Human-readable location label at create time';
comment on column public.work_items.unit_catalog_id is 'FK to public.units when unit resolved from catalog';

create index if not exists work_items_unit_catalog_id_idx
  on public.work_items (unit_catalog_id)
  where unit_catalog_id is not null;
