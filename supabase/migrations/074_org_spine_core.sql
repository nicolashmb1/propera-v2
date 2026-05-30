-- Multi-org spine (Phase MO-1): org_id on core catalog + allowlist uniqueness per org.
-- @see docs/MULTI_ORG_ARCHITECTURE.md

-- Ensure default org row exists (055 seed may have created it).
insert into public.organizations (id, brand_name, brand_short_name)
values ('grand', 'Grand Management Group', 'Grand')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- portal_auth_allowlist — one email may exist in different orgs later
-- ---------------------------------------------------------------------------
alter table public.portal_auth_allowlist
  add column if not exists org_id text;

update public.portal_auth_allowlist
set org_id = 'grand'
where org_id is null or trim(org_id) = '';

alter table public.portal_auth_allowlist
  alter column org_id set default 'grand';

alter table public.portal_auth_allowlist
  alter column org_id set not null;

alter table public.portal_auth_allowlist
  drop constraint if exists portal_auth_allowlist_email_lower_key;

create unique index if not exists portal_auth_allowlist_org_email_uidx
  on public.portal_auth_allowlist (org_id, email_lower);

create index if not exists portal_auth_allowlist_org_active_idx
  on public.portal_auth_allowlist (org_id, email_lower)
  where active = true;

comment on column public.portal_auth_allowlist.org_id is
  'Management company tenant; email is unique per org, not globally';

-- ---------------------------------------------------------------------------
-- staff — org membership for portal scope
-- ---------------------------------------------------------------------------
alter table public.staff
  add column if not exists org_id text;

update public.staff
set org_id = 'grand'
where org_id is null or trim(org_id) = '';

alter table public.staff
  alter column org_id set default 'grand';

alter table public.staff
  alter column org_id set not null;

create index if not exists staff_org_id_idx on public.staff (org_id);

-- ---------------------------------------------------------------------------
-- vendors — org-scoped directory (vendor_id PK remains global for vendor_lane FKs)
-- ---------------------------------------------------------------------------
alter table public.vendors
  add column if not exists org_id text;

update public.vendors
set org_id = 'grand'
where org_id is null or trim(org_id) = '';

alter table public.vendors
  alter column org_id set default 'grand';

alter table public.vendors
  alter column org_id set not null;

create index if not exists vendors_org_active_idx
  on public.vendors (org_id, active)
  where active = true;

-- ---------------------------------------------------------------------------
-- tenant_roster — denormalized org for list filters
-- ---------------------------------------------------------------------------
alter table public.tenant_roster
  add column if not exists org_id text;

update public.tenant_roster tr
set org_id = coalesce(
  (
    select p.org_id
    from public.properties p
    where upper(trim(p.code)) = upper(trim(tr.property_code))
    limit 1
  ),
  'grand'
)
where tr.org_id is null or trim(tr.org_id) = '';

alter table public.tenant_roster
  alter column org_id set default 'grand';

alter table public.tenant_roster
  alter column org_id set not null;

create index if not exists tenant_roster_org_active_idx
  on public.tenant_roster (org_id, active);

-- ---------------------------------------------------------------------------
-- property_aliases — intake detection scoped to org
-- ---------------------------------------------------------------------------
alter table public.property_aliases
  add column if not exists org_id text;

update public.property_aliases pa
set org_id = coalesce(
  (
    select p.org_id
    from public.properties p
    where upper(trim(p.code)) = upper(trim(pa.property_code))
    limit 1
  ),
  'grand'
)
where pa.org_id is null or trim(pa.org_id) = '';

alter table public.property_aliases
  alter column org_id set default 'grand';

alter table public.property_aliases
  alter column org_id set not null;

create index if not exists property_aliases_org_active_idx
  on public.property_aliases (org_id, active);

-- ---------------------------------------------------------------------------
-- properties — backfill org_id on rows still null (incl. GLOBAL)
-- ---------------------------------------------------------------------------
update public.properties
set org_id = 'grand'
where org_id is null or trim(org_id) = '';

create index if not exists properties_org_active_idx
  on public.properties (org_id, active);
