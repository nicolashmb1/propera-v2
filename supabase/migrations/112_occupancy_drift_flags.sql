-- WESTFIELD pilot — flag LH snapshot tenant_name changes for staff review (no auto move-out).
-- Written by V2 brain on accounting import; adapter passes prior vs new names from snapshot upsert.

create table if not exists public.occupancy_drift_flags (
  id uuid primary key default gen_random_uuid(),
  unit_catalog_id uuid not null references public.units (id) on delete cascade,
  property_code text not null references public.properties (code) on delete restrict,
  unit_label text not null default '',
  drift_kind text not null default 'tenant_name_change',
  previous_value text not null default '',
  new_value text not null default '',
  source_system text not null default 'leasehold',
  synced_at timestamptz not null,
  idempotency_key text not null,
  status text not null default 'open',
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint occupancy_drift_flags_kind_chk
    check (drift_kind in ('tenant_name_change')),
  constraint occupancy_drift_flags_status_chk
    check (status in ('open', 'dismissed', 'resolved'))
);

create unique index if not exists occupancy_drift_flags_idempotency_uidx
  on public.occupancy_drift_flags (idempotency_key);

create index if not exists occupancy_drift_flags_property_status_idx
  on public.occupancy_drift_flags (upper(trim(property_code)), status, synced_at desc);

create index if not exists occupancy_drift_flags_unit_idx
  on public.occupancy_drift_flags (unit_catalog_id, synced_at desc);

comment on table public.occupancy_drift_flags is
  'Staff-review flags when LH snapshot tenant_name changes — turnover hint; does not close occupancy.';

comment on column public.occupancy_drift_flags.idempotency_key is
  'Stable dedupe — leasehold:{property}:{unit}:occupancy_drift:tenant_name:{prev}:{next}:{sync_day}';
