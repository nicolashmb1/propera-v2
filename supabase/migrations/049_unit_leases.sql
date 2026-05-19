-- Unit leases V1 — manually-entered rent, deposit, dates, recurring charge lines.
-- Feature flag (propera-app): NEXT_PUBLIC_FINANCE_ENABLED
-- One active lease record per unit. Lease history is a future concern (add version/end_at).
-- charge_lines: [{type, mode, amount_cents|null}] — see propera-app LeaseEditorModal for types.

-- ---------------------------------------------------------------------------
-- unit_leases
-- ---------------------------------------------------------------------------
create table if not exists public.unit_leases (
  id                      uuid primary key default gen_random_uuid(),
  unit_catalog_id         uuid not null references public.units (id) on delete cascade,
  property_code           text not null references public.properties (code) on delete restrict,
  rent_cents              bigint,
  security_deposit_cents  bigint,
  lease_start             date,
  lease_end               date,
  -- [{type: text, mode: "fixed"|"variable"|"included"|"none", amount_cents: bigint|null}]
  charge_lines            jsonb not null default '[]'::jsonb,
  notes                   text not null default '',
  created_by              text not null default '',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint unit_leases_rent_nonneg     check (rent_cents is null or rent_cents >= 0),
  constraint unit_leases_deposit_nonneg  check (security_deposit_cents is null or security_deposit_cents >= 0),
  constraint unit_leases_dates_order     check (lease_start is null or lease_end is null or lease_end >= lease_start)
);

comment on table public.unit_leases is
  'One record per unit; manually-entered rent, deposit, lease period, and per-charge billing modes. '
  'Populated by the owner / PM via propera-app until a PMS integration is available.';

-- One active lease per unit (extend to lease history with a separate versioned table later)
create unique index if not exists unit_leases_unit_uidx
  on public.unit_leases (unit_catalog_id);

create index if not exists unit_leases_property_idx
  on public.unit_leases (upper(trim(property_code)));

-- updated_at touch trigger
create or replace function public.unit_leases_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists unit_leases_touch_biud on public.unit_leases;
create trigger unit_leases_touch_biud
  before insert or update on public.unit_leases
  for each row
  execute procedure public.unit_leases_touch_updated_at();
