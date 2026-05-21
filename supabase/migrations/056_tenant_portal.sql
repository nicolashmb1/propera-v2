-- Tenant portal V1 — OTP auth, documents, org domain routing, roster/ticket portal flags.
-- @see docs/TENANT_PORTAL_BUILD_PLAN.md

-- ---------------------------------------------------------------------------
-- tenant_otp_codes
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_otp_codes (
  id          uuid primary key default gen_random_uuid(),
  phone_e164  text not null,
  code        text not null,
  expires_at  timestamptz not null,
  used        boolean not null default false,
  attempts    int not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists tenant_otp_codes_phone_active_idx
  on public.tenant_otp_codes (phone_e164, used, expires_at desc);

comment on table public.tenant_otp_codes is 'Short-lived OTP for resident portal login; purge expired rows periodically';

-- ---------------------------------------------------------------------------
-- tenant_documents (staff upload, tenant read via signed URL)
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_documents (
  id                  uuid primary key default gen_random_uuid(),
  org_id              text not null,
  tenant_roster_id    uuid not null references public.tenant_roster (id) on delete cascade,
  unit_id             uuid not null references public.units (id) on delete restrict,
  property_code       text not null references public.properties (code) on delete restrict,
  name                text not null,
  doc_type            text not null default 'OTHER',
  storage_path        text not null,
  storage_bucket      text not null default 'tenant-documents',
  file_size_bytes     int,
  mime_type           text,
  uploaded_by         text not null default '',
  visible_to_tenant   boolean not null default true,
  created_at          timestamptz not null default now()
);

create index if not exists tenant_documents_roster_idx
  on public.tenant_documents (tenant_roster_id);

create index if not exists tenant_documents_unit_idx
  on public.tenant_documents (unit_id);

-- ---------------------------------------------------------------------------
-- tenant_roster — portal access
-- ---------------------------------------------------------------------------
alter table public.tenant_roster
  add column if not exists portal_enabled boolean not null default true,
  add column if not exists preferred_language text not null default 'en';

comment on column public.tenant_roster.portal_enabled is 'When false, block resident portal login without deactivating roster row';
comment on column public.tenant_roster.preferred_language is 'en | es | pt — resident profile preference';

-- ---------------------------------------------------------------------------
-- tickets — intake channel
-- ---------------------------------------------------------------------------
alter table public.tickets
  add column if not exists intake_channel text not null default 'sms';

comment on column public.tickets.intake_channel is 'sms | whatsapp | tenant_portal | staff_portal | phone';

-- ---------------------------------------------------------------------------
-- communication_recipients — read tracking
-- ---------------------------------------------------------------------------
alter table public.communication_recipients
  add column if not exists opened_at timestamptz;

-- ---------------------------------------------------------------------------
-- organizations — attribution + domain routing
-- ---------------------------------------------------------------------------
alter table public.organizations
  add column if not exists show_propera_attribution boolean not null default true,
  add column if not exists custom_domain text,
  add column if not exists propera_subdomain text;

create unique index if not exists organizations_custom_domain_uidx
  on public.organizations (lower(trim(custom_domain)))
  where custom_domain is not null and trim(custom_domain) <> '';

create unique index if not exists organizations_propera_subdomain_uidx
  on public.organizations (lower(trim(propera_subdomain)))
  where propera_subdomain is not null and trim(propera_subdomain) <> '';

-- ---------------------------------------------------------------------------
-- properties — org link for brand + OTP scoping
-- ---------------------------------------------------------------------------
alter table public.properties
  add column if not exists org_id text;

-- Backfill Grand portfolio (055 seed org id = grand)
update public.properties set org_id = 'grand'
where org_id is null
  and upper(trim(code)) in ('PENN', 'MORRIS', 'MURRAY', 'WESTFIELD', 'WESTGRAND', 'WGRA');

update public.organizations set
  propera_subdomain = 'thegrand',
  custom_domain = null,
  show_propera_attribution = true
where id = 'grand'
  and (propera_subdomain is null or trim(propera_subdomain) = '');
