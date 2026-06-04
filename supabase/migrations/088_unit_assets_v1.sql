-- Unit assets V1 — installed equipment registry per unit (Phase 3 unit lifecycle).
-- Brain: src/dal/unitAssets.js + portal /api/portal/unit-assets*
-- Flag: PROPERA_UNIT_LIFECYCLE_ENABLED=1 (shared with occupancies)

-- ---------------------------------------------------------------------------
-- unit_assets
-- ---------------------------------------------------------------------------
create table if not exists public.unit_assets (
  id uuid primary key default gen_random_uuid(),
  unit_catalog_id uuid not null references public.units (id) on delete cascade,
  property_code text not null references public.properties (code) on delete cascade,
  unit_label_snapshot text not null default '',
  category text not null default 'appliance',
  asset_type text not null default '',
  make text not null default '',
  model text not null default '',
  serial_number text not null default '',
  installed_at date null,
  installed_by text not null default '',
  warranty_start date null,
  warranty_end date null,
  status text not null default 'active',
  replaced_by_id uuid null references public.unit_assets (id) on delete set null,
  nameplate_photo_url text not null default '',
  source_ticket_id text null,
  source_turnover_id uuid null references public.turnovers (id) on delete set null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unit_assets_category_chk check (
    category in ('appliance', 'fixture', 'hvac', 'lock', 'other')
  ),
  constraint unit_assets_status_chk check (
    status in ('active', 'removed', 'replaced')
  ),
  constraint unit_assets_type_nonempty_chk check (length(trim(asset_type)) > 0)
);

comment on table public.unit_assets is
  'Installed equipment / fixtures per unit — survives ticket close; nameplate source of truth';

create index if not exists unit_assets_unit_status_idx
  on public.unit_assets (unit_catalog_id, status);

create index if not exists unit_assets_property_idx
  on public.unit_assets (upper(trim(property_code)));

create unique index if not exists unit_assets_one_active_type_per_unit_uidx
  on public.unit_assets (unit_catalog_id, lower(trim(asset_type)))
  where status = 'active';

alter table public.unit_assets enable row level security;

create or replace function public.unit_assets_normalize_row()
returns trigger
language plpgsql
as $$
begin
  new.property_code := upper(trim(new.property_code));
  new.unit_label_snapshot := trim(new.unit_label_snapshot);
  new.asset_type := trim(new.asset_type);
  new.make := trim(new.make);
  new.model := trim(new.model);
  new.serial_number := trim(new.serial_number);
  new.nameplate_photo_url := trim(new.nameplate_photo_url);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists unit_assets_normalize_biud on public.unit_assets;
create trigger unit_assets_normalize_biud
  before insert or update on public.unit_assets
  for each row
  execute procedure public.unit_assets_normalize_row();

-- ---------------------------------------------------------------------------
-- portal_unit_assets_v1 — read shape for propera-app
-- ---------------------------------------------------------------------------
create or replace view public.portal_unit_assets_v1 as
select
  a.id as asset_id,
  a.unit_catalog_id,
  upper(trim(a.property_code)) as property_code,
  trim(coalesce(p.display_name, p.code)) as property_display_name,
  trim(a.unit_label_snapshot) as unit_label,
  trim(a.category) as category,
  trim(a.asset_type) as asset_type,
  trim(a.make) as make,
  trim(a.model) as model,
  trim(a.serial_number) as serial_number,
  a.installed_at,
  trim(a.installed_by) as installed_by,
  a.warranty_start,
  a.warranty_end,
  trim(a.status) as status,
  a.replaced_by_id,
  trim(a.nameplate_photo_url) as nameplate_photo_url,
  a.source_ticket_id,
  a.source_turnover_id,
  a.metadata_json,
  trim(a.created_by) as created_by,
  a.created_at,
  a.updated_at
from public.unit_assets a
inner join public.properties p
  on upper(trim(p.code)) = upper(trim(a.property_code))
where coalesce(p.active, true) = true
  and upper(trim(p.code)) <> 'GLOBAL';

comment on view public.portal_unit_assets_v1 is
  'Unit assets joined to properties for portal UI';
