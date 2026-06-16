-- MO-5: org-scoped RLS on core catalog tables exposed to PostgREST.
-- Service role (propera-v2 DAL + propera-app admin client) bypasses RLS.
-- Authenticated portal JWT: read only rows for the caller's org (via portal_auth_allowlist).
-- @see docs/MULTI_ORG_ARCHITECTURE.md

-- ---------------------------------------------------------------------------
-- Helper — map Supabase Auth JWT → org_id (mirrors resolvePortalOrgContext.js)
-- ---------------------------------------------------------------------------
create or replace function public.propera_org_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select pa.org_id
  from public.portal_auth_allowlist pa
  where pa.active = true
    and (
      pa.auth_user_id = auth.uid()
      or (
        pa.auth_user_id is null
        and pa.email_lower = lower(coalesce((select auth.jwt()) ->> 'email', ''))
      )
    )
  order by pa.registered_at desc nulls last, pa.created_at desc
  limit 1;
$$;

comment on function public.propera_org_id() is
  'Portal org scope for RLS: active allowlist row for auth.uid() or JWT email.';

grant execute on function public.propera_org_id() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS on catalog tables that had none
-- ---------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.staff enable row level security;
alter table public.properties enable row level security;
alter table public.property_aliases enable row level security;
alter table public.org_channel_configs enable row level security;
alter table public.staff_assignments enable row level security;
alter table public.contacts enable row level security;

-- ---------------------------------------------------------------------------
-- SELECT policies — authenticated portal users, org-scoped
-- ---------------------------------------------------------------------------

drop policy if exists "organizations_select_org" on public.organizations;
create policy "organizations_select_org"
  on public.organizations
  for select
  to authenticated
  using (id = public.propera_org_id());

drop policy if exists "staff_select_org" on public.staff;
create policy "staff_select_org"
  on public.staff
  for select
  to authenticated
  using (org_id = public.propera_org_id());

drop policy if exists "properties_select_org" on public.properties;
create policy "properties_select_org"
  on public.properties
  for select
  to authenticated
  using (org_id = public.propera_org_id());

drop policy if exists "property_aliases_select_org" on public.property_aliases;
create policy "property_aliases_select_org"
  on public.property_aliases
  for select
  to authenticated
  using (org_id = public.propera_org_id());

drop policy if exists "org_channel_configs_select_org" on public.org_channel_configs;
create policy "org_channel_configs_select_org"
  on public.org_channel_configs
  for select
  to authenticated
  using (org_id = public.propera_org_id());

drop policy if exists "staff_assignments_select_org" on public.staff_assignments;
create policy "staff_assignments_select_org"
  on public.staff_assignments
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.staff s
      where s.id = staff_assignments.staff_id
        and s.org_id = public.propera_org_id()
    )
  );

drop policy if exists "contacts_select_org_staff" on public.contacts;
create policy "contacts_select_org_staff"
  on public.contacts
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.staff s
      where s.contact_id = contacts.id
        and s.org_id = public.propera_org_id()
    )
  );

-- Tables that already had RLS enabled but no policies (default deny)
drop policy if exists "portal_auth_allowlist_select_own" on public.portal_auth_allowlist;
create policy "portal_auth_allowlist_select_own"
  on public.portal_auth_allowlist
  for select
  to authenticated
  using (
    auth_user_id = auth.uid()
    or email_lower = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  );

drop policy if exists "tenant_roster_select_org" on public.tenant_roster;
create policy "tenant_roster_select_org"
  on public.tenant_roster
  for select
  to authenticated
  using (org_id = public.propera_org_id());

drop policy if exists "vendors_select_org" on public.vendors;
create policy "vendors_select_org"
  on public.vendors
  for select
  to authenticated
  using (org_id = public.propera_org_id());
