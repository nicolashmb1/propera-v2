-- Phase 1.5 — incumbent accounting read-only snapshots (Leasehold adapter → normalized facts).
-- Finance roadmap §1.5; sequence 058 is already access_engine (058_access_property_location_link).

create table if not exists public.tenant_account_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  unit_catalog_id     uuid not null references public.units (id) on delete cascade,
  property_code       text not null references public.properties (code) on delete restrict,
  source_system       text not null,
  synced_at           timestamptz not null,
  rent_cents          bigint,
  balance_cents       bigint,
  balance_status      text not null default 'unknown',
  lease_start         date,
  lease_end           date,
  last_payment_at     date,
  last_payment_cents  bigint,
  tenant_name_display text not null default '',
  payload_json        jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint tenant_account_snapshots_balance_status_chk
    check (balance_status in ('paid_up', 'delinquent', 'unknown')),
  constraint tenant_account_snapshots_rent_nonneg
    check (rent_cents is null or rent_cents >= 0),
  constraint tenant_account_snapshots_balance_any
    check (balance_cents is null or balance_cents >= -99999999999),
  constraint tenant_account_snapshots_last_payment_nonneg
    check (last_payment_cents is null or last_payment_cents >= 0)
);

comment on table public.tenant_account_snapshots is
  'Read-only incumbent accounting truth per unit (Leasehold, QuickBooks, …). '
  'Written only by source adapters via propera-app import API — never mutates public.units.';

create unique index if not exists tenant_account_snapshots_unit_source_uidx
  on public.tenant_account_snapshots (unit_catalog_id, source_system);

create index if not exists tenant_account_snapshots_property_source_idx
  on public.tenant_account_snapshots (upper(trim(property_code)), source_system, synced_at desc);

create or replace function public.tenant_account_snapshots_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tenant_account_snapshots_touch_biud on public.tenant_account_snapshots;
create trigger tenant_account_snapshots_touch_biud
  before insert or update on public.tenant_account_snapshots
  for each row
  execute procedure public.tenant_account_snapshots_touch_updated_at();
