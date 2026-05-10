-- Canonical building locations (common areas, etc.) — ticket targets + Building Structure UI source.

create table if not exists public.property_locations (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references public.properties (code) on delete cascade,
  kind text not null default 'common_area',
  label text not null default '',
  aliases jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  sort_order integer not null default 0,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint property_locations_kind_chk check (
    kind in ('common_area', 'property', 'floor_zone', 'system')
  ),
  constraint property_locations_label_nonempty_chk check (length(trim(label)) > 0)
);

comment on table public.property_locations is 'Per-property canonical locations (common areas, property-wide, etc.); tickets.location_id may reference rows here';

create index if not exists property_locations_prop_kind_active_idx
  on public.property_locations (property_code, kind, active, sort_order);

-- One active row per property + kind + normalized label (case-insensitive)
create unique index if not exists property_locations_active_label_uidx
  on public.property_locations (property_code, kind, lower(trim(label)))
  where active = true;

create or replace function public.property_locations_normalize_row()
returns trigger
language plpgsql
as $$
begin
  new.property_code := upper(trim(new.property_code));
  new.label := trim(new.label);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists property_locations_normalize_biud on public.property_locations;
create trigger property_locations_normalize_biud
  before insert or update on public.property_locations
  for each row
  execute procedure public.property_locations_normalize_row();

alter table public.property_locations enable row level security;

-- Seed from existing preventive building structure (common_paint_scopes); idempotent.
insert into public.property_locations (property_code, kind, label, active, sort_order)
select
  src.pc,
  'common_area',
  src.lb,
  true,
  src.ord_n
from (
  select
    upper(trim(p.code)) as pc,
    trim(t.elem::text) as lb,
    min(t.ord::integer) as ord_n
  from public.properties p
  cross join lateral jsonb_array_elements_text(
    coalesce(p.program_expansion_profile->'common_paint_scopes', '[]'::jsonb)
  ) with ordinality as t(elem, ord)
  where length(trim(t.elem::text)) > 0
    and upper(trim(p.code)) <> 'GLOBAL'
  group by upper(trim(p.code)), trim(t.elem::text)
) src
where not exists (
  select 1
  from public.property_locations pl
  where pl.property_code = src.pc
    and pl.kind = 'common_area'
    and lower(trim(pl.label)) = lower(trim(src.lb))
    and pl.active = true
);
