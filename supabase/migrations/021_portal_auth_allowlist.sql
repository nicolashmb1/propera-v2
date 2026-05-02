-- Pre-approved portal emails + roles for Supabase Auth self-service signup.
-- Ops inserts rows here (SQL Editor). App server checks allowlist before auth.admin.createUser.
-- Passwords live only in auth.users — never in this table. See propera-app auth plan (register/login API).

create table if not exists public.portal_auth_allowlist (
  id uuid primary key default gen_random_uuid(),
  email_lower text not null unique,
  portal_role text not null default 'Read-only',
  staff_id text references public.staff (staff_id) on delete set null,
  active boolean not null default true,
  auth_user_id uuid,
  registered_at timestamptz,
  created_at timestamptz not null default now(),
  notes text not null default ''
);

comment on table public.portal_auth_allowlist is
  'Pre-approved emails for portal signup; portal_role mirrors GAS Users.Role (Owner, Ops, Staff, Read-only, …).';

create index if not exists portal_auth_allowlist_active_idx
  on public.portal_auth_allowlist (email_lower) where active = true;

alter table public.portal_auth_allowlist enable row level security;
