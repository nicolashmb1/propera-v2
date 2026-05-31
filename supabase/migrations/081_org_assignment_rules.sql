-- Phase 3 — org auto-assignment rules (module → role target via Team & routing roster).
-- Escalation stays in org_escalation_config (Phase 4 lifecycle wire-up).

create table if not exists public.org_assignment_rules (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  rule_key text not null,
  label text not null default '',
  enabled boolean not null default true,
  priority integer not null default 100,
  module text not null,
  property_code text not null default '*',
  category_match text not null default '',
  target_kind text not null default 'primary_role',
  target_ref text not null,
  assign_mode text not null default 'staff',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_assignment_rules_org_rule_key_uq unique (org_id, rule_key)
);

create index if not exists org_assignment_rules_org_module_idx
  on public.org_assignment_rules (org_id, module, enabled, priority);

comment on table public.org_assignment_rules is
  'Auto-assignment rules: which catalog role (or future vendor key) owns new work per module/property/category.';

-- Seed default rules for every org (maintenance active; office/leasing off until modules ship).
insert into public.org_assignment_rules (
  org_id,
  rule_key,
  label,
  enabled,
  priority,
  module,
  property_code,
  category_match,
  target_kind,
  target_ref,
  assign_mode
)
select
  o.id,
  v.rule_key,
  v.label,
  v.enabled,
  v.priority,
  v.module,
  '*',
  '',
  'primary_role',
  v.target_ref,
  'staff'
from public.organizations o
cross join (
  values
    ('maintenance:building_super', 'Building lead (primary)', true, 10, 'maintenance', 'building_super'),
    (
      'maintenance:maintenance_tech_fallback',
      'Maintenance staff (fallback)',
      true,
      20,
      'maintenance',
      'maintenance_tech'
    ),
    ('office:office_staff', 'Office staff', false, 10, 'office', 'office_staff'),
    ('leasing:leasing', 'Leasing contact', false, 10, 'leasing', 'leasing')
) as v(rule_key, label, enabled, priority, module, target_ref)
on conflict (org_id, rule_key) do nothing;
