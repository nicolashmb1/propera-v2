-- PENN Round 1 — approved 2026-06-10
-- 305 + 402 inserts; rename 303, 319, 514 (no Jan add)
-- Run in Supabase SQL Editor. Review returning → commit or rollback.

begin;

-- 305 — missing roster
insert into public.tenant_roster (
  property_code, unit_label, phone_e164, resident_name, active, org_id, notes
)
select
  'PENN',
  '305',
  '+15713353029',
  'Anish Anjana Balachandran',
  true,
  p.org_id,
  '[reconcile 2026-06-10: created from LH]'
from public.properties p
where upper(trim(p.code)) = 'PENN';

-- 402 — missing roster (2 LH phones)
insert into public.tenant_roster (
  property_code, unit_label, phone_e164, resident_name, active, org_id, notes
)
select
  'PENN',
  '402',
  '+19082476100',
  'Fernando R',
  true,
  p.org_id,
  '[reconcile 2026-06-10: created from LH]'
from public.properties p
where upper(trim(p.code)) = 'PENN'
union all
select
  'PENN',
  '402',
  '+19084004015',
  'Jose',
  true,
  p.org_id,
  '[reconcile 2026-06-10: created from LH]'
from public.properties p
where upper(trim(p.code)) = 'PENN';

-- 303 — rename
update public.tenant_roster
set
  resident_name = 'Yenifer L Cordoba',
  notes = trim(notes || ' [reconcile 2026-06-10: LH name]'),
  updated_at = now()
where id = 'c634c360-346d-41b5-a5a6-9cbaba1ad38e'
  and upper(trim(property_code)) = 'PENN'
  and trim(unit_label) = '303';

-- 319 — rename
update public.tenant_roster
set
  resident_name = 'Clenny Raphael Perez',
  notes = trim(notes || ' [reconcile 2026-06-10: LH name]'),
  updated_at = now()
where id = 'ac43fdcd-475b-4ed0-8c4c-603147ddb983'
  and upper(trim(property_code)) = 'PENN'
  and trim(unit_label) = '319';

-- 514 — rename only (no Jan)
update public.tenant_roster
set
  resident_name = 'Johanna C',
  notes = trim(notes || ' [reconcile 2026-06-10: LH name]'),
  updated_at = now()
where id = '0a003b5d-5338-452f-b3e9-d28167d4a5c0'
  and upper(trim(property_code)) = 'PENN'
  and trim(unit_label) = '514';

-- Preview all touched rows this session
select id, property_code, unit_label, resident_name, phone_e164, active
from public.tenant_roster
where upper(trim(property_code)) = 'PENN'
  and (
    trim(unit_label) in ('305', '402', '303', '319', '514')
    or notes like '%reconcile 2026-06-10%'
  )
order by unit_label, resident_name;

-- commit;
-- rollback;
