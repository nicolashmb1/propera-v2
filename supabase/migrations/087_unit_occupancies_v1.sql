-- Unit occupancies V1 — time-bounded residency episodes per unit (Phase 1 unit lifecycle).
-- Brain: src/dal/unitOccupancies.js + portal /api/portal/occupancies*
-- Flag: PROPERA_UNIT_LIFECYCLE_ENABLED=1

-- ---------------------------------------------------------------------------
-- unit_occupancies
-- ---------------------------------------------------------------------------
create table if not exists public.unit_occupancies (
  id uuid primary key default gen_random_uuid(),
  unit_catalog_id uuid not null references public.units (id) on delete cascade,
  property_code text not null references public.properties (code) on delete cascade,
  tenant_roster_id uuid null references public.tenant_roster (id) on delete set null,
  unit_label_snapshot text not null default '',
  resident_name_snapshot text not null default '',
  started_at timestamptz not null default now(),
  ended_at timestamptz null,
  status text not null default 'current',
  lease_snapshot_json jsonb not null default '{}'::jsonb,
  move_out_turnover_id uuid null references public.turnovers (id) on delete set null,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unit_occupancies_status_chk check (
    status in ('current', 'past', 'pending')
  ),
  constraint unit_occupancies_time_order_chk check (
    ended_at is null or ended_at >= started_at
  ),
  constraint unit_occupancies_current_requires_open_end check (
    status <> 'current' or ended_at is null
  ),
  constraint unit_occupancies_past_requires_end check (
    status <> 'past' or ended_at is not null
  )
);

comment on table public.unit_occupancies is
  'Unit residency episodes — who lived here from move-in to move-out; lease terms snapshot at open';

comment on column public.unit_occupancies.lease_snapshot_json is
  'Copy of unit_leases terms at occupancy open (rent, deposit, dates, charge_lines)';

comment on column public.unit_occupancies.move_out_turnover_id is
  'Optional turnover started after this occupancy closed';

create unique index if not exists unit_occupancies_one_current_per_unit_uidx
  on public.unit_occupancies (unit_catalog_id)
  where status = 'current';

create index if not exists unit_occupancies_unit_started_idx
  on public.unit_occupancies (unit_catalog_id, started_at desc);

create index if not exists unit_occupancies_property_started_idx
  on public.unit_occupancies (upper(trim(property_code)), started_at desc);

create index if not exists unit_occupancies_tenant_idx
  on public.unit_occupancies (tenant_roster_id)
  where tenant_roster_id is not null;

alter table public.unit_occupancies enable row level security;

create or replace function public.unit_occupancies_normalize_row()
returns trigger
language plpgsql
as $$
begin
  new.property_code := upper(trim(new.property_code));
  new.unit_label_snapshot := trim(new.unit_label_snapshot);
  new.resident_name_snapshot := trim(new.resident_name_snapshot);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists unit_occupancies_normalize_biud on public.unit_occupancies;
create trigger unit_occupancies_normalize_biud
  before insert or update on public.unit_occupancies
  for each row
  execute procedure public.unit_occupancies_normalize_row();

-- ---------------------------------------------------------------------------
-- portal_unit_occupancies_v1 — read shape for propera-app (service role)
-- ---------------------------------------------------------------------------
create or replace view public.portal_unit_occupancies_v1 as
select
  o.id as occupancy_id,
  o.unit_catalog_id,
  upper(trim(o.property_code)) as property_code,
  trim(coalesce(p.display_name, p.code)) as property_display_name,
  trim(o.unit_label_snapshot) as unit_label,
  o.tenant_roster_id,
  trim(o.resident_name_snapshot) as resident_name,
  trim(o.status) as status,
  o.started_at,
  o.ended_at,
  o.lease_snapshot_json,
  o.move_out_turnover_id,
  trim(o.created_by) as created_by,
  o.created_at,
  o.updated_at
from public.unit_occupancies o
inner join public.properties p
  on upper(trim(p.code)) = upper(trim(o.property_code))
where coalesce(p.active, true) = true
  and upper(trim(p.code)) <> 'GLOBAL';

comment on view public.portal_unit_occupancies_v1 is
  'Unit occupancies joined to properties for portal UI / history tab';

-- ---------------------------------------------------------------------------
-- Backfill: one current occupancy per unit with an active roster row (best-effort)
-- ---------------------------------------------------------------------------
insert into public.unit_occupancies (
  unit_catalog_id,
  property_code,
  tenant_roster_id,
  unit_label_snapshot,
  resident_name_snapshot,
  started_at,
  status,
  lease_snapshot_json,
  created_by
)
select
  u.id,
  upper(trim(u.property_code)),
  tr.id,
  trim(u.unit_label),
  trim(coalesce(tr.resident_name, '')),
  coalesce(
    (ul.lease_start::timestamptz at time zone 'UTC'),
    coalesce(tr.updated_at, now())
  ),
  'current',
  coalesce(
    jsonb_strip_nulls(
      jsonb_build_object(
        'rent_cents', ul.rent_cents,
        'security_deposit_cents', ul.security_deposit_cents,
        'lease_start', ul.lease_start,
        'lease_end', ul.lease_end,
        'charge_lines', ul.charge_lines,
        'notes', ul.notes
      )
    ),
    '{}'::jsonb
  ),
  'migration_087_backfill'
from public.units u
inner join lateral (
  select tr.*
  from public.tenant_roster tr
  where upper(trim(tr.property_code)) = upper(trim(u.property_code))
    and trim(tr.unit_label) = trim(u.unit_label)
    and tr.active = true
  order by tr.updated_at desc nulls last
  limit 1
) tr on true
left join public.unit_leases ul on ul.unit_catalog_id = u.id
where not exists (
  select 1
  from public.unit_occupancies o
  where o.unit_catalog_id = u.id
    and o.status = 'current'
);
