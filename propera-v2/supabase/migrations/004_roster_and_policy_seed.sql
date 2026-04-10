-- Roster + PropertyPolicy seed (from Sheets export). Run after 001 + 002 + 003.
-- Secrets: do not put real PORTAL_API_TOKEN_PM in git — set via SQL Editor locally (see below).

-- ---------------------------------------------------------------------------
-- staff_assignments: sheet allows multiple rows per (staff, property) for different roles
-- ---------------------------------------------------------------------------
alter table public.staff_assignments
  drop constraint if exists staff_assignments_staff_id_property_code_key;

alter table public.staff_assignments
  add constraint staff_assignments_staff_prop_role_key unique (staff_id, property_code, role);

-- ---------------------------------------------------------------------------
-- Optional columns (sheet parity)
-- ---------------------------------------------------------------------------
alter table public.properties
  add column if not exists legacy_property_id text,
  add column if not exists address text default '',
  add column if not exists short_name text default '';

create unique index if not exists properties_legacy_property_id_uidx
  on public.properties (legacy_property_id)
  where legacy_property_id is not null and legacy_property_id <> '';

alter table public.contacts
  add column if not exists legacy_contact_id text;

create unique index if not exists contacts_legacy_contact_id_uidx
  on public.contacts (legacy_contact_id)
  where legacy_contact_id is not null and legacy_contact_id <> '';

alter table public.staff
  add column if not exists active boolean not null default true;

comment on column public.staff_assignments.role is 'RoleType|Domain from sheet, e.g. SUPER|MAINTENANCE';

-- ---------------------------------------------------------------------------
-- Properties (includes GLOBAL for org-wide assignments)
-- ---------------------------------------------------------------------------
insert into public.properties (code, display_name, active, ticket_prefix, legacy_property_id, address, short_name)
values
  ('GLOBAL', 'Global / Org-wide', true, '', 'GLOBAL', '', 'Global'),
  ('PENN', 'The Grand at Penn', true, 'PENN', 'PROP_PENN', '702 Pennsylvania ave, Elizabeth - NJ', 'Penn'),
  ('MORRIS', 'The Grand at Morris', true, 'MORR', 'PROP_MORRIS', '540 Morris ave, Elizabeth - NJ', 'Morris'),
  ('MURRAY', 'The Grand at Murray', true, 'MURR', 'PROP_MURRAY', '57 Murray st. Elizabeth - NJ', 'Murray'),
  ('WESTFIELD', 'The Grand at Westfield', true, 'WEST', 'PROP_WESTFIELD', '618 Westfield ave, Elizabeth - NJ', 'Westfield'),
  ('WESTGRAND', 'The Grand at Westgrand', true, 'WGRA', 'PROP_WESTGRAND', '318 Westgrand ave, Elizabeth - NJ', 'Westgrand')
on conflict (code) do update
set
  display_name = excluded.display_name,
  active = excluded.active,
  ticket_prefix = excluded.ticket_prefix,
  legacy_property_id = coalesce(public.properties.legacy_property_id, excluded.legacy_property_id),
  address = excluded.address,
  short_name = excluded.short_name;

-- ---------------------------------------------------------------------------
-- Contacts + staff (only rows with a real PhoneE164 in your export)
-- Add more contacts + staff before inserting assignments for STAFF_OSCAR, etc.
-- ---------------------------------------------------------------------------
insert into public.contacts (legacy_contact_id, phone_e164, display_name, preferred_lang)
values
  ('CNT_NICK', '+19083380390', 'Nick', 'en'),
  ('CNT_GEFF', '+12158247916', 'Geff', 'en')
on conflict (phone_e164) do update
set
  display_name = excluded.display_name,
  preferred_lang = excluded.preferred_lang,
  legacy_contact_id = coalesce(public.contacts.legacy_contact_id, excluded.legacy_contact_id);

insert into public.staff (contact_id, staff_id, display_name, role, active)
select c.id, 'STAFF_NICK', 'Nick', '', true
from public.contacts c
where c.phone_e164 = '+19083380390'
  and not exists (select 1 from public.staff s where s.staff_id = 'STAFF_NICK');

insert into public.staff (contact_id, staff_id, display_name, role, active)
select c.id, 'STAFF_GEFF', 'Geff', '', true
from public.contacts c
where c.phone_e164 = '+12158247916'
  and not exists (select 1 from public.staff s where s.staff_id = 'STAFF_GEFF');

-- ---------------------------------------------------------------------------
-- Staff assignments: role = RoleType || '|' || Domain (unique per slot)
-- Skipped: STAFF_OSCAR, STAFF_ROMAN, STAFF_SAM, STAFF_JULIANA, STAFF_YESENIA, STAFF_BRITSY (no contact rows yet)
-- ---------------------------------------------------------------------------
insert into public.staff_assignments (staff_id, property_code, role)
select s.id, x.property_code, x.role_slot
from public.staff s
join public.contacts c on c.id = s.contact_id
cross join (values
  ('STAFF_NICK', 'WESTFIELD', 'SUPER|MAINTENANCE'),
  ('STAFF_NICK', 'WESTFIELD', 'PM|GENERAL'),
  ('STAFF_NICK', 'WESTFIELD', 'MAINTENANCE|MAINTENANCE'),
  ('STAFF_NICK', 'WESTGRAND', 'SUPER|MAINTENANCE'),
  ('STAFF_NICK', 'WESTGRAND', 'PM|GENERAL'),
  ('STAFF_NICK', 'WESTGRAND', 'MAINTENANCE|MAINTENANCE'),
  ('STAFF_NICK', 'PENN', 'SUPER|MAINTENANCE'),
  ('STAFF_NICK', 'PENN', 'PM|GENERAL'),
  ('STAFF_NICK', 'PENN', 'MAINTENANCE|MAINTENANCE'),
  ('STAFF_GEFF', 'MURRAY', 'SUPER|MAINTENANCE'),
  ('STAFF_GEFF', 'MURRAY', 'PM|GENERAL'),
  ('STAFF_GEFF', 'MURRAY', 'MAINTENANCE|MAINTENANCE'),
  ('STAFF_GEFF', 'MORRIS', 'SUPER|MAINTENANCE'),
  ('STAFF_GEFF', 'MORRIS', 'PM|GENERAL'),
  ('STAFF_GEFF', 'MORRIS', 'MAINTENANCE|MAINTENANCE'),
  ('STAFF_NICK', 'MORRIS', 'MAINTENANCE|MAINTENANCE')
) as x(staff_key, property_code, role_slot)
where s.staff_id = x.staff_key
on conflict (staff_id, property_code, role) do nothing;

-- ---------------------------------------------------------------------------
-- PropertyPolicy (ppGet_ keys). TOKEN: set in dashboard — placeholder here.
-- Fix typo PEEN -> PENN for dry-run row.
-- ---------------------------------------------------------------------------
insert into public.property_policy (property_code, policy_key, value, value_type)
values
  ('GLOBAL', 'SCHED_EARLIEST_HOUR', '9', 'NUMBER'),
  ('GLOBAL', 'SCHED_LATEST_HOUR', '17', 'NUMBER'),
  ('GLOBAL', 'SCHED_SAT_ALLOWED', 'TRUE', 'BOOL'),
  ('GLOBAL', 'SCHED_SAT_LATEST_HOUR', '13', 'NUMBER'),
  ('GLOBAL', 'SCHED_SUN_ALLOWED', 'FALSE', 'BOOL'),
  ('GLOBAL', 'SCHED_MIN_LEAD_HOURS', '1', 'NUMBER'),
  ('GLOBAL', 'SCHED_MAX_DAYS_OUT', '14', 'NUMBER'),
  ('PENN', 'ASSIGN_DEFAULT_OWNER', 'STAFF_NICK', 'TEXT'),
  ('WESTFIELD', 'ASSIGN_DEFAULT_OWNER', 'STAFF_NICK', 'TEXT'),
  ('WESTGRAND', 'ASSIGN_DEFAULT_OWNER', 'STAFF_NICK', 'TEXT'),
  ('MORRIS', 'ASSIGN_DEFAULT_OWNER', 'STAFF_GEFF', 'TEXT'),
  ('MURRAY', 'ASSIGN_DEFAULT_OWNER', 'STAFF_GEFF', 'TEXT'),
  ('GLOBAL', 'PORTAL_API_TOKEN_PM', '__SET_IN_SQL_EDITOR_NOT_IN_GIT__', 'TEXT'),
  ('GLOBAL', 'POLICY_ENGINE_ENABLED', 'TRUE', 'BOOL'),
  ('PENN', 'POLICY_ENGINE_DRY_RUN', 'FALSE', 'BOOL'),
  ('GLOBAL', 'SCHEDULE_BUFFER_HOURS', '4', 'NUMBER'),
  ('GLOBAL', 'TENANT_VERIFY_REQUIRED', 'FALSE', 'BOOL'),
  ('GLOBAL', 'TENANT_VERIFY_HOURS', '12', 'NUMBER'),
  ('GLOBAL', 'STAFF_UPDATE_PING_HOURS', '4', 'NUMBER'),
  ('GLOBAL', 'STAFF_UPDATE_MAX_ATTEMPTS', '3', 'NUMBER'),
  ('GLOBAL', 'PARTS_WAIT_MAX_HOURS', '48', 'NUMBER'),
  ('GLOBAL', 'PARTS_ETA_BUFFER_HOURS', '0', 'NUMBER'),
  ('GLOBAL', 'PARTS_ETA_ASK_REPEAT_HOURS', '48', 'NUMBER'),
  ('GLOBAL', 'PARTS_ETA_MAX_ATTEMPTS', '2', 'NUMBER'),
  ('GLOBAL', 'LIFECYCLE_ENABLED', 'TRUE', 'BOOL'),
  ('GLOBAL', 'CONTACT_EARLIEST_HOUR', '8', 'NUMBER'),
  ('GLOBAL', 'CONTACT_LATEST_HOUR', '18', 'NUMBER'),
  ('GLOBAL', 'CONTACT_SAT_ALLOWED', 'TRUE', 'BOOL'),
  ('GLOBAL', 'CONTACT_SAT_LATEST_HOUR', '16', 'NUMBER'),
  ('GLOBAL', 'CONTACT_SUN_ALLOWED', 'FALSE', 'BOOL'),
  ('GLOBAL', 'PING_STAFF_UPDATE_RESPECT_CONTACT_HOURS', 'TRUE', 'BOOL'),
  ('GLOBAL', 'PING_UNSCHEDULED_RESPECT_CONTACT_HOURS', 'TRUE', 'BOOL'),
  ('GLOBAL', 'TIMER_ESCALATE_RESPECT_CONTACT_HOURS', 'TRUE', 'BOOL'),
  ('GLOBAL', 'AUTO_CLOSE_RESPECT_CONTACT_HOURS', 'FALSE', 'BOOL'),
  ('GLOBAL', 'TENANT_VERIFY_RESPECT_CONTACT_HOURS', 'TRUE', 'BOOL'),
  ('GLOBAL', 'UNSCHEDULED_FIRST_PING_HOURS', '24', 'NUMBER'),
  ('GLOBAL', 'UNSCHEDULED_REPEAT_PING_HOURS', '24', 'NUMBER'),
  ('GLOBAL', 'UNSCHEDULED_MAX_ATTEMPTS', '3', 'NUMBER')
on conflict (property_code, policy_key) do update
set value = excluded.value,
    value_type = excluded.value_type;

-- After running this file once, set the real portal token in SQL Editor (do not commit):
-- update public.property_policy set value = '<your token>' where property_code = 'GLOBAL' and policy_key = 'PORTAL_API_TOKEN_PM';
