-- Tenant portal Web Push subscriptions.
-- Identity: tenant_roster_id (JWT-issued) scoped by org_id.
-- Separate from portal_push_subscriptions (staff/PM subscriptions).

create table if not exists public.tenant_push_subscriptions (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      text not null,
  tenant_roster_id            uuid references public.tenant_roster (id) on delete cascade,
  property_code               text not null references public.properties (code) on delete restrict,
  endpoint                    text not null,
  p256dh                      text not null,
  auth_key                    text not null,
  notify_rent_reminders       boolean not null default true,
  notify_maintenance_updates  boolean not null default true,
  notify_building_notices     boolean not null default true,
  active                      boolean not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint tenant_push_subscriptions_tenant_endpoint_uq
    unique (tenant_roster_id, endpoint)
);

comment on table public.tenant_push_subscriptions is
  'Web Push subscriptions for resident portal tenants. '
  'Keyed by tenant_roster_id + browser endpoint. '
  'Push events: rent_due, rent_late, maintenance_update, building_notice.';

create index if not exists tenant_push_subscriptions_org_active_idx
  on public.tenant_push_subscriptions (org_id, active);

create index if not exists tenant_push_subscriptions_property_active_idx
  on public.tenant_push_subscriptions (property_code, active);

create index if not exists tenant_push_subscriptions_roster_idx
  on public.tenant_push_subscriptions (tenant_roster_id)
  where active = true;

create or replace function public.tenant_push_subscriptions_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tenant_push_subscriptions_touch_biud on public.tenant_push_subscriptions;
create trigger tenant_push_subscriptions_touch_biud
  before insert or update on public.tenant_push_subscriptions
  for each row
  execute procedure public.tenant_push_subscriptions_touch_updated_at();
