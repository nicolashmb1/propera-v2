-- Identity: properties, contacts, staff, staff_assignments (aligns with GAS Staff + Contacts + StaffAssignments)
-- Run in Supabase SQL Editor after 001 + 002

create table if not exists public.properties (
  code text primary key,
  display_name text not null default '',
  active boolean not null default true,
  ticket_prefix text default '',
  created_at timestamptz default now()
);

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  display_name text default '',
  preferred_lang text default 'en',
  created_at timestamptz default now()
);

create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  staff_id text unique,
  display_name text default '',
  role text default '',
  unique (contact_id)
);

create table if not exists public.staff_assignments (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff (id) on delete cascade,
  property_code text not null references public.properties (code) on delete cascade,
  role text default '',
  unique (staff_id, property_code)
);

create index if not exists contacts_phone_idx on public.contacts (phone_e164);
create index if not exists staff_assignments_prop_idx on public.staff_assignments (property_code);

comment on table public.properties is 'GAS: Properties sheet (minimal columns)';
comment on table public.contacts is 'GAS: Contacts — PhoneE164';
comment on table public.staff is 'GAS: Staff — links to Contacts';
comment on table public.staff_assignments is 'GAS: StaffAssignments — property scope';

-- Minimal seed for dev (edit phones / codes to match your roster)
insert into public.properties (code, display_name, active, ticket_prefix)
values
  ('WESTFIELD', 'The Grand at Westfield', true, 'WEST'),
  ('PENN', 'The Grand at Penn', true, 'PENN')
on conflict (code) do nothing;

-- Example staff phone — replace with a real test number from Contacts when importing
insert into public.contacts (phone_e164, display_name)
values ('+19085550101', 'Dev Staff (seed)')
on conflict (phone_e164) do nothing;

insert into public.staff (contact_id, staff_id, display_name, role)
select c.id, 'STAFF_DEV_1', 'Dev Staff (seed)', 'PM'
from public.contacts c
where c.phone_e164 = '+19085550101'
  and not exists (select 1 from public.staff s where s.contact_id = c.id);

insert into public.staff_assignments (staff_id, property_code, role)
select s.id, 'WESTFIELD', 'PM'
from public.staff s
join public.contacts c on c.id = s.contact_id
where c.phone_e164 = '+19085550101'
  and not exists (
    select 1 from public.staff_assignments sa
    where sa.staff_id = s.id and sa.property_code = 'WESTFIELD'
  );
