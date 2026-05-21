-- Access Engine V1 — amenity reservations, policies, credentials (lock adapter).
-- @see docs/ACCESS_ENGINE_BUILD_PLAN.md

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type access_reservation_status as enum (
    'REQUESTED',
    'PENDING_DEPOSIT',
    'PENDING_APPROVAL',
    'CONFIRMED',
    'ACTIVE',
    'COMPLETED',
    'CANCELLED',
    'NO_SHOW'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type access_pass_status as enum (
    'PENDING',
    'ISSUED',
    'ACTIVE',
    'REVOKED',
    'EXPIRED'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type access_credential_type as enum ('pin', 'qr', 'mobile_key', 'card');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type access_lock_provider as enum ('noop', 'seam', 'august', 'nuki');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- access_locations
-- ---------------------------------------------------------------------------
create table if not exists public.access_locations (
  id              uuid primary key default gen_random_uuid(),
  org_id          text not null references public.organizations (id) on delete restrict,
  property_code   text not null references public.properties (code) on delete restrict,
  slug            text not null default '',
  name            text not null,
  description     text not null default '',
  active          boolean not null default true,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, property_code, slug)
);

create index if not exists access_locations_org_idx on public.access_locations (org_id);
create index if not exists access_locations_property_idx on public.access_locations (property_code);

comment on table public.access_locations is 'Bookable controlled-access amenity (gameroom, sauna, terrace, …)';

-- ---------------------------------------------------------------------------
-- access_location_policies (versioned rules — engine reads active row only)
-- ---------------------------------------------------------------------------
create table if not exists public.access_location_policies (
  id                          uuid primary key default gen_random_uuid(),
  location_id                 uuid not null references public.access_locations (id) on delete cascade,
  org_id                      text not null,
  effective_from              timestamptz not null default now(),
  effective_until             timestamptz,
  min_duration_min            int not null default 30,
  max_duration_min            int not null default 120,
  advance_booking_min         int not null default 60,
  advance_booking_max_days    int not null default 14,
  same_day_allowed            boolean not null default true,
  max_concurrent              int not null default 1,
  max_per_tenant_day          int,
  max_per_tenant_week         int,
  max_per_tenant_month        int,
  requires_approval           boolean not null default false,
  approval_timeout_min        int not null default 60,
  approval_timeout_action     text not null default 'auto_cancel'
    check (approval_timeout_action in ('auto_cancel', 'auto_approve')),
  deposit_amount              numeric(12, 2) not null default 0,
  deposit_refundable          boolean not null default true,
  deposit_refund_cutoff_hours int not null default 24,
  hourly_rate                 numeric(12, 2) not null default 0,
  eligible_tenants            text not null default 'all'
    check (eligible_tenants in ('all', 'unit_whitelist', 'lease_active_only')),
  guest_allowed               boolean not null default false,
  max_guests                  int not null default 0,
  reminder_before_min         int not null default 30,
  staff_notify_on_reserve     boolean not null default true,
  staff_notify_on_cancel      boolean not null default true,
  staff_notify_reminder_copy  boolean not null default false,
  created_by                  text not null default '',
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists access_location_policies_location_idx
  on public.access_location_policies (location_id, effective_from desc);

-- ---------------------------------------------------------------------------
-- access_schedules — recurring weekly hours
-- ---------------------------------------------------------------------------
create table if not exists public.access_schedules (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.access_locations (id) on delete cascade,
  day_of_week     int not null check (day_of_week between 0 and 6),
  open_time       time not null,
  close_time      time not null,
  effective_from  date,
  effective_until date,
  created_at      timestamptz not null default now(),
  unique (location_id, day_of_week, open_time, close_time)
);

create index if not exists access_schedules_location_idx on public.access_schedules (location_id);

-- ---------------------------------------------------------------------------
-- access_blackouts
-- ---------------------------------------------------------------------------
create table if not exists public.access_blackouts (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.access_locations (id) on delete cascade,
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  reason          text not null default '',
  created_by      text not null default '',
  created_at      timestamptz not null default now(),
  check (end_at > start_at)
);

create index if not exists access_blackouts_location_range_idx
  on public.access_blackouts (location_id, start_at, end_at);

-- ---------------------------------------------------------------------------
-- access_locks
-- ---------------------------------------------------------------------------
create table if not exists public.access_locks (
  id                uuid primary key default gen_random_uuid(),
  org_id            text not null,
  location_id       uuid not null references public.access_locations (id) on delete cascade,
  provider          access_lock_provider not null default 'noop',
  external_lock_id  text not null default '',
  config            jsonb not null default '{}'::jsonb,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists access_locks_location_idx on public.access_locks (location_id);

-- ---------------------------------------------------------------------------
-- access_reservations
-- ---------------------------------------------------------------------------
create table if not exists public.access_reservations (
  id              uuid primary key default gen_random_uuid(),
  org_id          text not null,
  location_id     uuid not null references public.access_locations (id) on delete restrict,
  tenant_id       uuid not null references public.tenant_roster (id) on delete restrict,
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  status          access_reservation_status not null default 'REQUESTED',
  channel         text not null default 'portal',
  deposit_amount  numeric(12, 2) not null default 0,
  deposit_status  text not null default 'none',
  deposit_ref     text not null default '',
  access_pass_id  uuid,
  notes           text not null default '',
  override_by     text not null default '',
  approved_by     text not null default '',
  cancelled_by    text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_at > start_at)
);

create index if not exists access_reservations_location_range_idx
  on public.access_reservations (location_id, start_at, end_at);
create index if not exists access_reservations_tenant_idx
  on public.access_reservations (tenant_id, start_at desc);
create index if not exists access_reservations_status_idx
  on public.access_reservations (location_id, status);

-- ---------------------------------------------------------------------------
-- access_passes
-- ---------------------------------------------------------------------------
create table if not exists public.access_passes (
  id                    uuid primary key default gen_random_uuid(),
  reservation_id        uuid not null references public.access_reservations (id) on delete cascade,
  lock_id               uuid not null references public.access_locks (id) on delete restrict,
  credential_type       access_credential_type not null default 'pin',
  credential_value_enc  text not null default '',
  valid_from            timestamptz not null,
  valid_until           timestamptz not null,
  status                access_pass_status not null default 'PENDING',
  issued_at             timestamptz,
  revoked_at            timestamptz,
  revoked_by            text not null default '',
  created_at            timestamptz not null default now(),
  check (valid_until > valid_from)
);

create index if not exists access_passes_reservation_idx on public.access_passes (reservation_id);

alter table public.access_reservations
  add constraint access_reservations_pass_fk
  foreign key (access_pass_id) references public.access_passes (id) on delete set null;

-- ---------------------------------------------------------------------------
-- access_policy_audit
-- ---------------------------------------------------------------------------
create table if not exists public.access_policy_audit (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.access_locations (id) on delete cascade,
  policy_id       uuid references public.access_location_policies (id) on delete set null,
  changed_by      text not null default '',
  change_summary  jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- access_policy_templates (schema only — UI later)
-- ---------------------------------------------------------------------------
create table if not exists public.access_policy_templates (
  id              uuid primary key default gen_random_uuid(),
  org_id          text not null references public.organizations (id) on delete cascade,
  name            text not null,
  policy_snapshot jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, name)
);

-- ---------------------------------------------------------------------------
-- Pilot seed: PENN Gameroom (org grand) — data only, not engine hardcode
-- ---------------------------------------------------------------------------
insert into public.access_locations (org_id, property_code, slug, name, description, active, sort_order)
select 'grand', 'PENN', 'gameroom', 'Gameroom', 'Resident gameroom — pilot access engine', true, 10
where not exists (
  select 1 from public.access_locations
  where org_id = 'grand' and property_code = 'PENN' and slug = 'gameroom'
);

insert into public.access_location_policies (
  location_id, org_id,
  min_duration_min, max_duration_min,
  advance_booking_min, advance_booking_max_days,
  max_concurrent, requires_approval, deposit_amount,
  created_by
)
select l.id, l.org_id,
  30, 120,
  60, 14,
  1, false, 0,
  'migration_057'
from public.access_locations l
where l.org_id = 'grand' and l.property_code = 'PENN' and l.slug = 'gameroom'
  and not exists (
    select 1 from public.access_location_policies p where p.location_id = l.id
  );

insert into public.access_schedules (location_id, day_of_week, open_time, close_time)
select l.id, d.dow, time '08:00', time '23:00'
from public.access_locations l
cross join (select generate_series(0, 6) as dow) d
where l.org_id = 'grand' and l.property_code = 'PENN' and l.slug = 'gameroom'
  and not exists (
    select 1 from public.access_schedules s
    where s.location_id = l.id and s.day_of_week = d.dow
  );

insert into public.access_locks (org_id, location_id, provider, external_lock_id, active)
select l.org_id, l.id, 'noop', 'pilot-gameroom', true
from public.access_locations l
where l.org_id = 'grand' and l.property_code = 'PENN' and l.slug = 'gameroom'
  and not exists (
    select 1 from public.access_locks k where k.location_id = l.id and k.active = true
  );
