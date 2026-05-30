-- Grand org team coverage backfill (operator-approved 2026-05-30).
-- Safe to re-run: ON CONFLICT DO NOTHING on staff_property_roles.

insert into public.org_responsibility_prefs (org_id, enabled_role_keys)
values (
  'grand',
  '["building_super","maintenance_tech","office_pm","office_staff","leasing","owner"]'::jsonb
)
on conflict (org_id) do update
set enabled_role_keys = excluded.enabled_role_keys,
    updated_at = now();

insert into public.org_escalation_config (org_id, module, property_code, enabled, chain_json)
values ('grand', 'maintenance', '*', false, '["building_super","office_pm","owner"]'::jsonb)
on conflict (org_id, module, property_code) do update
set chain_json = excluded.chain_json,
    updated_at = now();

-- Nick: maintenance all 5; super on Penn, Westfield, Westgrand
insert into public.staff_property_roles (org_id, staff_id, property_code, role_key, is_primary, active)
select 'grand', 'STAFF_NICK', p.code, 'maintenance_tech', false, true
from public.properties p
where p.org_id = 'grand' and p.code not in ('GLOBAL') and p.active = true
  and exists (select 1 from public.staff s where s.org_id = 'grand' and s.staff_id = 'STAFF_NICK' and s.active = true)
on conflict (org_id, property_code, role_key, staff_id) do nothing;

insert into public.staff_property_roles (org_id, staff_id, property_code, role_key, is_primary, active)
select 'grand', 'STAFF_NICK', p.code, 'building_super', true, true
from public.properties p
where p.org_id = 'grand' and p.code in ('PENN', 'WESTFIELD', 'WESTGRAND') and p.active = true
  and exists (select 1 from public.staff s where s.org_id = 'grand' and s.staff_id = 'STAFF_NICK' and s.active = true)
on conflict (org_id, property_code, role_key, staff_id) do update
set is_primary = true, active = true, updated_at = now();

-- Geff: maintenance all 5; super on Morris, Murray
insert into public.staff_property_roles (org_id, staff_id, property_code, role_key, is_primary, active)
select 'grand', 'STAFF_GEFF', p.code, 'maintenance_tech', false, true
from public.properties p
where p.org_id = 'grand' and p.code not in ('GLOBAL') and p.active = true
  and exists (select 1 from public.staff s where s.org_id = 'grand' and s.staff_id = 'STAFF_GEFF' and s.active = true)
on conflict (org_id, property_code, role_key, staff_id) do nothing;

insert into public.staff_property_roles (org_id, staff_id, property_code, role_key, is_primary, active)
select 'grand', 'STAFF_GEFF', p.code, 'building_super', true, true
from public.properties p
where p.org_id = 'grand' and p.code in ('MORRIS', 'MURRAY') and p.active = true
  and exists (select 1 from public.staff s where s.org_id = 'grand' and s.staff_id = 'STAFF_GEFF' and s.active = true)
on conflict (org_id, property_code, role_key, staff_id) do update
set is_primary = true, active = true, updated_at = now();

-- Juliana: office PM all active properties
insert into public.staff_property_roles (org_id, staff_id, property_code, role_key, is_primary, active)
select 'grand', 'STAFF_JULIANA', p.code, 'office_pm', true, true
from public.properties p
where p.org_id = 'grand' and p.code not in ('GLOBAL') and p.active = true
  and exists (select 1 from public.staff s where s.org_id = 'grand' and s.staff_id = 'STAFF_JULIANA' and s.active = true)
on conflict (org_id, property_code, role_key, staff_id) do update
set is_primary = true, active = true, updated_at = now();

-- Britsy: office staff all properties
insert into public.staff_property_roles (org_id, staff_id, property_code, role_key, is_primary, active)
select 'grand', 'STAFF_BRITSY', p.code, 'office_staff', true, true
from public.properties p
where p.org_id = 'grand' and p.code not in ('GLOBAL') and p.active = true
  and exists (select 1 from public.staff s where s.org_id = 'grand' and s.staff_id = 'STAFF_BRITSY' and s.active = true)
on conflict (org_id, property_code, role_key, staff_id) do update
set is_primary = true, active = true, updated_at = now();

-- Yesenia: leasing all properties
insert into public.staff_property_roles (org_id, staff_id, property_code, role_key, is_primary, active)
select 'grand', 'STAFF_YESENIA', p.code, 'leasing', true, true
from public.properties p
where p.org_id = 'grand' and p.code not in ('GLOBAL') and p.active = true
  and exists (select 1 from public.staff s where s.org_id = 'grand' and s.staff_id = 'STAFF_YESENIA' and s.active = true)
on conflict (org_id, property_code, role_key, staff_id) do update
set is_primary = true, active = true, updated_at = now();

-- Samuel: owner org-wide on GLOBAL property
insert into public.staff_property_roles (org_id, staff_id, property_code, role_key, is_primary, active)
select 'grand', s.staff_id, 'GLOBAL', 'owner', true, true
from public.staff s
where s.org_id = 'grand' and s.active = true
  and s.staff_id in ('STAFF_SAM', 'STAFF_SAMUEL', 'STAFF_OWNER')
limit 1
on conflict (org_id, property_code, role_key, staff_id) do update
set is_primary = true, active = true, updated_at = now();
