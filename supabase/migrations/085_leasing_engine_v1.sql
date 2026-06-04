-- Leasing Engine V1
-- Part A: extend unit_leases with renewal intent tracking
-- Part B: new leasing_prospects table
-- Feature flags: propera-app NEXT_PUBLIC_PROPERA_LEASING_ENABLED=1
--                propera-v2 PROPERA_LEASING_ENGINE_ENABLED=1

-- ---------------------------------------------------------------------------
-- A) unit_leases — renewal intent
-- ---------------------------------------------------------------------------
alter table public.unit_leases
  add column if not exists renewal_status text not null default 'pending'
    constraint unit_leases_renewal_status_chk
      check (renewal_status in ('pending', 'renewing', 'vacating')),
  add column if not exists renewal_notes text not null default '';

comment on column public.unit_leases.renewal_status is
  'Expiry intent for current lease: pending=unknown, renewing=tenant staying, vacating=unit will be available.';
comment on column public.unit_leases.renewal_notes is
  'Staff notes on renewal / move-out notice.';

create index if not exists unit_leases_renewal_status_idx
  on public.unit_leases (renewal_status);

-- ---------------------------------------------------------------------------
-- B) leasing_prospects
-- ---------------------------------------------------------------------------
create table if not exists public.leasing_prospects (
  id                    uuid primary key default gen_random_uuid(),
  org_id                text references public.organizations (id) on delete set null,
  property_code         text not null references public.properties (code) on delete restrict,
  unit_catalog_id       uuid references public.units (id) on delete set null,

  name                  text not null default '',
  phone                 text not null default '',
  email                 text not null default '',

  desired_bedrooms      integer,
  desired_bathrooms     integer,
  budget_min_cents      bigint,
  budget_max_cents      bigint,
  target_move_in        date,

  status                text not null default 'new'
    constraint leasing_prospects_status_chk
      check (status in ('new', 'toured', 'applied', 'approved', 'signed', 'lost')),

  source                text not null default '',

  notes                 text not null default '',
  created_by            text not null default '',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint leasing_prospects_budget_order
    check (budget_min_cents is null or budget_max_cents is null or budget_max_cents >= budget_min_cents),
  constraint leasing_prospects_budget_nonneg_min
    check (budget_min_cents is null or budget_min_cents >= 0),
  constraint leasing_prospects_budget_nonneg_max
    check (budget_max_cents is null or budget_max_cents >= 0)
);

comment on table public.leasing_prospects is
  'Leasing pipeline: prospects interested in renting a unit. '
  'Linked to a specific unit when one is identified. Status tracks the prospect journey.';

create index if not exists leasing_prospects_org_idx
  on public.leasing_prospects (org_id);

create index if not exists leasing_prospects_property_idx
  on public.leasing_prospects (upper(trim(property_code)));

create index if not exists leasing_prospects_unit_idx
  on public.leasing_prospects (unit_catalog_id)
  where unit_catalog_id is not null;

create index if not exists leasing_prospects_status_idx
  on public.leasing_prospects (status);

create index if not exists leasing_prospects_target_move_in_idx
  on public.leasing_prospects (target_move_in)
  where target_move_in is not null;

create or replace function public.leasing_prospects_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists leasing_prospects_touch_biud on public.leasing_prospects;
create trigger leasing_prospects_touch_biud
  before insert or update on public.leasing_prospects
  for each row
  execute procedure public.leasing_prospects_touch_updated_at();
