-- Canonical units catalog (replaces GAS Units sheet). Portal views + property rollups.

-- ---------------------------------------------------------------------------
-- units — per-property inventory + vacancy (status is authoritative vs roster)
-- ---------------------------------------------------------------------------
create table if not exists public.units (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references public.properties (code) on delete cascade,
  unit_label text not null,
  floor text not null default '',
  bedrooms text not null default '',
  bathrooms text not null default '',
  status text not null default 'Vacant',
  notes text not null default '',
  legacy_gas_unit_id text,
  unit_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint units_unit_label_nonempty_chk check (length(trim(unit_label)) > 0),
  constraint units_status_nonempty_chk check (length(trim(status)) > 0)
);

comment on table public.units is 'Property unit inventory; status drives occupied/vacant counts for portal';

create unique index if not exists units_legacy_gas_unit_id_uidx
  on public.units (legacy_gas_unit_id)
  where legacy_gas_unit_id is not null and trim(legacy_gas_unit_id) <> '';

create unique index if not exists units_unit_key_uidx
  on public.units (unit_key)
  where unit_key is not null and trim(unit_key) <> '';

create unique index if not exists units_property_unit_uidx
  on public.units (property_code, unit_label);

create index if not exists units_property_code_idx on public.units (property_code);

-- Normalize property_code (uppercase) and trim labels before insert/update.
create or replace function public.units_normalize_row()
returns trigger
language plpgsql
as $$
begin
  new.property_code := upper(trim(new.property_code));
  new.unit_label := trim(new.unit_label);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists units_normalize_biud on public.units;
create trigger units_normalize_biud
  before insert or update on public.units
  for each row
  execute procedure public.units_normalize_row();

alter table public.units enable row level security;

-- ---------------------------------------------------------------------------
-- Tickets: filter by property + unit for unit hub history
-- ---------------------------------------------------------------------------
create index if not exists tickets_property_unit_ci_idx
  on public.tickets (
    upper(trim(coalesce(property_code, ''))),
    upper(trim(coalesce(unit_label, '')))
  );

-- ---------------------------------------------------------------------------
-- portal_properties_v1 — real unit / occupied counts from units table
-- ---------------------------------------------------------------------------
create or replace view public.portal_properties_v1 as
select
  trim(p.code) as property_code,
  trim(coalesce(p.display_name, p.code)) as name,
  trim(coalesce(p.short_name, '')) as short_name,
  trim(coalesce(p.ticket_prefix, '')) as ticket_prefix,
  coalesce(r.open_count, 0)::integer as open,
  coalesce(r.urgent_count, 0)::integer as urgent,
  coalesce(uc.unit_count, 0)::integer as units,
  coalesce(uc.occupied_count, 0)::integer as occupied,
  '—'::text as avg_resolution,
  '—'::text as last_activity,
  trim(coalesce(p.address, '')) as address,
  p.program_expansion_profile
from public.properties p
left join public.portal_property_rollups_v1 r
  on upper(trim(r.property_code)) = upper(trim(p.code))
left join lateral (
  select
    count(*)::integer as unit_count,
    count(*) filter (
      where lower(trim(u.status)) = 'occupied'
    )::integer as occupied_count
  from public.units u
  where upper(trim(u.property_code)) = upper(trim(p.code))
) uc on true
where coalesce(p.active, true) = true
  and upper(trim(p.code)) <> 'GLOBAL';

comment on view public.portal_properties_v1 is 'Active properties with ticket KPIs + units catalog counts';

-- ---------------------------------------------------------------------------
-- portal_units_v1 — list/detail rows for propera-app (service role)
-- ---------------------------------------------------------------------------
create or replace view public.portal_units_v1 as
select
  u.id as unit_id,
  trim(u.property_code) as property_code,
  trim(coalesce(p.display_name, p.code)) as property_display_name,
  trim(u.unit_label) as unit_label,
  trim(coalesce(u.floor, '')) as floor,
  trim(coalesce(u.bedrooms, '')) as bedrooms,
  trim(coalesce(u.bathrooms, '')) as bathrooms,
  trim(u.status) as status,
  trim(coalesce(u.notes, '')) as notes,
  trim(coalesce(u.legacy_gas_unit_id, '')) as legacy_gas_unit_id,
  trim(coalesce(u.unit_key, '')) as unit_key,
  u.created_at,
  u.updated_at
from public.units u
inner join public.properties p
  on upper(trim(p.code)) = upper(trim(u.property_code))
where coalesce(p.active, true) = true
  and upper(trim(p.code)) <> 'GLOBAL';

comment on view public.portal_units_v1 is 'Units joined to active properties for portal UI';
