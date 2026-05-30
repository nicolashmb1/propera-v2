-- MO-4b / Responsibility catalog Phase 1 — per-org team coverage + escalation prefs.
-- Platform role keys are defined in code (src/responsibility/roleCatalog.js).

-- ---------------------------------------------------------------------------
-- staff_property_roles — who holds which routing slot at which property
-- ---------------------------------------------------------------------------
create table if not exists public.staff_property_roles (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  staff_id text not null,
  property_code text not null references public.properties (code) on delete cascade,
  role_key text not null,
  is_primary boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_property_roles_org_staff_prop_role_uq
    unique (org_id, property_code, role_key, staff_id)
);

create unique index if not exists staff_property_roles_one_primary_uq
  on public.staff_property_roles (org_id, property_code, role_key)
  where is_primary = true and active = true;

create index if not exists staff_property_roles_org_prop_idx
  on public.staff_property_roles (org_id, property_code, role_key);

comment on table public.staff_property_roles is
  'Org-scoped responsibility catalog: staff assigned to platform role slots per property (or GLOBAL).';

-- ---------------------------------------------------------------------------
-- org_responsibility_prefs — which extended role slots this org uses in UI
-- ---------------------------------------------------------------------------
create table if not exists public.org_responsibility_prefs (
  org_id text primary key references public.organizations (id) on delete cascade,
  enabled_role_keys jsonb not null default '["building_super","maintenance_tech","office_pm","owner"]'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.org_responsibility_prefs is
  'Per-org toggles for extended responsibility role slots shown in Settings Team coverage.';

-- ---------------------------------------------------------------------------
-- org_escalation_config — on/off + role chain (lifecycle wire-up in Phase 4)
-- ---------------------------------------------------------------------------
create table if not exists public.org_escalation_config (
  org_id text not null references public.organizations (id) on delete cascade,
  module text not null default 'maintenance',
  property_code text not null default '*',
  enabled boolean not null default false,
  chain_json jsonb not null default '["building_super","office_pm","owner"]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (org_id, module, property_code)
);

comment on table public.org_escalation_config is
  'Escalation master switch and ordered role chain per org/module; thresholds stay in property_policy.';

-- Seed prefs + default escalation row for existing orgs
insert into public.org_responsibility_prefs (org_id, enabled_role_keys)
select o.id, '["building_super","maintenance_tech","office_pm","office_staff","leasing","owner"]'::jsonb
from public.organizations o
on conflict (org_id) do nothing;

insert into public.org_escalation_config (org_id, module, property_code, enabled, chain_json)
select o.id, 'maintenance', '*', false, '["building_super","office_pm","owner"]'::jsonb
from public.organizations o
on conflict (org_id, module, property_code) do nothing;
